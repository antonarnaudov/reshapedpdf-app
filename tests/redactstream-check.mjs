#!/usr/bin/env node
/*
 * Does redaction actually take the words out, on the shapes real PDFs come in?
 *
 * redactPageContent edits a page's own drawing instructions so the covered
 * words are absent from the file rather than hidden under a rectangle. The bar
 * is unforgiving: if it returns { complete: true } the exporter ships the file
 * as-is with no raster fallback, so a run it failed to remove is live,
 * selectable, copyable text under a black box — the exact "sticker" the module
 * exists to prevent. And a run it removes too eagerly deletes text nobody
 * marked.
 *
 * The CDP redact suite proves the happy path on two real fixtures. It cannot
 * cheaply vary page rotation, crop boxes, form XObjects, graphics-state stacks,
 * split content streams, text rise, Type3 fonts or the "  operator — each ~2.5s
 * of app boot per case. So this drives redactPageContent headlessly on
 * synthetic pages with hand-written content streams, one per known failure
 * mode, and checks the ground truth directly: is the run's own string still in
 * the bytes the function wrote back?
 *
 *   LEAK  the run is still in the file but complete:true (no raster fallback)
 *   LOSS  a run nobody marked was destroyed
 *   HONEST  could not remove it, but said so (complete:false) -> caller rasters
 *
 *   node tests/redactstream-check.mjs
 */
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import {
  PDFDocument, PDFName, PDFArray, PDFRawStream, decodePDFRawStream,
} from 'pdf-lib'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const TMP = join(HERE, '.artifacts', 'redactstream')

if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

// Bundle the real module (and geometry, for placing marks where the app would)
// to ESM we can import. pdf-lib stays external so it resolves from node_modules.
async function bundle(entry) {
  const outfile = join(TMP, entry.replace(/[\/.]/g, '_') + '.mjs')
  await build({
    entryPoints: [join(ROOT, entry)],
    outfile, bundle: true, format: 'esm', platform: 'node',
    external: ['pdf-lib', '@pdf-lib/fontkit'], logLevel: 'silent',
  })
  return import('file://' + outfile)
}
const { redactPageContent } = await bundle('src/pdf/redactstream.ts')
const { walkPageContent, removeSpans } = await bundle('src/pdf/contentwalk.ts')
const { userRectToView } = await bundle('src/core/geometry.ts')

/* ---- synthetic page builder --------------------------------------------- */

// A font resource whose every code (0..255) advances a known fraction of em.
function simpleFont(doc, emWidth = 0.5) {
  const widths = Array.from({ length: 256 }, () => Math.round(emWidth * 1000))
  return doc.context.register(doc.context.obj({
    Type: PDFName.of('Font'), Subtype: PDFName.of('Type1'),
    BaseFont: PDFName.of('Helvetica'), FirstChar: 0, LastChar: 255, Widths: widths,
  }))
}

// Build a one-page doc we fully control. `content` may be a string (one stream)
// or an array of strings (a /Contents array). `xobjects` maps name -> ref.
function mkDoc({
  mediaBox = [0, 0, 612, 792], rotate, cropBox,
  content, emWidth = 0.5, fontMatrix, subtype = 'Type1', xobjects, noWidths,
}) {
  return PDFDocument.create().then((d) => {
    const [, , w, h] = mediaBox
    const page = d.addPage([w, h])
    page.node.set(PDFName.of('MediaBox'), d.context.obj(mediaBox))
    if (rotate != null) page.node.set(PDFName.of('Rotate'), d.context.obj(rotate))
    if (cropBox) page.node.set(PDFName.of('CropBox'), d.context.obj(cropBox))

    // font resource
    let fontRef
    if (noWidths) {
      // No /Widths array. With a STANDARD base-14 name the metrics are still
      // known — they are published, and readWidths reads them — so the run stays
      // measurable. Pass noWidths:'nonstandard' for the genuinely unmeasurable
      // case: a font that declares neither widths nor a name anyone has metrics
      // for, where the run's extent really cannot be bounded.
      fontRef = d.context.register(d.context.obj({
        Type: PDFName.of('Font'), Subtype: PDFName.of('Type1'),
        BaseFont: PDFName.of(noWidths === 'nonstandard' ? 'AcmeSans-Book' : 'Helvetica'),
      }))
    } else if (fontMatrix) {
      fontRef = d.context.register(d.context.obj({
        Type: PDFName.of('Font'), Subtype: PDFName.of(subtype),
        FirstChar: 0, LastChar: 255,
        Widths: Array.from({ length: 256 }, () => Math.round(emWidth * 1000)),
        FontMatrix: fontMatrix,
      }))
    } else {
      fontRef = simpleFont(d, emWidth)
    }
    const res = { Font: d.context.obj({ F1: fontRef }) }
    if (xobjects) {
      const xo = {}
      for (const [k, v] of Object.entries(xobjects)) xo[k] = v
      res.XObject = d.context.obj(xo)
    }
    page.node.set(PDFName.of('Resources'), d.context.obj(res))

    // contents
    if (Array.isArray(content)) {
      const refs = content.map((s) => d.context.register(d.context.stream(s)))
      const arr = PDFArray.withContext(d.context)
      refs.forEach((r) => arr.push(r))
      page.node.set(PDFName.of('Contents'), arr)
    } else {
      page.node.set(PDFName.of('Contents'), d.context.register(d.context.stream(content)))
    }
    return { doc: d, page }
  })
}

