'use strict'

// Session safety net.
//
// Claude Desktop keeps a session *index* inside each profile:
//
//     <profile>/claude-code-sessions/<accountUuid>/<orgUuid>/local_*.json
//
// The conversation itself lives somewhere else entirely — Claude Code writes
// transcripts to ~/.claude/projects/<encoded-cwd>/<cliSessionId>.jsonl. The two
// are joined by the index entry's cliSessionId.
//
// That split is why sessions can disappear while every message survives: if the
// app cannot write the index (a symlinked storage dir makes ensureStorageDir
// fail with ENOTDIR), it keeps the session in memory, logs the failure, and
// carries on. Nothing looks wrong until it restarts, and then the session is
// simply not in the list.
//
// This module is deliberately additive. It reads Claude's data, copies it, and
// creates missing index entries. It never edits or deletes anything of Claude's.

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')

const PROJECTS = path.join(os.homedir(), '.claude', 'projects')
const KEEP_BACKUPS = 10

// The profile Claude uses with no CLAUDE_USER_DATA_DIR set, and where Electron
// leaves that profile's log.
const DEFAULT_PROFILE = path.join(os.homedir(), 'Library', 'Application Support', 'Claude')
const SHARED_LOG = path.join(os.homedir(), 'Library', 'Logs', 'Claude', 'main.log')

// ------------------------------------------------------------------ file io ---

/** Read the first `bytes` of a file as text, without pulling in a 14 MB transcript. */
function readHead (file, bytes = 65536) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    const buf = Buffer.alloc(Math.min(bytes, size))
    fs.readSync(fd, buf, 0, buf.length, 0)
    return buf.toString('utf8')
  } catch { return '' } finally { if (fd !== undefined) fs.closeSync(fd) }
}

function readTail (file, bytes = 262144) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    const len = Math.min(bytes, size)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, size - len)
    return buf.toString('utf8')
  } catch { return '' } finally { if (fd !== undefined) fs.closeSync(fd) }
}

const lines = text => text.split('\n').filter(Boolean)

function parseJsonl (text, { skipFirst = false } = {}) {
  const out = []
  const ls = lines(text)
  // A partial read almost always slices a line in half at one end.
  for (const l of ls.slice(skipFirst ? 1 : 0, ls.length - 1 || undefined)) {
    try { out.push(JSON.parse(l)) } catch {}
  }
  return out
}

// ------------------------------------------------------------------- index ---

/** Every namespace directory in a profile's session index. */
function namespaces (profile) {
  const root = path.join(profile, 'claude-code-sessions')
  const out = []
  let accounts = []
  try { accounts = fs.readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const a of accounts) {
    if (!a.isDirectory()) continue
    let orgs = []
    try { orgs = fs.readdirSync(path.join(root, a.name), { withFileTypes: true }) } catch { continue }
    for (const o of orgs) {
      if (o.isDirectory()) out.push({ account: a.name, org: o.name, dir: path.join(root, a.name, o.name) })
    }
  }
  return out
}

function indexEntries (profile) {
  const out = []
  for (const ns of namespaces(profile)) {
    let files = []
    try { files = fs.readdirSync(ns.dir) } catch { continue }
    for (const f of files) {
      if (!f.startsWith('local_') || !f.endsWith('.json')) continue
      try {
        out.push({ ns, file: path.join(ns.dir, f), ...JSON.parse(fs.readFileSync(path.join(ns.dir, f), 'utf8')) })
      } catch {}
    }
  }
  return out
}

/** Where a rebuilt entry should go: the busiest namespace, matching the signed-in account when known. */
function targetNamespace (profile) {
  const all = namespaces(profile)
  if (!all.length) return null
  let preferred = null
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(profile, 'config.json'), 'utf8'))
    preferred = cfg.lastKnownAccountUuid || null
  } catch {}
  const scored = all.map(ns => {
    let n = 0
    try { n = fs.readdirSync(ns.dir).filter(f => f.startsWith('local_')).length } catch {}
    return { ns, n, preferred: ns.account === preferred }
  })
  scored.sort((a, b) => (b.preferred - a.preferred) || (b.n - a.n))
  return scored[0].ns
}

/**
 * Is the index writable right now? The log keeps every historical failure, so
 * without this a fixed problem would raise a warning for ever.
 */
