#!/usr/bin/env node
/*
 * What peel is actually FOR: turn printed text into editable text, leave nothing
 * of the original behind, and don't flatten the page into a picture doing it.
 *
 * peel-check only parses bounding boxes out of model replies — it never runs a
 * peel. So the properties that decide whether the tool is any good had no
 * coverage at all:
 *   1. the result is EDITABLE — real text objects, not one big raster of the page;
 *   2. the original ink is GONE from the PAGE — delete what peel produced and the
 *      band is bare paper, with no debris of the printed words left underneath;
 *   3. and gone from the FILE — a patch is a picture, so a peel that only paints
 *      over the words ships a document that says everything twice to pdftotext,
 *      copy-paste and every indexer;
 *   4. the rest of the page is UNTOUCHED — peel the block it was given, nothing else;
 *   5. a model that answers with junk costs the document NOTHING.
 *
 * Peel needs a vision model, which is why this never existed. It doesn't need a
 * GOOD one: the model's only job is to say where the text blocks are, so a canned
 * OpenAI-shaped reply on localhost makes the whole thing deterministic. Boxes are
 * returned as FRACTIONS so the test doesn't depend on the render size peel picks.
 *
 * The stub has to answer TWO different questions, which is what took the harness a
 * while to get right: first "where are the text blocks" (a box list), then, per
 * block, "transcribe this crop" (a reading object — {text, font, color}). Answering
 * the second with the box list makes parseReading throw, the block is skipped, and
 * the peel silently produces nothing at all — no error, no toast. They are told
 * apart here by the read prompt's own wording.
 *
 *   node tests/peel-quality-check.mjs
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { connect, launchApp, sleep } from './harness/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const OUT = join(HERE, '.artifacts', 'peel-quality')
const PORT = Number(process.env.CDP_PORT || 9395)
const AI_PORT = PORT + 40
const DPI = 150
if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

// The dark header banner of the sample invoice, as a fraction of the page. Peel
// should hand back the words printed on it as editable text.
const BLOCKS = [{ box: [0.06, 0.018, 0.95, 0.06] }]
// What the stub 'reads' back out of that block. Deliberately NOT the words that
// are printed there: it has to be possible to tell peel's reprint apart from the
// original in the exported text, and the printed banner ("Ironworks Supply Co.")
// also appears in the footer, which peel never touches.
const READ_TEXT = 'PEELEDLINEZQ'
// What the banner really says, and a line well outside the peeled block.
// "Outside" has to mean outside the INK ROW, not merely outside the words: peel
// replaces each ink band it finds inside the block with what the model read
// there, patch and all, so anything sharing that row goes with it. ("INVOICE
// #2041" sits on the banner's own row and is covered by the patch either way —
// it makes a fine demonstration of that and a useless control.)
const PRINTED = 'IRONWORKS SUPPLY CO.'
const ELSEWHERE = 'Bulgaria'

/** An OpenAI-compatible endpoint that always answers with the block list. */
let hits = 0
let lastBody = ''
// flipped on for the last case: a model that answers with something that isn't
// the JSON peel asked for. It must cost the document nothing.
let junk = false
function fakeModel() {
  const srv = createServer((req, res) => {
    hits++
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      lastBody = body.slice(0, 200)
      // Peel asks TWO different questions and they need different answers: first
      // "where are the text blocks" (a box list), then, per block, "transcribe this
      // crop" (a reading object). Answering the second with the box list makes
      // parseReading throw, the block is skipped, and the peel silently yields
      // nothing — which is exactly what this harness did until the request bodies
      // were inspected. Tell them apart by the read prompt's own wording.
      const isRead = /print-matching assistant/i.test(body)
      const content = junk
        ? "I'm sorry, I can't help with that."
        : isRead
          ? JSON.stringify({ text: READ_TEXT, font: 'sans', color: '#ffffff', bold: true })
          : JSON.stringify(BLOCKS)
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({
        id: 'fake', object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      }))
    })
  })
  return new Promise((ok) => srv.listen(AI_PORT, '127.0.0.1', () => ok(srv)))
}

