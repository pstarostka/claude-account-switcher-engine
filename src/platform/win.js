'use strict'

// Windows plumbing, the counterpart to ./mac.js. Same keys, same meanings; see
// ./index.js for the rule about what belongs here.
//
// Nothing in this file may touch the filesystem, read the environment or reach
// into Electron at require time — it has to be loadable on a Mac for the
// contract test to compare the two, so all of that happens inside the functions.
//
// Every helper spawned here passes windowsHide. The main process is a GUI-
// subsystem binary, so a console child without it flashes a black window.

const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const { execFile, spawn } = require('node:child_process')

function run (cmd, args, timeout = 8000) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: stdout || '', err: stderr || '' }))
  })
}

const runp = (cmd, args) => new Promise((resolve, reject) =>
  execFile(cmd, args, { maxBuffer: 1 << 20, windowsHide: true },
    (err, out) => (err ? reject(err) : resolve(String(out)))))

const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * Quote a string for PowerShell. Single quotes are the only ones PowerShell does
 * nothing inside, and the single quote itself escapes by doubling — so unlike
 * sh, there is no backslash involved.
 */
const pq = s => `'${String(s).replace(/'/g, "''")}'`

const localAppData = () => process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
const appData = () => process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
const system32 = file => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', file)

// ------------------------------------------------------------------ claude ---

const CLAUDE_ROOT = () => path.join(localAppData(), 'AnthropicClaude')

const readdirSafe = dir => { try { return fs.readdirSync(dir) } catch { return [] } }

function cmpParts (a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0)
    if (d) return d
  }
  return 0
}

/**
 * The highest-versioned `app-<version>` directory in a Squirrel install.
 *
 * Squirrel keeps every version it has installed side by side and only the newest
 * is current. Picking that by sorting the names as text is wrong the first time
 * a minor reaches 10 — `app-0.9.9` sorts after `app-0.10.0` — and the symptom
 * would be CASE quietly launching a stale Claude for ever.
 */
function newestAppDir (names) {
  return (names || [])
    .filter(n => /^app-\d/.test(n))
    .map(n => ({ n, v: n.slice(4).split('.').map(x => parseInt(x, 10) || 0) }))
    .sort((a, b) => cmpParts(b.v, a.v))[0]?.n || null
}

/**
 * Claude Desktop's executable, or null.
 *
 * The versioned payload rather than the stub at the root of the install: the
 * stub re-launches the real exe and exits immediately, so its pid is dead by the
 * time there is anything to record — and that pid is the only handle Windows
 * gives us on "which Claude is this account".
 */
function claudeExe () {
  const root = CLAUDE_ROOT()
  const dir = newestAppDir(readdirSafe(root))
  if (dir) {
    const exe = path.join(root, dir, 'claude.exe')
    if (fs.existsSync(exe)) return exe
  }
  // A stub-only install still launches; quitting one account degrades to the
  // "could not find the process" path, which is the honest answer there.
  const stub = path.join(root, 'claude.exe')
  return fs.existsSync(stub) ? stub : null
}

/**
 * Whether Claude is installed from the Microsoft Store.
 *
 * An MSIX package is activated through the app model, which builds the child's
 * environment itself — CLAUDE_USER_DATA_DIR would be dropped on the way, and
 * every account would silently open the same profile. Detecting it is what lets
 * CASE say so instead of appearing to work.
 */
function storeInstalled () {
  return readdirSafe(path.join(localAppData(), 'Packages')).some(n => /^Claude_/i.test(n))
}

const claudeInstalled = () => Boolean(claudeExe())

const claudeHint = () => storeInstalled()
  ? 'Claude is installed from the Microsoft Store, which cannot be opened with a separate profile. Install the standalone download from claude.ai/download.'
  : 'Claude Desktop is not installed — accounts cannot be launched.'

// -------------------------------------------------------- launch and quit ---

// Written by CASE when it starts Claude, and the only way back from a profile to
// a process id: Windows will not hand out another process's environment, so
// there is nothing to match a running claude.exe against. It lives in the
// profile, so archiving or restoring one carries its own record along.
const PID_FILE = 'case-instance.json'

