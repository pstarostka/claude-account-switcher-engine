'use strict'

// macOS plumbing: the things that need the shell or LaunchServices rather than
// an Electron API. Its counterpart is ./win.js — see ./index.js for the rule
// about what belongs here.
//
// Nothing in this file may touch the filesystem, read the environment or reach
// into Electron at require time. It has to be loadable on Windows for the
// contract test to compare the two, so all of that happens inside the functions.

const path = require('node:path')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const { execFile, spawn } = require('node:child_process')

function run (cmd, args, timeout = 8000) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: stdout || '', err: stderr || '' }))
  })
}

const runp = (cmd, args) => new Promise((resolve, reject) =>
  execFile(cmd, args, { maxBuffer: 1 << 20 }, (err, out) => (err ? reject(err) : resolve(String(out)))))

/**
 * Quote a string for /bin/sh. Single quotes are the only ones sh does nothing
 * inside, so the single quote itself is the one character needing care —
 * JSON.stringify looks close enough to be tempting here and is not: it leaves
 * `$` and backticks alone, which a double-quoted shell string still expands.
 */
const sq = s => `'${String(s).replace(/'/g, "'\\''")}'`

// ------------------------------------------------------------------ claude ---

const CLAUDE_APP = '/Applications/Claude.app'

const claudeInstalled = () => fs.existsSync(CLAUDE_APP)

const claudeHint = () => 'Claude is not installed in /Applications — accounts cannot be launched.'

/**
 * Open Claude on a profile.
 *
 * `-n` is what gets a second instance out of a bundle that would otherwise just
 * front the first, and `--env` is the only way to hand a launched .app an
 * environment — macOS gives a GUI app the login session's, not this process's.
 */
async function launchClaude (dir, isDefault) {
  const args = ['-n', '-a', 'Claude']
  if (!isDefault) args.push('--env', `CLAUDE_USER_DATA_DIR=${dir}`)
  const { ok } = await run('/usr/bin/open', args, 15000)
  return { ok }
}

/**
 * Front the instance already holding a profile. macOS cannot raise one instance
 * of a bundle, so this fronts whichever Claude the window server picks — hence
 * the ignored argument, which win.js does use.
 */
async function activateProfile (dir) {
  await run('/usr/bin/osascript', ['-e', 'tell application "Claude" to activate'])
  return { ok: true }
}

// ---------------------------------------------------------------- processes ---

const PROBES = ['Cookies', 'Local Storage/leveldb/LOCK', 'Network Persistent State']
const MAIN_BINARY = /Claude\.app\/Contents\/MacOS\/Claude$/

const probeFiles = dir => PROBES.map(p => path.join(dir, p)).filter(f => fs.existsSync(f))

// macOS hides process environments, so there is no way to ask a running Claude
// which profile it uses. The profile's own open files are the reliable signal.
async function isRunning (dir) {
  const probes = probeFiles(dir)
  if (!probes.length) return false
  // Probe in parallel: lsof is the slowest thing this app does.
  const results = await Promise.all(probes.map(f => run('/usr/sbin/lsof', ['--', f], 2500)))
  return results.some(r => r.ok)
}

/**
 * The Claude process holding a given profile directory. Helper processes turn up
 * too, so the list is filtered down to the main binary; ending that takes its
 * helpers with it.
 */
async function pidsForProfile (dir) {
  const found = new Set()
  for (const f of probeFiles(dir)) {
    const { ok, out } = await run('/usr/sbin/lsof', ['-t', '--', f], 4000)
    if (!ok) continue
    for (const line of out.split('\n')) {
      const pid = parseInt(line.trim(), 10)
      if (pid) found.add(pid)
    }
  }
  if (!found.size) return []

  const { out } = await run('/bin/ps', ['-o', 'pid=,command=', '-p', [...found].join(',')])
  return out.split('\n')
    .map(l => l.trim().match(/^(\d+)\s+(.*)$/))
    .filter(m => m && MAIN_BINARY.test(m[2]))
    .map(m => Number(m[1]))
}

/** Ask one Claude instance to quit, leaving any other account running. */
async function quitProfile (dir) {
  const pids = await pidsForProfile(dir)
  if (!pids.length) return { ok: false, error: 'Could not find the process for that account.' }
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM') } catch {}
  }
  return { ok: true, count: pids.length }
}

// ---------------------------------------------------------------- shortcut ---

/** This launcher's .app bundle, derived from the running executable. */
function installPath () {
  // …/CASE.app/Contents/MacOS/CASE → …/CASE.app
  return path.resolve(process.execPath, '..', '..', '..')
}

const installLooksSane = p => p.endsWith('.app')