function storageHealth (profile) {
  const ns = targetNamespace(profile)
  if (!ns) return { ok: false, reason: 'no session index yet' }
  try {
    if (fs.lstatSync(ns.dir).isSymbolicLink()) {
      return { ok: false, reason: 'the storage directory is a symlink, which the app refuses to write into' }
    }
    fs.accessSync(ns.dir, fs.constants.W_OK)
    return { ok: true, reason: null }
  } catch {
    return { ok: false, reason: 'the storage directory is not writable' }
  }
}

// --------------------------------------------------------------------- logs ---

const MAP_RE = /Mapping internal session (local_[0-9a-f-]+) to CLI session ([0-9a-f-]+)/g
const FAIL_RE = /^(\S+ \S+) \[error\] Failed to save session (local_[0-9a-f-]+): (.+)$/

/**
 * The app logs every internal-session → CLI-session pairing. That log is the
 * only record that a transcript ever belonged to a *desktop* session, which is
 * what separates a genuinely lost session from an ordinary CLI transcript.
 */
function readLog (profile) {
  // Profiles launched with CLAUDE_USER_DATA_DIR get <profile>/Logs. Only the
  // default profile falls back to the shared log, and only it may: for any other
  // profile a missing log means the account has not been opened yet, and reading
  // the shared one would report the default profile's sessions as this account's
  // — every one of them missing from an index that does not exist yet.
  const own = path.join(profile, 'Logs', 'main.log')
  const file = !fs.existsSync(own) && profile === DEFAULT_PROFILE ? SHARED_LOG : own
  // readTail answers '' for a file that is not there, so an unopened account
  // comes back with nothing to report rather than someone else's history.
  const text = readTail(file, 8 * 1024 * 1024)

  const mappings = new Map()      // cliSessionId -> localId
  for (const m of text.matchAll(MAP_RE)) mappings.set(m[2], m[1])

  const failures = []
  for (const l of lines(text)) {
    const m = l.match(FAIL_RE)
    if (m) failures.push({ at: m[1], sessionId: m[2], reason: m[3].split('\\n')[0].slice(0, 200) })
  }

  return { mappings, failures, logFile: file, exists: fs.existsSync(file) }
}

// --------------------------------------------------------------- transcripts ---

/** Index every transcript on disk by its session id. */
function transcriptIndex () {
  const byId = new Map()
  let dirs = []
  try { dirs = fs.readdirSync(PROJECTS, { withFileTypes: true }) } catch { return byId }
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    let files = []
    try { files = fs.readdirSync(path.join(PROJECTS, d.name)) } catch { continue }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      byId.set(f.slice(0, -6), path.join(PROJECTS, d.name, f))
    }
  }
  return byId
}

/** Pull the details needed to rebuild an index entry, reading only the ends of the file. */
function describeTranscript (file) {
  const head = parseJsonl(readHead(file), {})
  const tail = parseJsonl(readTail(file), { skipFirst: true })
  const stat = fs.statSync(file)

  const titleRec = head.find(r => r.type === 'custom-title')
  const cwdRec = [...head, ...tail].find(r => typeof r.cwd === 'string' && r.cwd)
  const withTs = [...head, ...tail].filter(r => r.timestamp)
  const modelRec = [...tail].reverse().find(r => r.message && r.message.model)

  return {
    title: titleRec?.customTitle || null,
    cwd: cwdRec?.cwd || null,
    model: modelRec?.message?.model || null,
    createdAt: withTs.length ? Date.parse(withTs[0].timestamp) : stat.birthtimeMs,
    lastActivityAt: stat.mtimeMs,
    bytes: stat.size
  }
}

// ------------------------------------------------------------------ backups ---

/**
 * Snapshot the index before each launch. It is a few hundred KB of JSON, so the
 * copy is nearly free — and it is the exact thing that goes missing when the app
 * cannot write to its storage directory.
 */
async function backupIndex (account, backupRoot) {
  const entries = indexEntries(account.dir)
  if (!entries.length) return null

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = path.join(backupRoot, account.id, stamp)
  await fsp.mkdir(dest, { recursive: true })

  for (const e of entries) {
    const sub = path.join(dest, e.ns.account, e.ns.org)
    await fsp.mkdir(sub, { recursive: true })
    await fsp.copyFile(e.file, path.join(sub, path.basename(e.file)))
  }

  // Rotate.
  const parent = path.join(backupRoot, account.id)
  const kept = (await fsp.readdir(parent)).sort()
  for (const old of kept.slice(0, Math.max(0, kept.length - KEEP_BACKUPS))) {
    await fsp.rm(path.join(parent, old), { recursive: true, force: true })
  }

  return { dir: dest, count: entries.length }
}

