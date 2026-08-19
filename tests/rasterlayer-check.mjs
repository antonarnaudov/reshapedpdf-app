#!/usr/bin/env node
/*
 * When a redaction has to rasterise the page, do the covered words stay gone —
 * and do the uncovered ones stay readable?
 *
 *   node tests/rasterlayer-check.mjs
 *
 * True redaction normally works by deleting drawing instructions. Sometimes it
 * cannot: the clearest case is text inside a form XObject that two pages share,
 * where editing the object for the page that covers it would strip the ink off
 * the page that does not. The export then falls back to re-forging the page as
 * an image with the marks painted on, which is safe but flat — a picture of a
 * page has no text in it at all, so search, copy and every screen reader lose
 * the entire page, marked or not.
 *
 * So the exporter lays the page's own words back over the raster as invisible
 * glyphs, minus any run that touches a mark. That layer is SAFETY-CRITICAL in a
 * way most of this codebase is not: get the exclusion wrong and the redacted
 * text is sitting in the file as selectable characters, underneath a black box,
 * in a document whose whole promise is that it is not. Everything about it is
 * written to fail closed — a run that is uncertain for any reason is dropped —
 * and until now none of it was exercised end to end.
 *
 * The fixture puts both halves of the contract in one page:
 *
 *   SECRET       inside a shared form, under a mark  -> must NOT be extractable
 *   KEEPTHISLINE in the page's own content, unmarked -> must STILL be extractable
 *
 * One of those alone proves nothing. A layer that is simply never written passes
 * the first; a layer that copies everything passes the second.
 *
 * Read with pdftotext, deliberately: it shares no code with the pdf.js that drew
 * the page or the pdf-lib that wrote it, so a leak cannot hide behind the
 * library that produced it.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument, PDFName } from 'pdf-lib'
import { connect, launchApp, sleep } from './harness/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const TMP = join(HERE, '.artifacts', 'rasterlayer')
const PORT = Number(process.env.CDP_PORT || 9491)

const SECRET = 'CONFIDENTIAL7788'
const KEEP = 'KEEPTHISLINE'

if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

try {
  execFileSync('pdftotext', ['-v'], { stdio: 'ignore' })
} catch {
  console.log('  SKIP  pdftotext (poppler) is not installed — nothing to read the export with')
  process.exit(0)
}

/* ---- the one document shape that forces the raster path ------------------ */
async function makeSharedFormDoc() {
  const doc = await PDFDocument.create()
  const ctx = doc.context
  const fontRef = ctx.register(ctx.obj({
    Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding',
  }))
  // ONE form object, drawn by both pages. That is what makes it unremovable:
  // deleting the show op for page 1 would blank it on page 2 as well.
  const formRef = ctx.register(ctx.flateStream(
    `BT /F1 24 Tf 1 0 0 1 60 700 Tm (${SECRET}) Tj ET\n`,
    { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 612, 792], Resources: { Font: { F1: fontRef } } },
  ))
  for (let i = 0; i < 2; i++) {
    const page = doc.addPage([612, 792])
    const res = ctx.obj({})
    const xo = ctx.obj({}); xo.set(PDFName.of('X0'), formRef)
    res.set(PDFName.of('XObject'), xo)
    res.set(PDFName.of('Font'), ctx.obj({ F1: fontRef }))
    page.node.set(PDFName.of('Resources'), res)
    // The page's OWN text, well clear of the mark. This is the half the
    // invisible layer exists to preserve.
    page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(
      `q /X0 Do Q\nBT /F1 18 Tf 1 0 0 1 60 400 Tm (${KEEP}) Tj ET\n`,
    )))
  }
  return Buffer.from(await doc.save()).toString('base64')
}

const b64 = await makeSharedFormDoc()

const child = launchApp({ cwd: ROOT, port: PORT, userDataDir: join(TMP, 'rasterlayer-profile') })
const cdp = await connect({ port: PORT })
await sleep(1800)

// The secret sits at user y=700 on a 792pt page, so its baseline is 92pt from
// the top in view space; the box covers the line with room around it.
const MARK = { x: 50, y: 66, w: 340, h: 40 }

const RUN = `(async () => {
  const S = window.__reshapedpdf, st = () => S.state()
  const d = st().docs[st().active]
  st().addObject({
    id: 'mark1', page: d.pages[0].id, kind: 'redact', opacity: 1, color: '#000000',
    x: ${MARK.x}, y: ${MARK.y}, w: ${MARK.w}, h: ${MARK.h},
  })
  await new Promise(r => setTimeout(r, 400))
  const e = await S.exportActive({ trueRedact: true })
  return { size: e && e.size, b64: e && e.b64, marks: Object.values(st().docs[st().active].objects).filter(o => o.kind === 'redact').length }
})()`

let out
try {
  await cdp.run(`window.__reshapedpdf.openBase64(${JSON.stringify(b64)}, "sharedform.pdf")`)
  await sleep(2500)
  out = await cdp.run(RUN)
} finally {
  cdp.close()
  try { child.kill('SIGKILL') } catch { /* already gone */ }
}

