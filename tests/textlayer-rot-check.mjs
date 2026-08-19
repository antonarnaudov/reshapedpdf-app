#!/usr/bin/env node
/*
 * The selectable text layer must follow the page when it is rotated.
 *
 * pdf.js reports rotation ONLY through the `data-main-rotation` attribute and
 * expects the stylesheet to act on it (stock pdf_viewer.css does). This app
 * hand-rolls `.textLayer`, so the attribute was set and ignored: after a rotate
 * the spans stayed in the un-rotated frame, sitting on blank paper. Selection,
 * ⌘C, caret placement and any highlight made from a selection were all wrong —
 * measured here at up to 828px from the glyphs.
 *
 * The check compares the DOM span carrying a known word against the app's own
 * search rect for that word. Note it compares the RESIDUAL, not the raw distance:
 * the span covers a whole run ("IRONWORKS SUPPLY CO.") while the match is one
 * word, so there is a constant ~55px centre offset even at 0°. What must hold is
 * that this offset does not CHANGE when the page turns — that is exactly what
 * "the layer rotated with the page" means. (Comparing raw corners instead would
 * read a rotated box's opposite corner as a false error of the word's own width.)
 *
 *   node tests/textlayer-rot-check.mjs
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, launchApp, sleep } from './harness/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PORT = Number(process.env.CDP_PORT || 9391)

const results = []
const rec = (id, ok, detail) => { results.push({ id, ok }); console.log(`  ${id.padEnd(30)} ${ok ? 'PASS' : 'FAIL'}  ${detail}`) }

async function main() {
  console.log('booting app…')
  const child = launchApp({ cwd: ROOT, port: PORT, userDataDir: join(HERE, '.artifacts', 'textlayer-rot-profile') })
  const cdp = await connect({ port: PORT })
  await sleep(1600)
  let rows
  try {
    await cdp.run('window.__reshapedpdf.openSample()')
    await sleep(1600)
    await cdp.run('window.__reshapedpdf.state().setZoom(1)')
    await sleep(500)
    rows = await cdp.run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      const S = window.__reshapedpdf, st = () => S.state()
      const pid = st().docs[st().active].pages[0].id
      const out = []
      for (const turn of [0, 1, 1, 1]) {            // 0, 90, 180, 270
        if (turn) { st().rotatePages([pid], 1); await sleep(1600) }
        const hits = await S.searchActive('Ironworks')
        const shell = document.querySelector('.page-shell')
        const layer = document.querySelector('.textLayer')
        if (!hits.length || !shell || !layer) { out.push({ err: 'no hit/shell/layer' }); continue }
        const span = [...layer.querySelectorAll('span')].find(s => /ironworks/i.test(s.textContent || ''))
        if (!span) { out.push({ err: 'no span carrying the word' }); continue }
        const want = hits[0].rects[0], sr = shell.getBoundingClientRect(), b = span.getBoundingClientRect()
        const z = st().zoom
        const cx = (b.left + b.width / 2 - sr.left) / z, cy = (b.top + b.height / 2 - sr.top) / z
        out.push({
          rot: st().docs[st().active].pages[0].extraRot,
          attr: layer.getAttribute('data-main-rotation'),
          dist: +Math.hypot(cx - (want.x + want.w / 2), cy - (want.y + want.h / 2)).toFixed(1),
        })
      }
      return out
    })()`)
  } finally {
    cdp.close()
    try { child.kill('SIGKILL') } catch { /* gone */ }
  }

  const bad = rows.find((r) => r.err)
  if (bad) {
    rec('text-layer-follows-rotation', false, `could not measure: ${bad.err}`)
  } else {
    const base = rows[0].dist
    const drift = rows.map((r) => Math.abs(r.dist - base))
    const worst = Math.max(...drift)
    rec('text-layer-follows-rotation', worst < 8,
      rows.map((r) => `${r.rot}deg(attr=${r.attr}):${r.dist}`).join('  ') + `  | worst drift from 0deg = ${worst.toFixed(1)}px`)
    rec('rotation-attribute-tracks-page', rows.every((r) => Number(r.attr) === r.rot),
      `attrs=[${rows.map((r) => r.attr).join(',')}] rots=[${rows.map((r) => r.rot).join(',')}]`)
  }

  const fails = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - fails}/${results.length} text-layer rotation invariants hold`)
  process.exit(fails ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(2) })
