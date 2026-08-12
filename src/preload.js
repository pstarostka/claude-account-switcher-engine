'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  list: () => ipcRenderer.invoke('accounts:list'),
  status: () => ipcRenderer.invoke('accounts:status'),
  adopt: picked => ipcRenderer.invoke('accounts:adopt', picked),
  add: name => ipcRenderer.invoke('accounts:add', name),
  update: (id, fields) => ipcRenderer.invoke('accounts:update', { id, ...fields }),
  remove: (id, deleteData) => ipcRenderer.invoke('accounts:remove', { id, deleteData }),
  launch: id => ipcRenderer.invoke('accounts:launch', id),
  size: id => ipcRenderer.invoke('accounts:size', id),
  archiveAccount: id => ipcRenderer.invoke('accounts:archive', id),
  archiveRestore: id => ipcRenderer.invoke('archive:restore', id),
  archiveDelete: id => ipcRenderer.invoke('archive:delete', id),
  reveal: id => ipcRenderer.invoke('accounts:reveal', id),
  hide: () => ipcRenderer.invoke('app:hide'),
  dismiss: () => ipcRenderer.invoke('app:dismiss'),
  ensureHeight: min => ipcRenderer.invoke('app:ensureHeight', min),
  fitWindow: () => ipcRenderer.invoke('app:fitWindow'),
  extraHeight: px => ipcRenderer.invoke('app:extraHeight', px),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setHotkey: (hotkey, enabled) => ipcRenderer.invoke('settings:setHotkey', { hotkey, enabled }),
  setLoginItem: enabled => ipcRenderer.invoke('settings:setLoginItem', enabled),
  setSorting: sortByRecent => ipcRenderer.invoke('settings:setSorting', sortByRecent),
  setAutoUpdate: enabled => ipcRenderer.invoke('settings:setAutoUpdate', enabled),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  updatePage: () => ipcRenderer.invoke('update:page'),
  onUpdateAvailable: cb => ipcRenderer.on('update:available', (_e, info) => cb(info)),
  // Returns its own remover: an install can be attempted more than once, and
  // each attempt's callback writes into a modal that is gone by the next one.
  onUpdateProgress: cb => {
    const on = (_e, p) => cb(p)
    ipcRenderer.on('update:progress', on)
    return () => ipcRenderer.removeListener('update:progress', on)
  },
  setPresentation: (menuBar, hideDock) => ipcRenderer.invoke('settings:setPresentation', { menuBar, hideDock }),
  onShowSettings: cb => ipcRenderer.on('settings:show', () => cb()),
  dockStatus: () => ipcRenderer.invoke('dock:status'),
  dockPin: () => ipcRenderer.invoke('dock:pin'),
  quitAccount: id => ipcRenderer.invoke('accounts:quit', id),
  chromeList: accountId => ipcRenderer.invoke('chrome:list', accountId),
  chromePair: (accountId, dir, openOnLaunch) => ipcRenderer.invoke('chrome:pair', { accountId, dir, openOnLaunch }),
  chromeExtension: dir => ipcRenderer.invoke('chrome:extension', dir),
  chromeNewProfile: () => ipcRenderer.invoke('chrome:newProfile'),
  scanHealth: () => ipcRenderer.invoke('health:scan'),
  onHealthUpdate: cb => ipcRenderer.on('health:update', (_e, data) => cb(data)),
  onShowHealth: cb => ipcRenderer.on('health:show', () => cb()),
  rebuildSession: (accountId, orphan) => ipcRenderer.invoke('health:rebuild', { accountId, orphan }),
  revealPath: target => ipcRenderer.invoke('health:reveal', target),
  claudeInstalled: () => ipcRenderer.invoke('app:claudeInstalled')
})
