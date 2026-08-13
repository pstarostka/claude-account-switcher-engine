'use strict'

// Builds CASE, for whichever platform it is run on.
//
//   node tools/build.js            → installs locally, for this machine
//   node tools/build.js --dist     → zip + checksum in out/, no install
//
// Installing to the same path each time keeps an existing Dock pin or Start menu
// shortcut working. The --dist build is what CI publishes to a release: a
// universal bundle on macOS, so there is a single download whatever Mac someone
// is on, and an x64 folder on Windows.
//
// Cross-building is deliberately not supported. @electron/packager writes the
// Windows icon and version resources through rcedit, which needs Wine off
// Windows, and a macOS bundle cannot be signed anywhere else — so each artifact
// comes from its own machine or its own CI runner.

const { execFileSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const DIST = process.argv.includes('--dist')
const WIN = process.platform === 'win32'

const ROOT = path.join(__dirname, '..')
const ASSETS = path.join(ROOT, 'assets')
const ICONSET = path.join(ASSETS, 'icon.iconset')
const ICNS = path.join(ASSETS, 'icon.icns')
const ICO = path.join(ASSETS, 'icon.ico')
const OUT = path.join(ROOT, 'out')

const DEST = WIN
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'CASE')
  : path.join(os.homedir(), 'Applications', 'CASE.app')
const LEGACY_DEST = path.join(os.homedir(), 'Applications', 'Claude Accounts.app')

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts })

const ps = script =>
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { stdio: 'inherit', cwd: ROOT, windowsHide: true })

/** PowerShell single-quoting: the quote itself is the only character that escapes. */
const pq = s => `'${String(s).replace(/'/g, "''")}'`

/**
 * The checksum published beside the zip, in the format `shasum -c` reads.
 *
 * Done in Node rather than by shelling out, because `shasum` is not a Windows
 * command and `Get-FileHash` prints something else entirely. One code path, and
 * both of those still verify what it writes.
 */
function writeChecksum (zip) {
  const hex = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex')
  fs.writeFileSync(`${zip}.sha256`, `${hex}  ${path.basename(zip)}\n`)
  return hex
}

/**
 * Package for a release.
 *
 * On macOS, `ditto` rather than `zip`: it is the only archiver here that
 * preserves the symlinks inside a framework bundle and the signature metadata,
 * and it is what the updater unpacks with on the other end. On Windows the
 * bundle is a plain folder, so what matters is only that it lands inside the
 * zip under a directory of its own — which is what --keepParent gives on the
 * other side, and what the updater looks for.
 */
function dist (src) {
  const pkg = require(path.join(ROOT, 'package.json'))
  const zip = path.join(OUT, `CASE-${pkg.version}-${WIN ? 'win-x64' : 'mac-universal'}.zip`)
  fs.rmSync(zip, { force: true })

  if (WIN) {
    console.log('==> archiving')
    const stage = path.join(OUT, 'stage')
    fs.rmSync(stage, { recursive: true, force: true })
    fs.mkdirSync(stage, { recursive: true })
    fs.cpSync(src, path.join(stage, 'CASE'), { recursive: true })
    ps('Add-Type -AssemblyName System.IO.Compression.FileSystem; ' +
       `[IO.Compression.ZipFile]::CreateFromDirectory(${pq(stage)}, ${pq(zip)})`)
    fs.rmSync(stage, { recursive: true, force: true })
  } else {
    console.log('==> signing (ad-hoc)')
    try {
      execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', src], { stdio: 'ignore' })
    } catch {
      console.warn('    warning: ad-hoc signing failed')
    }

    console.log('==> archiving')
    sh('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', src, zip])
  }

  const hex = writeChecksum(zip)
  const mb = (fs.statSync(zip).size / 1e6).toFixed(1)
  console.log(`\nbuilt: ${path.relative(ROOT, zip)} (${mb} MB)`)
  console.log(`sha256: ${hex}`)
}

// ---------------------------------------------------------------- icon ---

console.log('==> icon')