function writePid (dir, pid, exe) {
  try {
    fs.writeFileSync(path.join(dir, PID_FILE), JSON.stringify({ pid, at: Date.now(), dir, exe }, null, 2))
  } catch {}
}

function readPid (dir) {
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(dir, PID_FILE), 'utf8'))
    return Number.isInteger(rec.pid) ? rec.pid : null
  } catch { return null }
}

let pidCache = { at: 0, pids: null }

/**
 * Every live claude.exe, memoised for a second. The status poll asks once per
 * account every 2.5 s, so without this a five-account list is five spawns a tick.
 */
async function livePids () {
  const now = Date.now()
  if (pidCache.pids && now - pidCache.at < 1000) return pidCache.pids

  const { ok, out } = await run(system32('tasklist.exe'),
    ['/FI', 'IMAGENAME eq claude.exe', '/FO', 'CSV', '/NH'], 4000)

  const pids = new Set()
  if (ok) {
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^"[^"]*","(\d+)"/)
      if (m) pids.add(Number(m[1]))
    }
  }
  pidCache = { at: now, pids }
  return pids
}

/** Uncached, for the quit loop — a one-second-stale answer there reads as a hang. */
async function pidLive (pid) {
  const { ok, out } = await run(system32('tasklist.exe'),
    ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], 4000)
  return ok && new RegExp(`","${pid}","`).test(out)
}

/** The recorded pid for a profile, if that process is still alive. */
async function livePidFor (dir) {
  const pid = readPid(dir)
  if (!pid) return null
  return (await livePids()).has(pid) ? pid : null
}

const LOCKS = [
  path.join('Local Storage', 'leveldb', 'LOCK'),
  path.join('Session Storage', 'LOCK')
]

/**
 * Whether anything holds the profile's leveldb locks.
 *
 * leveldb opens LOCK with no sharing, so a competing open comes back
 * ERROR_SHARING_VIOLATION — which Node reports as EBUSY or EPERM. That is the
 * one exclusive marker in a Chromium profile: Cookies is SQLite and is opened
 * shared, so probing it would call a running profile idle.
 */
function lockBusy (dir) {
  for (const rel of LOCKS) {
    const f = path.join(dir, rel)
    if (!fs.existsSync(f)) continue
    let fd
    try {
      fd = fs.openSync(f, 'r')
    } catch (e) {
      if (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES') return true
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd) } catch {} }
    }
  }
  return false
}

/**
 * The lock answers for any instance, including ones CASE did not start; the
 * recorded pid covers the seconds between spawning Claude and leveldb opening,
 * when the profile is claimed but nothing is locked yet.
 */
async function isRunning (dir) {
  if (lockBusy(dir)) return true
  return Boolean(await livePidFor(dir))
}

async function launchClaude (dir, isDefault) {
  const exe = claudeExe()
  if (!exe) return { ok: false, error: claudeHint() }

  const env = { ...process.env }
  // Deleted rather than merely not set. Claude's own test is
  // `if (process.env.CLAUDE_USER_DATA_DIR)`, so a value inherited from whatever
  // started CASE would send every default-profile launch into another account.
  if (isDefault) delete env.CLAUDE_USER_DATA_DIR
  else env.CLAUDE_USER_DATA_DIR = dir

  let child
  try {
    child = spawn(exe, [], {
      env,
      detached: true,          // outlives CASE, which is the point of a launcher
      stdio: 'ignore',
      windowsHide: true,
      cwd: path.dirname(exe)
    })
  } catch (e) {
    return { ok: false, error: `Could not start Claude: ${e.message}` }
  }
  child.unref()
  if (!child.pid) return { ok: false, error: 'Claude did not start.' }

  writePid(dir, child.pid, exe)
  return { ok: true, pid: child.pid }
}

async function activateProfile (dir) {
  const pid = await livePidFor(dir)
  if (!pid) return { ok: false }
  // Windows' foreground lock may turn this into a flashing taskbar button rather
  // than a raised window. That is the OS deciding, not a failure to report.
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `(New-Object -ComObject WScript.Shell).AppActivate(${pid})`], 8000)
  return { ok: true }
}

