'use strict'

const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, Notification, globalShortcut } = require('electron')
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const health = require('./health')
const usage = require('./usage')
const archive = require('./archive')
const update = require('./update')
const chrome = require('./chrome')
const macos = require('./macos')
const tray = require('./tray')

// Claude Desktop reads CLAUDE_USER_DATA_DIR at startup and calls
// app.setPath('userData', ...) with it, so a profile directory *is* an account.
// There is no single-instance lock in the bundle, so profiles run side by side.
const SUPPORT = app.getPath('appData')            // ~/Library/Application Support
const DEFAULT_PROFILE = path.join(SUPPORT, 'Claude')
// Electron's own userData directory — SUPPORT/<productName>. Asked for rather
// than spelled out, so renaming the app cannot silently move the config.
const CONF_DIR = app.getPath('userData')
const LEGACY_CONF_DIR = path.join(SUPPORT, 'Claude Accounts')
const CONF = path.join(CONF_DIR, 'accounts.json')
const LEGACY_TSV = path.join(CONF_DIR, 'accounts.tsv')
const BACKUP_ROOT = path.join(CONF_DIR, 'session-index-backups')

// Carry a pre-rename install across before anything reads it.
//
// The directory cannot be renamed into place: Electron creates its own userData
// before this file runs, so the destination always exists. What moves is the
// three things this app keeps there — never over something already present, so
// a half-finished migration cannot overwrite a working config on the next run.
if (!fs.existsSync(CONF)) {
  for (const name of ['accounts.json', 'accounts.tsv', 'session-index-backups']) {
    try {
      const from = path.join(LEGACY_CONF_DIR, name)
      const to = path.join(CONF_DIR, name)
      if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to)
    } catch {}
  }
}

let win = null

// macOS reports wasOpenedAtLogin; the --hidden arg covers the login-item case
// where that flag is not set.
let startHidden = process.argv.includes('--hidden')
let isQuitting = false

// ------------------------------------------------------------------ store ---

function readConfig () {
  try {
    const raw = JSON.parse(fs.readFileSync(CONF, 'utf8'))
    if (Array.isArray(raw.accounts)) return raw.accounts
  } catch {}

  // Migrate the v1 tab-separated file, preserving the names already chosen.
  try {
    const accounts = fs.readFileSync(LEGACY_TSV, 'utf8')
      .split('\n')
      .map(l => l.split('\t'))
      .filter(p => p.length >= 2 && p[0].trim() && !p[0].startsWith('#'))
      .map(([name, dir]) => ({ id: crypto.randomUUID(), name: name.trim(), dir: dir.trim() }))
    if (accounts.length) { writeConfig(accounts); return accounts }
  } catch {}

  return null
}

const DEFAULT_SETTINGS = {
  hotkey: 'Alt+Command+C',
  hotkeyEnabled: true,
  menuBar: true,
  hideDock: false,
  // Off by default: reordering the list also reorders ⌘1–9, and with two
  // accounts the order would flip on every switch.
  sortByRecent: false,
  // Checks only — nothing is ever downloaded or installed without being asked.
  autoUpdateCheck: true,
  lastUpdateCheck: 0
}

function readRaw () {
  try { return JSON.parse(fs.readFileSync(CONF, 'utf8')) } catch { return {} }
}

function readSettings () {
  return { ...DEFAULT_SETTINGS, ...(readRaw().settings || {}) }
}

function readArchived () {
  const raw = readRaw()
  return Array.isArray(raw.archived) ? raw.archived : []
}

