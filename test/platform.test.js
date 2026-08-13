'use strict'

// The platform split only works if the two halves stay the same shape. Nothing
// else can check that: whichever machine the tests run on, half the code is for
// the other one, so a missing Windows export would otherwise surface as a
// TypeError on a user's desktop rather than here.
//
// Requiring both modules on either OS is also the point of the rule that neither
// may touch the filesystem, read the environment or reach into Electron at
// require time. If one starts doing that, this test is where it says so.

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const mac = require('../src/platform/mac.js')
const win = require('../src/platform/win.js')

// The contract, written out rather than derived, so that widening it is a
// deliberate edit to this list and not a side effect of adding an export.
const INTERFACE = {
  claudeInstalled: 'function',
  claudeHint: 'function',
  launchClaude: 'function',
  activateProfile: 'function',
  isRunning: 'function',
  quitProfile: 'function',
  shortcutStatus: 'function',
  shortcutCreate: 'function',
  installPath: 'function',
  installLooksSane: 'function',
  unpack: 'function',
  findFresh: 'function',
  swapAndRelaunch: 'function',
  ASSET_RE: 'object',
  setBadge: 'function',
  profileSize: 'function',
  trayImage: 'function',
  forgetTheme: 'function',
  chrome: 'object',
  QUIT_ACCEL: 'string',
  DEFAULT_HOTKEY: 'string',
  loginItemOptions: 'function'
}

for (const [name, mod] of [['mac', mac], ['win', win]]) {
  test(`${name}.js implements the platform interface`, () => {
    for (const [key, type] of Object.entries(INTERFACE)) {
      assert.equal(typeof mod[key], type, `${name}.js: ${key} should be a ${type}`)
    }
    for (const key of ['installed', 'root', 'launch']) {
      assert.equal(typeof mod.chrome[key], 'function', `${name}.js: chrome.${key}`)
    }
  })
}

test('the two halves agree on arity, so a caller can be written once', () => {
  for (const [key, type] of Object.entries(INTERFACE)) {
    if (type !== 'function') continue
    assert.equal(mac[key].length, win[key].length, `${key} takes a different number of arguments`)
  }
})

test('each platform claims only its own release asset', () => {
  const macZip = 'CASE-3.2.0-mac-universal.zip'
  const winZip = 'CASE-3.2.0-win-x64.zip'

  assert.ok(mac.ASSET_RE.test(macZip) && !mac.ASSET_RE.test(winZip))
  assert.ok(win.ASSET_RE.test(winZip) && !win.ASSET_RE.test(macZip))
})

// --------------------------------------------------------------- quoting ---

// Both swap scripts are built around paths the app does not choose: it can be
// installed anywhere and named anything. Nothing in a path may execute.
const HOSTILE = [
  "it's here",
  'two words',
  'CA$(id -un)SE',
  '`id -un`',
  '$HOME',
  'x;touch /tmp/case-quoting-canary',
  'back\\slash',
  '%APPDATA%',
  'a&b',
  '100% done'
]

// Each of these runs only where its shell exists. The quoting is checked as a
// string everywhere; only actually executing it needs the right machine.
test('paths reach the sh swap script literally, whatever is in them', { skip: process.platform === 'win32' }, () => {
  const marker = '/tmp/case-quoting-canary'
  for (const p of HOSTILE) {
    const out = execFileSync('/bin/sh', ['-c', `P=${mac.sq(p)}; printf %s "$P"`]).toString()
    assert.equal(out, p, `${p} did not survive quoting intact`)
  }
  assert.ok(!fs.existsSync(marker), 'a path with a ; must not run a command')
})

test('the PowerShell quoting doubles the only character that escapes', () => {
  // Shape is checkable anywhere; only the doubled quote needs care, because a
  // single-quoted PowerShell string expands nothing else.
  assert.equal(win.pq('plain'), "'plain'")
  assert.equal(win.pq("it's"), "'it''s'")
  assert.equal(win.pq('$HOME `x` %A% & ;'), "'$HOME `x` %A% & ;'")
})

test('paths reach the PowerShell swap script literally', { skip: process.platform !== 'win32' }, () => {
  for (const p of HOSTILE) {
    const out = execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `Write-Output ${win.pq(p)}`]).toString()
    assert.equal(out.replace(/\r?\n$/, ''), p, `${p} did not survive quoting intact`)
  }
})

// -------------------------------------------------------------- discovery ---

test('a Squirrel install is ordered by version, not by name', () => {
  // The first minor to reach 10 is where sorting these as text goes wrong, and
  // the symptom would be CASE launching a stale Claude for ever.
  assert.equal(win.newestAppDir(['app-0.9.9', 'app-0.10.0', 'app-0.9.10']), 'app-0.10.0')
  assert.equal(win.newestAppDir(['app-1.2.3', 'app-1.2.10']), 'app-1.2.10')
  assert.equal(win.newestAppDir(['app-2.0.0', 'app-10.0.0']), 'app-10.0.0')
})

test('only version directories count as an install', () => {
  assert.equal(win.newestAppDir(['Update.exe', 'packages', 'app-1.0.0']), 'app-1.0.0')
  assert.equal(win.newestAppDir(['Update.exe', 'packages']), null)
  assert.equal(win.newestAppDir([]), null)
  assert.equal(win.newestAppDir(undefined), null)
})

// ------------------------------------------------------------------ asar ---

/** The two back-to-back pickles an .asar starts with, around one file. */
function fakeAsar (pkg) {
  const body = Buffer.from(JSON.stringify(pkg), 'utf8')
  const json = Buffer.from(JSON.stringify({
    files: { 'package.json': { size: body.length, offset: '0' } }
  }), 'utf8')

  const header = Buffer.alloc(8 + json.length)
  header.writeUInt32LE(4 + json.length, 0)     // pickle payload
  header.writeUInt32LE(json.length, 4)         // string length
  json.copy(header, 8)

  const size = Buffer.alloc(8)
  size.writeUInt32LE(4, 0)
  size.writeUInt32LE(header.length, 4)

  return Buffer.concat([size, header, body])
}

test('the identity check reads package.json back out of an asar', () => {
  const file = path.join(os.tmpdir(), `case-asar-${process.pid}.asar`)
  try {
    fs.writeFileSync(file, fakeAsar({ name: 'case', version: '9.9.9' }))
    assert.equal(win.asarPackageJson(file).name, 'case')
    assert.equal(win.asarPackageJson(file).version, '9.9.9')

    fs.writeFileSync(file, fakeAsar({ name: 'something-else' }))
    assert.notEqual(win.asarPackageJson(file).name, 'case')
  } finally {
    fs.rmSync(file, { force: true })
  }
})

test('a file that is not an asar is refused rather than guessed at', () => {
  const file = path.join(os.tmpdir(), `case-notasar-${process.pid}.asar`)
  try {
    fs.writeFileSync(file, Buffer.from('not an archive at all'))
    assert.throws(() => win.asarPackageJson(file))
  } finally {
    fs.rmSync(file, { force: true })
  }
})
