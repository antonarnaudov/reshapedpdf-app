#!/usr/bin/env node
/*
 * The AI clean tool: draw around something and it comes off the page.
 *
 * What makes it worth having is what it does NOT do. Every phone removes an
 * object by inventing the pixels underneath, because a photograph is all it has.
 * A PDF is the instructions that drew the page, so the thing to remove is some
 * of those instructions — delete them and what appears is not a guess at the
 * background, it IS the background. The model is asked one question, "which
 * marks are the object", and everything after that is deterministic.
 *
 * So the properties worth pinning are:
 *   1. it RUNS off a drawn box and adds exactly one patch — not a stack of them,
 *      and not an image of the page;
 *   2. the object is GONE from the page — the dark banner it was told to clean
 *      comes back as bare paper;
 *   3. and gone from the FILE — the words it removed are out of the content
 *      stream, not merely painted over (the same leak the retype had);
 *   4. the rest of the page is UNTOUCHED;
 *   5. a model that answers with junk still cleans the box the user drew — the
 *      drawn box is the fallback answer — and must not throw or damage anything.
 *
 * The model only has to say where the object is, so a canned OpenAI-shaped reply
 * on localhost makes the whole thing deterministic.
 *
 *   node tests/clean-check.mjs
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { connect, launchApp, sleep } from './harness/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const OUT = join(HERE, '.artifacts', 'clean')
const PORT = Number(process.env.CDP_PORT || 9397)
const AI_PORT = PORT + 40
const DPI = 150
if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

// The box the user drags: the sample invoice's dark header banner and the words
// on it. Page is 612x792 view units.
const DRAG = { x: 0, y: 0, w: 612, h: 90 }
// what the stub says the object's extent is, as fractions of the crop it was
// shown — near enough the whole crop, which is what a model looking at a banner
// filling the frame would say
const OBJECT = [{ box: [0.01, 0.01, 0.99, 0.99] }]
const PRINTED = 'IRONWORKS SUPPLY CO.'   // on the banner, and again in the footer
const ELSEWHERE = 'Bulgaria'             // far down the page

let hits = 0
let junk = false
function fakeModel() {
  const srv = createServer((req, res) => {
    hits++
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const content = junk ? 'I would rather not.' : JSON.stringify(OBJECT)
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({
        id: 'fake', object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      }))
    })
  })
  return new Promise((ok) => srv.listen(AI_PORT, '127.0.0.1', () => ok(srv)))
}

/** fraction of a page-space rect that is near-white paper */
function paperFraction(pdf, prefix, rect) {
  execFileSync('pdftoppm', ['-r', String(DPI), '-f', '1', '-l', '1', pdf, prefix], { stdio: 'ignore' })
  const buf = readFileSync(`${prefix}-1.ppm`)
  let pos = 0
  const tok = () => { while ([32, 10, 13, 9].includes(buf[pos])) pos++; let s = ''; while (pos < buf.length && buf[pos] > 32) s += String.fromCharCode(buf[pos++]); return s }
  if (tok() !== 'P6') throw new Error('not a P6 ppm')
  const w = +tok(); tok(); tok(); pos++
  const k = DPI / 72
  let paper = 0, n = 0
  for (let y = Math.round(rect.y * k); y < Math.round((rect.y + rect.h) * k); y++) {
    for (let x = Math.round(rect.x * k); x < Math.round((rect.x + rect.w) * k); x++) {
      const i = pos + (y * w + x) * 3
      n++
      if (buf[i] > 225 && buf[i + 1] > 225 && buf[i + 2] > 225) paper++
    }
  }
  return n ? paper / n : 0
}

const results = []
const rec = (id, ok, detail) => { results.push({ id, ok }); console.log(`  ${id.padEnd(28)} ${ok ? 'PASS' : 'FAIL'}  ${detail}`) }

const DRAG_SCRIPT = (aiPort) => `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const S = window.__reshapedpdf, st = () => S.state()
  st().setAiConfig({ presetId: 'test', baseUrl: 'http://127.0.0.1:${aiPort}/v1', model: 'test', apiKey: 'x' })
  await sleep(200)
  st().setZoom(1); await sleep(400)
  const pristine = await S.exportActive()
  const before = new Set(Object.keys(st().docs[st().active].objects))
  st().setTool('clean'); await sleep(300)
  const cap = [...document.querySelectorAll('.overlay-capture')]
    .map(el => ({ el, r: el.getBoundingClientRect() }))
    .filter(x => x.r.width > 200 && x.r.height > 250)[0]
  if (!cap) return { err: 'no capture overlay' }
  const pev = (ty, cx, cy) => new PointerEvent(ty, { clientX: cx, clientY: cy, bubbles: true,
    cancelable: true, pointerId: 1, button: 0, buttons: ty === 'pointerup' ? 0 : 1, isPrimary: true,
    pointerType: 'mouse', view: window })
  const z = st().zoom, D = ${JSON.stringify(DRAG)}
  const ax = cap.r.left + D.x * z, ay = cap.r.top + D.y * z
  const bx = cap.r.left + (D.x + D.w) * z, by = cap.r.top + (D.y + D.h) * z
  cap.el.dispatchEvent(pev('pointerdown', ax, ay))
  for (let i = 1; i <= 6; i++) { cap.el.dispatchEvent(pev('pointermove', ax + (bx-ax)*i/6, ay + (by-ay)*i/6)); await sleep(20) }
  cap.el.dispatchEvent(pev('pointerup', bx, by))
  // the walk + true-background render take a moment on a busy machine
  for (let i = 0; i < 60 && st().busy; i++) await sleep(200)
  await sleep(600)
  const d = st().docs[st().active]
  const added = d.objOrder.filter(id => !before.has(id)).map(id => d.objects[id])
  return {
    kinds: added.map(o => o.kind),
    patches: added.filter(o => o.kind === 'whiteout').length,
    spans: added.reduce((n, o) => n + ((o.removedSpans || []).length), 0),
    toasts: st().toasts.map(t => t.text),
    pristine, after: await S.exportActive(),
  }
})()`

