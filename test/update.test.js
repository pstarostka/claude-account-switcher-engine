'use strict'

// update.js talks to Electron, but the two things worth pinning down here do
// not: version ordering decides whether anyone is offered an update at all, and
// the shell quoting decides what the swap script does with a path.

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const { execFileSync } = require('node:child_process')

const { compareVersions, sq } = require('../src/update.js')

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

test('paths reach the swap script literally, whatever is in them', () => {
  // apply() builds a /bin/sh script around paths the app does not choose: the
  // bundle can be anywhere and named anything. Nothing in a path may execute.
  const marker = '/tmp/case-quoting-canary'
  const hostile = [
    '/Applications/CASE.app',
    "/Applications/it's here.app",
    '/Applications/two words/CASE.app',
    '/Applications/CA$(id -un)SE.app',
    '/Applications/`id -un`.app',
    '/Applications/$HOME.app',
    `/Applications/x;touch ${marker}.app`,
    '/Applications/back\\slash.app'
  ]

  for (const p of hostile) {
    const out = execFileSync('/bin/sh', ['-c', `P=${sq(p)}; printf %s "$P"`]).toString()
    assert.equal(out, p, `${p} did not survive quoting intact`)
  }

  assert.ok(!fs.existsSync(marker), 'a path with a ; must not run a command')
})
