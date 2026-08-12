'use strict'

// Builds CASE.app.
//
//   node tools/build.js            → installs to ~/Applications for this Mac
//   node tools/build.js --dist     → universal zip + checksum in out/, no install
//
// Installing to the same path each time keeps an existing Dock pin working.
// The --dist build is what CI publishes to a release: one universal bundle, so
// there is a single download whatever Mac someone is on.

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const DIST = process.argv.includes('--dist')

const ROOT = path.join(__dirname, '..')
const ASSETS = path.join(ROOT, 'assets')
const ICONSET = path.join(ASSETS, 'icon.iconset')
const ICNS = path.join(ASSETS, 'icon.icns')
const OUT = path.join(ROOT, 'out')
const DEST = path.join(os.homedir(), 'Applications', 'CASE.app')
const LEGACY_DEST = path.join(os.homedir(), 'Applications', 'Claude Accounts.app')

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts })

/**
 * Package the bundle for a release. `ditto` rather than `zip`: it is the only
 * archiver here that preserves the symlinks inside a framework bundle and the
 * signature metadata, and it is what the updater unpacks with on the other end.
 */
function dist (src) {
  const pkg = require(path.join(ROOT, 'package.json'))
  const zip = path.join(OUT, `CASE-${pkg.version}-mac-universal.zip`)

  console.log('==> signing (ad-hoc)')
  try {
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', src], { stdio: 'ignore' })
  } catch {
    console.warn('    warning: ad-hoc signing failed')
  }

  console.log('==> archiving')
  fs.rmSync(zip, { force: true })
  sh('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', src, zip])

  // Published beside the zip so the updater can check what it downloaded.
  const sum = execFileSync('/usr/bin/shasum', ['-a', '256', path.basename(zip)],
    { cwd: OUT }).toString().trim()
  fs.writeFileSync(`${zip}.sha256`, sum + '\n')

  const mb = (fs.statSync(zip).size / 1e6).toFixed(1)
  console.log(`\nbuilt: ${path.relative(ROOT, zip)} (${mb} MB)`)
  console.log(`sha256: ${sum.split(/\s+/)[0]}`)
}

// ---------------------------------------------------------------- icon ---

console.log('==> icon')
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

// --------------------------------------------------------------- package ---

console.log('==> packaging')
const { packager } = require('@electron/packager')
const pkg = require(path.join(ROOT, 'package.json'))

packager({
  dir: ROOT,
  out: OUT,
  overwrite: true,
  platform: 'darwin',
  arch: DIST ? 'universal' : (process.arch === 'x64' ? 'x64' : 'arm64'),
  name: pkg.productName,
  appBundleId: 'local.launcher.case',
  appVersion: pkg.version,
  icon: ICNS,
  prune: true,
  quiet: true,
  ignore: [/^\/out/, /^\/tools/, /^\/test/, /^\/assets/, /^\/\.git/, /^\/README\.md$/]
}).then(([built]) => {
  const src = path.join(built, `${pkg.productName}.app`)

  if (DIST) return dist(src)

  console.log('==> installing')
  fs.mkdirSync(path.dirname(DEST), { recursive: true })
  fs.rmSync(DEST, { recursive: true, force: true })
  fs.cpSync(src, DEST, { recursive: true, verbatimSymlinks: true })

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