/** Ask one Claude instance to quit, leaving any other account running. */
async function quitProfile (dir) {
  const pid = await livePidFor(dir)
  if (!pid) return { ok: false, error: 'Could not find the process for that account.' }

  // /T without /F posts WM_CLOSE through the tree, so Electron raises its close
  // event and Claude saves on the way out. Force is the escalation, not the plan.
  await run(system32('taskkill.exe'), ['/PID', String(pid), '/T'], 8000)
  for (let i = 0; i < 25 && await pidLive(pid); i++) await sleep(200)
  if (await pidLive(pid)) {
    await run(system32('taskkill.exe'), ['/PID', String(pid), '/T', '/F'], 8000)
  }
  return { ok: true, count: 1 }
}

// ---------------------------------------------------------------- shortcut ---

const startMenuLink = () =>
  path.join(appData(), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'CASE.lnk')

async function shortcutStatus () {
  return {
    supported: true,
    present: fs.existsSync(startMenuLink()),
    blurb: 'Add CASE to your Start menu so an account is always one click away.',
    cta: 'Add to Start menu',
    tip: 'Creates a Start menu shortcut, which is also what lets Windows show notifications'
  }
}

/**
 * Windows has not allowed an app to pin itself to the taskbar since 8.1, so the
 * Start menu is the equivalent gesture. The shortcut carries the AppUserModelID,
 * and that is not decoration: Windows drops every toast from an app it cannot
 * tie to a shortcut, silently, while Notification.isSupported() still says yes.
 */
async function shortcutCreate () {
  const { shell } = require('electron')
  const link = startMenuLink()
  if (fs.existsSync(link)) return { ok: true, already: true }
  try {
    await fsp.mkdir(path.dirname(link), { recursive: true })
    const ok = shell.writeShortcutLink(link, 'create', {
      target: process.execPath,
      cwd: path.dirname(process.execPath),
      description: 'CASE — Claude Account Switcher Engine',
      appUserModelId: 'local.launcher.case'
    })
    return ok ? { ok: true, already: false } : { ok: false, error: 'Could not create the shortcut.' }
  } catch (e) {
    return { ok: false, error: `Could not create the shortcut: ${e.message}` }
  }
}

// ------------------------------------------------------------- self-update ---

const installPath = () => path.dirname(process.execPath)

const installLooksSane = p =>
  fs.existsSync(path.join(p, 'CASE.exe')) && fs.existsSync(path.join(p, 'resources', 'app.asar'))

/**
 * bsdtar has shipped in Windows since 1803 and reads zips. Expand-Archive is the
 * obvious alternative and spends most of a 200 MB extraction drawing a progress
 * bar at a console nobody is looking at.
 */
async function unpack (zip, dest) {
  await fsp.mkdir(dest, { recursive: true })
  await runp(system32('tar.exe'), ['-xf', zip, '-C', dest])
}

/**
 * package.json out of an asar, which is the Windows analogue of reading a
 * bundle's Info.plist — the archive's own record of what it is.
 *
 * The format is two Chromium pickles back to back: [u32 4][u32 headerSize], then
 * [u32 payload][u32 jsonLength][json]. File offsets in that JSON are relative to
 * the end of the second pickle.
 */
function asarPackageJson (asar) {
  const fd = fs.openSync(asar, 'r')
  try {
    const head = Buffer.alloc(16)
    if (fs.readSync(fd, head, 0, 16, 0) < 16) throw new Error('truncated')
    const headerSize = head.readUInt32LE(4)
    const jsonLen = head.readUInt32LE(12)
    if (jsonLen > headerSize) throw new Error('bad header')

    const json = Buffer.alloc(jsonLen)
    fs.readSync(fd, json, 0, jsonLen, 16)
    const entry = JSON.parse(json.toString('utf8')).files?.['package.json']
    if (!entry) throw new Error('no package.json')

    const body = Buffer.alloc(Number(entry.size))
    fs.readSync(fd, body, 0, body.length, 8 + headerSize + Number(entry.offset))
    return JSON.parse(body.toString('utf8'))
  } finally {
    fs.closeSync(fd)
  }
}

