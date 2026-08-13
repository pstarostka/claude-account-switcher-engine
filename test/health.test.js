'use strict'

// A scan reads three separate places — the log, the session index and the
// transcripts — and only the combination says whether a session is lost. The
// fixture below is the smallest arrangement where that holds.

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// health.js resolves ~/.claude, the default profile and the shared log when it
// loads, so the fixture and the home directory both have to be in place before
// the require — USERPROFILE and APPDATA alongside HOME, because which of them
// os.homedir() reads depends on the platform this is running on.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'case-health-'))
process.env.HOME = HOME
process.env.USERPROFILE = HOME
process.env.APPDATA = path.join(HOME, 'AppData', 'Roaming')

const health = require('../src/health.js')

// Taken from health.js rather than spelled out again: the layout differs by
// platform, and a second copy of it here would only ever test itself.
const DEFAULT_PROFILE = health.DEFAULT_PROFILE
const SUPPORT = path.dirname(DEFAULT_PROFILE)
const UNOPENED = path.join(SUPPORT, 'Claude-Unopened')
const CLI_ID = '11111111-2222-3333-4444-555555555555'

// The shared log records one desktop session…
fs.mkdirSync(path.dirname(health.SHARED_LOG), { recursive: true })
fs.writeFileSync(health.SHARED_LOG,
  `2026-08-12 10:00:00 [info] Mapping internal session local_abc to CLI session ${CLI_ID}\n`)

// …the default profile has an index that does not mention it…
fs.mkdirSync(path.join(DEFAULT_PROFILE, 'claude-code-sessions', 'acct', 'org'), { recursive: true })

// …and the transcript is still on disk, which is what makes it restorable.
fs.mkdirSync(path.join(HOME, '.claude', 'projects', 'proj'), { recursive: true })
fs.writeFileSync(path.join(HOME, '.claude', 'projects', 'proj', `${CLI_ID}.jsonl`),
  JSON.stringify({ type: 'user', cwd: '/tmp/work', timestamp: '2026-08-12T10:00:00Z' }) + '\n' +
  JSON.stringify({ type: 'assistant', timestamp: '2026-08-12T10:05:00Z' }) + '\n')

// A second account, added but never opened: no log of its own, and no index.
fs.mkdirSync(UNOPENED, { recursive: true })

const scan = () => health.scan([
  { id: 'default', name: 'Main', dir: DEFAULT_PROFILE },
  { id: 'new', name: 'Unopened', dir: UNOPENED }
], path.join(SUPPORT, 'CASE', 'session-index-backups'))

const find = (accounts, id) => accounts.find(a => a.id === id)

test('a session in the log but not in the index is an orphan', async () => {
  const { accounts } = await scan()
  const main = find(accounts, 'default')
  assert.equal(main.orphans.length, 1)
  assert.equal(main.orphans[0].cliSessionId, CLI_ID)
  assert.equal(main.orphans[0].localId, 'local_abc')
  assert.equal(main.orphans[0].cwd, '/tmp/work', 'read back out of the transcript')
})

test('an account that has never been opened inherits nothing from the shared log', async () => {
  // Regression: the shared log belongs to the *default* profile. Falling back to
  // it for any other profile reported every one of Main's sessions as that
  // account's — all of them missing from an index that did not exist yet — and
  // raised a "sessions went missing" notification for each.
  const { accounts } = await scan()
  const fresh = find(accounts, 'new')
  assert.equal(fresh.orphans.length, 0)
  assert.equal(fresh.logExists, false, 'so the UI can say to open it once and rescan')
})

test('a session already in the index is not reported as lost', async () => {
  const entry = path.join(DEFAULT_PROFILE, 'claude-code-sessions', 'acct', 'org', 'local_abc.json')
  fs.writeFileSync(entry, JSON.stringify({ sessionId: 'local_abc', cliSessionId: CLI_ID }))
  try {
    const { accounts } = await scan()
    assert.equal(find(accounts, 'default').orphans.length, 0)
  } finally {
    fs.rmSync(entry)
  }
})

test('a log with Windows line endings reads the same as any other', async () => {
  // Claude writes this log on Windows too. Splitting on \n alone left a \r on
  // the end of every line: it trailed into the reason shown in the UI, and it
  // sat between the reason and the `$` the failure pattern anchors on, so no
  // failure was ever recognised.
  const saved = fs.readFileSync(health.SHARED_LOG)
  fs.writeFileSync(health.SHARED_LOG,
    `2026-08-12 10:00:00 [info] Mapping internal session local_abc to CLI session ${CLI_ID}\r\n` +
    '2026-08-12 10:01:00 [error] Failed to save session local_abc: ENOTDIR: not a directory\r\n')
  try {
    const main = find((await scan()).accounts, 'default')
    assert.equal(main.orphans.length, 1, 'the mapping is still found')
    assert.equal(main.failures?.count, 1, 'and so is the failure that follows it')
    assert.equal(main.failures.reason, 'ENOTDIR: not a directory',
      'with no carriage return left on the end of the reason')
  } finally {
    fs.writeFileSync(health.SHARED_LOG, saved)
  }
})

test('a mapping whose transcript is gone is not offered for restore', async () => {
  const transcript = path.join(HOME, '.claude', 'projects', 'proj', `${CLI_ID}.jsonl`)
  const saved = fs.readFileSync(transcript)
  fs.rmSync(transcript)
  try {
    const { accounts } = await scan()
    assert.equal(find(accounts, 'default').orphans.length, 0, 'there would be nothing to restore from')
  } finally {
    fs.writeFileSync(transcript, saved)
  }
})