function writeConfig (accounts, settings, archived) {
  fs.mkdirSync(CONF_DIR, { recursive: true })
  const raw = readRaw()
  const next = {
    version: 2,
    accounts: accounts || raw.accounts || [],
    settings: settings || raw.settings || DEFAULT_SETTINGS,
    // Carried explicitly: this writer replaces the file wholesale, so anything
    // not named here would be dropped on the next unrelated save.
    archived: archived || raw.archived || []
  }
  const tmp = `${CONF}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
  fs.renameSync(tmp, CONF)
}

/**
 * Recency order, when it is switched on. V8's sort is stable, so accounts that
 * have never been opened keep their configured order at the bottom.
 */
function sortAccounts (list) {
  if (!readSettings().sortByRecent) return list
  return [...list].sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0))
}

/** Config order and flags only — no probing, so it returns immediately. */
function storedList (accounts) {
  return sortAccounts(accounts).map(a => ({ ...a, isDefault: a.dir === DEFAULT_PROFILE }))
}

/** Stamp an account as just used. Activating a running one counts. */
function touchAccount (id) {
  const accounts = currentAccounts()
  const a = accounts.find(x => x.id === id)
  if (!a) return
  a.lastUsedAt = Date.now()
  writeConfig(accounts)
}

/** Profiles present on disk that the config does not know about yet. */
function discoverProfiles () {
  const found = []
  if (fs.existsSync(DEFAULT_PROFILE)) {
    found.push({ name: 'Main', dir: DEFAULT_PROFILE, isDefault: true })
  }
  let entries = []
  try { entries = fs.readdirSync(SUPPORT, { withFileTypes: true }) } catch {}
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith('Claude-')) continue
    // An archived profile is deliberately set aside; offering it back here
    // would undo the archive by accident.
    if (archive.isArchivePath(e.name)) continue
    found.push({ name: e.name.slice('Claude-'.length), dir: path.join(SUPPORT, e.name), isDefault: false })
  }
  return found
}

// ----------------------------------------------------------------- probing ---

function run (cmd, args, timeout = 4000) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout }, (err, stdout) =>
      resolve({ ok: !err, out: stdout || '' }))
  })
}

// macOS hides process environments, so there is no way to ask a running Claude
// which profile it uses. The profile's own open files are the reliable signal.
async function isRunning (dir) {
  const probes = ['Cookies', 'Local Storage/leveldb/LOCK', 'Network Persistent State']
    .map(p => path.join(dir, p))
    .filter(f => fs.existsSync(f))
  if (!probes.length) return false
  // Probe in parallel: lsof is the slowest thing this app does.
  const results = await Promise.all(probes.map(f => run('/usr/sbin/lsof', ['--', f], 2500)))
  return results.some(r => r.ok)
}

async function sessionCount (dir) {
  const root = path.join(dir, 'claude-code-sessions')
  let n = 0
  try {
    for (const acct of await fsp.readdir(root)) {
      for (const org of await fsp.readdir(path.join(root, acct))) {
        const files = await fsp.readdir(path.join(root, acct, org))
        n += files.filter(f => f.startsWith('local_') && f.endsWith('.json')).length
      }
    }
  } catch {}
  return n
}

async function decorate (accounts) {
  return Promise.all(accounts.map(async a => ({
    ...a,
    isDefault: a.dir === DEFAULT_PROFILE,
    exists: fs.existsSync(a.dir),
    running: await isRunning(a.dir),
    sessions: await sessionCount(a.dir),
    usage: usage.read(a.dir)
  })))
}

// ---------------------------------------------------------------- launching ---

async function launchAccount (account) {
  touchAccount(account.id)

  if (await isRunning(account.dir)) {
    // Two instances on one profile corrupt its LevelDB stores. macOS cannot
    // raise a specific instance of a bundle, so this fronts the current one.
    await run('/usr/bin/osascript', ['-e', 'tell application "Claude" to activate'])
    await openPairedChrome(account)
    return { ok: true, alreadyRunning: true }
  }

  // Snapshot the session index before handing control to Claude. This is the
  // cheap insurance against the failure mode health.js exists to catch.
  try { await health.backupIndex(account, BACKUP_ROOT) } catch {}

  fs.mkdirSync(account.dir, { recursive: true })

  const args = ['-n', '-a', 'Claude']
  if (account.dir !== DEFAULT_PROFILE) {
    args.push('--env', `CLAUDE_USER_DATA_DIR=${account.dir}`)
  }
  const { ok } = await run('/usr/bin/open', args, 15000)
  await openPairedChrome(account)
  return { ok, alreadyRunning: false }
}

/** Bring the account's browser context along, if one is paired and enabled. */
async function openPairedChrome (account) {
  const c = account.chrome
  if (!c || !c.dir || c.openOnLaunch === false) return
  try { await chrome.launch(c.dir) } catch {}
}

function slug (name) {
  const s = name.normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return (s || 'account').slice(0, 40)
}

function uniqueDir (name) {
  const base = path.join(SUPPORT, `Claude-${slug(name)}`)
  let dir = base
  for (let i = 2; fs.existsSync(dir); i++) dir = `${base}-${i}`
  return dir
}

/** A name not already taken, for restoring an archive alongside a namesake. */
function freeName (name, accounts) {
  const taken = new Set(accounts.map(a => a.name.toLowerCase()))
  if (!taken.has(String(name).toLowerCase())) return name
  for (let i = 2; ; i++) {
    const candidate = `${name} ${i}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

/** Decimal units, to match what Finder reports for the same folder. */
function fmtBytes (bytes) {
  if (!Number.isFinite(bytes)) return 'an unknown amount'
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB']
  let n = bytes
  let i = 0
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++ }
  return `${i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`
}

