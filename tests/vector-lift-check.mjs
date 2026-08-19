#!/usr/bin/env node
/*
 * Does a curve come off the page as VECTORS, or as a picture of a curve?
 *
 *   node tests/vector-lift-check.mjs
 *
 * The lift tool could always name two shapes — an axis-aligned rectangle and a
 * straight line — and handed back everything else as a raster of itself. That is
 * most of the interesting artwork on a page: logos, icons, rounded panels, the
 * plot line of a chart. A picture of a curve cannot be recoloured, cannot be
 * resized without softening, and exports as pixels.
 *
 * The walker records the path's own construction operators, transformed into
 * user space, so the geometry is there to be reused. This checks the whole way
 * through: the fixture's ellipse (drawn by pdf-lib as Bezier segments, which is
 * the `c` operator) is lifted, and must come back as a vector object carrying a
 * path — then the document must still export.
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { connect, launchApp, sleep } from './harness/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PORT = 9484

// the ellipse make-fixtures draws, in view space
const CURVE = { x: 424, y: 420, w: 92, h: 52 }

const b64 = readFileSync(join(ROOT, 'tests', 'fixtures', 'letter.pdf')).toString('base64')
const child = launchApp({ cwd: ROOT, port: PORT, userDataDir: '/tmp/veclift-ud' })
const cdp = await connect({ port: PORT })
await sleep(1800)

let r
try {
  await cdp.run(`window.__reshapedpdf.openBase64(${JSON.stringify(b64)}, "letter.pdf")`)
  await sleep(3200)
  r = await cdp.run(`(async () => {
    const sleep = (ms) => new Promise(res => setTimeout(res, ms))
    const S = window.__reshapedpdf, st = () => S.state()
    const C = ${JSON.stringify(CURVE)}
    st().setZoom(1); st().setSelection([]); st().setTool('lift'); await sleep(700)
    const cap = [...document.querySelectorAll('.overlay-capture')]
      .map(el => ({ el, r: el.getBoundingClientRect() }))
      .filter(z => z.r.width > 200 && z.r.height > 250)[0]
    if (!cap) return { err: 'no capture overlay' }
    const pev = (ty, cx, cy) => new PointerEvent(ty, { clientX: cx, clientY: cy, bubbles: true,
      cancelable: true, pointerId: 1, button: 0, buttons: ty === 'pointerup' ? 0 : 1,
      isPrimary: true, pointerType: 'mouse', view: window })
    const z = st().zoom
    const cx = cap.r.left + (C.x + C.w / 2) * z, cy = cap.r.top + (C.y + C.h / 2) * z
    cap.el.dispatchEvent(pev('pointerdown', cx, cy))
    cap.el.dispatchEvent(pev('pointerup', cx, cy))
    await sleep(1500)
    const preview = st().liftPreview ? st().liftPreview.label : null
    const before = new Set(Object.keys(st().docs[st().active].objects))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await sleep(3500)
    const d = st().docs[st().active]
    const added = d.objOrder.filter(id => !before.has(id)).map(id => d.objects[id])
    const v = added.find(o => o.kind === 'vector')
    let exportBytes = 0, exportErr = null
    try { const e = await S.exportActive({ trueRedact: false }); exportBytes = e ? e.size : 0 }
    catch (err) { exportErr = String(err && err.message || err).slice(0, 60) }
    return {
      preview, kinds: added.map(o => o.kind),
      vector: v ? { dLen: (v.d || '').length, segs: ((v.d || '').match(/[MLCQZ]/g) || []).length,
        w: +v.w.toFixed(1), h: +v.h.toFixed(1), fill: v.fill, curved: /C/.test(v.d || '') } : null,
      exportBytes, exportErr,
    }
  })()`)
} finally {
  cdp.close()
  try { child.kill('SIGKILL') } catch { /* already gone */ }
}

if (process.env.VDEBUG) console.log('  raw:', JSON.stringify(r))
const checks = [
  ['lifted as a vector', Boolean(r.vector), r.vector ? `${r.vector.segs} segments, ${r.vector.w}x${r.vector.h}pt` : `got ${r.kinds?.join('+') || r.err || 'nothing'}`],
  ['kept its curves', Boolean(r.vector?.curved), r.vector ? (r.vector.curved ? 'Bezier segments preserved' : 'flattened to straight lines') : '—'],
  ['kept its fill', Boolean(r.vector?.fill), r.vector?.fill ?? '—'],
  ['still exports', r.exportBytes > 0 && !r.exportErr, r.exportErr ?? `${r.exportBytes} bytes`],
]
let bad = 0
for (const [name, ok, detail] of checks) {
  if (!ok) bad++
  console.log(`  ${name.padEnd(20)} ${ok ? 'PASS' : 'FAIL'}  ${detail}`)
}
console.log(`\n${checks.length - bad}/${checks.length} vectorisation invariants hold`)
process.exit(bad ? 1 : 0)