/** The app inside an unpacked download, refused unless it is recognisably ours. */
async function findFresh (unpacked) {
  const entries = await fsp.readdir(unpacked, { withFileTypes: true })
  const dir = entries
    .filter(e => e.isDirectory())
    .map(e => path.join(unpacked, e.name))
    .find(d => fs.existsSync(path.join(d, 'CASE.exe')))
  if (!dir) return { error: 'The download did not contain an app.' }

  try {
    if (asarPackageJson(path.join(dir, 'resources', 'app.asar')).name !== 'case') {
      return { error: 'The download is not CASE, so it was not installed.' }
    }
  } catch {
    return { error: 'The download does not look like a Windows build of CASE.' }
  }
  return { path: dir }
}

/**
 * Replace the install and relaunch. This cannot happen in-process — the code
 * doing it is inside the folder being replaced — so it is handed to a detached
 * PowerShell script that waits for this process to exit first.
 *
 * The install is moved aside rather than mirrored over: /MIR onto a live folder
 * has no way back, and a failure half-way would leave a mixture of two versions.
 * A rename on the same volume is instantaneous, and gives the same rollback the
 * macOS script has.
 */
async function swapAndRelaunch ({ dest, fresh, stage, pid }) {
  // Not inside `stage`: the shell keeps a handle on the script it is running,
  // and the script's last act is to delete `stage`. On macOS unlinking an open
  // file is fine, so swap.sh can live there; on Windows it is not.
  const own = await fsp.mkdtemp(path.join(os.tmpdir(), 'case-swap-'))
  const script = path.join(own, 'swap.ps1')

  await fsp.writeFile(script, `$ErrorActionPreference = 'Stop'

# Wait for CASE to exit before replacing its own folder.
Wait-Process -Id ${pid} -Timeout 60 -ErrorAction SilentlyContinue

$DEST  = ${pq(dest)}
$OLD   = ${pq(dest + '.old')}
$FRESH = ${pq(fresh)}
$STAGE = ${pq(stage)}
$OWN   = ${pq(own)}

Remove-Item -LiteralPath $OLD -Recurse -Force -ErrorAction SilentlyContinue
Move-Item -LiteralPath $DEST -Destination $OLD

# robocopy reports success with a non-zero code (1 means "files were copied"),
# so the exit code is read rather than trusted to mean failure. Anything under 8
# is a success of some kind; 8 and above is the first real error.
robocopy $FRESH $DEST /MIR /NFL /NDL /NJH /NJS /NP /R:2 /W:1 | Out-Null
if ($LASTEXITCODE -ge 8) {
  Remove-Item -LiteralPath $DEST -Recurse -Force -ErrorAction SilentlyContinue
  Move-Item -LiteralPath $OLD -Destination $DEST
  exit 1
}

Remove-Item -LiteralPath $OLD -Recurse -Force -ErrorAction SilentlyContinue
Start-Process -FilePath (Join-Path $DEST 'CASE.exe')
Remove-Item -LiteralPath $STAGE -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $OWN -Recurse -Force -ErrorAction SilentlyContinue
`, 'utf8')

  // powershell.exe, not pwsh: Windows PowerShell is always present, and it does
  // not turn robocopy's non-zero success codes into thrown errors the way
  // PowerShell 7.4 does. cwd must be outside DEST, or the move fails on the
  // shell's own handle.
  spawn('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
    { detached: true, stdio: 'ignore', windowsHide: true, cwd: os.tmpdir() }).unref()
}

/** Which of the release's assets this build can install. */
const ASSET_RE = /-win-/i

// -------------------------------------------------------------------- misc ---

let badgeImg

/**
 * app.dock.setBadge has no Windows equivalent; an overlay on the taskbar button
 * is the gesture. The number does not survive 16 px, so the dot says "something",
 * and the tray menu's "Session health (n)" carries the count.
 */