// --------------------------------------------------------------------- IPC ---

function currentAccounts () { return readConfig() || [] }

/** Re-fit the window after the account count changes, so the list never scrolls. */
function fitWindow () {
  if (!win || win.isDestroyed()) return
  const [w] = win.getSize()
  win.setSize(w, preferredHeight(), true)
}

// Fast path: config only, no probing. The window must paint immediately.
ipcMain.handle('accounts:list', async () => {
  const stored = readConfig()
  if (stored === null) {
    // First run: nothing configured. Offer what is already on disk.
    return { needsSetup: true, discovered: discoverProfiles(), accounts: [] }
  }
  return {
    needsSetup: false,
    discovered: [],
    accounts: sortAccounts(stored).map(a => ({ ...a, isDefault: a.dir === DEFAULT_PROFILE })),
    chromeProfiles: chrome.listProfiles(),
    archived: archive.withStatus(readArchived())
  }
})

// Slow path: lsof and session counts, folded in once they resolve.
ipcMain.handle('accounts:status', async () => {
  const stored = readConfig() || []
  const decorated = await decorate(stored)
  return decorated.map(({ id, running, sessions, exists, usage }) => ({ id, running, sessions, exists, usage }))
})

ipcMain.handle('accounts:adopt', async (_e, picked) => {
  const accounts = picked.map(p => ({ id: crypto.randomUUID(), name: p.name, dir: p.dir }))
  writeConfig(accounts)
  fitWindow()
  return decorate(accounts)
})

ipcMain.handle('accounts:add', async (_e, name) => {
  const accounts = currentAccounts()
  name = (name || '').trim()
  if (!name) return { error: 'Name cannot be empty.' }
  if (accounts.some(a => a.name.toLowerCase() === name.toLowerCase())) {
    return { error: 'An account with that name already exists.' }
  }
  const dir = uniqueDir(name)
  fs.mkdirSync(dir, { recursive: true })
  accounts.push({ id: crypto.randomUUID(), name, dir })
  writeConfig(accounts)
  fitWindow()
  tray.refresh()
  return { accounts: sortAccounts(await decorate(accounts)) }
})

// Name, emoji and colour move together, because they are edited together.
// Each field is optional; only what is present is touched.
ipcMain.handle('accounts:update', async (_e, { id, name, emoji, hue }) => {
  const accounts = currentAccounts()
  const a = accounts.find(x => x.id === id)
  if (!a) return { error: 'Account not found.' }

  if (name !== undefined) {
    name = (name || '').trim()
    if (!name) return { error: 'Name cannot be empty.' }
    if (accounts.some(x => x.id !== id && x.name.toLowerCase() === name.toLowerCase())) {
      return { error: 'An account with that name already exists.' }
    }
    a.name = name
  }

  if (emoji !== undefined) {
    // Bounded rather than validated against a list: a ZWJ sequence is many code
    // points, and there is no reason to refuse one the picker does not offer.
    const e = String(emoji || '').trim().slice(0, 16)
    if (e) a.emoji = e
    else delete a.emoji
  }

  if (hue !== undefined) {
    // null is "derive it from the name" and must not survive Number(), which
    // would quietly turn it into hue 0 — red.
    const h = hue === null ? NaN : Number(hue)
    if (Number.isFinite(h)) a.hue = ((Math.round(h) % 360) + 360) % 360
    else delete a.hue
  }

  writeConfig(accounts)
  tray.refresh()
  // Deliberately not decorate(): its lsof probes would put two seconds between
  // pressing Save and seeing the new name. The renderer keeps the status it has.
  return { accounts: storedList(accounts) }
})