if (!out?.b64) { console.error('  FAIL  the export produced nothing'); process.exit(1) }
const pdf = join(TMP, 'redacted.pdf')
writeFileSync(pdf, Buffer.from(out.b64, 'base64'))

const textOf = (n) => {
  try { return execFileSync('pdftotext', ['-f', String(n), '-l', String(n), pdf, '-'], { encoding: 'utf8' }) } catch { return '' }
}
const p1 = textOf(1)
const p2 = textOf(2)
const results = []
const record = (name, ok, detail) => { results.push(ok); console.log(`  ${name.padEnd(30)} ${ok ? 'PASS' : 'FAIL'}  ${detail}`) }

// If the page was NOT rasterised the rest proves nothing about the layer, so
// say so loudly rather than passing on a path this test never meant to take.
const rasterised = /\/Subtype\s*\/Image/.test(readFileSync(pdf, 'latin1'))
record('page 1 was rasterised', rasterised,
  rasterised ? 'the shared form forced the fallback, which is the path under test'
             : 'NO image XObject — removal succeeded, so the invisible layer was never written and nothing here was tested')

record('the covered words are gone', !p1.includes(SECRET),
  p1.includes(SECRET) ? `pdftotext still reads ${SECRET} on page 1 — under the black box` : `no trace of ${SECRET} on page 1`)

/* NOT "the secret is absent from the file" — it is not supposed to be. Page 2
 * draws the same shared form and carries no mark, so the words legitimately
 * remain there; removing them would be data loss, not redaction. The assertion
 * this replaces claimed the whole-file property and passed only because it
 * searched compressed bytes for a string pdf-lib writes as hex, so it could
 * never match either way. Made real, it fails — correctly — and that is the
 * clearest possible sign it was asserting the wrong thing.
 *
 * The property that IS true and IS worth guarding: page 1's own drawing program
 * must not contain the covered words. That page is a raster plus an invisible
 * text layer, and the invisible layer is precisely where a mishandled exclusion
 * would put them back as selectable characters. So inflate that one page's
 * content and look there. */
const page1Streams = await (async () => {
  const doc = await PDFDocument.load(readFileSync(pdf))
  const node = doc.getPage(0).node
  const contents = node.Contents()
  const refs = contents && 'asArray' in contents
    ? contents.asArray()
    : [node.get(PDFName.of('Contents'))]
  let out = ''
  for (const r of refs) {
    const st = r && doc.context.lookup(r)
    if (!st || !st.contents) continue
    try { out += inflateSync(Buffer.from(st.contents)).toString('latin1') } catch { out += Buffer.from(st.contents).toString('latin1') }
  }
  return out
})()
const onPage1 = (word) =>
  page1Streams.includes(word) ||
  page1Streams.toLowerCase().includes(Buffer.from(word, 'latin1').toString('hex'))

record("the covered words are not in page 1's drawing program", !onPage1(SECRET),
  onPage1(SECRET) ? 'the invisible text layer put them back as selectable characters under the box'
                  : "not in page 1's inflated content, as text or as hex")

// The control. Without it, a lookup that can never match reads as a clean bill —
// which is exactly how the assertion above passed for as long as it was wrong.
record('that lookup can actually find things', onPage1(KEEP),
  onPage1(KEEP) ? `${KEEP} is visible to the same lookup that just cleared ${SECRET}`
                : 'the lookup found nothing at all, so it proves nothing about the secret either')

record('the uncovered words survive', p1.includes(KEEP),
  p1.includes(KEEP) ? `${KEEP} is still selectable over the raster` : `${KEEP} was lost — the page is flat pixels and search, copy and screen readers get nothing`)

// Page 2 shares the form and has no mark, so it must be untouched: the secret
// belongs to that page and removing it there would be data loss, not redaction.
record('the other page is untouched', p2.includes(SECRET) && p2.includes(KEEP),
  `page 2 still reads ${p2.includes(SECRET) ? 'the shared form' : 'NOTHING of the shared form'} and ${p2.includes(KEEP) ? 'its own line' : 'NOT its own line'}`)

/* And is still TEXT. The assertion above reads page 2 with pdftotext, which is
 * just as happy with a rasterised page carrying an invisible layer — so a bug
 * that re-forged every page as an image, not only the marked one, would pass it
 * while quietly destroying the quality of a page nobody redacted. Only page 1
 * should have become a picture. */
const page2HasImage = await (async () => {
  const doc = await PDFDocument.load(readFileSync(pdf))
  const res = doc.getPage(1).node.Resources()
  const xo = res && res.lookup(PDFName.of('XObject'))
  if (!xo || !xo.entries) return false
  for (const [, ref] of xo.entries()) {
    const st = doc.context.lookup(ref)
    const sub = st && st.dict && st.dict.get(PDFName.of('Subtype'))
    if (sub && String(sub) === '/Image') return true
  }
  return false
})()
record('only the marked page was rasterised', !page2HasImage,
  page2HasImage ? 'page 2 became an image too — an unmarked page lost its vector text for nothing'
                : 'page 2 is still its original drawing program')

const bad = results.filter((r) => !r).length
console.log(`\n${results.length - bad} of ${results.length} hold  (${pdf})`)
process.exit(bad ? 1 : 0)
