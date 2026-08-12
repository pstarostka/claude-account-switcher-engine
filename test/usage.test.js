'use strict'

// The non-obvious part of usage.js is not reading the file, it is what a sample
// still means some time after it was taken.

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const usage = require('../src/usage.js')

/** A throwaway profile directory holding the given samples. */
function profile (...samples) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'case-usage-'))
  fs.writeFileSync(path.join(dir, 'plan-usage-history.json'),
    JSON.stringify({ version: 1, samples }))
  return dir
}

test('a fresh sample is reported as it was recorded', () => {
  const u = usage.read(profile({ t: Date.now() - 60_000, org: 'o', u: { fh: 42, sd: 7 } }))
  assert.equal(u.fh, 42)
  assert.equal(u.sd, 7)
})

test('the five-hour figure is known to be zero once that window has passed', () => {
  const u = usage.read(profile({ t: Date.now() - usage.FIVE_HOURS - 1000, u: { fh: 90, sd: 30 } }))
  assert.equal(u.fh, 0, 'that window has certainly reset since the sample')
  assert.equal(u.sd, 30, 'but the weekly one has not, so it still stands')
})

test('the weekly figure follows once a week has passed', () => {
  const u = usage.read(profile({ t: Date.now() - usage.ONE_WEEK - 1000, u: { fh: 90, sd: 30 } }))
  assert.equal(u.fh, 0)
  assert.equal(u.sd, 0)
})

test('the newest sample wins wherever it sits in the file', () => {
  const u = usage.read(profile(
    { t: Date.now() - 600_000, u: { fh: 10, sd: 1 } },
    { t: Date.now() - 60_000, u: { fh: 55, sd: 5 } },     // newest, listed in the middle
    { t: Date.now() - 300_000, u: { fh: 30, sd: 3 } }
  ))
  assert.equal(u.fh, 55)
})

test('readings outside 0–100 are clamped rather than shown', () => {
  const u = usage.read(profile({ t: Date.now(), u: { fh: 140, sd: -5 } }))
  assert.equal(u.fh, 100)
  assert.equal(u.sd, 0)
})

test('a profile Claude has never recorded usage for reads as nothing', () => {
  assert.equal(usage.read(fs.mkdtempSync(path.join(os.tmpdir(), 'case-usage-'))), null)
})

test('a corrupt history file is not fatal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'case-usage-'))
  fs.writeFileSync(path.join(dir, 'plan-usage-history.json'), '{ not json')
  assert.equal(usage.read(dir), null)
})