ipcMain.handle('accounts:remove', async (_e, { id, deleteData }) => {
  const accounts = currentAccounts()
  const a = accounts.find(x => x.id === id)
  if (!a) return { error: 'Account not found.' }

  if (deleteData) {
    if (a.dir === DEFAULT_PROFILE) {
      return { error: 'The default profile is Claude’s own data directory and cannot be deleted.' }
    }
    if (await isRunning(a.dir)) {
      return { error: 'That account is open. Quit it first, then try again.' }
    }
    const sessions = await sessionCount(a.dir)
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Cancel', 'Delete Permanently'],
      defaultId: 0,
      cancelId: 0,
      message: `Delete “${a.name}” and all of its data?`,
      detail:
        `This erases the profile directory and everything in it, including ` +
        `${sessions} saved session${sessions === 1 ? '' : 's'} and the signed-in account.\n\n` +
        `Your ~/.claude data — skills, plugins, settings and transcripts — is not affected.\n\n${a.dir}`
    })
    if (response !== 1) return { cancelled: true }
    await fsp.rm(a.dir, { recursive: true, force: true })
  }

  const next = accounts.filter(x => x.id !== id)
  writeConfig(next)
  fitWindow()
  tray.refresh()
  return { accounts: sortAccounts(await decorate(next)) }
})

// ------------------------------------------------------------- lifecycle ---

ipcMain.handle('accounts:size', async (_e, id) => {
  const a = currentAccounts().find(x => x.id === id)
  return { bytes: a ? await archive.size(a.dir) : null }
})

ipcMain.handle('accounts:archive', async (_e, id) => {
  const accounts = currentAccounts()
  const a = accounts.find(x => x.id === id)
  if (!a) return { error: 'Account not found.' }
  if (a.dir === DEFAULT_PROFILE) {
    return { error: 'The default profile is Claude’s own data directory and cannot be moved aside.' }
  }
  // Renaming a directory out from under a running app is how you corrupt one.
  if (await isRunning(a.dir)) {
    return { error: 'That account is open. Quit it first, then try again.' }
  }

  // No second confirmation: archiving deletes nothing and restores in a click,
  // and the picker's own menu already spelled out what it does. The native
  // warnings are kept for the two paths that cannot be undone.
  const bytes = await archive.size(a.dir)
  const res = archive.archive(a, bytes)
  if (res.error) return res

  const next = accounts.filter(x => x.id !== id)
  writeConfig(next, null, [...readArchived(), res.record])
  fitWindow()
  tray.refresh()
  // Undecorated for the same reason as the edit path: lsof would sit between
  // the click and the list updating. The renderer polls status right after.
  return {
    accounts: storedList(next),
    archived: archive.withStatus(readArchived()),
    movedTo: path.basename(res.record.dir)
  }
})

ipcMain.handle('archive:restore', async (_e, id) => {
  const records = readArchived()
  const r = records.find(x => x.id === id)
  if (!r) return { error: 'That archive is no longer listed.' }

  const res = archive.restore(r)
  if (res.error) return res

  const accounts = currentAccounts()
  // A fresh id: the archived one may since have been reused by a new account.
  accounts.push({
    id: crypto.randomUUID(),
    name: freeName(r.name, accounts),
    dir: res.dir,
    ...(r.emoji ? { emoji: r.emoji } : {}),
    ...(Number.isFinite(r.hue) ? { hue: r.hue } : {}),
    ...(r.chrome ? { chrome: r.chrome } : {})
  })
  writeConfig(accounts, null, records.filter(x => x.id !== id))
  fitWindow()
  tray.refresh()
  return {
    accounts: storedList(accounts),
    archived: archive.withStatus(readArchived()),
    renamed: res.renamed ? res.dir : null
  }
})

