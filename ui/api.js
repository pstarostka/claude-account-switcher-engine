'use strict'

// The surface the page talks to: one method per command in src/main.rs, and one
// subscription per event it emits. tests/bridge.rs holds the three files to the
// same list, so a renamed command fails there rather than in a menu nobody opened.

const { invoke } = window.__TAURI__.core
const { listen } = window.__TAURI__.event

/** Subscribe to an event's payload. Returns its own remover. */
const on = (event, cb) => {
  const pending = listen(event, e => cb(e.payload))
  return () => { pending.then(off => off()) }
}

window.api = {
  list: () => invoke('accounts_list'),
  status: () => invoke('accounts_status'),
  adopt: picked => invoke('accounts_adopt', { picked }),
  add: name => invoke('accounts_add', { name }),
  update: (id, fields) => invoke('accounts_update', { id, ...fields }),
  remove: (id, deleteData) => invoke('accounts_remove', { id, deleteData }),
  launch: id => invoke('accounts_launch', { id }),
  size: id => invoke('accounts_size', { id }),
  archiveAccount: id => invoke('accounts_archive', { id }),
  archiveRestore: id => invoke('archive_restore', { id }),
  archiveDelete: id => invoke('archive_delete', { id }),
  reveal: id => invoke('accounts_reveal', { id }),
  hide: () => invoke('app_hide'),
  dismiss: () => invoke('app_dismiss'),
  ensureHeight: min => invoke('app_ensure_height', { min }),
  fitWindow: () => invoke('app_fit_window'),
  extraHeight: px => invoke('app_extra_height', { px }),
  getSettings: () => invoke('settings_get'),
  setHotkey: (hotkey, enabled) => invoke('settings_set_hotkey', { hotkey, enabled }),
  setLoginItem: enabled => invoke('settings_set_login_item', { enabled }),
  setSorting: sortByRecent => invoke('settings_set_sorting', { sortByRecent }),
  setAutoUpdate: enabled => invoke('settings_set_auto_update', { enabled }),
  updateCheck: () => invoke('update_check'),
  updateInstall: () => invoke('update_install'),
  updatePage: () => invoke('update_page'),
  onUpdateAvailable: cb => on('update:available', cb),
  // An install can be attempted more than once, and each attempt's callback
  // writes into a modal that is gone by the next one — hence the remover.
  onUpdateProgress: cb => on('update:progress', cb),
  setPresentation: (menuBar, hideDock) => invoke('settings_set_presentation', { menuBar, hideDock }),
  onShowSettings: cb => on('settings:show', () => cb()),
  shortcutStatus: () => invoke('shortcut_status'),
  shortcutCreate: () => invoke('shortcut_create'),
  quitAccount: id => invoke('accounts_quit', { id }),
  chromeList: accountId => invoke('chrome_list', { accountId }),
  chromePair: (accountId, dir, openOnLaunch) => invoke('chrome_pair', { accountId, dir, openOnLaunch }),
  chromeExtension: dir => invoke('chrome_extension', { dir }),
  chromeNewProfile: () => invoke('chrome_new_profile'),
  scanHealth: () => invoke('health_scan'),
  onHealthUpdate: cb => on('health:update', cb),
  onShowHealth: cb => on('health:show', () => cb()),
  rebuildSession: (accountId, orphan) => invoke('health_rebuild', { accountId, orphan }),
  revealPath: target => invoke('health_reveal', { target }),
  claudeInstalled: () => invoke('app_claude_installed'),
  // Not a command: the renderer needs this on every keystroke to tell Ctrl
  // from Command.
  platform: navigator.userAgent.includes('Windows') ? 'win32' : 'darwin'
}
