'use strict'

// Produces the image assets the app ships. With no argument, the macOS set;
// with --win, the Windows one.
//
//  * assets/icon.png        — the Dock icon, rasterised from assets/icon.svg,
//                             which is the source of truth for the artwork.
//  * assets/icon.ico        — the same artwork full-bleed, at the seven sizes
//                             Windows picks between.
//  * src/assets/tray*.png   — the menu-bar icon, drawn here instead. A 16px
//                             monochrome glyph is not a shrunken app icon; the
//                             arrows and the </> turn to mud at that size, so
//                             the tray keeps only the two-tile motif.
//  * src/assets/tray-win*.ico — the same glyph for the notification area, in
//                             black and white: unlike macOS, Windows does not
//                             recolour a tray icon, so both are shipped and the
//                             app picks by the taskbar's theme.
//  * src/assets/badge.png   — the taskbar overlay that stands in for a Dock badge.
//
// The tray drawing uses signed distance fields, so its edges are antialiased
// analytically rather than by supersampling. No image libraries either way.

const { execFileSync } = require('node:child_process')
const zlib = require('node:zlib')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const SIZE = 1024

// ------------------------------------------------------------------ shapes ---

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v)

/** Signed distance to a rounded rectangle centred at (cx, cy). */
function sdRoundRect (x, y, cx, cy, hw, hh, r) {
  const dx = Math.abs(x - cx) - (hw - r)
  const dy = Math.abs(y - cy) - (hh - r)
  const ax = Math.max(dx, 0)
  const ay = Math.max(dy, 0)
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r
}

/** Pixel coverage for a signed distance: 1 inside, 0 outside, soft across the edge. */
const coverage = d => clamp(0.5 - d, 0, 1)

// ----------------------------------------------------------- tray template ---

// An outlined tile behind a filled one: at 16px two filled tiles merge into a
// single blob, and two outlined ones lose their edges entirely.
//
// Black + alpha by default — macOS treats that as a template and inverts it as
// needed. Windows does no such thing, so it asks for the colour it wants.
function renderTray (size, [cr, cg, cb] = [0, 0, 0]) {
  const px = new Float64Array(size * size * 4)
  const s = size / 32

  const back = { cx: 12.4 * s, cy: 12.4 * s, hw: 8.2 * s, r: 2.9 * s }
  const front = { cx: 20.2 * s, cy: 20.2 * s, hw: 8.2 * s, r: 2.9 * s }
  const stroke = 2.3 * s

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const cx = x + 0.5
      const cy = y + 0.5

      // Ring of the back tile, minus where the front tile (plus a gap) covers it.
      const ring = Math.abs(sdRoundRect(cx, cy, back.cx, back.cy, back.hw, back.hw, back.r)) - stroke / 2
      const cut = coverage(sdRoundRect(cx, cy, front.cx, front.cy,
        front.hw + stroke * 0.6, front.hw + stroke * 0.6, front.r + stroke * 0.6))
      const ringA = coverage(ring) * (1 - cut)

      const frontA = coverage(sdRoundRect(cx, cy, front.cx, front.cy, front.hw, front.hw, front.r))

      const a = Math.min(1, ringA + frontA)
      if (a <= 0) continue
      px[i] = cr; px[i + 1] = cg; px[i + 2] = cb
      px[i + 3] = 255 * a
    }
  }

  const out = Buffer.alloc(size * size * 4)
  for (let i = 0; i < px.length; i++) out[i] = clamp(Math.round(px[i]), 0, 255)
  return out
}

// ------------------------------------------------------------------- badge ---

/**
 * A filled dot for the taskbar overlay, in the --danger red of the stylesheet.
 *
 * app.dock.setBadge has no Windows equivalent, and the count it would carry is
 * unreadable at 16px anyway — this only has to say "something", which the tray
 * menu and its tooltip then put a number to.
 */
function renderBadge (size) {
  const out = Buffer.alloc(size * size * 4)
  const c = size / 2
  const r = size / 2 - 0.5

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = coverage(Math.hypot(x + 0.5 - c, y + 0.5 - c) - r)
      if (a <= 0) continue
      const i = (y * size + x) * 4
      out[i] = 0xc0; out[i + 1] = 0x39; out[i + 2] = 0x2b
      out[i + 3] = clamp(Math.round(255 * a), 0, 255)
    }
  }
  return out
}

