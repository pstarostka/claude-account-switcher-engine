'use strict'

// update.js talks to Electron, but the two things worth pinning down here do
// not: version ordering decides whether anyone is offered an update at all, and
// asset matching decides which of a release's builds each platform installs.
//
// (The shell quoting that used to be tested here moved with the swap scripts,
// to test/platform.test.js.)

const { test } = require('node:test')
const assert = require('node:assert')

const { compareVersions, pickAsset } = require('../src/update.js')

const newer = (a, b) => compareVersions(a, b) > 0

test('ordering is numeric, not lexicographic', () => {
  assert.ok(newer('3.10.0', '3.2.0'), '10 is a later minor than 2, though it sorts earlier as text')
  assert.ok(newer('3.1.1', '3.1.0'))
  assert.ok(!newer('3.1.0', '3.1.0'), 'the running version is not an update')
  assert.ok(!newer('3.1.0', '3.1.1'), 'nor is an older one')
})

test('a leading v is ignored and a shorter version is padded', () => {
  assert.equal(compareVersions('v3.1.0', '3.1.0'), 0, 'tags carry a v, package.json does not')
  assert.equal(compareVersions('3.1', '3.1.0'), 0)
  assert.ok(newer('3.2', '3.1.9'))
})

test('a pre-release loses to the release it precedes', () => {
  assert.ok(newer('3.2.0', '3.2.0-beta.1'))
  assert.ok(!newer('3.2.0-beta.1', '3.2.0'))
  assert.ok(newer('3.2.0-beta.1', '3.1.0'), 'but still beats a genuinely older release')
})

// A release carries a build per platform, and both halves of the pairing matter.
// Taking the first .zip would hand a Mac a Windows build; taking the first
// .sha256 would check one platform's download against the other's checksum, and
// the only symptom of that is a corrupt-download error that never clears.
const MAC = /-mac-/i
const WIN = /-win-/i

const release = (...names) => names.map(name => ({ name }))

const BOTH = release(
  'CASE-3.2.0-mac-universal.zip',
  'CASE-3.2.0-mac-universal.zip.sha256',
  'CASE-3.2.0-win-x64.zip',
  'CASE-3.2.0-win-x64.zip.sha256'
)

test('each platform takes its own zip and the checksum published for it', () => {
  const mac = pickAsset(BOTH, MAC)
  assert.equal(mac.zip.name, 'CASE-3.2.0-mac-universal.zip')
  assert.equal(mac.sum.name, 'CASE-3.2.0-mac-universal.zip.sha256')

  const win = pickAsset(BOTH, WIN)
  assert.equal(win.zip.name, 'CASE-3.2.0-win-x64.zip')
  assert.equal(win.sum.name, 'CASE-3.2.0-win-x64.zip.sha256')
})

test('a release built for the other platform yields nothing at all', () => {
  const macOnly = release('CASE-3.2.0-mac-universal.zip', 'CASE-3.2.0-mac-universal.zip.sha256')
  assert.deepEqual(pickAsset(macOnly, WIN), { zip: null, sum: null })
  assert.equal(pickAsset([], MAC).zip, null)
  assert.equal(pickAsset(undefined, MAC).zip, null)
})

test('a checksum belonging to the other build is not accepted as this one’s', () => {
  const mismatched = release('CASE-3.2.0-win-x64.zip', 'CASE-3.2.0-mac-universal.zip.sha256')
  const { zip, sum } = pickAsset(mismatched, WIN)
  assert.equal(zip.name, 'CASE-3.2.0-win-x64.zip')
  assert.equal(sum, null, 'an unpaired checksum reads as none, so download() refuses it')
})

test('a .sha256 is never mistaken for the zip itself', () => {
  assert.equal(pickAsset(release('CASE-3.2.0-mac-universal.zip.sha256'), MAC).zip, null)
})