// A form XObject stream drawing `body`, wrapping the whole page by default.
function formXObject(d, body, { bbox = [0, 0, 612, 792], matrix = [1, 0, 0, 1, 0, 0] } = {}) {
  const fontRef = simpleFont(d)
  const dict = {
    Type: PDFName.of('XObject'), Subtype: PDFName.of('Form'),
    BBox: bbox, Matrix: matrix,
    Resources: d.context.obj({ Font: d.context.obj({ F1: fontRef }) }),
  }
  return d.context.register(d.context.stream(body, dict))
}
function imageXObject(d, { w = 100, h = 100 } = {}) {
  // a tiny valid-enough image XObject; redaction only reads its dict
  const dict = {
    Type: PDFName.of('XObject'), Subtype: PDFName.of('Image'),
    Width: w, Height: h, ColorSpace: PDFName.of('DeviceRGB'),
    BitsPerComponent: 8, Filter: PDFName.of('ASCIIHexDecode'),
  }
  return d.context.register(d.context.stream('00 >', dict))
}

// Decoded text of every content stream after redaction ran.
function finalSrc(doc, page) {
  const c = page.node.Contents()
  const refs = c instanceof PDFArray
    ? c.asArray()
    : [page.node.get(PDFName.of('Contents'))]
  let out = ''
  for (const ref of refs) {
    const s = doc.context.lookup(ref)
    if (s instanceof PDFRawStream) {
      const bytes = decodePDFRawStream(s).decode()
      for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    }
  }
  return out
}

// mark (view space, y-down) that covers a user-space rect on an unrotated,
// uncropped page of height H.
const markOverUser = (H, ux, uy, uw, uh) => ({ x: ux, y: H - uy - uh, w: uw, h: uh })

// default geometry for an unrotated, uncropped US-letter page
const G0 = { cx: 0, cy: 0, uw: 612, uh: 792, rot: 0 }

/* ---- cases -------------------------------------------------------------- */

const results = []
function record(id, defect, verdict, detail) {
  results.push({ id, defect, verdict, detail })
}

// Helper: run redaction and classify. `expectGone` string must leave the file;
// `expectKept` strings must survive.
function classify({ doc, page, result, expectGoneOp, expectKeptOps = [] }) {
  const src = finalSrc(doc, page)
  const goneStillThere = expectGoneOp && src.includes(expectGoneOp)
  const keptDestroyed = expectKeptOps.filter((k) => !src.includes(k))
  if (goneStillThere && result.complete) return { verdict: 'LEAK', src }
  if (goneStillThere && !result.complete) return { verdict: 'HONEST', src }
  if (keptDestroyed.length) return { verdict: 'LOSS', src, keptDestroyed }
  return { verdict: 'OK', src }
}

const H = 792

// ---------- Defect 5: page /Rotate ignored ----------
for (const rot of [0, 90, 180, 270]) {
  const ux = 100, uy = 700, fs = 24
  const { doc, page } = await mkDoc({
    rotate: rot,
    content: `BT /F1 ${fs} Tf ${ux} ${uy} Td (SECRET) Tj ET`,
  })
  // the app places the black box via userToView of the text's user rect
  const geom = { cx: 0, cy: 0, uw: 612, uh: 792, rot }
  const uw = 0.5 * fs * 6 // 6 glyphs at 0.5em
  const viewRect = userRectToView(geom, [ux, uy, ux + uw, uy + fs])
  const result = redactPageContent(doc, page, [viewRect], geom)
  const { verdict } = classify({ doc, page, result, expectGoneOp: '(SECRET)' })
  record(`rotate-${rot}`, '#5 Rotate', verdict, `removedRuns=${result.removedRuns} complete=${result.complete}`)
}

// ---------- Defect 5b: non-zero CropBox origin ----------
{
  const ux = 100, uy = 780, fs = 12
  const { doc, page } = await mkDoc({
    mediaBox: [0, 0, 612, 892], cropBox: [0, 100, 612, 892],
    content: `BT /F1 ${fs} Tf ${ux} ${uy} Td (SECRET) Tj ET`,
  })
  const geom = { cx: 0, cy: 100, uw: 612, uh: 792, rot: 0 }
  const uw = 0.5 * fs * 6
  const viewRect = userRectToView(geom, [ux, uy, ux + uw, uy + fs])
  const result = redactPageContent(doc, page, [viewRect], geom)
  const { verdict } = classify({ doc, page, result, expectGoneOp: '(SECRET)' })
  record('cropbox-origin', '#5 CropBox', verdict, `removedRuns=${result.removedRuns} complete=${result.complete}`)
}

// ---------- Defect 6: text rise ----------
{
  const ux = 100, uy = 700, fs = 12, rise = 20
  const { doc, page } = await mkDoc({
    content: `BT /F1 ${fs} Tf ${rise} Ts ${ux} ${uy} Td (SECRET) Tj ET`,
  })
  // glyphs really occupy user y [uy+rise, uy+rise+fs]; mark over the real glyphs
  const result = redactPageContent(doc, page, [markOverUser(H, ux, uy + rise + 2, 0.5 * fs * 6, fs - 4)], G0)
  const { verdict } = classify({ doc, page, result, expectGoneOp: '(SECRET)' })
  record('text-rise', '#6 Ts', verdict, `removedRuns=${result.removedRuns} complete=${result.complete}`)
}