if (WIN) {
  // make-icon.js writes the .ico itself: an .ico is a container of PNGs, so
  // there is no iconutil step to mirror and nothing to resize afterwards.
  sh(process.execPath, [path.join(ROOT, 'tools', 'make-icon.js'), '--win'])
  console.log(`    ${path.relative(ROOT, ICO)}`)
} else {
  sh(process.execPath, [path.join(ROOT, 'tools', 'make-icon.js')])

  fs.rmSync(ICONSET, { recursive: true, force: true })
  fs.mkdirSync(ICONSET, { recursive: true })

  // The set macOS expects; anything missing makes iconutil refuse the bundle.
  for (const [size, scale] of [[16, 1], [16, 2], [32, 1], [32, 2], [128, 1], [128, 2],
    [256, 1], [256, 2], [512, 1], [512, 2]]) {
    const px = size * scale
    const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`
    sh('/usr/bin/sips', ['-z', String(px), String(px), path.join(ASSETS, 'icon.png'),
      '--out', path.join(ICONSET, name)], { stdio: 'ignore' })
  }
  sh('/usr/bin/iconutil', ['-c', 'icns', ICONSET, '-o', ICNS])
  console.log(`    ${path.relative(ROOT, ICNS)}`)
}

// --------------------------------------------------------------- package ---

console.log('==> packaging')
const { packager } = require('@electron/packager')
const pkg = require(path.join(ROOT, 'package.json'))

packager({
  dir: ROOT,
  out: OUT,
  overwrite: true,
  platform: WIN ? 'win32' : 'darwin',
  arch: WIN ? 'x64' : (DIST ? 'universal' : (process.arch === 'x64' ? 'x64' : 'arm64')),
  name: pkg.productName,
  appBundleId: 'local.launcher.case',
  appVersion: pkg.version,
  icon: WIN ? ICO : ICNS,
  // Windows carries its identity in the exe's resources rather than a plist.
  win32metadata: {
    CompanyName: 'CASE',
    FileDescription: 'CASE — Claude Account Switcher Engine',
    ProductName: pkg.productName,
    OriginalFilename: `${pkg.productName}.exe`
  },
  prune: true,
  quiet: true,
  ignore: [/^\/out/, /^\/tools/, /^\/test/, /^\/assets/, /^\/\.git/, /^\/README\.md$/]
}).then(([built]) => {
  const src = WIN ? built : path.join(built, `${pkg.productName}.app`)

  if (DIST) return dist(src)

  console.log('==> installing')
  fs.mkdirSync(path.dirname(DEST), { recursive: true })
  fs.rmSync(DEST, { recursive: true, force: true })
  fs.cpSync(src, DEST, { recursive: true, verbatimSymlinks: true })

  if (WIN) {
    // A Start menu entry, so the app is reachable and pinnable. WScript.Shell
    // cannot set an AppUserModelID, which is what Windows matches a toast
    // against — the button inside the app rewrites this same .lnk with one.
    const lnk = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'CASE.lnk')
    const exe = path.join(DEST, `${pkg.productName}.exe`)
    try {
      ps(`$s = (New-Object -COM WScript.Shell).CreateShortcut(${pq(lnk)}); ` +
         `$s.TargetPath = ${pq(exe)}; $s.WorkingDirectory = ${pq(DEST)}; ` +
         '$s.Description = \'CASE — Claude Account Switcher Engine\'; $s.Save()')
      console.log(`    ${lnk}`)
    } catch {
      console.warn('    warning: could not create the Start menu shortcut')
    }

    console.log(`\ninstalled: ${DEST}`)
    console.log('press “Add to Start menu” in the app once, so notifications work')
    return
  }

  // Ad-hoc signature: enough for a locally built bundle, keeps Gatekeeper quiet.
  try {
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', DEST], { stdio: 'ignore' })
  } catch {
    console.warn('    warning: ad-hoc signing failed (the app will still run)')
  }

  // Nudge LaunchServices and the Dock so a pinned tile picks up the new icon.
  const lsreg = '/System/Library/Frameworks/CoreServices.framework/Frameworks/' +
                'LaunchServices.framework/Support/lsregister'
  try { execFileSync(lsreg, ['-f', DEST], { stdio: 'ignore' }) } catch {}

  // Leave no pre-rename copy behind to be launched by accident.
  if (fs.existsSync(LEGACY_DEST)) {
    fs.rmSync(LEGACY_DEST, { recursive: true, force: true })
    console.log(`    removed old bundle: ${LEGACY_DEST}`)
  }

  console.log(`\ninstalled: ${DEST}`)
  console.log('if a pinned Dock icon looks stale, run:  killall Dock')
}).catch(err => {
  console.error(err)
  process.exit(1)
})