/**
 * Fraction of pixels in a page-space rect that are LIGHT. The band under test is
 * the invoice's dark header and its lettering is white — so after a clean peel
 * (with the text peel produced deleted) the band should be uniformly dark, and any
 * light pixel left is a leftover glyph. Counting "dark" instead just measures the
 * banner itself, which is supposed to be there.
 */
function lightFraction(pdf, prefix, rect) {
  execFileSync('pdftoppm', ['-r', String(DPI), '-f', '1', '-l', '1', pdf, prefix], { stdio: 'ignore' })
  const buf = readFileSync(`${prefix}-1.ppm`)
  let pos = 0
  const tok = () => { while ([32, 10, 13, 9].includes(buf[pos])) pos++; let s = ''; while (pos < buf.length && buf[pos] > 32) s += String.fromCharCode(buf[pos++]); return s }
  if (tok() !== 'P6') throw new Error('not a P6 ppm')
  const w = +tok(); tok(); tok(); pos++
  const k = DPI / 72
  let ink = 0, n = 0
  for (let y = Math.round(rect.y * k); y < Math.round((rect.y + rect.h) * k); y++) {
    for (let x = Math.round(rect.x * k); x < Math.round((rect.x + rect.w) * k); x++) {
      const i = pos + (y * w + x) * 3
      n++
      if (buf[i] > 180 && buf[i + 1] > 180 && buf[i + 2] > 180) ink++
    }
  }
  return n ? ink / n : 0
}

const results = []
const rec = (id, ok, detail) => { results.push({ id, ok }); console.log(`  ${id.padEnd(30)} ${ok ? 'PASS' : 'FAIL'}  ${detail}`) }