// ---------- Regression: fs=0 (invisible text) must not emit ±Infinity ----------
{
  const ux = 100, uy = 700
  // Zero font size with non-zero char spacing: a covered glyph's advance is Tc
  // alone, and the TJ stand-in reproduces it as -covAdv*1000/fs — which at fs=0
  // divided by zero and wrote the literal token `-Infinity` into the content
  // stream, corrupting it. The glyphs are an invisible baseline sliver; cover it.
  const { doc, page } = await mkDoc({
    content: `BT /F1 0 Tf 5 Tc ${ux} ${uy} Td (SECRET) Tj ET`,
  })
  const result = redactPageContent(doc, page, [markOverUser(H, ux, uy - 3, 200, 8)], G0)
  const src = finalSrc(doc, page)
  const bad = /Infinity|NaN/.test(src)
  // pass = the removed run left the stream AND no bad number token was emitted
  record('fs0-no-infinity', '#regr fs0', bad ? 'LOSS' : 'OK', `removedRuns=${result.removedRuns} badNumberToken=${bad}`)
}

// ---------- Defect 8: the " operator's aw/ac spacing ----------
{
  const ux = 100, uy = 700, fs = 10, ac = 50
  // aw ac string "  -> sets Tw=0, Tc=50 then shows the string. With Tc=50 the
  // B sits at ux + 0.5*fs + 50 = 155; ignore the operands and B stays at 105,
  // sliding out from under a mark placed over its real position.
  const { doc, page } = await mkDoc({
    content: `BT /F1 ${fs} Tf ${ux} ${uy} Td 0 ${ac} (AB) " ET`,
  })
  const result = redactPageContent(doc, page, [markOverUser(H, ux + 52, uy, 12, fs)], G0)
  const { verdict } = classify({ doc, page, result, expectGoneOp: '(AB)' })
  record('quote-op', '#8 " spacing', verdict, `removedRuns=${result.removedRuns} complete=${result.complete}`)
}

// ---------- Defect 7: Type3 FontMatrix ----------
{
  const ux = 100, uy = 700, fs = 10
  // FontMatrix .01 means widths (500) are glyph-space: real adv = 500*.01*fs = 50
  const { doc, page } = await mkDoc({
    subtype: 'Type3', fontMatrix: [0.01, 0, 0, 0.01, 0, 0], emWidth: 0.5,
    content: `BT /F1 ${fs} Tf ${ux} ${uy} Td (SECRET) Tj ET`,
  })
  // 6 glyphs at 50 user units each really span x 100..400; mark near the end
  const result = redactPageContent(doc, page, [markOverUser(H, ux + 250, uy, 40, fs)], G0)
  const { verdict } = classify({ doc, page, result, expectGoneOp: '(SECRET)' })
  record('type3-matrix', '#7 Type3', verdict, `removedRuns=${result.removedRuns} complete=${result.complete}`)
}

// ---------- Defect 3: q/Q graphics-state ----------
{
  const ux = 100, uy = 700, fs = 40
  // fs set to 40, saved, dropped to 4 inside q..Q, and per spec RESTORED to 40
  // by Q — but the module pops only the CTM, so fs leaks out as 4. The run is
  // really drawn at 40 (spans x 100..300 for 10 glyphs at 0.5em); the mark is
  // over the tail "WORD", which fs=40 reaches and the leaked fs=4 (x 100..120)
  // does not. First-glyph-at-origin can't rescue it: the mark avoids the origin.
  const { doc, page } = await mkDoc({
    content: `BT /F1 ${fs} Tf q /F1 4 Tf Q ${ux} ${uy} Td (SECRETWORD) Tj ET`,
  })
  const tailX = ux + 0.5 * fs * 7 // over the 8th glyph onward
  const result = redactPageContent(doc, page, [markOverUser(H, tailX, uy, 0.5 * fs * 3, fs)], G0)
  const { verdict } = classify({ doc, page, result, expectGoneOp: '(SECRETWORD)' })
  record('qQ-state', '#3 q/Q', verdict, `removedRuns=${result.removedRuns} complete=${result.complete}`)
}

// ---------- Defect 2: form XObject wrapping the page ----------
{
  const { doc, page } = await mkDoc({ content: '/Fm1 Do' })
  const fm = formXObject(doc, `BT /F1 24 Tf 100 700 Td (SECRET) Tj ET`)
  page.node.Resources().set(PDFName.of('XObject'), doc.context.obj({ Fm1: fm }))
  const result = redactPageContent(doc, page, [markOverUser(H, 100, 700, 200, 24)], G0)
  // the SECRET lives inside the form; redaction can't reach it, so the only
  // acceptable outcome is HONEST (complete:false -> raster fallback)
  const src = finalSrc(doc, page)
  const verdict = result.complete ? 'LEAK' : 'HONEST'
  record('form-xobject', '#2 Do form', verdict, `removedRuns=${result.removedRuns} complete=${result.complete} reason=${result.reason || ''}`)
}

// ---------- Defect 2b: image XObject overlap must not throw ----------
{
  const { doc, page } = await mkDoc({ content: 'q 200 0 0 100 100 600 cm /Im1 Do Q' })
  const im = imageXObject(doc)
  page.node.Resources().set(PDFName.of('XObject'), doc.context.obj({ Im1: im }))
  let threw = false, result
  try {
    result = redactPageContent(doc, page, [markOverUser(H, 150, 620, 40, 40)], G0)
  } catch (e) { threw = true; result = { complete: false, removedImages: 0 } }
  // A mark that only PARTLY covers the image must force the raster fallback
  // (complete:false), not drop the whole image — either is "handled".
  const verdict = threw ? 'THREW' : (result.removedImages > 0 || !result.complete ? 'OK' : 'MISS')
  record('image-xobject', '#2 Do image', verdict, threw ? 'TypeError in .lookup' : `removedImages=${result.removedImages} complete=${result.complete}`)
}

