#!/usr/bin/env node
/*
 * Does exporting change a page that nobody edited?
 *
 *   node tests/export-fidelity-check.mjs [cv|teambuilding|letter]
 *
 * The most basic promise the exporter makes is the one nothing tested: open a
 * document, touch nothing, export, and the page must come back the same. Every
 * suite so far measures the area AROUND an edit — residue, debris, the width of
 * a reprint — so a fault that shifts every page slightly, drops a vector fill,
 * or re-encodes an image softer would pass all of them, because they compare the
 * export against the export.
 *
 * This compares it against the ORIGINAL FILE, rendered by poppler, which shares
 * no code with anything in this repository. Two renders, one difference count.
 *
 * Then it does it again with a single edit on page 1, where the only thing that
 * may differ is the patch: everything outside the edited band must still match,
 * or the exporter is disturbing parts of the document nobody asked it to touch.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, launchApp, sleep } from './harness/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const TMP = join(HERE, '.artifacts', 'fidelity')
const PORT = 9451
const DPI = 100

try { execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' }) } catch {
  console.error('pdftoppm not found — install poppler. This check renders both files and')
  console.error('compares them; with no renderer it would pass without looking at anything.')
  process.exit(1)
}

const want = process.argv[2] ?? 'cv'
const benchPath = join(ROOT, 'tests', 'fixtures', 'bench', `${want}.pdf`)
const usingBench = existsSync(benchPath)
const src = usingBench ? benchPath : join(ROOT, 'tests', 'fixtures', 'letter.pdf')
const label = usingBench ? want : 'letter (fallback — no benchmark documents present)'

if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

/** Render page 1 to raw RGB, via poppler. */
function render(pdf, tag) {
  execFileSync('pdftoppm', ['-r', String(DPI), '-f', '1', '-l', '1', '-png', pdf, join(TMP, tag)], { stdio: 'ignore' })
  const png = join(TMP, `${tag}-1.png`)
  if (!existsSync(png)) throw new Error(`poppler produced nothing for ${tag}`)
  // convert to ppm so we can read pixels without a PNG decoder
  execFileSync('pdftoppm', ['-r', String(DPI), '-f', '1', '-l', '1', pdf, join(TMP, tag + 'raw')], { stdio: 'ignore' })
  const ppm = join(TMP, `${tag}raw-1.ppm`)
  const buf = readFileSync(ppm)
  // P6 header: magic, w, h, maxval
  let p = 0
  const tok = () => {
    while (buf[p] === 32 || buf[p] === 10 || buf[p] === 13 || buf[p] === 9) p++
    if (buf[p] === 35) { while (buf[p] !== 10) p++; return tok() }
    let s = ''
    while (p < buf.length && ![32, 10, 13, 9].includes(buf[p])) s += String.fromCharCode(buf[p++])
    return s
  }
  tok(); const w = +tok(), h = +tok(); tok(); p++
  return { w, h, data: buf.subarray(p) }
}

/** Fraction of pixels that differ by more than a just-noticeable amount. */
function diff(a, b, skip) {
  if (a.w !== b.w || a.h !== b.h) return { pct: 100, note: `size ${a.w}x${a.h} vs ${b.w}x${b.h}` }
  let bad = 0, tot = 0
  for (let y = 0; y < a.h; y++) {
    if (skip && y >= skip.y0 && y <= skip.y1) continue
    for (let x = 0; x < a.w; x++) {
      const i = (y * a.w + x) * 3
      tot++
      if (Math.abs(a.data[i] - b.data[i]) > 26 ||
          Math.abs(a.data[i + 1] - b.data[i + 1]) > 26 ||
          Math.abs(a.data[i + 2] - b.data[i + 2]) > 26) bad++
    }
  }
  return { pct: +((bad / tot) * 100).toFixed(3), note: '' }
}

console.log(`export-fidelity on ${label}`)
const b64 = readFileSync(src).toString('base64')
const child = launchApp({ cwd: ROOT, port: PORT, userDataDir: '/tmp/fidelity-ud' })
const cdp = await connect({ port: PORT })
await sleep(1800)

