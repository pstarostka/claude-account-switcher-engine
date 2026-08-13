'use strict'

// Menu-bar mode: the whole picker as a menu, so switching account never needs a
// window at all.

const { Tray, Menu } = require('electron')
const platform = require('./platform')

let tray = null
let deps = null

async function buildMenu () {
  const { accounts, issues } = await deps.getState()

  const items = accounts.map(a => ({
    label: (a.emoji ? `${a.emoji}  ` : '') + (a.running ? `${a.name}  ●` : a.name),
    // A checkmark would imply a selection; the dot just marks what is open.
    click: () => deps.onLaunch(a.id)
  }))

  if (!items.length) items.push({ label: 'No accounts yet', enabled: false })

  return Menu.buildFromTemplate([
    ...items,
    { type: 'separator' },
    { label: issues ? `Session health (${issues})` : 'Session health', click: deps.onOpenHealth },
    { label: 'Settings…', click: deps.onOpenSettings },
    { label: 'Open CASE', click: deps.onOpenWindow },
    { type: 'separator' },
    { label: 'Quit CASE', accelerator: platform.QUIT_ACCEL, click: deps.onQuit }
  ])
}

// Windows pops the menu itself, from a fresh build on each click; macOS wants a
// menu already attached and rebuilds it on mouse-down. Setting a context menu on
// Windows too would mean the menu opens before the rebuild it triggered lands.
const WIN = process.platform === 'win32'

async function refresh () {
  if (!tray || tray.isDestroyed() || WIN) return
  try { tray.setContextMenu(await buildMenu()) } catch {}
}

async function enable (dependencies) {
  deps = dependencies || deps
  if (tray && !tray.isDestroyed()) return refresh()

  tray = new Tray(await platform.trayImage())
  tray.setToolTip('CASE — Claude Account Switcher Engine')
  await refresh()

  // Rebuild on open so running state is current, not as of the last poll.
  // mouse-down never fires on Windows, so there the click events do it — and
  // without this the menu would quietly show whatever was true at startup.
  if (WIN) {
    const pop = async () => { try { tray.popUpContextMenu(await buildMenu()) } catch {} }
    tray.on('click', pop)
    tray.on('right-click', pop)
  } else {
    tray.on('mouse-down', refresh)
  }
}

/** Swap in a fresh icon, for a theme change. Windows picks one per taskbar theme. */
async function reload () {
  if (!tray || tray.isDestroyed()) return
  try { tray.setImage(await platform.trayImage()) } catch {}
}

function disable () {
  if (tray && !tray.isDestroyed()) tray.destroy()
  tray = null
}

const isEnabled = () => Boolean(tray && !tray.isDestroyed())

module.exports = { enable, disable, refresh, reload, isEnabled }