// ---------- Defect: image only PARTLY under a mark dropped whole -> blank page ----------
{
  // a full-page scan; a small mark over one corner must NOT delete the whole image
  const { doc, page } = await mkDoc({ content: 'q 612 0 0 792 0 0 cm /Im1 Do Q' })
  page.node.Resources().set(PDFName.of('XObject'), doc.context.obj({ Im1: imageXObject(doc) }))
  const result = redactPageContent(doc, page, [markOverUser(H, 60, 60, 120, 20)], G0)
  // correct: rasterise (complete:false); the bug dropped the whole image with complete:true
  const bad = result.removedImages > 0 && result.complete
  record('image-partial-overlap', '#loss image drop', bad ? 'LOSS' : 'HONEST', `removedImages=${result.removedImages} complete=${result.complete}`)
}

// ---------- Defect: outlined-text vector paint under a mark is invisible to redaction ----------
// Sensitive content OUTLINED to vector paths (Create Outlines) is COMPLEX (curves /
// many vertices) and carries readable content, so a footprint over a mark must
// rasterise. A simple coloured rectangle / rule is a background with no readable
// content and is kept, so a plain text-on-a-bar redaction stays vector.
{
  // an outlined letter/number: a curve makes it "complex"
  const { doc, page } = await mkDoc({ content: '100 700 m 150 760 250 760 300 700 c 300 740 l 100 740 l h f' })
  const result = redactPageContent(doc, page, [markOverUser(H, 150, 705, 100, 30)], G0)
  const src = finalSrc(doc, page)
  const leaked = src.includes('100 700 m') && result.complete
  record('outlined-text-fill', '#leak outlined text', leaked ? 'LEAK' : 'HONEST', `complete=${result.complete}`)
}
{
  // self-review #1/#4: outlined content + an incidental glyph share ONE mark — the
  // complex paint must STILL rasterise (not be kept just because a glyph dropped there)
  const { doc, page } = await mkDoc({ content: '100 700 m 150 760 250 760 300 700 c 300 740 l 100 740 l h f\nBT /F1 12 Tf 150 715 Td (5) Tj ET' })
  const result = redactPageContent(doc, page, [markOverUser(H, 150, 705, 100, 30)], G0)
  const src = finalSrc(doc, page)
  const leaked = src.includes('100 700 m') && result.complete
  record('outlined-text-plus-glyph', '#leak vector+text', leaked ? 'LEAK' : 'HONEST', `complete=${result.complete}`)
}
{
  // a simple COLOURED background bar under redacted text stays VECTOR (bar carries no
  // readable content; the glyphs are dropped) — must NOT flatten the page
  const { doc, page } = await mkDoc({ content: '0.8 0.9 1 rg 90 695 200 24 re f\n0 g BT /F1 12 Tf 100 700 Td (SECRET) Tj ET' })
  const result = redactPageContent(doc, page, [markOverUser(H, 100, 700, 0.5 * 12 * 6, 12)], G0)
  const { verdict } = classify({ doc, page, result, expectGoneOp: '(SECRET)' })
  record('coloured-bar-stays-vector', 'control paint', verdict === 'OK' && result.complete ? 'OK' : (result.complete ? verdict : 'OVER-RASTER'), `complete=${result.complete}`)
}
{
  // an outlined-text fill FAR from the mark must NOT force a raster (no over-rasterising)
  const { doc, page } = await mkDoc({ content: '20 20 m 30 60 50 60 60 20 c 60 60 l 20 60 l h f\nBT /F1 12 Tf 100 700 Td (SECRET) Tj ET' })
  const result = redactPageContent(doc, page, [markOverUser(H, 100, 700, 0.5 * 12 * 6, 12)], G0)
  const { verdict } = classify({ doc, page, result, expectGoneOp: '(SECRET)' })
  record('vector-fill-clear', 'control paint', verdict === 'OK' && result.complete ? 'OK' : verdict, `complete=${result.complete}`)
}
{
  // self-review #2: a WHITE page background + text — redacting the text must stay
  // VECTOR (the white fill is benign), NOT rasterise the whole page
  const { doc, page } = await mkDoc({ content: '1 1 1 rg 0 0 612 792 re f\n0 g BT /F1 12 Tf 100 700 Td (SECRET) Tj ET' })
  const result = redactPageContent(doc, page, [markOverUser(H, 100, 700, 0.5 * 12 * 6, 12)], G0)
  const { verdict } = classify({ doc, page, result, expectGoneOp: '(SECRET)' })
  record('white-bg-stays-vector', 'control paint', verdict === 'OK' && result.complete ? 'OK' : (result.complete ? verdict : 'OVER-RASTER'), `complete=${result.complete}`)
}
{
  // self-review #3: a non-numeric element inside a TJ array must not become NaN and
  // poison the text matrix (which would slide the covered glyphs off the mark)
  const { doc, page } = await mkDoc({ content: 'BT /F1 12 Tf 100 700 Td [ (visible) /X (SECRET) ] TJ ET' })
  const result = redactPageContent(doc, page, [markOverUser(H, 141, 700, 44, 12)], G0)
  const src = finalSrc(doc, page)
  const leaked = src.includes('(SECRET)') && result.complete
  record('tj-nonnumeric-token', '#leak TJ NaN', leaked ? 'LEAK' : 'HONEST', `complete=${result.complete} removedRuns=${result.removedRuns}`)
}

