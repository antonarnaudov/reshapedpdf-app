#!/usr/bin/env node
/*
 * Zooming must keep the point you aimed at where it was.
 *
 * The zoom effect scaled the scroll offset as if ALL scrolled content scaled, but
 * the column's padding and each page's margin do not — so the anchored point slid
 * by (padding + margin x pageIndex) x (k-1). Measured before the fix: one notch on
 * page 21 moved it 202px in an 821px viewport; five notches, 1899px. It grows with
 * page index, so it is invisible on page 1 and unusable deep in a document.
 *
 * The check anchors on a real page shell: note where a given page's top sits
 * relative to the viewport, zoom, and require it to still be there.
 *
 *   node tests/zoom-anchor-check.mjs
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, launchApp, sleep } from './harness/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PORT = Number(process.env.CDP_PORT || 9393)

const results = []
const rec = (id, ok, detail) => { results.push({ id, ok }); console.log(`  ${id.padEnd(30)} ${ok ? 'PASS' : 'FAIL'}  ${detail}`) }

async function main() {
  console.log('booting app…')
  const child = launchApp({ cwd: ROOT, port: PORT, userDataDir: join(HERE, '.artifacts', 'zoomanchor-profile') })
  const cdp = await connect({ port: PORT })
  await sleep(1600)
  let out
  try {
    await cdp.run('window.__reshapedpdf.openSample()')
    await sleep(1500)
    // a long document: the drift is proportional to page index, so 3 pages is not
    // enough to see it — duplicate up to ~24 pages first
    await cdp.run(`(() => {
      const st = window.__reshapedpdf.state
      for (let i = 0; i < 3; i++) {
        const d = st().docs[st().active]
        for (const p of [...d.pages]) st().duplicatePage(p.id)
      }
      return st().docs[st().active].pages.length
    })()`)
    await sleep(2500)
    out = await cdp.run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      const st = () => window.__reshapedpdf.state()
      st().setZoom(1); await sleep(900)
      const el = document.querySelector('.viewer-scroll')
      if (!el) return { err: 'no scroller' }
      const shells = () => [...document.querySelectorAll('.page-shell')]
      const n = shells().length
      const rows = []
      // skip page 1: parking it 120px down clamps scrollTop at 0, so it cannot be
      // set up the same way as the others and is not comparable
      for (const idx of [3, Math.floor(n / 2), n - 2].filter((i) => i >= 3 && i < n)) {
        st().setZoom(1); await sleep(700)
        // park the chosen page's top a little below the viewport top
        el.scrollTop = shells()[idx].offsetTop - 120
        await sleep(500)
        const before = shells()[idx].getBoundingClientRect().top
        st().setZoom(1.25)                        // one "notch"
        await sleep(800)
        const after = shells()[idx].getBoundingClientRect().top
        rows.push({ page: idx + 1, of: n, drift: +(after - before).toFixed(1) })
      }
      return { rows }
    })()`)
  } finally {
    cdp.close()
    try { child.kill('SIGKILL') } catch { /* gone */ }
  }

  if (out?.err) {
    rec('zoom-keeps-its-anchor', false, out.err)
  } else {
    // the anchored point is the viewport centre, not this page's top, so the top
    // legitimately moves as the page grows; what must NOT happen is drift that
    // scales with page index — compare each page against page 1's own drift
    const base = out.rows[0].drift
    const worst = Math.max(...out.rows.map((r) => Math.abs(r.drift - base)))
    rec('zoom-anchor-independent-of-page', worst < 12,
      out.rows.map((r) => `p${r.page}/${r.of}:${r.drift}px`).join('  ') + `  | spread vs page 1 = ${worst.toFixed(1)}px`)
  }

  const bad = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - bad}/${results.length} zoom-anchor invariants hold`)
  process.exit(bad ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(2) })
