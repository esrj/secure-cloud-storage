// Check what the Windows build really contains (Windows smart-classify fix plan §6.1):
//   - no .gguf model anywhere (the model is downloaded / imported after install);
//   - the CPU (win-x64) and Vulkan node-llama-cpp backends are unpacked from the asar;
//   - the CUDA backends are not shipped;
//   - fido_helper.py and config/default.yaml still ship;
//   - the NSIS installer stays under the ~2 GB limit, and its embedded app-64.7z
//     has the same contents (checked with electron-builder's own 7za).
//
// Run after `electron-builder --win --config electron-builder.win.cjs`
// (npm run build:win does both). Exits with code 1 on any failure.
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const dist = join(root, 'dist')
const unpacked = join(dist, 'win-unpacked')
const resources = join(unpacked, 'resources')
const nodeModules = join(resources, 'app.asar.unpacked', 'node_modules')
const installer = join(dist, `${pkg.name}-${pkg.version}-setup.exe`)
const NSIS_LIMIT = 2 * 1024 ** 3

let failed = 0
const ok = (msg) => console.log(`  ✓ ${msg}`)
const bad = (msg) => {
  failed += 1
  console.log(`  ✗ ${msg}`)
}
const check = (cond, msg) => (cond ? ok(msg) : bad(msg))
const mb = (n) => `${(n / 1024 ** 2).toFixed(0)} MB`

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

function checkTree(label, files, has) {
  const ggufs = files.filter((f) => f.toLowerCase().endsWith('.gguf'))
  check(
    ggufs.length === 0,
    `${label}: no .gguf model${ggufs.length ? ` (found ${ggufs.join(', ')})` : ''}`
  )
  check(
    has('@node-llama-cpp/win-x64/bins/win-x64/llama-addon.node'),
    `${label}: CPU backend (win-x64) present`
  )
  check(
    has('@node-llama-cpp/win-x64-vulkan/bins/win-x64-vulkan/llama-addon.node'),
    `${label}: Vulkan backend (win-x64-vulkan) present`
  )
  check(!has('@node-llama-cpp/win-x64-cuda/'), `${label}: CUDA backend not shipped`)
  check(!has('@node-llama-cpp/win-x64-cuda-ext/'), `${label}: CUDA runtime not shipped`)
  check(has('node-llama-cpp/dist/index.js'), `${label}: node-llama-cpp unpacked from the asar`)
  check(has('fido/fido_helper.py'), `${label}: fido/fido_helper.py present`)
}

console.log(`Windows build check (${pkg.name} ${pkg.version})`)

// 1) dist/win-unpacked
if (!existsSync(unpacked)) {
  bad(`missing ${relative(root, unpacked)} — run npm run build:win first`)
} else {
  const files = walk(unpacked).map((f) => relative(unpacked, f).replaceAll('\\', '/'))
  const has = (needle) => files.some((f) => f.includes(needle))
  checkTree('win-unpacked', files, has)
  check(existsSync(join(resources, 'app.asar')), 'win-unpacked: app.asar present')
  if (existsSync(join(resources, 'app.asar'))) {
    const asar = createRequire(import.meta.url)('@electron/asar')
    const inAsar = new Set(
      asar.listPackage(join(resources, 'app.asar')).map((p) => p.split(sep).join('/'))
    )
    check(inAsar.has('/config/default.yaml'), 'app.asar: config/default.yaml present')
    check(inAsar.has('/out/main/index.js'), 'app.asar: out/main/index.js present')
    check(!inAsar.has('/electron-builder.win.cjs'), 'app.asar: build config not packaged')
  }
  check(!existsSync(join(resources, 'models')), 'win-unpacked: no resources/models folder')
  check(existsSync(join(nodeModules, '@node-llama-cpp')), 'win-unpacked: @node-llama-cpp unpacked')
}

// 2) the installer itself
if (!existsSync(installer)) {
  bad(`missing ${relative(root, installer)}`)
} else {
  const size = statSync(installer).size
  check(
    size < NSIS_LIMIT,
    `installer ${relative(root, installer)} is ${mb(size)} (< 2 GB NSIS limit)`
  )

  const require = createRequire(import.meta.url)
  const sevenZip = require('7zip-bin').path7za
  const list = (archive) => {
    const l = spawnSync(sevenZip, ['l', '-slt', '-ba', archive], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024
    })
    return (l.stdout || '')
      .split(/\r?\n/)
      .filter((line) => line.startsWith('Path = '))
      .map((line) => line.slice('Path = '.length).replaceAll('\\', '/'))
  }

  // 7-Zip reads the app files straight out of electron-builder's NSIS installer.
  // Some layouts keep them in a nested $PLUGINSDIR/app-64.7z; unpack that if present.
  let entries = list(installer)
  const nested = entries.find((p) => /(^|\/)app-64\.7z$/i.test(p))
  const work = nested ? mkdtempSync(join(tmpdir(), 'scs-win-check-')) : null
  try {
    if (nested) {
      spawnSync(sevenZip, ['x', '-y', `-o${work}`, installer, nested], { encoding: 'utf8' })
      const archive = join(work, ...nested.split('/'))
      entries = existsSync(archive) ? list(archive) : []
    }
    const has = (needle) => entries.some((f) => f.includes(needle))
    check(entries.length > 0, `installer: lists ${entries.length} entries`)
    if (entries.length > 0) checkTree('installer', entries, has)
  } finally {
    if (work) rmSync(work, { recursive: true, force: true })
  }
}

if (failed) {
  console.log(`\n${failed} check(s) failed.`)
  process.exit(1)
}
console.log('\nAll Windows build checks passed.')
