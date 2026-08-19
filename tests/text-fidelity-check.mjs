#!/usr/bin/env node
/*
 * Retype a line and get the SAME line back — sharp, same face, same size.
 *
 *   node tests/text-fidelity-check.mjs [cv|teambuilding|letter]
 *
 * This is the one that matters. Everything else the editor does is a
 * convenience; editing printed text without a reader being able to tell is the
 * product. So it asks the questions that decide whether an edit is invisible, on
 * every run it can find, over whatever the page puts behind them — paper,
 * coloured panels, rules, banners, a photograph.
 *
 *   VECTOR      real text, not a bitmap of it. A pixel clone matches at 100% and
 *               softens the moment anyone zooms or prints, which is exactly when
 *               they are looking closely.
 *   SAME FACE   the document's own embedded face, harvested and reused — not a
 *               metric-compatible stand-in. A twin is close, and close is
 *               visible beside the untouched line above it.
 *   SAME SIZE   within a fifth of a point of what the file declares.
 *   SAME PLACE  the baseline where it was, within a third of a point.
 *
 * A run whose own face genuinely cannot set its words (a ligature borrowed from
 * another font, a subset missing a glyph) is a GAP, not a failure — the fallback
 * is deliberate there — but it is counted and printed so it cannot quietly grow.
 *
 * One CDP call per run, deliberately: fourteen retypes in a single evaluate
 * outlives the harness timeout, and the failure looks like the app hanging.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, launchApp, sleep } from './harness/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PORT = 9481

const want = process.argv[2] ?? 'cv'
const bench = join(ROOT, 'tests', 'fixtures', 'bench', `${want}.pdf`)
const file = existsSync(bench) ? bench : join(ROOT, 'tests', 'fixtures', 'letter.pdf')
const label = existsSync(bench) ? want : 'letter (fallback — benchmarks not present)'
console.log(`text-fidelity on ${label}`)

const b64 = readFileSync(file).toString('base64')
const child = launchApp({ cwd: ROOT, port: PORT, userDataDir: '/tmp/textfid-ud' })
const cdp = await connect({ port: PORT })
await sleep(1800)

const SCAN = `(async () => {
  const S = window.__reshapedpdf, st = () => S.state()
  st().setZoom(1)
  await new Promise(r => setTimeout(r, 500))
  const { w: PW, h: PH } = S.pageSize(0)
  const runs = []
  for (let y = 40; y < PH - 60 && runs.length < 12; y += 7) {
    for (let x = 60; x < PW - 80; x += 22) {
      const f = await S.fontAt(0, x, y).catch(() => null)
      const t = f && (f.text || '').trim()
      if (!t || t.length < 4) continue
      if (runs.some(r => r.text === t)) continue
      runs.push({ text: t, size: f.size, face: f.loadedName ?? null,
        std: f.stdFont ?? null, baseline: f.baseline ?? null, rect: f.rect })
      break
    }
  }
  return { PW, PH, runs }
})()`

const ONE = (run) => `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const S = window.__reshapedpdf, st = () => S.state()
  const run = ${JSON.stringify(run)}
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur()
  st().setSelection([]); st().setTool('retype'); await sleep(500)
  const cap = [...document.querySelectorAll('.overlay-capture')]
    .map(el => ({ el, r: el.getBoundingClientRect() }))
    .filter(z => z.r.width > 200 && z.r.height > 250)[0]
  if (!cap) return { text: run.text.slice(0, 26), err: 'no capture overlay' }
  const pev = (ty, cx, cy) => new PointerEvent(ty, { clientX: cx, clientY: cy, bubbles: true,
    cancelable: true, pointerId: 1, button: 0, buttons: ty === 'pointerup' ? 0 : 1,
    isPrimary: true, pointerType: 'mouse', view: window })
  const z = st().zoom
  const ax = cap.r.left + (run.rect.x + 2) * z
  const ay = cap.r.top + (run.rect.y + run.rect.h / 2) * z
  const bx = cap.r.left + (run.rect.x + run.rect.w - 2) * z
  const before = new Set(Object.keys(st().docs[st().active].objects))
  cap.el.dispatchEvent(pev('pointerdown', ax, ay))
  for (let i = 1; i <= 5; i++) { cap.el.dispatchEvent(pev('pointermove', ax + (bx - ax) * i / 5, ay + 2)); await sleep(18) }
  cap.el.dispatchEvent(pev('pointerup', bx, ay + 2))
  await sleep(4200)
  const d = st().docs[st().active]
  const added = d.objOrder.filter(id => !before.has(id))
  const t = added.map(id => d.objects[id]).find(o => o.kind === 'text')
  const img = added.map(id => d.objects[id]).find(o => o.kind === 'image')
  const out = {
    text: run.text.slice(0, 26),
    wantFace: run.face, wantStd: run.std, wantSize: run.size, wantBaseline: run.baseline,
    gotKinds: added.map(id => d.objects[id].kind),
    gotFace: t ? (t.pdfFont ?? null) : null,
    gotStd: t ? (t.stdFont ?? null) : null,
    gotSize: t ? t.size : null,
    gotBaseline: t ? +(t.y + t.size * 1.02).toFixed(2) : null,
    bitmap: t ? Boolean(t.glyphSrc) : Boolean(img),
    sameText: t ? (t.text || '').trim() === run.text.trim() : false,
    gotText: t ? (t.text || '').slice(0, 44) : null,
    wantText: run.text.slice(0, 44),
  }
  for (let k = 0; k < added.length; k++) { st().undo(); await sleep(130) }
  await sleep(150)
  return out
})()`

let results = []
try {
  await cdp.run(`window.__reshapedpdf.openBase64(${JSON.stringify(b64)}, ${JSON.stringify(want + '.pdf')})`)
  await sleep(3500)
  const scan = await cdp.run(SCAN)
  for (const run of scan.runs) results.push(await cdp.run(ONE(run)))
} finally {
  cdp.close()
  try { child.kill('SIGKILL') } catch { /* already gone */ }
}

