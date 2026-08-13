'use strict'

// The .ico packer writes a binary format by hand, where every entry carries a
// byte offset into the file. Nothing downstream would report a wrong one: a
// malformed icon does not fail a build, it just renders as a blank square in the
// taskbar, on a machine nobody is looking at.

const { test } = require('node:test')
const assert = require('node:assert')

const { ico, encodePng, renderTray, renderBadge } = require('../tools/make-icon.js')

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const pack = sizes => ico(sizes.map(size => ({ size, png: encodePng(size, renderTray(size)) })))

test('the directory header says what it is and how many images follow', () => {
  const buf = pack([16, 32, 48])
  assert.equal(buf.readUInt16LE(0), 0, 'reserved')
  assert.equal(buf.readUInt16LE(2), 1, 'type: icon, not cursor')
  assert.equal(buf.readUInt16LE(4), 3)
})

test('every entry points at a real PNG, in bounds', () => {
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const buf = pack(sizes)

  sizes.forEach((size, i) => {
    const e = 6 + i * 16
    const len = buf.readUInt32LE(e + 8)
    const off = buf.readUInt32LE(e + 12)

    assert.ok(off + len <= buf.length, `${size}px runs past the end of the file`)
    assert.ok(buf.subarray(off, off + 8).equals(PNG_MAGIC), `${size}px is not a PNG`)
    assert.equal(buf.readUInt16LE(e + 4), 1, 'colour planes')
    assert.equal(buf.readUInt16LE(e + 6), 32, 'bits per pixel')
  })
})

test('256 is written as zero, because the width field is one byte', () => {
  const buf = pack([256, 16])
  assert.equal(buf[6], 0, 'a literal 256 would truncate to 0 anyway; this is the format saying so')
  assert.equal(buf[6 + 16], 16)
})

test('the payloads follow the directory, back to back and in order', () => {
  const sizes = [16, 32]
  const buf = pack(sizes)
  let expected = 6 + 16 * sizes.length

  sizes.forEach((_, i) => {
    const e = 6 + i * 16
    assert.equal(buf.readUInt32LE(e + 12), expected)
    expected += buf.readUInt32LE(e + 8)
  })
  assert.equal(expected, buf.length, 'no gaps and nothing trailing')
})

test('the tray glyph is drawn in the colour it is asked for', () => {
  // Windows does not recolour a tray icon the way macOS recolours a template,
  // so a light and a dark file are shipped and the app picks between them.
  const white = renderTray(32, [255, 255, 255])
  const black = renderTray(32, [0, 0, 0])

  const opaque = i => white[i + 3] > 200 && black[i + 3] > 200
  let checked = 0
  for (let i = 0; i < white.length; i += 4) {
    if (!opaque(i)) continue
    assert.equal(white[i], 255)
    assert.equal(black[i], 0)
    assert.equal(white[i + 3], black[i + 3], 'the shape itself is identical')
    checked++
  }
  assert.ok(checked > 100, 'the glyph should cover rather more than a few pixels')
})

test('the badge is a filled dot that reaches its own edges', () => {
  const size = 16
  const px = renderBadge(size)
  const alpha = (x, y) => px[(y * size + x) * 4 + 3]

  assert.ok(alpha(size / 2, size / 2) > 250, 'solid in the middle')
  assert.equal(alpha(0, 0), 0, 'and nothing in the corners')
  assert.ok(alpha(size / 2, 1) > 100, 'reaching the top edge')
})