async function main() {
  const srv = await fakeModel()
  console.log(`fake vision model on 127.0.0.1:${AI_PORT}`)
  const child = launchApp({ cwd: ROOT, port: PORT, userDataDir: join(OUT, 'profile') })
  const cdp = await connect({ port: PORT })
  await sleep(1600)
  let r, junkRun = null
  try {
    await cdp.run('window.__reshapedpdf.openSample()')
    await sleep(1600)
    r = await cdp.run(`(async () => {
      const S = window.__reshapedpdf, st = S.state
      st().setAiConfig({ presetId: 'test', baseUrl: 'http://127.0.0.1:${AI_PORT}/v1', model: 'test', apiKey: 'x' })
      await new Promise(r => setTimeout(r, 200))
      const before = new Set(Object.keys(st().docs[st().active].objects))
      const pristine = await S.exportActive()   // the file before the peel, to count against
      let err = null
      try { await S.peelPage(0) } catch (e) { err = String(e && e.message || e) }
      await new Promise(r => setTimeout(r, 2500))
      const d = st().docs[st().active]
      const added = d.objOrder.filter(id => !before.has(id)).map(id => d.objects[id])
      const peeled = await S.exportActive()     // everything peel produced, kept
      // remove everything peel produced EXCEPT its background patches: whatever is
      // left showing in the band is then the original ink it failed to take out
      const editable = added.filter(o => o.kind === 'text' || o.kind === 'image')
      st().removeObjects(editable.map(o => o.id))
      await new Promise(r => setTimeout(r, 300))
      const toasts = st().toasts.map(t => t.text)
      return { toasts, err, kinds: added.map(o => o.kind), texts: added.filter(o => o.kind === 'text').length,
        images: added.filter(o => o.kind === 'image').length, pristine, peeled, out: await S.exportActive() }
    })()`)
    // 5. A model that answers with something other than the JSON peel asked for
    //    must cost the document nothing: no half-peel, no patches over words it
    //    never read, nothing lost. Fresh app so the first peel can't colour it.
    junk = true
    junkRun = await cdp.run(`(async () => {
      const S = window.__reshapedpdf, st = S.state
      await S.openSample()
      await new Promise(r => setTimeout(r, 1700))
      const before = new Set(Object.keys(st().docs[st().active].objects))
      const pristine = await S.exportActive()
      let err = null
      try { await S.peelPage(0) } catch (e) { err = String(e && e.message || e) }
      await new Promise(r => setTimeout(r, 2000))
      const d = st().docs[st().active]
      const added = d.objOrder.filter(id => !before.has(id))
      return { err, added: added.length, pristine, after: await S.exportActive() }
    })()`)
  } finally {
    cdp.close()
    try { child.kill('SIGKILL') } catch { /* gone */ }
    srv.close()
  }

  if (r.err) { rec('peel-runs', false, `peelPage threw: ${r.err}`) } else {
    rec('peel-runs', true, `added [${r.kinds.join(', ')}] toasts=[${(r.toasts||[]).join(' | ')}] modelCalls=${hits}`)
    // 1. EDITABLE, not a picture of the page
    rec('peel-yields-editable-text', r.texts > 0 && r.images === 0,
      `text objects=${r.texts} image objects=${r.images} (a raster peel would be 0 text / >=1 image)`)
    // 2. nothing of the printed words left behind, on the page…
    const pdf = join(OUT, 'peeled.pdf')
    writeFileSync(pdf, Buffer.from(r.out.b64, 'base64'))
    const band = { x: 40, y: 14, w: 520, h: 34 }        // the header band, page space
    const ink = lightFraction(pdf, join(OUT, 'peeled'), band)
    rec('peel-leaves-no-debris', ink < 0.02,
      `lettering left in the peeled band after deleting what peel produced = ${(ink * 100).toFixed(2)}% (want <2%)`)

    // 3. …nor in the FILE. A patch is a picture: it hides the print, it does not
    //    remove it, and a peel that only paints over the words ships a document
    //    that says everything twice to pdftotext, copy-paste and every indexer.
    const p0 = join(OUT, 'pristine.pdf'), p1 = join(OUT, 'with-peel.pdf')
    writeFileSync(p0, Buffer.from(r.pristine.b64, 'base64'))
    writeFileSync(p1, Buffer.from(r.peeled.b64, 'base64'))
    const textOf = (p) => { try { return execFileSync('pdftotext', [p, '-'], { encoding: 'utf8' }) } catch { return '' } }
    const occurrences = (hay, needle) => hay.toLowerCase().split(needle.toLowerCase()).length - 1
    const t0 = textOf(p0), t1 = textOf(p1)
    const was = occurrences(t0, PRINTED), now = occurrences(t1, PRINTED)
    rec('peel-removes-the-print', t1.includes(READ_TEXT) && was > 0 && now === was - 1,
      `peel's own text in the file=${t1.includes(READ_TEXT)}; the printed "${PRINTED}" went ${was} → ${now} (want ${was - 1})`)

    // 4. and it peels the block it was given, not the page around it
    const wasE = occurrences(t0, ELSEWHERE), nowE = occurrences(t1, ELSEWHERE)
    rec('peel-spares-the-rest', wasE > 0 && nowE === wasE,
      `"${ELSEWHERE}", outside the peeled block, went ${wasE} → ${nowE} (want ${wasE}: untouched)`)
  }

  // 5. a model that answers with junk changes nothing
  if (!junkRun) rec('peel-junk-reply-is-harmless', false, 'no result')
  else {
    const j0 = join(OUT, 'junk-before.pdf'), j1 = join(OUT, 'junk-after.pdf')
    writeFileSync(j0, Buffer.from(junkRun.pristine.b64, 'base64'))
    writeFileSync(j1, Buffer.from(junkRun.after.b64, 'base64'))
    const readOut = (p) => { try { return execFileSync('pdftotext', [p, '-'], { encoding: 'utf8' }) } catch { return '' } }
    const same = readOut(j0).trim() === readOut(j1).trim()
    rec('peel-junk-reply-is-harmless', junkRun.added === 0 && same,
      `objects added=${junkRun.added} (want 0), page text unchanged=${same}, error=${junkRun.err ?? 'none (a toast)'}`)
  }

  console.log(`  (model was called ${hits} time(s); first request body starts: ${lastBody.slice(0,120) || 'n/a'})`)
  const bad = results.filter((x) => !x.ok).length
  console.log(`\n${results.length - bad}/${results.length} peel-quality invariants hold`)
  process.exit(bad ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(2) })