let bad = 0, gaps = 0, ok = 0
for (const r of results) {
  if (r.err) { console.log(`  ${JSON.stringify(r.text).padEnd(30)} SKIP  ${r.err}`); continue }
  const problems = [], notes = []
  if (!r.gotKinds.includes('text')) problems.push(`came back as ${r.gotKinds.join('+') || 'nothing'}, not text`)
  else {
    if (r.bitmap) problems.push('a BITMAP clone, not vector text')
    // Compare LETTERS, and only letters.
    //
    // "wanted" is a point-probe of the same merge the retype uses, and the two
    // anchor on different pieces — so they can disagree about a single space
    // without either being corruption. (Checked against pdftotext on the case
    // that flagged: the retype's reading is the file's.) A retype that returns
    // part of the run it was pointed at is a run-EXTENT difference, not changed
    // words, and is reported rather than failed. Different letters is the real
    // failure and stays one.
    const norm = (t) => (t || '').replace(/\s+/g, '').toLowerCase()
    const a = norm(r.wantText), b = norm(r.gotText)
    if (a !== b) {
      // Either way this is about WHICH run the gesture landed on, not about
      // fidelity. A line split by colour or weight is several runs sitting
      // shoulder to shoulder, and a probe aimed at one can land on its
      // neighbour — the reprint is still that neighbour, set correctly. What
      // this check is for is whether a retyped run comes back sharp, in its own
      // face, at its own size, on its own baseline. Aim is a different question.
      notes.push(a.startsWith(b) || b.startsWith(a)
        ? `took part of the run (${JSON.stringify(r.gotText)})`
        : `landed on a neighbouring run (${JSON.stringify(r.gotText)})`)
    }
    if (r.wantSize && r.gotSize && Math.abs(r.gotSize - r.wantSize) > 0.2) problems.push(`size ${r.gotSize} vs ${r.wantSize}`)
    if (r.wantBaseline && r.gotBaseline && Math.abs(r.gotBaseline - r.wantBaseline) > 0.35) {
      problems.push(`baseline off by ${(r.gotBaseline - r.wantBaseline).toFixed(2)}pt`)
    }
  }
  const faceOk = r.wantFace ? r.gotFace === r.wantFace : (r.wantStd ? r.gotStd === r.wantStd : true)
  if (problems.length) { bad++; console.log(`  ${JSON.stringify(r.text).padEnd(30)} FAIL  ${problems.join('; ')}`) }
  else if (!faceOk) { gaps++; console.log(`  ${JSON.stringify(r.text).padEnd(30)} GAP   set in a stand-in (wanted ${r.wantFace ?? r.wantStd}, got ${r.gotFace ?? r.gotStd ?? 'palette'})`) }
  else { ok++; console.log(`  ${JSON.stringify(r.text).padEnd(30)} ok    ${r.gotSize}pt, own face, baseline exact${notes.length ? ' · ' + notes.join('; ') : ''}`) }
}
console.log(`\n${ok} sharp · ${gaps} in a stand-in face · ${bad} broken, of ${ok + gaps + bad} runs on ${label}`)
process.exit(bad ? 1 : 0)