async function backupSummary (account, backupRoot) {
  const parent = path.join(backupRoot, account.id)
  let stamps = []
  try { stamps = (await fsp.readdir(parent)).sort() } catch { return { count: 0, latest: null, dir: parent } }
  return { count: stamps.length, latest: stamps[stamps.length - 1] || null, dir: parent }
}

// --------------------------------------------------------------------- scan ---

function scanAccount (account, transcripts) {
  const { mappings, failures, logFile, exists } = readLog(account.dir)
  const entries = indexEntries(account.dir)
  const known = new Set(entries.map(e => e.cliSessionId).filter(Boolean))
  // One desktop session spans several CLI transcripts as it compacts, all sharing
  // one internal id. If that id is already indexed the session is not lost — the
  // list shows it, pointing at its latest transcript.
  const knownLocal = new Set(entries.map(e => e.sessionId).filter(Boolean))

  const orphans = []
  for (const [cliSessionId, localId] of mappings) {
    if (known.has(cliSessionId) || knownLocal.has(localId)) continue
    const file = transcripts.get(cliSessionId)
    if (!file) continue          // transcript already gone; nothing to restore
    let d
    try { d = describeTranscript(file) } catch { continue }
    orphans.push({
      localId,
      cliSessionId,
      transcript: file,
      title: d.title || (d.cwd ? path.basename(d.cwd) : 'Untitled session'),
      hasCustomTitle: Boolean(d.title),
      cwd: d.cwd,
      model: d.model,
      createdAt: d.createdAt,
      lastActivityAt: d.lastActivityAt,
      bytes: d.bytes
    })
  }
  orphans.sort((a, b) => b.lastActivityAt - a.lastActivityAt)

  const storage = storageHealth(account.dir)

  return {
    logExists: exists,
    logFile,
    storage,
    failures: failures.length
      ? {
          count: failures.length,
          last: failures[failures.length - 1].at,
          reason: failures[failures.length - 1].reason,
          // Historical unless the index is still unwritable.
          resolved: storage.ok
        }
      : null,
    orphans,
    canRebuild: Boolean(targetNamespace(account.dir))
  }
}

async function scan (accounts, backupRoot) {
  const transcripts = transcriptIndex()
  const out = []
  for (const a of accounts) {
    const base = scanAccount(a, transcripts)
    out.push({ id: a.id, name: a.name, ...base, backups: await backupSummary(a, backupRoot) })
  }
  return { accounts: out, transcriptCount: transcripts.size }
}

// ------------------------------------------------------------------ rebuild ---

/**
 * Recreate a missing index entry so the session reappears in Claude's list.
 *
 * titleSource MUST be "user". The app clears any title whose source is not
 * "user" when it loads the entry — a rebuilt session would come back untitled.
 */
function rebuild (account, orphan) {
  const ns = targetNamespace(account.dir)
  if (!ns) return { error: 'This profile has no session index yet. Open the account in Claude once, then try again.' }

  const dest = path.join(ns.dir, `${orphan.localId}.json`)
  if (fs.existsSync(dest)) return { error: 'An entry for that session already exists.' }

  const entry = {
    sessionId: orphan.localId,
    cliSessionId: orphan.cliSessionId,
    cwd: orphan.cwd || os.homedir(),
    originCwd: orphan.cwd || os.homedir(),
    lastFocusedAt: Math.round(orphan.lastActivityAt),
    createdAt: Math.round(orphan.createdAt),
    lastActivityAt: Math.round(orphan.lastActivityAt),
    model: orphan.model || 'claude-opus-5',
    effort: 'high',
    isArchived: false,
    title: orphan.title,
    titleSource: 'user',
    permissionMode: 'auto',
    remoteMcpServersConfig: [],
    chromePermissionMode: 'skip_all_permission_checks',
    completedTurns: 0,
    alwaysAllowedReasons: [],
    sessionPermissionUpdates: [],
    classifierSummaryEnabled: true,
    spawnSeed: {}
  }

  fs.mkdirSync(ns.dir, { recursive: true })
  fs.writeFileSync(dest, JSON.stringify(entry, null, 2))
  return { ok: true, file: dest }
}

module.exports = { scan, rebuild, backupIndex, PROJECTS }