ipcMain.handle('archive:delete', async (_e, id) => {
  const records = readArchived()
  const r = records.find(x => x.id === id)
  if (!r) return { error: 'That archive is no longer listed.' }

  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Cancel', 'Delete Permanently'],
    defaultId: 0,
    cancelId: 0,
    message: `Delete the archive of “${r.name}”?`,
    detail:
      `This erases ${fmtBytes(r.bytes)} — the profile folder and everything in it, ` +
      `including its signed-in account. It cannot be undone.\n\n` +
      `Your ~/.claude data — skills, plugins, settings and transcripts — is not affected.\n\n${r.dir}`
  })
  if (response !== 1) return { cancelled: true }

  const res = archive.destroy(r)
  if (res.error) return res
  writeConfig(null, null, records.filter(x => x.id !== id))
  return { archived: archive.withStatus(readArchived()) }
})

ipcMain.handle('accounts:launch', async (_e, id) => {
  const a = currentAccounts().find(x => x.id === id)
  if (!a) return { error: 'Account not found.' }
  return launchAccount(a)
})

ipcMain.handle('accounts:reveal', async (_e, id) => {
  const a = currentAccounts().find(x => x.id === id)
  if (a) shell.showItemInFolder(a.dir)
})

ipcMain.handle('app:hide', () => { if (win) win.close() })

// A list modal needs more room than a two-account window has. Grow for it, then
// fitWindow() puts things back when the modal closes.
ipcMain.handle('app:ensureHeight', (_e, min) => {
  if (!win || win.isDestroyed()) return
  const [w, h] = win.getSize()
  if (h < min) win.setSize(w, min, true)
})

ipcMain.handle('app:fitWindow', () => fitWindow())

ipcMain.handle('app:extraHeight', (_e, px) => {
  extraHeight = Math.max(0, Number(px) || 0)
  fitWindow()
})

// After picking an account the launcher gets out of the way but stays running,
// so the next pick is instant instead of a cold Electron start. hide() rather
// than minimize(): a minimized window leaves a second thumbnail in the Dock.
ipcMain.handle('app:dismiss', () => { if (win && !win.isDestroyed()) win.hide() })

ipcMain.handle('settings:get', async () => ({
  ...readSettings(),
  version: app.getVersion(),
  packaged: app.isPackaged,
  hotkeyActive: Boolean(currentHotkey),
  menuBarActive: tray.isEnabled(),
  dockVisible: process.platform === 'darwin' && app.dock ? app.dock.isVisible() : true,
  openAtLogin: app.getLoginItemSettings().openAtLogin
}))

ipcMain.handle('settings:setHotkey', async (_e, { hotkey, enabled }) => {
  const res = registerHotkey(enabled ? hotkey : null)
  if (!res.ok && enabled) {
    applyHotkeyFromSettings()          // keep whatever was working before
    return { error: res.error }
  }
  writeConfig(null, { ...readSettings(), hotkey, hotkeyEnabled: enabled })
  return { ok: true }
})

ipcMain.handle('settings:setPresentation', async (_e, { menuBar, hideDock }) => {
  // No menu bar means the Dock icon has to stay, or the app becomes unreachable.
  const next = { ...readSettings(), menuBar: Boolean(menuBar), hideDock: Boolean(menuBar && hideDock) }
  writeConfig(null, next)
  await applyPresentation()
  return { menuBar: next.menuBar, hideDock: next.hideDock }
})

ipcMain.handle('settings:setSorting', async (_e, sortByRecent) => {
  const on = Boolean(sortByRecent)
  writeConfig(null, { ...readSettings(), sortByRecent: on })
  tray.refresh()
  return { sortByRecent: on }
})

ipcMain.handle('settings:setLoginItem', async (_e, enabled) => {
  app.setLoginItemSettings({
    openAtLogin: Boolean(enabled),
    openAsHidden: true,
    args: ['--hidden']
  })
  return { openAtLogin: app.getLoginItemSettings().openAtLogin }
})

