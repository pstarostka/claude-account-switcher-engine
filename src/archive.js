'use strict'

// Profile lifecycle: measure a profile, and move one aside without deleting it.
//
// Archiving is a rename inside the same directory, never a copy-then-delete.
// That matters for more than speed: a rename is atomic and reversible, so there
// is no window where the data exists in two half-states, and no path where a
// failure half-way through loses anything. A profile is 0.5–8 GB, so copying it
// would also be minutes of I/O to achieve strictly less.
//
// Nothing here deletes, with one exception that is named as such and sits behind
// its own confirmation.

const fs = require('node:fs')
const path = require('node:path')
const platform = require('./platform')

const SUFFIX = '.archived'

/** Disk usage in bytes. How it is measured differs by OS; see src/platform. */
const size = dir => platform.profileSize(dir)

/** First free path of the form `base`, `base-2`, `base-3`… */
function freePath (base) {
  let p = base
  for (let i = 2; fs.existsSync(p); i++) p = `${base}-${i}`
  return p
}

const isArchivePath = name => name.includes(SUFFIX)

/**
 * Rename, with a few attempts before giving up.
 *
 * The rename *is* the operation here, and on Windows it fails outright while any
 * file inside the directory is held open — which Defender, Windows Search or an
 * Explorer preview will do briefly, for reasons that have nothing to do with us.
 * macOS renames a directory with open files without complaint, so on a Mac this
 * loop only ever runs once.
 */
async function rename (from, to) {
  for (let attempt = 0; ; attempt++) {
    try { return fs.renameSync(from, to) } catch (e) {
      const transient = e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES'
      if (attempt === 3 || !transient) throw e
      await new Promise(r => setTimeout(r, 200))
    }
  }
}

/**
 * Move a profile aside. Returns the record to store, or an error. The caller is
 * responsible for the guards that make this safe to offer at all — not the
 * default profile, not while it is running.
 */
async function archive (account, bytes) {
  if (!fs.existsSync(account.dir)) return { error: 'That profile folder is no longer there.' }
  const dest = freePath(account.dir + SUFFIX)
  try {
    await rename(account.dir, dest)
  } catch (e) {
    return { error: `Could not move the profile aside: ${e.message}` }
  }
  return {
    record: {
      id: account.id,
      name: account.name,
      emoji: account.emoji,
      hue: account.hue,
      chrome: account.chrome,
      dir: dest,
      originalDir: account.dir,
      archivedAt: Date.now(),
      bytes: bytes ?? null
    }
  }
}

/**
 * Move an archived profile back. If something has since taken its old path — a
 * new account of the same name, say — it lands beside it rather than over it.
 */
async function restore (record) {
  if (!fs.existsSync(record.dir)) return { error: 'The archived folder is no longer there.' }
  const dest = freePath(record.originalDir)
  try {
    await rename(record.dir, dest)
  } catch (e) {
    return { error: `Could not move the profile back: ${e.message}` }
  }
  return { dir: dest, renamed: dest !== record.originalDir }
}

/** The one destructive call here. Named plainly; confirmed by the caller. */
function destroy (record) {
  try {
    fs.rmSync(record.dir, { recursive: true, force: true })
    return { ok: true }
  } catch (e) {
    return { error: `Could not delete the archive: ${e.message}` }
  }
}

/** Records whose folder has gone missing are reported, not silently dropped. */
function withStatus (records) {
  return (records || []).map(r => ({ ...r, exists: fs.existsSync(r.dir) }))
}

module.exports = { size, archive, restore, destroy, withStatus, isArchivePath, SUFFIX }