// ---------- Defect: vertical Type0 (Identity-V) font — pen goes down, boxes go right ----------
{
  // 5 CIDs down a column; the buggy code marches the boxes rightward, so a mark on
  // the real (vertical) column misses them and ships the covered CIDs live.
  const { doc, page } = await mkDoc({ content: 'BT /F1 12 Tf 100 700 Td <00410042004300440045> Tj ET' })
  const cid = doc.context.register(doc.context.obj({
    Type: PDFName.of('Font'), Subtype: PDFName.of('CIDFontType2'), BaseFont: PDFName.of('F0'), DW: 1000,
  }))
  const t0 = doc.context.register(doc.context.obj({
    Type: PDFName.of('Font'), Subtype: PDFName.of('Type0'), BaseFont: PDFName.of('F0'),
    Encoding: PDFName.of('Identity-V'), DescendantFonts: doc.context.obj([cid]),
  }))
  ;(page.node.Resources().lookup(PDFName.of('Font'))).set(PDFName.of('F1'), t0)
  const result = redactPageContent(doc, page, [markOverUser(H, 95, 660, 20, 24)], G0)
  // an unsafe (vertical/remapped) composite font on a marked page must rasterise
  record('type0-vertical', '#leak vertical CID', result.complete ? 'LEAK' : 'HONEST', `complete=${result.complete} removedRuns=${result.removedRuns}`)
}

// ---------- Defect 4: /Contents array resets state per element ----------
{
  // a q/cm prologue in element 0, the BT it scales in element 1
  const { doc, page } = await mkDoc({
    content: ['q 0.5 0 0 0.5 0 0 cm', 'BT /F1 48 Tf 200 1400 Td (SECRET) Tj ET Q'],
  })
  // after 0.5 scale, text at user (100,700) size 24; mark there
  const result = redactPageContent(doc, page, [markOverUser(H, 100, 700, 200, 24)], G0)
  const { verdict } = classify({ doc, page, result, expectGoneOp: '(SECRET)' })
  record('contents-array', '#4 array', verdict, `removedRuns=${result.removedRuns} complete=${result.complete}`)
}

// ---------- Defect: /Contents array split BETWEEN an operand and its operator ----------
// A spec-legal array split can fall mid-group: the (SECRET) string ends element 0,
// its Tj starts element 1. Tokenising each element alone drops the dangling operand,
// so the show op parses empty and the covered run is never seen -> it ships live.
{
  const { doc, page } = await mkDoc({
    content: ['BT /F1 12 Tf 100 700 Td (SECRET)', 'Tj ET'],
  })
  const result = redactPageContent(doc, page, [markOverUser(H, 100, 700, 0.5 * 12 * 6, 12)], G0)
  const { verdict } = classify({ doc, page, result, expectGoneOp: '(SECRET)' })
  record('array-split-operand', '#leak array split', verdict, `removedRuns=${result.removedRuns} complete=${result.complete}`)
}
// split between numeric operands and their operator (Td)
{
  const { doc, page } = await mkDoc({
    content: ['BT /F1 12 Tf 100 700', 'Td (SECRET) Tj ET'],
  })
  const result = redactPageContent(doc, page, [markOverUser(H, 100, 700, 0.5 * 12 * 6, 12)], G0)
  const { verdict } = classify({ doc, page, result, expectGoneOp: '(SECRET)' })
  record('array-split-numeric', '#leak array split', verdict, `removedRuns=${result.removedRuns} complete=${result.complete}`)
}

// ---------- Defect 1: a hit deletes the whole BT..ET block (LOSS) ----------
{
  const { doc, page } = await mkDoc({
    content: `BT /F1 12 Tf 100 700 Td (KEEPME) Tj 0 -600 Td (SECRET) Tj ET`,
  })
  // mark only over SECRET (100,100)
  const result = redactPageContent(doc, page, [markOverUser(H, 100, 100, 0.5 * 12 * 6, 12)], G0)
  const cls = classify({ doc, page, result, expectGoneOp: '(SECRET)', expectKeptOps: ['(KEEPME)'] })
  record('block-loss', '#1 block drop', cls.verdict, `removedRuns=${result.removedRuns} kept=${cls.keptDestroyed?.join(',') || 'all'}`)
}

// ---------- Defect 1b: consecutive same-line runs keep their place ----------
{
  // SECRET and KEEPME share a line with no positioning between them, so KEEPME's
  // position depends on SECRET's advance. Drop SECRET and KEEPME must NOT slide
  // left into the redacted gap: the stand-in advance has to stand in.
  const fs = 12
  const { doc, page } = await mkDoc({
    content: `BT /F1 ${fs} Tf 100 700 Td (SECRET) Tj (KEEPME) Tj ET`,
  })
  const result = redactPageContent(doc, page, [markOverUser(H, 100, 700, 0.5 * fs * 6, fs)], G0)
  const src = finalSrc(doc, page)
  const goneOk = !src.includes('(SECRET)')
  const keptOk = src.includes('(KEEPME)')
  const advanced = /]\s*TJ/.test(src) // the pen was advanced, not collapsed
  const verdict = goneOk && keptOk && advanced ? 'OK' : (!goneOk ? 'LEAK' : !keptOk ? 'LOSS' : 'SHIFT')
  record('consec-runs', '#1 advance', verdict, `removedRuns=${result.removedRuns} gone=${goneOk} kept=${keptOk} adv=${advanced}`)
}

