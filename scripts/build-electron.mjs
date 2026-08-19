#!/usr/bin/env node
/*
 * Bundle the Electron main process into one file.
 *
 * The renderer has always been bundled by Vite. The main process was shipped as
 * source and left to resolve its own requires out of node_modules inside the
 * asar — which worked for as long as it required nothing but Electron itself.
 * The moment it gained electron-updater, that stopped being true, and getting
 * node_modules into the package turned out to behave differently on each
 * platform: the same electron-builder config produced an asar with the module on
 * macOS and Linux and without it on Windows, so the Windows build threw before
 * its first window.
 *
 * Bundling removes the question. One file, no node_modules in the app at all,
 * identical on every platform. `electron` stays external because it is provided
 * by the runtime and must never be inlined.
 */
import { build } from 'esbuild'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'dist-electron')

for (const entry of ['main.cjs', 'preload.cjs']) {
  await build({
    entryPoints: [join(ROOT, 'electron', entry)],
    outfile: join(OUT, entry),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    // Provided by the runtime. Inlining it would ship a second, broken copy.
    external: ['electron'],
    logLevel: 'silent',
  })
  console.log(`  bundled electron/${entry}`)
}
