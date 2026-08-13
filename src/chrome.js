'use strict'

// Pairing a Claude account with a Chrome profile.
//
// Chrome keeps its profile list in Local State under profile.info_cache, keyed
// by directory name ("Default", "Profile 8") with the display name and signed-in
// address alongside. That file, and the "Profile N" naming, are the same on
// every platform — only where Chrome keeps them differs, and where it is
// launched from, both of which come from src/platform.
//
// Extensions are per-profile, so the Claude extension being present in one
// profile says nothing about another.

const fs = require('node:fs')
const path = require('node:path')
const platform = require('./platform')

const CHROME_DIR = () => platform.chrome.root()
const LOCAL_STATE = () => path.join(CHROME_DIR(), 'Local State')

// Claude in Chrome.
const EXTENSION_ID = 'fcoeoabgfenejglbffodgkkbkcdhcgfn'
const WEBSTORE_URL = `https://chromewebstore.google.com/detail/${EXTENSION_ID}`

const installed = () => platform.chrome.installed()

function hasExtension (profileDir) {
  return fs.existsSync(path.join(CHROME_DIR(), profileDir, 'Extensions', EXTENSION_ID))
}

/** Every Chrome profile, newest-used first. */
function listProfiles () {
  if (!installed()) return []
  let state
  try { state = JSON.parse(fs.readFileSync(LOCAL_STATE(), 'utf8')) } catch { return [] }
  const cache = state?.profile?.info_cache || {}
  const lastUsed = state?.profile?.last_used

  return Object.entries(cache)
    .filter(([dir]) => fs.existsSync(path.join(CHROME_DIR(), dir)))
    .map(([dir, info]) => ({
      dir,
      name: info.name || dir,
      userName: info.user_name || null,
      hasExtension: hasExtension(dir),
      lastUsed: dir === lastUsed
    }))
    .sort((a, b) => (b.lastUsed - a.lastUsed) || a.name.localeCompare(b.name))
}

/** The next unused "Profile N" directory, for creating a fresh profile. */
function nextProfileDir () {
  for (let i = 1; i < 500; i++) {
    const dir = `Profile ${i}`
    if (!fs.existsSync(path.join(CHROME_DIR(), dir))) return dir
  }
  return `Profile ${Date.now()}`
}

/**
 * Suggest a Chrome profile for a Claude account by name or address. Both of
 * these are things a person named their profiles, so an exact-ish match is a
 * strong signal — but it is only ever a default, never applied automatically.
 */
function suggestFor (accountName, profiles) {
  const want = accountName.trim().toLowerCase()
  if (!want) return null
  const norm = s => (s || '').toLowerCase()
  return profiles.find(p => norm(p.name) === want) ||
         profiles.find(p => norm(p.userName).split('@')[0] === want) ||
         profiles.find(p => norm(p.name).includes(want) || want.includes(norm(p.name))) ||
         null
}

/** Open a Chrome window on a profile. Creates the profile if it does not exist. */
const launch = (profileDir, url = null) => platform.chrome.launch(profileDir, url)

/** Open the extension's Web Store page in the given profile so it is one click away. */
function openExtensionPage (profileDir) {
  return launch(profileDir, WEBSTORE_URL)
}

module.exports = {
  installed,
  listProfiles,
  nextProfileDir,
  suggestFor,
  launch,
  openExtensionPage,
  hasExtension,
  EXTENSION_ID,
  WEBSTORE_URL
}