// ---------- Defect: redacting one word inside a run must keep the neighbours ----------
{
  // "foo SECRET bar" as ONE Tj. Mark only over SECRET (chars 4..10 → x 124..160
  // at 0.5em, 12pt). foo and bar must survive; SECRET must be gone; the pen must
  // still advance across the gap so bar keeps its place.
  const fs = 12
  const { doc, page } = await mkDoc({ content: `BT /F1 ${fs} Tf 100 700 Td (foo SECRET bar) Tj ET` })
  const result = redactPageContent(doc, page, [markOverUser(H, 124, 700, 36, fs)], G0)
  const src = finalSrc(doc, page)
  const gone = !src.includes('SECRET')
  const keptFoo = /\(foo/.test(src), keptBar = /bar\)/.test(src)
  const advanced = /\]\s*TJ/.test(src)
  const verdict = !gone ? 'LEAK' : (!keptFoo || !keptBar) ? 'LOSS' : !advanced ? 'SHIFT' : 'OK'
  record('partial-run-split', '#9 keep neighbours', verdict, `gone=${gone} foo=${keptFoo} bar=${keptBar} adv=${advanced}`)
}

// ---------- Defect: unmeasurable base-14 run (no /Widths) whose covered word is far from the origin ----------
{
  // One full-width line, single Tj, origin at the LEFT margin (x=72); the covered
  // number sits near the RIGHT margin. With no /Widths the run can't be measured,
  // so its horizontal extent is unknown. The old code cleared the hit because the
  // ORIGIN wasn't near the mark, and shipped the covered text as live characters.
  // It must instead force the raster fallback (complete=false) so nothing leaks.
  const { doc, page } = await mkDoc({ noWidths: 'nonstandard', content: `BT /F1 12 Tf 72 700 Td (Account holder card 4012 8888 8888 1881) Tj ET` })
  const result = redactPageContent(doc, page, [markOverUser(H, 430, 700, 130, 14)], G0)
  const src = finalSrc(doc, page)
  const leaked = src.includes('8888 1881') && result.complete
  record('nowidths-extent', '#leak no metrics at all', leaked ? 'LEAK' : 'HONEST', `complete=${result.complete} removedRuns=${result.removedRuns} reason=${result.reason || ''}`)
}