ipcMain.handle('dock:status', async () => ({ pinned: await macos.isPinned() }))

ipcMain.handle('dock:pin', async () => macos.pinToDock())

ipcMain.handle('accounts:quit', async (_e, id) => {
  const a = currentAccounts().find(x => x.id === id)
  if (!a) return { error: 'Account not found.' }
  return macos.quitProfile(a.dir, f => fs.existsSync(f))
})

ipcMain.handle('chrome:list', async (_e, accountId) => {
  const profiles = chrome.listProfiles()
  const a = currentAccounts().find(x => x.id === accountId)
  return {
    installed: chrome.installed(),
    profiles,
    suggestion: a ? chrome.suggestFor(a.name, profiles)?.dir || null : null,
    current: a?.chrome || null
  }
})

ipcMain.handle('chrome:pair', async (_e, { accountId, dir, openOnLaunch }) => {
  const accounts = currentAccounts()
  const a = accounts.find(x => x.id === accountId)
  if (!a) return { error: 'Account not found.' }
  if (dir) a.chrome = { dir, openOnLaunch: openOnLaunch !== false }
  else delete a.chrome
  writeConfig(accounts)
  return { accounts: sortAccounts(await decorate(accounts)) }
})

ipcMain.handle('chrome:extension', async (_e, dir) => chrome.openExtensionPage(dir))

ipcMain.handle('chrome:newProfile', async () => ({ dir: chrome.nextProfileDir() }))

ipcMain.handle('health:scan', async () => health.scan(currentAccounts(), BACKUP_ROOT))

ipcMain.handle('health:rebuild', async (_e, { accountId, orphan }) => {
  const a = currentAccounts().find(x => x.id === accountId)
  if (!a) return { error: 'Account not found.' }
  return health.rebuild(a, orphan)
})

ipcMain.handle('health:reveal', async (_e, target) => {
  if (target) shell.showItemInFolder(target)
})

ipcMain.handle('app:claudeInstalled', () => fs.existsSync('/Applications/Claude.app'))

// -------------------------------------------------------------- self-update ---

ipcMain.handle('update:check', async () => {
  const res = await update.check()
  lastUpdate = res
  if (res.available) writeConfig(null, { ...readSettings(), lastUpdateCheck: Date.now() })
  return { ...res, packaged: app.isPackaged }
})

ipcMain.handle('update:install', async _e => {
  if (!lastUpdate?.available) return { error: 'No update to install.' }
  // Held between the download and the install so the renderer never handles a
  // path, and cleared once the swap script owns it.
  let staged = null
  try {
    staged = await update.download(lastUpdate, p => {
      if (win && !win.isDestroyed()) win.webContents.send('update:progress', p)
    })
    if (staged.error) return staged
    const res = await update.apply(staged)
    if (res.error) return res
    staged = null
    // The swap script waits for this process to exit before replacing the bundle.
    isQuitting = true
    setTimeout(() => app.quit(), 250)
    return res
  } catch (e) {
    // Without this the renderer's promise never settles and the sheet sits on
    // "Downloading…" for ever, which is how the ReadableStream bug presented.
    return { error: `Update failed: ${e.message}` }
  } finally {
    // A download that never reached the swap script is ~200 MB of nothing.
    if (staged && !staged.error) await update.discard(staged)
  }
})

ipcMain.handle('update:page', async () => shell.openExternal(update.RELEASES_PAGE))

// ---------------------------------------------------------------- hotkey ---

let currentHotkey = null

