'use strict'

// Rasterises assets/icon.svg into the app icon, run under Electron so Chromium
// does the SVG work — no image dependency, and it is the same renderer the app
// itself draws with.
//
//   rasterize-icon.js <svg> <out.png> <sizes-csv> [mac|win]
//
// Two things happen here that a plain SVG-to-PNG would not do:
//
//  * On macOS the art is inset to Apple's icon grid. A full-bleed square would
//    sit in the Dock as a square tile among everyone else's squircles.
//  * The squircle is clipped with border-radius, so the corners come out
//    genuinely transparent rather than cream.
//
// Windows is the opposite case and wants neither. It does not mask app icons, so
// an inset squircle there reads as a small icon floating in a hole — the plate
// becomes the whole square, edge to edge and opaque.
//
// Offscreen rendering, because a 1024×1024 window is taller than the screen and
// macOS would otherwise clamp it and capture a truncated icon.

const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')

const [, , svgPath, outPath, sizesArg, mode] = process.argv
const WIN = mode === 'win'

// Rendered once at full size and stepped down from there. Asking Chromium for a
// 16px SVG directly turns the drawing to mud; resampling a large one does not.
const SIZE = 1024
const SIZES = String(sizesArg || SIZE).split(',').map(Number).filter(Boolean)

// Apple's grid: the rounded square is 824 of 1024, corner radius 185.4.
const INSET = WIN ? 0 : Math.round((SIZE * 100) / 1024)
const ART = SIZE - INSET * 2
const RADIUS = WIN ? 0 : Math.round((ART * 185.4) / 824)

// The drawing inside icon.svg occupies x 330–930, y 263–916 of its 1254 box —
// about 52% of it, which would leave the Dock icon looking half empty. Scaling
// about the drawing's own centre brings it to the ~78% Apple's grid expects,
// and the background rect scales with it, so the plate stays filled.
const ART_BOX = { x0: 330, y0: 263, x1: 930, y1: 916, canvas: 1254 }
const ORIGIN_X = ((ART_BOX.x0 + ART_BOX.x1) / 2 / ART_BOX.canvas) * 100
const ORIGIN_Y = ((ART_BOX.y0 + ART_BOX.y1) / 2 / ART_BOX.canvas) * 100
const SCALE = 0.78 / ((ART_BOX.y1 - ART_BOX.y0) / ART_BOX.canvas)

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    enableLargerThanScreen: true,
    useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false }
  })

  const svg = fs.readFileSync(svgPath, 'utf8')
  const html = `<!doctype html><meta charset="utf-8"><style>
    html, body { margin: 0; width: ${SIZE}px; height: ${SIZE}px; background: transparent; overflow: hidden; }
    #plate { position: absolute; left: ${INSET}px; top: ${INSET}px;
             width: ${ART}px; height: ${ART}px;
             border-radius: ${RADIUS}px; overflow: hidden; }
    #plate svg { display: block; width: 100%; height: 100%;
                 transform: scale(${SCALE.toFixed(4)});
                 transform-origin: ${ORIGIN_X.toFixed(3)}% ${ORIGIN_Y.toFixed(3)}%; }
  </style><div id="plate">${svg}</div>`

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  // Offscreen rendering paints asynchronously; capturing too early yields blank.
  await new Promise(r => setTimeout(r, 600))

  let img = await win.webContents.capturePage()
  // On a Retina display the capture comes back at the backing scale.
  if (img.getSize().width !== SIZE) {
    img = img.resize({ width: SIZE, height: SIZE, quality: 'best' })
  }

  // One size keeps the plain name, so the macOS path is unchanged; a set gets
  // the size appended, which is what the .ico packer reads back.
  for (const s of SIZES) {
    const out = s === SIZE ? img : img.resize({ width: s, height: s, quality: 'best' })
    const file = SIZES.length === 1 ? outPath : outPath.replace(/\.png$/, `-${s}.png`)
    fs.writeFileSync(file, out.toPNG())
  }
  app.exit(0)
})