// ---------- …and the same page in a STANDARD base-14 is simply measured ----------
{
  // Helvetica without /Widths is not a mystery: the metrics are published. The
  // run is boxed exactly, so the mark over the card number removes that and
  // leaves the rest — no raster fallback, no guessing, no leak.
  const { doc, page } = await mkDoc({ noWidths: true, content: `BT /F1 12 Tf 72 700 Td (Account holder card 4012 8888 8888 1881) Tj ET` })
  const [, , , x1] = [0, 0, 0, 0]
  // the number sits at the tail of the line; cover from 3/4 of the way along to
  // well past its end
  const result = redactPageContent(doc, page, [markOverUser(H, 210, 698, 200, 16)], G0)
  const src = finalSrc(doc, page)
  const verdict = !result.complete ? 'HONEST' : src.includes('1881') ? 'LEAK' : /\(Account/.test(src) ? 'OK' : 'LOSS'
  record('base14-metrics-known', 'base-14 metrics', verdict,
    `complete=${result.complete} removedRuns=${result.removedRuns} number gone=${!src.includes('1881')} start kept=${/\(Account/.test(src)}`)
}

// ---------- Defect: rotated/sheared glyph box built from only 2 corners ----------
// A 45-degree glyph's true AABB is bounded by its OFF-diagonal corners; a box from
// only the main-diagonal pair is narrower, so a mark over the real ink near an
// off-diagonal corner misses it and the covered glyph ships live (a leak).
{
  // one glyph 'X' at 40pt, rotated 45deg via Tm. Its true footprint spans user
  // x[271.7,314.1]; the 2-corner box only x[285.9,300]. A mark just RIGHT of 300
  // (x 302..313) sits on real ink (the B corner) but outside the 2-corner box.
  const { doc, page } = await mkDoc({
    content: `BT /F1 40 Tf 0.70710678 0.70710678 -0.70710678 0.70710678 300 400 Tm (X) Tj ET`,
  })
  const result = redactPageContent(doc, page, [markOverUser(H, 302, 402, 11, 38)], G0)
  const { verdict } = classify({ doc, page, result, expectGoneOp: '(X)' })
  record('rotated-text-tm', '#leak rotated glyph', verdict, `removedRuns=${result.removedRuns} complete=${result.complete}`)
}
{
  // same, but the rotation comes from a `cm` before BT (ctm, not tm)
  const { doc, page } = await mkDoc({
    content: `q 0.70710678 0.70710678 -0.70710678 0.70710678 300 400 cm BT /F1 40 Tf 0 0 Td (X) Tj ET Q`,
  })
  const result = redactPageContent(doc, page, [markOverUser(H, 302, 402, 11, 38)], G0)
  const { verdict } = classify({ doc, page, result, expectGoneOp: '(X)' })
  record('rotated-text-cm', '#leak rotated glyph', verdict, `removedRuns=${result.removedRuns} complete=${result.complete}`)
}

// ---------- Defect: width-less run fallback band assumes horizontal ----------
// A no-/Widths run rotated 90deg extends up the page, but the fallback band is a
// 1-unit horizontal strip at the baseline, so a mark up the column misses it and
// the covered widthless text ships live instead of forcing the raster fallback.
{
  const { doc, page } = await mkDoc({
    noWidths: true,
    content: `q 0 1 -1 0 300 400 cm BT /F1 40 Tf 0 0 Td (SECRET) Tj ET Q`,
  })
  const result = redactPageContent(doc, page, [markOverUser(H, 280, 440, 20, 20)], G0)
  const src = finalSrc(doc, page)
  const leaked = src.includes('(SECRET)') && result.complete
  record('widthless-rotated', '#leak rotated no /Widths', leaked ? 'LEAK' : 'HONEST', `complete=${result.complete} removedRuns=${result.removedRuns}`)
}

// ---------- Control: the happy path still works ----------
{
  const { doc, page } = await mkDoc({
    content: `BT /F1 12 Tf 100 700 Td (SECRET) Tj ET`,
  })
  const result = redactPageContent(doc, page, [markOverUser(H, 100, 700, 0.5 * 12 * 6, 12)], G0)
  const { verdict } = classify({ doc, page, result, expectGoneOp: '(SECRET)' })
  record('control-happy', 'control', verdict === 'OK' ? 'OK' : verdict, `removedRuns=${result.removedRuns} complete=${result.complete}`)
}

/* ---- cover mode: the patches an EDIT paints over the page ----------------
 *
 * A retype, a rubber, a peel or a lift covers printed words with a rebuilt
 * background. On the page that is the whole job; in the file the glyphs are
 * still in the content stream under the patch, and pdftotext hands them back.
 * Cover mode takes out what a patch is provably hiding — a glyph whose box lies
 * ENTIRELY inside it — and, unlike redaction, is never allowed to give up and
 * rasterise the page: it is running on every export, over boxes people drew by
 * hand, so its whole licence is that removing only invisible ink cannot change
 * what the page looks like.
 *
 * The app's own fixture can't test this (its base-14 fonts declare no /Widths,
 * so no glyph can be measured at all — the last case here pins that limit); the
 * synthetic pages above can.
 */
const COVER = { mode: 'cover' }

// what it hides, it removes — and what it merely clips, it leaves
{
  const { doc, page } = await mkDoc({
    content: `BT /F1 12 Tf 100 700 Td (HIDDEN) Tj 200 0 Td (EDGE) Tj ET`,
  })
  // over HIDDEN whole (6 glyphs at 0.5em), reaching UNDER the baseline as a real
  // patch does — cover mode counts the descender zone as part of a glyph, so a
  // mark that stops at the baseline does not contain it — and over the
  // whole WIDTH of EDGE but only the top of it, the way a patch cut to the ink
  // sits inside the taller box the glyphs are measured in. Not one of EDGE's
  // glyphs is contained, so not one may go.
  const patch = markOverUser(H, 99, 695, 0.5 * 12 * 6 + 2, 20)
  const clip = markOverUser(H, 299, 705, 0.5 * 12 * 4 + 2, 8)
  const result = redactPageContent(doc, page, [patch, clip], G0, COVER)
  const src = finalSrc(doc, page)
  const ok = !src.includes('(HIDDEN)') && src.includes('(EDGE)') && result.complete
  record('cover-hidden-vs-clipped', 'cover mode', ok ? 'OK' : (src.includes('(HIDDEN)') ? 'LEAK' : 'LOSS'),
    `hidden gone=${!src.includes('(HIDDEN)')} clipped kept=${src.includes('(EDGE)')} complete=${result.complete}`)
}

// a patch is not a promise: whatever it cannot remove, it leaves — and it never
// reports incompleteness, which is what would flatten the page to a raster
{
  const { doc, page } = await mkDoc({
    content: `BT /F1 12 Tf 100 700 Td (HIDDEN) Tj ET\nBI /W 2 /H 2 /CS /RGB /BPC 8 ID  
 EI\nq 1 0 0 1 0 0 cm 90 690 200 30 re f Q`,
  })
  const result = redactPageContent(doc, page, [markOverUser(H, 99, 695, 0.5 * 12 * 6 + 2, 20)], G0, COVER)
  const src = finalSrc(doc, page)
  const ok = result.complete && !src.includes('(HIDDEN)') && src.includes('BI')
  record('cover-never-rasters', 'cover mode', ok ? 'OK' : 'MISS',
    `complete=${result.complete} (must stay true) hidden gone=${!src.includes('(HIDDEN)')} inline image kept=${src.includes('BI')}`)
}

// A base-14 font may legally declare no /Widths — and then its metrics are not
// unknown, they are the published standard 14. Reading them makes the run
// measurable, so a patch that really does contain it can take it out.
{
  const { doc, page } = await mkDoc({
    noWidths: true,
    content: `BT /F1 12 Tf 100 700 Td (SECRET) Tj ET`,
  })
  const result = redactPageContent(doc, page, [markOverUser(H, 60, 660, 400, 100)], G0, COVER)
  const src = finalSrc(doc, page)
  record('cover-base14-metrics', 'cover mode', !src.includes('(SECRET)') && result.complete ? 'OK' : 'MISS',
    `removed=${!src.includes('(SECRET)')} complete=${result.complete} (Helvetica's widths are published, not unknown)`)
}

// …and the SAME run must survive a patch that only reaches most of the way
// across it. This is the case that used to be settled by a guess: at a flat half
// em a glyph the estimate falls short of Helvetica's caps by nearly half, so a
// patch over ~55% of a line looked like it contained the whole thing.
{
  const { doc, page } = await mkDoc({
    noWidths: true,
    content: `BT /F1 12 Tf 100 700 Td (TOTAL DUE 12,345.00 EUR) Tj ET`,
  })
  // Helvetica caps at 12pt run ~0.66em each: the real line is ~160pt wide. A mark
  // 95pt wide covers a bit over half of it and must remove nothing.
  const result = redactPageContent(doc, page, [markOverUser(H, 99, 698, 95, 16)], G0, COVER)
  const src = finalSrc(doc, page)
  record('cover-partial-line-kept', 'cover mode', src.includes('(TOTAL DUE 12,345.00 EUR)') ? 'OK' : 'LOSS',
    `whole line intact=${src.includes('(TOTAL DUE 12,345.00 EUR)')} (a patch over ~55% of it may take none of it)`)
}

// An inline image is one token whose entire byte run — dict, ID, payload, EI —
// lives in Tok.raw. Re-serialising it from {op,args} writes a bare `BI`, and a
// parser then eats every operator after it hunting for the ID that never comes.
// Redaction never reached this (an inline image forced the raster fallback);
// cover mode has no fallback, so the corrupt stream would ship.
{
  const { doc, page } = await mkDoc({
    content: 'q 100 0 0 100 20 20 cm\nBI /W 2 /H 2 /CS /G /BPC 8 ID \x01\x02\x03\x04 EI\nQ\n'
      + 'BT /F1 12 Tf 100 700 Td (HIDDEN) Tj ET\nBT /F1 12 Tf 100 600 Td (KEEPME) Tj ET',
  })
  const result = redactPageContent(doc, page, [markOverUser(H, 99, 695, 0.5 * 12 * 6 + 2, 20)], G0, COVER)
  const src = finalSrc(doc, page)
  const intact = src.includes('ID') && src.includes('EI') && src.includes('/W 2')
  record('cover-inline-image-intact', 'cover mode', intact && !src.includes('(HIDDEN)') && src.includes('(KEEPME)') ? 'OK' : 'LOSS',
    `inline image whole=${intact} hidden gone=${!src.includes('(HIDDEN)')} rest survives=${src.includes('(KEEPME)')}`)
}

// A path that also sets a clip (`re W f`) governs everything drawn after it. Its
// removal may take the paint and nothing else — drop the W and the construction
// with it and the clip is gone, so content that was cropped away reappears; drop
// the painter without standing in `n` and the stream is malformed.
{
  const { doc, page } = await mkDoc({
    content: 'q 50 690 200 30 re W f\nBT /F1 12 Tf 100 700 Td (INSIDE) Tj ET\nQ',
  })
  const els = walkPageContent(doc, page).elements
  const clipPath = els.find((e) => e.kind === 'fill-rect')
  const spanLen = clipPath ? clipPath.span[1] - clipPath.span[0] : -1
  record('clip-path-span-is-paint-only', 'clip', spanLen === 1 && clipPath?.standIn === 'n' ? 'OK' : 'LOSS',
    `span covers ${spanLen} token(s) (want 1: the painter alone) standIn=${JSON.stringify(clipPath?.standIn)}`)
}

// A form XObject's dictionary IS its identity: /Subtype /Form, /BBox, /Matrix,
// /Resources. Writing edited bytes back with a bare flateStream replaced the
// whole object and threw all of that away — the form stopped being a form and
// everything it drew left the page.
{
  const { doc, page } = await mkDoc({ content: 'q /Fm1 Do Q' })
  const formRef = formXObject(doc, 'BT /F1 12 Tf 10 10 Td (INFORM) Tj ET\nBT /F1 12 Tf 10 40 Td (ALSOIN) Tj ET', { bbox: [0, 0, 300, 200] })
  page.node.set(PDFName.of('Resources'), doc.context.obj({
    XObject: doc.context.obj({ Fm1: formRef }),
    Font: doc.context.obj({ F1: simpleFont(doc) }),
  }))
  const els = walkPageContent(doc, page).elements.filter((e) => e.kind === 'text' && e.formPath.length)
  removeSpans(doc, page, [{ span: els[0].span, formPath: els[0].formPath }])
  const form = doc.context.lookup(formRef)
  const dict = form?.dict
  const kept = ['Subtype', 'BBox', 'Matrix', 'Resources'].filter((k) => dict?.get(PDFName.of(k)))
  record('form-dict-survives-edit', 'form dict', kept.length === 4 ? 'OK' : 'LOSS',
    `kept [${kept.join(', ')}] of [Subtype, BBox, Matrix, Resources] after removing one run from inside the form`)
}

/* ---- report ------------------------------------------------------------- */

const BAD = new Set(['LEAK', 'LOSS', 'THREW', 'MISS'])
let bad = 0
console.log('\n  redactstream defect harness\n  ' + '-'.repeat(64))
for (const r of results) {
  const flag = BAD.has(r.verdict) ? '✗' : '·'
  if (BAD.has(r.verdict)) bad++
  console.log(`  ${flag} ${r.id.padEnd(16)} ${r.defect.padEnd(14)} ${r.verdict.padEnd(8)} ${r.detail}`)
}
console.log('  ' + '-'.repeat(64))
console.log(`  ${results.length - bad}/${results.length} acceptable  (${bad} defect${bad === 1 ? '' : 's'} reproduced)\n`)

writeFileSync(join(TMP, 'report.json'), JSON.stringify(results, null, 2))

// This harness is a DEFECT REPRODUCER first: on a clean checkout it is expected
// to show the known defects. Once fixed, every row should be acceptable and it
// becomes a regression guard. The process exit reflects that end state.
const CI = process.argv.includes('--ci')
if (CI && bad > 0) process.exit(1)