let exports_
try {
  await cdp.run(`window.__reshapedpdf.openBase64(${JSON.stringify(b64)}, ${JSON.stringify(want + '.pdf')})`)
  await sleep(3500)
  exports_ = await cdp.run(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const S = window.__reshapedpdf, st = () => S.state()
    const out = {}
    out.untouched = await S.exportActive({ trueRedact: true })

    // one erase over a real line, then export again
    st().setZoom(1); await sleep(400)
    const { w: PW, h: PH } = S.pageSize(0)
    let at = null
    for (let y = 100; y < PH - 120 && !at; y += 10) {
      for (let x = 60; x < Math.min(PW - 140, 420); x += 20) {
        const f = await S.fontAt(0, x, y).catch(() => null)
        if (f && (f.text || '').trim().length > 6) { at = { x, y }; break }
      }
    }
    if (!at) { out.editedSkipped = 'no text line found'; return out }
    st().setTool('whiteout'); await sleep(600)
    const cap = [...document.querySelectorAll('.overlay-capture')]
      .map(el => ({ el, r: el.getBoundingClientRect() }))
      .filter(x => x.r.width > 200 && x.r.height > 250)[0]
    if (!cap) { out.editedSkipped = 'no overlay'; return out }
    const pev = (ty, cx, cy) => new PointerEvent(ty, { clientX: cx, clientY: cy, bubbles: true,
      cancelable: true, pointerId: 1, button: 0, buttons: ty === 'pointerup' ? 0 : 1,
      isPrimary: true, pointerType: 'mouse', view: window })
    const z = st().zoom
    const ax = cap.r.left + at.x * z, ay = cap.r.top + (at.y - 4) * z
    const bx = cap.r.left + (at.x + 120) * z, by = cap.r.top + (at.y + 8) * z
    cap.el.dispatchEvent(pev('pointerdown', ax, ay))
    for (let i = 1; i <= 5; i++) { cap.el.dispatchEvent(pev('pointermove', ax + (bx-ax)*i/5, ay + (by-ay)*i/5)); await sleep(20) }
    cap.el.dispatchEvent(pev('pointerup', bx, by))
    await sleep(4000)
    out.edited = await S.exportActive({ trueRedact: true })
    out.editBand = { y0: at.y - 10, y1: at.y + 16 }
    return out
  })()`)
} finally {
  cdp.close()
  try { child.kill('SIGKILL') } catch { /* already gone */ }
}

const results = []
const orig = render(src, 'orig')

writeFileSync(join(TMP, 'untouched.pdf'), Buffer.from(exports_.untouched.b64, 'base64'))
const un = render(join(TMP, 'untouched.pdf'), 'untouched')
const d1 = diff(orig, un)
results.push({ name: 'export without editing', pct: d1.pct, limit: 0.5, note: d1.note })

if (exports_.edited) {
  writeFileSync(join(TMP, 'edited.pdf'), Buffer.from(exports_.edited.b64, 'base64'))
  const ed = render(join(TMP, 'edited.pdf'), 'edited')
  // everything OUTSIDE the edited band must be untouched
  const k = DPI / 72
  const skip = { y0: Math.floor(exports_.editBand.y0 * k), y1: Math.ceil(exports_.editBand.y1 * k) }
  const d2 = diff(orig, ed, skip)
  results.push({ name: 'rest of the page after one erase', pct: d2.pct, limit: 0.5, note: d2.note })
} else {
  console.log(`  (edited pass skipped: ${exports_.editedSkipped})`)
}

let bad = 0
for (const r of results) {
  const ok = r.pct <= r.limit
  if (!ok) bad++
  console.log(`  ${r.name.padEnd(34)} ${ok ? 'PASS' : 'FAIL'}  ${r.pct}% of pixels differ (limit ${r.limit}%) ${r.note}`)
}
console.log(`\n${results.length - bad}/${results.length} fidelity invariants hold on ${label}`)
if (bad) console.log(`artifacts: ${TMP}`)
process.exit(bad ? 1 : 0)
