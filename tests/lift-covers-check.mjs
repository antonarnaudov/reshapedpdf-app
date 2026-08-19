#!/usr/bin/env node
/*
 * Does a lift cover what it took?
 *
 *   node tests/lift-covers-check.mjs
 *
 * Lift builds the editable object and the patch that hides the original from two
 * different readings of the page. The object comes from buildTextObject, which
 * re-reads the spot with runFontInfo and grows the run across pdf.js's arbitrary
 * splits — so clicking one letter lifts the whole word, which is what anyone
 * would want. The patch was built from the single walked element: one glyph.
 *
 * The two disagreed by an order of magnitude and nothing compared them. On the
 * benchmark CV, clicking inside "Creativity" lifted 73.5pt of text behind a
 * 16.7pt patch that removed ONE span — 56.9pt of the printed word left sitting
 * on the page under the copy. Move the copy and the mutilated original appears;
 * export and the file carries "C eativity" and a duplicate.
 *
 * The invariant: whatever a lift hands you, the patch behind it is at least as
 * wide. It may be wider — it pads to catch antialiasing — but never narrower.
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { connect, launchApp, sleep } from './harness/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PORT = 9467

const b64 = readFileSync(join(ROOT, 'tests', 'fixtures', 'letter.pdf')).toString('base64')
const child = launchApp({ cwd: ROOT, port: PORT, userDataDir: '/tmp/liftcov-ud' })
const cdp = await connect({ port: PORT })
await sleep(1800)

let out
try {
  await cdp.run(`window.__reshapedpdf.openBase64(${JSON.stringify(b64)}, "letter.pdf")`)
  await sleep(3200)
  out = await cdp.run(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const S = window.__reshapedpdf, st = () => S.state()
    st().setZoom(1); await sleep(500)
    const results = []
    const { w: PW, h: PH } = S.pageSize(0)

    // aim INSIDE words, which is where the two readings diverge.
    // The first is deliberate: the fixture draws "Adaptability" as two adjacent
    // show operators, which is the shape that makes the run reading and the
    // element reading disagree. A scan alone would keep landing on lines the
    // file happens to emit whole, where they agree and nothing is proved.
    const spots = [{ x: 100, y: 443, text: 'Adaptability (split across two pieces)' }]
    for (let y = 200; y < PH - 120 && spots.length < 4; y += 13) {
      for (let x = 70; x < Math.min(PW - 140, 380); x += 26) {
        const f = await S.fontAt(0, x, y).catch(() => null)
        const t = f && (f.text || '').trim()
        if (t && t.length > 6 && !spots.some(s => s.text === t)) { spots.push({ x, y, text: t }); break }
      }
    }

    for (const sp of spots) {
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur()
      st().setSelection([]); st().setTool('lift'); await sleep(600)
      const cap = [...document.querySelectorAll('.overlay-capture')]
        .map(el => ({ el, r: el.getBoundingClientRect() }))
        .filter(x => x.r.width > 200 && x.r.height > 250)[0]
      if (!cap) { results.push({ text: sp.text, err: 'no capture overlay' }); continue }
      const pev = (ty, cx, cy) => new PointerEvent(ty, { clientX: cx, clientY: cy, bubbles: true,
        cancelable: true, pointerId: 1, button: 0, buttons: ty === 'pointerup' ? 0 : 1,
        isPrimary: true, pointerType: 'mouse', view: window })
      const z = st().zoom, cx = cap.r.left + sp.x * z, cy = cap.r.top + sp.y * z
      cap.el.dispatchEvent(pev('pointerdown', cx, cy)); cap.el.dispatchEvent(pev('pointerup', cx, cy))
      await sleep(1400)
      const before = new Set(Object.keys(st().docs[st().active].objects))
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await sleep(4000)
      const d = st().docs[st().active]
      const added = d.objOrder.filter(id => !before.has(id)).map(id => d.objects[id])
      const txt = added.find(o => o.kind === 'text')
      const wo = added.find(o => o.kind === 'whiteout')
      if (txt && wo) {
        results.push({ text: sp.text.slice(0, 26), lifted: +txt.w.toFixed(1),
          patch: +wo.w.toFixed(1), spans: (wo.removedSpans || []).length })
      } else if (added.length) {
        results.push({ text: sp.text.slice(0, 26), notText: added.map(o => o.kind).join('+') })
      } else {
        results.push({ text: sp.text.slice(0, 26), nothing: true })
      }
      for (let k = 0; k < added.length; k++) { st().undo(); await sleep(150) }
      await sleep(200)
    }
    return results
  })()`)
} finally {
  cdp.close()
  try { child.kill('SIGKILL') } catch { /* already gone */ }
}

let bad = 0, checked = 0
for (const r of out) {
  if (r.err || r.nothing) { console.log(`  ${JSON.stringify(r.text).padEnd(30)} SKIP  ${r.err ?? 'nothing was lifted'}`); continue }
  if (r.notText) { console.log(`  ${JSON.stringify(r.text).padEnd(30)} SKIP  lifted as ${r.notText}, not editable text`); continue }
  checked++
  const ok = r.patch >= r.lifted
  if (!ok) bad++
  console.log(`  ${JSON.stringify(r.text).padEnd(30)} ${ok ? 'PASS' : 'FAIL'}  lifted ${r.lifted}pt behind a ${r.patch}pt patch (${r.spans} span${r.spans === 1 ? '' : 's'} removed)${ok ? '' : ` — ${(r.lifted - r.patch).toFixed(1)}pt left on the page`}`)
}
if (!checked) { console.log('\nno editable-text lift could be measured'); process.exit(1) }
console.log(`\n${checked - bad}/${checked} lift-coverage invariants hold`)
process.exit(bad ? 1 : 0)