// --------------------------------------------------------------- png output ---

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32 (buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk (type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng (size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8    // bit depth
  ihdr[9] = 6    // truecolour with alpha
  // 10..12 stay zero: deflate, adaptive filtering, no interlace

  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// --------------------------------------------------------------- ico output ---

/**
 * Pack PNGs into a .ico: an ICONDIR, then one ICONDIRENTRY each, then the
 * payloads. Since Vista an entry may be a PNG verbatim, which is why this needs
 * no decoder — the bytes go in exactly as they came off disk.
 */
function ico (images) {                        // [{ size, png }]
  const dir = Buffer.alloc(6 + 16 * images.length)
  dir.writeUInt16LE(0, 0)                      // reserved
  dir.writeUInt16LE(1, 2)                      // type: icon
  dir.writeUInt16LE(images.length, 4)

  let offset = dir.length
  images.forEach((im, i) => {
    const e = 6 + i * 16
    // Width and height are one byte each, so 256 is written as 0.
    dir[e] = dir[e + 1] = im.size >= 256 ? 0 : im.size
    dir.writeUInt16LE(1, e + 4)                // colour planes
    dir.writeUInt16LE(32, e + 6)               // bits per pixel
    dir.writeUInt32LE(im.png.length, e + 8)
    dir.writeUInt32LE(offset, e + 12)
    offset += im.png.length
  })

  return Buffer.concat([dir, ...images.map(i => i.png)])
}

// --------------------------------------------------------------------- main ---

// The sizes Windows picks between: the small ones for the taskbar and Explorer
// lists, 256 for the large-icon views and the Start menu tile.
const ICO_SIZES = [256, 128, 64, 48, 32, 24, 16]
// What the notification area asks for across the DPI scales people run at.
const TRAY_SIZES = [16, 20, 24, 32, 40, 48]

// require('electron') from Node resolves to the path of the binary, not the API.
const rasterize = (svg, dest, sizes, mode) =>
  execFileSync(require('electron'),
    [path.join(__dirname, 'rasterize-icon.js'), svg, dest, sizes.join(','), mode],
    { stdio: ['ignore', 'ignore', 'inherit'], cwd: ROOT })

function makeMac (svg, assets, trayDir) {
  const dest = path.join(assets, 'icon.png')
  rasterize(svg, dest, [SIZE], 'mac')
  if (!fs.existsSync(dest)) throw new Error('icon rasterisation produced no file')
  console.log(`icon: ${path.relative(process.cwd(), dest)} (${SIZE}×${SIZE}, from icon.svg)`)

  for (const [px, name] of [[16, 'trayTemplate.png'], [32, 'trayTemplate@2x.png']]) {
    const f = path.join(trayDir, name)
    fs.writeFileSync(f, encodePng(px, renderTray(px)))
    console.log(`tray: ${path.relative(process.cwd(), f)} (${px}x${px})`)
  }
}

function makeWin (svg, assets, trayDir) {
  const base = path.join(assets, 'icon-win.png')
  rasterize(svg, base, ICO_SIZES, 'win')

  const parts = ICO_SIZES.map(size => {
    const f = base.replace(/\.png$/, `-${size}.png`)
    if (!fs.existsSync(f)) throw new Error(`icon rasterisation produced no ${size}px file`)
    return { size, png: fs.readFileSync(f) }
  })

  const dest = path.join(assets, 'icon.ico')
  fs.writeFileSync(dest, ico(parts))
  // The per-size PNGs were only ever scaffolding for the .ico.
  for (const size of ICO_SIZES) fs.rmSync(base.replace(/\.png$/, `-${size}.png`), { force: true })
  console.log(`icon: ${path.relative(process.cwd(), dest)} (${ICO_SIZES.length} sizes, from icon.svg)`)

  for (const [name, rgb] of [['tray-win.ico', [0, 0, 0]], ['tray-win-dark.ico', [255, 255, 255]]]) {
    const f = path.join(trayDir, name)
    fs.writeFileSync(f, ico(TRAY_SIZES.map(size =>
      ({ size, png: encodePng(size, renderTray(size, rgb)) }))))
    console.log(`tray: ${path.relative(process.cwd(), f)} (${TRAY_SIZES.length} sizes)`)
  }

  const badge = path.join(trayDir, 'badge.png')
  fs.writeFileSync(badge, encodePng(16, renderBadge(16)))
  console.log(`badge: ${path.relative(process.cwd(), badge)} (16x16)`)
}

if (require.main === module) {
  const svg = path.join(ROOT, 'assets', 'icon.svg')
  const assets = path.join(ROOT, 'assets')
  // Tray images ship inside src/ so they are packaged with the app.
  const trayDir = path.join(ROOT, 'src', 'assets')
  fs.mkdirSync(assets, { recursive: true })
  fs.mkdirSync(trayDir, { recursive: true })

  if (process.argv.includes('--win')) makeWin(svg, assets, trayDir)
  else makeMac(svg, assets, trayDir)
}

module.exports = { ico, encodePng, renderTray, renderBadge }