function setBadge (win, n) {
  if (!win || win.isDestroyed()) return
  if (!n) return win.setOverlayIcon(null, '')

  if (badgeImg === undefined) {
    const { nativeImage } = require('electron')
    const img = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'badge.png'))
    badgeImg = img.isEmpty() ? null : img
  }
  if (badgeImg) win.setOverlayIcon(badgeImg, `${n} session issue${n === 1 ? '' : 's'}`)
}

/**
 * Disk usage in bytes.
 *
 * Windows has no `du`. robocopy walks fastest but prints a summary table with
 * localised row labels, so parsing it breaks on a non-English install — which is
 * not a thing to find out from a bug report. Walking the tree here is a few
 * seconds against `du`'s ~110 ms, which is why the caller fills this figure in
 * rather than waiting on it.
 */
async function profileSize (dir) {
  if (!fs.existsSync(dir)) return null
  let entries
  try {
    entries = await fsp.readdir(dir, { recursive: true, withFileTypes: true })
  } catch { return null }

  const files = entries.filter(e => e.isFile())
  let total = 0
  // Batched rather than one await per file: a Chromium profile is tens of
  // thousands of them, and the round trips dominate everything else.
  for (let i = 0; i < files.length; i += 500) {
    const sizes = await Promise.all(files.slice(i, i + 500).map(async e => {
      try { return (await fsp.stat(path.join(e.parentPath ?? e.path, e.name))).size } catch { return 0 }
    }))
    for (const s of sizes) total += s
  }
  return total
}

let systemLight

/**
 * Whether the taskbar is light. This is not the same setting as the app theme —
 * Windows 11 ships light apps over a dark taskbar by default, so trusting
 * nativeTheme here would put a black icon on a black background for most people.
 */
async function taskbarIsLight () {
  if (systemLight !== undefined) return systemLight
  const { ok, out } = await run(system32('reg.exe'), ['query',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize',
    '/v', 'SystemUsesLightTheme'], 4000)
  const m = ok && out.match(/SystemUsesLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)/i)
  systemLight = m ? parseInt(m[1], 16) === 1 : false
  return systemLight
}

/** Forget the cached taskbar theme, so the next tray build re-reads it. */
function forgetTheme () { systemLight = undefined }

async function trayImage () {
  const { nativeImage } = require('electron')
  // A light taskbar needs the dark glyph, and the other way round.
  const file = await taskbarIsLight() ? 'tray-win.ico' : 'tray-win-dark.ico'
  return nativeImage.createFromPath(path.join(__dirname, '..', 'assets', file))
}

function chromeExe () {
  const candidates = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    localAppData()
  ].filter(Boolean).map(root => path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  return candidates.find(p => fs.existsSync(p)) || null
}

const chrome = {
  installed: () => Boolean(chromeExe()),
  root: () => path.join(localAppData(), 'Google', 'Chrome', 'User Data'),
  /** Open a Chrome window on a profile. Creates the profile if it does not exist. */
  launch: async (profileDir, url = null) => {
    const exe = chromeExe()
    if (!exe) return { ok: false }
    // No `open -n` equivalent is needed: Chrome routes by profile itself, and a
    // second launch on a profile already open just raises its window.
    const args = [`--profile-directory=${profileDir}`]
    if (url) args.push(url)
    try {
      spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
      return { ok: true }
    } catch {
      return { ok: false }
    }
  }
}

const QUIT_ACCEL = 'Ctrl+Q'

// Not Ctrl+Alt+C: on Polish and most other European layouts AltGr *is* Ctrl+Alt,
// so that combination would swallow a character people type.
const DEFAULT_HOTKEY = 'Alt+Shift+C'

// openAsHidden is macOS-only. Windows matches its Run key entry on path and
// args, so the same object has to be handed to the read as well as the write or
// it always reports back as off.
const loginItemOptions = () => ({ path: process.execPath, args: ['--hidden'] })

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
  newestAppDir,
  asarPackageJson,
  pq
}