async function isPinned () {
  const app = installPath()
  const { ok, out } = await run('/usr/bin/defaults', ['read', 'com.apple.dock', 'persistent-apps'])
  if (!ok) return false

  // The Dock rewrites entries percent-encoded ("Claude%20Accounts.app"), so a
  // literal path never matches what it stored. Decode before comparing.
  for (const m of out.matchAll(/"_CFURLString"\s*=\s*"([^"]+)"/g)) {
    let url = m[1]
    try { url = decodeURIComponent(url) } catch {}
    if (url.replace(/^file:\/\//, '').replace(/\/$/, '') === app) return true
  }
  return false
}

async function shortcutStatus () {
  return {
    supported: true,
    present: await isPinned(),
    blurb: 'Keep this in your Dock so an account is always one click away.',
    cta: 'Keep in Dock',
    tip: 'Add to the Dock permanently (restarts the Dock)'
  }
}

/**
 * Add the launcher to the Dock permanently. The Dock only re-reads its
 * preferences on restart, so `killall Dock` is part of the operation, not an
 * optional extra — without it the tile does not appear until the next login.
 */
async function shortcutCreate () {
  if (await isPinned()) return { ok: true, already: true }

  const app = installPath()
  const tile = '<dict><key>tile-data</key><dict><key>file-data</key><dict>' +
    `<key>_CFURLString</key><string>file://${encodeURI(app)}/</string>` +
    '<key>_CFURLStringType</key><integer>15</integer>' +
    '</dict></dict><key>tile-type</key><string>file-tile</string></dict>'

  const w = await run('/usr/bin/defaults', ['write', 'com.apple.dock', 'persistent-apps', '-array-add', tile])
  if (!w.ok) return { ok: false, error: 'Could not write Dock preferences.' }

  await run('/usr/bin/killall', ['Dock'])
  // The Dock takes a moment to come back and rewrite its plist.
  await new Promise(r => setTimeout(r, 1500))
  return { ok: await isPinned(), already: false }
}

// ------------------------------------------------------------- self-update ---

/**
 * `ditto`, not `unzip`: the bundle contains symlinks inside its framework and
 * signature metadata beside them, and only ditto puts both back as they were —
 * which is also what tools/build.js used to make the archive.
 */
async function unpack (zip, dest) {
  await fsp.mkdir(dest, { recursive: true })
  await runp('/usr/bin/ditto', ['-x', '-k', zip, dest])
}

/** The app inside an unpacked download, refused unless it is recognisably ours. */
async function findFresh (unpacked) {
  const entries = await fsp.readdir(unpacked)
  const name = entries.find(n => n.endsWith('.app'))
  if (!name) return { error: 'The download did not contain an app.' }
  const fresh = path.join(unpacked, name)

  try {
    const plist = await fsp.readFile(path.join(fresh, 'Contents', 'Info.plist'), 'utf8')
    if (!plist.includes('local.launcher.case')) {
      return { error: 'The download is not CASE, so it was not installed.' }
    }
  } catch {
    return { error: 'The download does not look like a macOS app bundle.' }
  }
  return { path: fresh }
}

/**
 * Replace the bundle and relaunch. This cannot happen in-process — the code
 * doing it lives inside the bundle being replaced — so it is handed to a
 * detached shell script that waits for this process to exit first. The old
 * bundle is moved aside rather than deleted, and moved back if the copy fails,
 * so a failure here leaves a working app rather than none.
 */
async function swapAndRelaunch ({ dest, fresh, stage, pid }) {
  const script = path.join(stage, 'swap.sh')
  await fsp.writeFile(script, `#!/bin/sh
# Wait for CASE to exit before touching its own bundle.
for i in $(seq 1 200); do
  kill -0 ${pid} 2>/dev/null || break
  sleep 0.1
done

DEST=${sq(dest)}
FRESH=${sq(fresh)}
STAGE=${sq(stage)}

rm -rf "$DEST.old"
mv "$DEST" "$DEST.old" || exit 1
if ! cp -R "$FRESH" "$DEST"; then
  rm -rf "$DEST"
  mv "$DEST.old" "$DEST"
  exit 1
fi
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null
rm -rf "$DEST.old"
open "$DEST"
rm -rf "$STAGE"
`, { mode: 0o755 })

  spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' }).unref()
}

/** Which of the release's assets this build can install. */
const ASSET_RE = /-mac-/i

// -------------------------------------------------------------------- misc ---

function setBadge (win, n) {
  const { app } = require('electron')
  if (app.dock) app.dock.setBadge(n ? String(n) : '')
}

/** Disk usage in bytes. `du` beats walking the tree: 8 GB measured in ~110 ms. */
function profileSize (dir) {
  return new Promise(resolve => {
    if (!fs.existsSync(dir)) return resolve(null)
    execFile('/usr/bin/du', ['-sk', dir], { timeout: 20000 }, (err, stdout) => {
      if (err) return resolve(null)
      const kb = Number(String(stdout).trim().split(/\s+/)[0])
      resolve(Number.isFinite(kb) ? kb * 1024 : null)
    })
  })
}

async function trayImage () {
  const { nativeImage } = require('electron')
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'trayTemplate.png'))
  // Template images are recoloured by macOS to suit the menu bar, including
  // when it inverts for dark mode or a highlighted menu. Nothing to re-read on a
  // theme change, which is why forgetTheme has nothing to do here.
  img.setTemplateImage(true)
  return img
}

/** Drop any cached theme. macOS recolours the template itself; Windows does not. */
function forgetTheme () {}

const chrome = {
  installed: () => fs.existsSync('/Applications/Google Chrome.app'),
  root: () => path.join(require('node:os').homedir(), 'Library', 'Application Support', 'Google', 'Chrome'),
  /** Open a Chrome window on a profile. Creates the profile if it does not exist. */
  launch: (profileDir, url = null) => {
    const args = ['-na', 'Google Chrome', '--args', `--profile-directory=${profileDir}`]
    if (url) args.push(url)
    return run('/usr/bin/open', args, 15000).then(({ ok }) => ({ ok }))
  }
}

const QUIT_ACCEL = 'Command+Q'
const DEFAULT_HOTKEY = 'Alt+Command+C'

/** Extra options for app.setLoginItemSettings, and for reading it back. */
const loginItemOptions = () => ({ openAsHidden: true, args: ['--hidden'] })

module.exports = {
  claudeInstalled,
  claudeHint,
  launchClaude,
  activateProfile,
  isRunning,
  quitProfile,
  shortcutStatus,
  shortcutCreate,
  installPath,
  installLooksSane,
  unpack,
  findFresh,
  swapAndRelaunch,
  ASSET_RE,
  setBadge,
  profileSize,
  trayImage,
  forgetTheme,
  chrome,
  QUIT_ACCEL,
  DEFAULT_HOTKEY,
  loginItemOptions,
  sq
}