async function main() {
  const srv = await fakeModel()
  console.log(`fake vision model on 127.0.0.1:${AI_PORT}`)
  const child = launchApp({ cwd: ROOT, port: PORT, userDataDir: join(OUT, 'profile') })
  const cdp = await connect({ port: PORT })
  await sleep(1600)
  let r, jr = null
  try {
    await cdp.run('window.__reshapedpdf.openSample()')
    await sleep(1700)
    r = await cdp.run(DRAG_SCRIPT(AI_PORT))

    junk = true
    await cdp.run('window.__reshapedpdf.openSample()')
    await sleep(1700)
    jr = await cdp.run(DRAG_SCRIPT(AI_PORT))
  } finally {
    cdp.close()
    try { child.kill('SIGKILL') } catch { /* gone */ }
    srv.close()
  }

  const textOf = (p) => { try { return execFileSync('pdftotext', [p, '-'], { encoding: 'utf8' }) } catch { return '' } }
  const occurrences = (hay, needle) => hay.toLowerCase().split(needle.toLowerCase()).length - 1

  if (!r || r.err) { rec('clean-runs', false, (r && r.err) || 'no result') } else {
    // 1. one patch, and it is not a picture of the page
    rec('clean-runs', r.patches === 1 && !r.kinds.includes('image'),
      `added [${r.kinds.join(', ')}] carrying ${r.spans} removed span(s) — toasts=[${(r.toasts || []).join(' | ')}]`)

    const p0 = join(OUT, 'pristine.pdf'), p1 = join(OUT, 'cleaned.pdf')
    writeFileSync(p0, Buffer.from(r.pristine.b64, 'base64'))
    writeFileSync(p1, Buffer.from(r.after.b64, 'base64'))

    // 2. the banner is off the page — that band is bare paper now
    const paper = paperFraction(p1, join(OUT, 'cleaned'), { x: 20, y: 10, w: 560, h: 30 })
    rec('clean-removes-the-object', paper > 0.95,
      `${(paper * 100).toFixed(1)}% of the banner band is bare paper in the export (want >95%)`)

    // 3. and out of the FILE, not merely painted over
    const t0 = textOf(p0), t1 = textOf(p1)
    const was = occurrences(t0, PRINTED), now = occurrences(t1, PRINTED)
    rec('clean-removes-from-the-file', was > 0 && now === was - 1,
      `"${PRINTED}" went ${was} → ${now} (want ${was - 1}: the banner's copy gone, the footer's kept)`)

    // 4. nothing outside the box moved
    const wasE = occurrences(t0, ELSEWHERE), nowE = occurrences(t1, ELSEWHERE)
    rec('clean-spares-the-rest', wasE > 0 && nowE === wasE,
      `"${ELSEWHERE}", far outside the drawn box, went ${wasE} → ${nowE} (want ${wasE})`)
  }

  // 5. a model that won't answer still cleans what was drawn, and breaks nothing
  if (!jr || jr.err) { rec('clean-junk-reply-still-works', false, (jr && jr.err) || 'no result') } else {
    const q1 = join(OUT, 'junk-cleaned.pdf')
    writeFileSync(q1, Buffer.from(jr.after.b64, 'base64'))
    const paper = paperFraction(q1, join(OUT, 'junk-cleaned'), { x: 20, y: 10, w: 560, h: 30 })
    const t1 = textOf(q1)
    rec('clean-junk-reply-still-works', jr.patches === 1 && paper > 0.95 && occurrences(t1, ELSEWHERE) > 0,
      `patches=${jr.patches}, banner band ${(paper * 100).toFixed(1)}% paper, "${ELSEWHERE}" still present=${occurrences(t1, ELSEWHERE) > 0}`)
  }

  console.log(`  (model was called ${hits} time(s))`)
  const bad = results.filter((x) => !x.ok).length
  console.log(`\n${results.length - bad}/${results.length} clean invariants hold`)
  process.exit(bad ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(2) })
