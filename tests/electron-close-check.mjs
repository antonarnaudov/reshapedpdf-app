#!/usr/bin/env node
/*
 * Closing the desktop window must not silently destroy unsaved work.
 *
 * The whole session lives in memory until the user exports, and a renderer
 * `beforeunload` prompt is suppressed in Electron — so the guard has to live in
 * the main process. It didn't: ⌘W / ⌘Q / ⌘R ended the session with no prompt and
 * no way back. The renderer now pushes the dirty-document count over IPC and main
 * vetoes the close.
 *
 * Under --enable-automation there is nobody to answer the modal, so the guard
 * always holds; that is what makes it testable. A CLEAN document must still close
 * normally — a guard that never lets go is its own bug.
 *
 *   node tests/electron-close-check.mjs
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, launchApp, sleep } from './harness/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const BASE = Number(process.env.CDP_PORT || 9386)

const results = []
const rec = (id, ok, detail) => { results.push({ id, ok }); console.log(`  ${id.padEnd(28)} ${ok ? 'PASS' : 'FAIL'}  ${detail}`) }

// A CDP eval that starts a window teardown may never settle — the target can go
// away mid-call. Bound every such call so a stuck one fails the case, not the run.
const bounded = (p, ms, fallback) =>
  Promise.race([Promise.resolve(p).catch(() => fallback), new Promise((r) => setTimeout(() => r(fallback), ms))])

/** Is a page still open on this debugging port? (out-of-band, so a closing page can't stall it) */
async function hasPageTarget(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(4000) })
    return (await res.json()).some((t) => t.type === 'page')
  } catch {
    return false // port gone => app exited
  }
}

/** Open the sample, optionally dirty it, ask the window to close, report whether it survived. */
async function attemptClose({ dirty, port, profile }) {
  const child = launchApp({ cwd: ROOT, port, userDataDir: join(HERE, '.artifacts', profile) })
  const cdp = await connect({ port })
  await sleep(1600)
  try {
    await cdp.run('window.__reshapedpdf.openSample()')
    await sleep(900)
    if (dirty) {
      await cdp.run(`(() => {
        const st = window.__reshapedpdf.state, d = st().docs[st().active]
        st().addObject({ id: 'ec1', page: d.pages[0].id, kind: 'text', opacity: 1, x: 40, y: 40,
          w: 120, h: 24, text: 'unsaved', color: '#000000', size: 14, font: 'sans', bold: false }, { select: false })
        return true
      })()`)
    }
    await sleep(600) // let the dirty count reach the main process
    const isDirty = await cdp.run('Object.values(window.__reshapedpdf.state().docs).some(d => d.dirty)')
    // the real close path (what the red button and ⌘W do); a renderer window.close()
    // never raises BrowserWindow's 'close', so it would not exercise the guard at all
    await bounded(cdp.run('(() => { window.reshapedpdfNative.testClose(); return 1 })()'), 4000, null)
    await sleep(1500)
    // Ask the debugger, not the page: once a close is in flight the renderer stops
    // answering evaluations even when the close is then vetoed, so an in-page probe
    // reports "dead" for a window that is very much alive. A page target on the
    // debugging port means the window survived.
    const alive = await hasPageTarget(port)
    return { alive, isDirty }
  } finally {
    // Release the guard before tearing down. A vetoed window keeps Electron alive,
    // and killing the npm wrapper does not kill it — it would hold the debugging
    // port and break the next run. Mark everything saved so the close goes through.
    try {
      await bounded(cdp.run(`(() => {
        const st = window.__reshapedpdf.state
        for (const id of Object.keys(st().docs)) st().markSaved(id)
        window.reshapedpdfNative.testClose()
        return 1
      })()`), 4000, null)
      await sleep(700)
    } catch { /* window already gone */ }
    try { cdp.close() } catch { /* already gone */ }
    try { child.kill('SIGKILL') } catch { /* gone */ }
    await sleep(500)
  }
}

async function main() {
  console.log('booting app…')
  const d = await attemptClose({ dirty: true, port: BASE, profile: 'close-dirty' })
  rec('dirty-close-is-vetoed', d.isDirty === true && d.alive === true,
    `doc dirty=${d.isDirty}, window still alive after close=${d.alive} (must be true)`)

  const c = await attemptClose({ dirty: false, port: BASE + 1, profile: 'close-clean' })
  rec('clean-close-still-works', c.isDirty === false && c.alive === false,
    `doc dirty=${c.isDirty}, window alive after close=${c.alive} (must be false)`)

  const bad = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - bad}/${results.length} close-guard invariants hold`)
  process.exit(bad ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(2) })