/** Summon the launcher, or put it away if it is already in front. */
function toggleWindow () {
  if (!win || win.isDestroyed()) return createWindow()
  if (win.isVisible() && win.isFocused()) return win.hide()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function registerHotkey (accel) {
  if (currentHotkey) { globalShortcut.unregister(currentHotkey); currentHotkey = null }
  if (!accel) return { ok: true, registered: false }
  let ok = false
  try { ok = globalShortcut.register(accel, toggleWindow) } catch { ok = false }
  if (ok) currentHotkey = accel
  // register() returns false when another app already owns the combination.
  return { ok, registered: ok, error: ok ? null : 'That shortcut is already taken by another app.' }
}

function applyHotkeyFromSettings () {
  const s = readSettings()
  return registerHotkey(s.hotkeyEnabled ? s.hotkey : null)
}

// -------------------------------------------------------------- menu bar ---

function openWindow () {
  if (!win || win.isDestroyed()) return createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

const TRAY_DEPS = {
  getState: async () => ({
    // Same order as the picker, so the menu and ⌘1–9 never disagree.
    accounts: sortAccounts(await decorate(currentAccounts())),
    issues: lastIssueCount
  }),
  onLaunch: async id => {
    const a = currentAccounts().find(x => x.id === id)
    if (a) await launchAccount(a)
    tray.refresh()
  },
  onOpenHealth: () => revealHealth(),
  onOpenSettings: () => { openWindow(); win?.webContents.send('settings:show') },
  onOpenWindow: openWindow,
  onQuit: () => app.quit()
}

/**
 * Apply the menu-bar / Dock presentation. Hiding the Dock icon is only offered
 * alongside the menu bar — without either, the app would have no way back.
 */
async function applyPresentation () {
  const s = readSettings()
  if (s.menuBar) await tray.enable(TRAY_DEPS)
  else tray.disable()

  if (process.platform === 'darwin' && app.dock) {
    if (s.menuBar && s.hideDock) app.dock.hide()
    else app.dock.show()
  }
}

// ----------------------------------------------------------- update watch ---

const UPDATE_EVERY_MS = 24 * 60 * 60 * 1000

let lastUpdate = null

/**
 * A quiet daily check. It only ever *looks* — installing stays a decision, and
 * a launcher that cannot reach GitHub should behave exactly as it always did.
 */
async function updateTick () {
  if (!app.isPackaged) return
  const s = readSettings()
  if (!s.autoUpdateCheck) return
  if (Date.now() - (s.lastUpdateCheck || 0) < UPDATE_EVERY_MS) return

  const res = await update.check()
  lastUpdate = res
  if (!res.ok) return
  writeConfig(null, { ...readSettings(), lastUpdateCheck: Date.now() })
  if (res.available && win && !win.isDestroyed()) {
    win.webContents.send('update:available', res)
  }
}

ipcMain.handle('settings:setAutoUpdate', async (_e, enabled) => {
  const on = Boolean(enabled)
  writeConfig(null, { ...readSettings(), autoUpdateCheck: on })
  return { autoUpdateCheck: on }
})

// ------------------------------------------------------------ health watch ---

// A scan costs ~50 ms, so checking every couple of minutes is free. The point is
// latency: the failure this catches is invisible while the app runs, so the gap
// between "it started failing" and "you were told" is the whole value.
// CLAUDE_ACCOUNTS_WATCH_MS shortens this for testing.
const WATCH_INTERVAL_MS = Number(process.env.CLAUDE_ACCOUNTS_WATCH_MS) || 2 * 60 * 1000

let watchTimer = null
let seenIssues = new Set()
let lastIssueCount = 0

function issueKeys (data) {
  const keys = new Set()
  for (const a of data.accounts) {
    // Keyed on the account, not the last failure timestamp: a continuing failure
    // must not re-notify on every tick.
    if (a.failures && !a.failures.resolved) keys.add(`fail:${a.id}`)
    for (const o of a.orphans) keys.add(`orphan:${a.id}:${o.cliSessionId}`)
  }
  return keys
}

function issueCount (data) {
  return data.accounts.reduce((n, a) =>
    n + a.orphans.length + (a.failures && !a.failures.resolved ? 1 : 0), 0)
}

function revealHealth () {
  if (!win || win.isDestroyed()) createWindow()
  if (win) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    win.webContents.send('health:show')
  }
}

function notify (title, body) {
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body })
  n.on('click', revealHealth)
  n.show()
}

