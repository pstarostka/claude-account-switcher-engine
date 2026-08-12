'use strict'

// The pre-flight CI runs on every push. `npm run check` runs this and then the
// tests in test/; this half covers what no unit test can see:
//
//   * every source file parses
//   * the preload surface and the main process agree on their IPC channels
//   * the packaged version matches the tag being released (in CI only)
//
// The IPC check is the useful one. Renderer and main talk through strings, so a
// renamed channel fails at runtime, in a menu nobody opened, rather than here.

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const problems = []

// ------------------------------------------------------------ parse check ---

function sources (dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...sources(p))
    else if (e.name.endsWith('.js')) out.push(p)
  }
  return out
}

const files = [...sources(path.join(ROOT, 'src')), ...sources(path.join(ROOT, 'tools'))]
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' })
  } catch (e) {
    problems.push(`${path.relative(ROOT, f)} does not parse:\n${e.stderr}`)
  }
}
console.log(`parsed ${files.length} source files`)

// -------------------------------------------------------------- ipc check ---

const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8')

const mainSrc = read('src/main.js')
const preloadSrc = read('src/preload.js')

const handled = new Set([...mainSrc.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)].map(m => m[1]))
const sent = new Set([...mainSrc.matchAll(/webContents\.send\(\s*'([^']+)'/g)].map(m => m[1]))

const invoked = new Set([...preloadSrc.matchAll(/ipcRenderer\.invoke\(\s*'([^']+)'/g)].map(m => m[1]))
const listened = new Set([...preloadSrc.matchAll(/ipcRenderer\.on\(\s*'([^']+)'/g)].map(m => m[1]))

for (const ch of invoked) {
  if (!handled.has(ch)) problems.push(`preload invokes '${ch}', which main.js never handles`)
}
for (const ch of listened) {
  if (!sent.has(ch)) problems.push(`preload listens for '${ch}', which main.js never sends`)
}
for (const ch of handled) {
  if (!invoked.has(ch)) problems.push(`main.js handles '${ch}', which nothing invokes — dead channel`)
}
console.log(`checked ${invoked.size + listened.size} ipc channels`)

// Everything the renderer reaches for must exist on the preload bridge, and
// everything the bridge offers must be reached for — an exposed method nothing
// calls is IPC surface kept alive by nothing but habit.
const rendererSrc = read('src/renderer/renderer.js')
const exposed = new Set([...preloadSrc.matchAll(/^\s{2}(\w+):/gm)].map(m => m[1]))
const used = new Set([...rendererSrc.matchAll(/window\.api\.(\w+)/g)].map(m => m[1]))
for (const name of used) {
  if (!exposed.has(name)) problems.push(`renderer calls window.api.${name}, which preload does not expose`)
}
for (const name of exposed) {
  if (!used.has(name)) problems.push(`preload exposes ${name}, which the renderer never calls — dead bridge method`)
}
console.log(`checked ${exposed.size} bridge methods`)

// ---------------------------------------------------------- version check ---

const pkg = require(path.join(ROOT, 'package.json'))
const tag = process.env.GITHUB_REF_NAME
if (tag && /^v\d/.test(tag) && tag.replace(/^v/, '') !== pkg.version) {
  problems.push(`tag ${tag} does not match package.json version ${pkg.version}`)
}

// --------------------------------------------------------------------------

if (problems.length) {
  console.error(`\n${problems.length} problem${problems.length === 1 ? '' : 's'}:\n`)
  for (const p of problems) console.error(`  • ${p}`)
  process.exit(1)
}
console.log('\nall checks passed')
