#!/usr/bin/env node
/*
 * Does the thing we are about to publish actually start?
 *
 *   node tests/packaged-app-check.mjs          # after `npm run package`
 *
 * v0.1.0 and v0.1.1 shipped an app that could not open a window. The renderer is
 * bundled into dist/ by Vite, so `"!node_modules/**"` in the electron-builder
 * files list looked like sensible weight-saving — but the MAIN process is not
 * bundled, and it had just gained `require('electron-updater')`. The require
 * threw before the first window, on every platform, and every check we had still
 * passed: the suites drive a DEV build, the tag matched, the installers uploaded,
 * the release page looked perfect.
 *
 * So this reads the artifact itself. It resolves every bare `require()` in the
 * packaged main process against what is actually inside the asar, which is the
 * exact question that was never asked. Static on purpose: it wants no display
 * and no window, so it can run on every platform in CI before anything is
 * published.
 */
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The asar node API rather than `npx asar`: on Windows npx is npx.cmd, which
// execFileSync cannot find without a shell, and the check died there having
// proved nothing about the Windows build — the one platform none of us runs.
const require_ = createRequire(import.meta.url)
const asarApi = require_('@electron/asar')

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const REL = join(ROOT, 'release')

if (!existsSync(REL)) {
  console.log('no release/ directory — run `npm run package` first')
  process.exit(0)
}

// Find the app.asar of whichever platform was just built.
const candidates = []
for (const d of readdirSync(REL)) {
  const mac = join(REL, d, 'ReshapedPDF.app', 'Contents', 'Resources', 'app.asar')
  const other = join(REL, d, 'resources', 'app.asar')
  if (existsSync(mac)) candidates.push(mac)
  else if (existsSync(other)) candidates.push(other)
}
if (!candidates.length) {
  console.log('no packaged app.asar found under release/ — nothing to check')
  process.exit(0)
}

let bad = 0
for (const asar of candidates) {
  const rel = asar.slice(ROOT.length + 1)
  const files = new Set(asarApi.listPackage(asar))

  // extractFile returns the BYTES. The CLI's extract-file writes a file into the
  // working directory and prints nothing, so an earlier version of this check
  // read an empty stdout, saw no requires at all, and passed on the very app it
  // was written to reject.
  const main = Buffer.from(asarApi.extractFile(asar, 'electron/main.cjs')).toString('utf8')
  if (!main.includes('require(')) {
    console.log(`  FAIL  ${rel} — could not read the packaged main process`)
    bad++
    continue
  }

  // every bare module the main process pulls in at runtime
  const bare = [...main.matchAll(/require\(['"]([^'".][^'"]*)['"]\)/g)]
    .map((m) => m[1])
    .filter((n) => !n.startsWith('node:'))
  const builtin = new Set(['electron', 'fs', 'path', 'os', 'child_process', 'http', 'https', 'url', 'crypto', 'zlib', 'stream', 'util', 'events', 'net', 'buffer'])

  const missing = [...new Set(bare)].filter((n) => {
    if (builtin.has(n)) return false
    const root = n.startsWith('@') ? n.split('/').slice(0, 2).join('/') : n.split('/')[0]
    return !files.has(`/node_modules/${root}`) && ![...files].some((f) => f.startsWith(`/node_modules/${root}/`))
  })

  const ok = missing.length === 0
  if (!ok) bad++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${rel}`)
  console.log(`        main requires: ${[...new Set(bare)].filter((n) => !builtin.has(n)).join(', ') || '(only builtins)'}`)
  if (!ok) console.log(`        NOT IN THE BUNDLE: ${missing.join(', ')} — the app throws before its first window`)
}
console.log(`\n${candidates.length - bad}/${candidates.length} packaged apps can resolve everything their main process requires`)
process.exit(bad ? 1 : 0)