async function healthTick ({ first = false } = {}) {
  let data
  try { data = await health.scan(currentAccounts(), BACKUP_ROOT) } catch { return }

  const n = issueCount(data)
  lastIssueCount = n
  if (process.platform === 'darwin' && app.dock) app.dock.setBadge(n ? String(n) : '')
  tray.refresh()
  if (win && !win.isDestroyed()) win.webContents.send('health:update', data)

  const keys = issueKeys(data)
  const fresh = [...keys].filter(k => !seenIssues.has(k))
  seenIssues = keys

  const failing = data.accounts.filter(a => a.failures && !a.failures.resolved)
  if (failing.length && (first || fresh.some(k => k.startsWith('fail:')))) {
    // Worth interrupting for: while this lasts, every session is memory-only.
    notify('Claude is not saving sessions',
      `${failing.map(a => a.name).join(', ')} — sessions will be lost when Claude restarts.`)
    return
  }

  // Pre-existing orphans are old news at startup; the badge already carries them.
  const newOrphans = first ? [] : fresh.filter(k => k.startsWith('orphan:'))
  if (newOrphans.length) {
    notify(newOrphans.length === 1 ? 'A session went missing from Claude’s list'
                                   : `${newOrphans.length} sessions went missing from Claude’s list`,
      'Their transcripts survived. Open Claude Accounts to restore them.')
  }
}

function startWatching () {
  healthTick({ first: true })
  watchTimer = setInterval(() => healthTick(), WATCH_INTERVAL_MS)
}

// -------------------------------------------------------------------- window ---

// Banners the renderer shows (the Dock prompt) need room the account count
// alone does not account for.
let extraHeight = 0

/** Size the window to its content so it never opens as a half-empty panel. */
function preferredHeight () {
  const stored = readConfig()
  if (stored === null) return 560            // setup view carries its own copy
  const CHROME = 52 + 16 + 60                // titlebar + list padding + footer
  return Math.max(260, Math.min(760, CHROME + stored.length * 66 + extraHeight))
}

function createWindow () {
  win = new BrowserWindow({
    width: 440,
    height: preferredHeight(),
    minWidth: 380,
    minHeight: 240,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 18 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1b1f' : '#f6f5f3',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
      // sandbox is left at its default (on): the preload needs contextBridge and
      // ipcRenderer, both of which a sandboxed preload still gets.
    }
  })

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  win.once('ready-to-show', () => {
    // Launched at login, the point is to be ready for the hotkey, not to appear.
    if (!startHidden) { win.show(); win.focus() }
    startHidden = false

    // Dev aid: CLAUDE_ACCOUNTS_SHOT=/path/to.png renders the window to a file
    // and exits. Uses in-process capture, so no screen-recording permission.
    const shot = process.env.CLAUDE_ACCOUNTS_SHOT
    if (shot) {
      setTimeout(async () => {
        const img = await win.webContents.capturePage()
        fs.writeFileSync(shot, img.toPNG())
        app.quit()
      }, 1200)
    }
  })
  // With a global hotkey (or launch-at-login) the app must outlive its window,
  // or the shortcut dies the first time the window is dismissed.
  win.on('close', e => {
    if (isQuitting) return
    const s = readSettings()
    let atLogin = false
    try { atLogin = app.getLoginItemSettings().openAtLogin } catch {}
    if (s.hotkeyEnabled || atLogin) { e.preventDefault(); win.hide() }
  })

  win.on('closed', () => { win = null })
}

app.whenReady().then(() => {
  try { startHidden = startHidden || app.getLoginItemSettings().wasOpenedAtLogin } catch {}
  createWindow()
  applyHotkeyFromSettings()
  applyPresentation()
  startWatching()
  // Behind the first paint: an update check is never worth delaying the window.
  setTimeout(() => { updateTick().catch(() => {}) }, 4000)
  // The window survives a pick (hidden, not closed), so clicking the Dock icon
  // has to reveal it rather than only rebuild a window that was never gone.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) return createWindow()
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })
})

// A launcher has no reason to linger once its window is gone.
app.on('window-all-closed', () => {
  const s = readSettings()
  // With a menu bar or a shortcut there is still a way back in, so closing the
  // last window should not end the app.
  if (s.menuBar || s.hotkeyEnabled) return
  app.quit()
})
app.on('before-quit', () => { isQuitting = true; if (watchTimer) clearInterval(watchTimer) })
app.on('will-quit', () => globalShortcut.unregisterAll())
