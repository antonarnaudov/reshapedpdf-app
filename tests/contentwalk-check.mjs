#!/usr/bin/env node
/*
 * Does the page-walk see what the page paints, and in the right place?
 *
 * walkPageContent is redaction's walk with the decision removed: instead of
 * dropping what a mark covers, it records every run, image, form, filled
 * rectangle and stroked line, with the user-space box it lands in and the token
 * span that draws it. Layer extraction picks one of these; getting the box or
 * the kind wrong means the wrong thing gets lifted, or it lands in the wrong
 * place. layersAt turns a view click into the stack of elements under it,
 * topmost first, so a click can reach an element beneath a larger one.
 *
 * This drives both headlessly on synthetic pages whose content stream is
 * hand-written, so the expected boxes are exact arithmetic, not eyeballed.
 *
 *   node tests/contentwalk-check.mjs [--ci]
 */
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { PDFDocument, PDFName, PDFArray, PDFRawStream, decodePDFRawStream } from 'pdf-lib'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const TMP = join(HERE, '.artifacts', 'contentwalk')
if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

async function bundle(entry) {
  const out = join(TMP, entry.replace(/[\/.]/g, '_') + '.mjs')
  await build({
    entryPoints: [join(ROOT, entry)], outfile: out, bundle: true, format: 'esm',
    platform: 'node', external: ['pdf-lib', '@pdf-lib/fontkit'], logLevel: 'silent',
  })
  return import('file://' + out)
}
const { walkPageContent, layersAt, removeSpans, formStreamShared } = await bundle('src/pdf/contentwalk.ts')

// decode a page's content streams (or a form's) back to text, to check removeSpans
function pageSrc(doc, page) {
  const c = page.node.Contents()
  const refs = c instanceof PDFArray ? c.asArray() : [page.node.get(PDFName.of('Contents'))]
  let out = ''
  for (const ref of refs) {
    const st = doc.context.lookup(ref)
    if (st instanceof PDFRawStream) { const b = decodePDFRawStream(st).decode(); for (let i = 0; i < b.length; i += 0x8000) out += String.fromCharCode(...b.subarray(i, i + 0x8000)) }
  }
  return out
}
function formSrc(doc, page, name) {
  const xo = page.node.Resources()?.lookup(PDFName.of('XObject'))
  const st = doc.context.lookup(xo.get(PDFName.of(name)))
  const b = decodePDFRawStream(st).decode()
  let out = ''; for (let i = 0; i < b.length; i += 0x8000) out += String.fromCharCode(...b.subarray(i, i + 0x8000))
  return out
}

/* ---- synthetic page builder (same shape as redactstream-check) ---------- */

function simpleFont(d, emWidth = 0.5) {
  return d.context.register(d.context.obj({
    Type: PDFName.of('Font'), Subtype: PDFName.of('Type1'), BaseFont: PDFName.of('Helvetica'),
    FirstChar: 0, LastChar: 255, Widths: Array.from({ length: 256 }, () => Math.round(emWidth * 1000)),
  }))
}
function imageXObject(d) {
  return d.context.register(d.context.stream('00 >', {
    Type: PDFName.of('XObject'), Subtype: PDFName.of('Image'), Width: 10, Height: 10,
    ColorSpace: PDFName.of('DeviceRGB'), BitsPerComponent: 8, Filter: PDFName.of('ASCIIHexDecode'),
  }))
}
function formXObject(d, body, { bbox = [0, 0, 612, 792], matrix = [1, 0, 0, 1, 0, 0] } = {}) {
  return d.context.register(d.context.stream(body, {
    Type: PDFName.of('XObject'), Subtype: PDFName.of('Form'), BBox: bbox, Matrix: matrix,
    Resources: d.context.obj({ Font: d.context.obj({ F1: simpleFont(d) }) }),
  }))
}
async function mkDoc({ content, xobjects, colorSpaces } = {}) {
  const d = await PDFDocument.create()
  const page = d.addPage([612, 792])
  page.node.set(PDFName.of('MediaBox'), d.context.obj([0, 0, 612, 792]))
  const res = { Font: d.context.obj({ F1: simpleFont(d) }) }
  if (xobjects) res.XObject = d.context.obj(xobjects)
  if (colorSpaces) res.ColorSpace = d.context.obj(colorSpaces)
  page.node.set(PDFName.of('Resources'), d.context.obj(res))
  page.node.set(PDFName.of('Contents'), d.context.register(d.context.stream(content)))
  return { doc: d, page }
}

const G0 = { cx: 0, cy: 0, uw: 612, uh: 792, rot: 0 }
const viewYForUser = (uy) => 792 - uy // rot 0, cy 0

const results = []
const rec = (id, ok, detail) => results.push({ id, ok, detail })
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol
const boxNear = (box, x, y, w, h, tol = 1) => near(box.x, x, tol) && near(box.y, y, tol) && near(box.w, w, tol) && near(box.h, h, tol)

/* ---- cases -------------------------------------------------------------- */

// text run
{
  const { doc, page } = await mkDoc({ content: 'BT /F1 24 Tf 100 700 Td (Hello) Tj ET' })
  const els = walkPageContent(doc, page).elements
  const t = els.find((e) => e.kind === 'text')
  const ok = els.length === 1 && t && boxNear(t.userBox, 100, 700, 60, 24) && t.axisAligned && t.detail.measurable
  rec('text', ok, t ? `box=${JSON.stringify(t.userBox)} aa=${t.axisAligned}` : 'no text element')
}

// A base-14 font may declare no /Widths — and its metrics are still known, because
// the standard 14 are published. "Hello world" at 24pt Helvetica is 118.7pt wide;
// the flat half-em-a-glyph guess this used to fall back to says 132, and that 11%
// is the difference between a box you can trust to decide what a patch covers and
// one you can only pick with.
{
  const d = await PDFDocument.create()
  const page = d.addPage([612, 792])
  page.node.set(PDFName.of('MediaBox'), d.context.obj([0, 0, 612, 792]))
  const noWidths = d.context.register(d.context.obj({
    Type: PDFName.of('Font'), Subtype: PDFName.of('Type1'), BaseFont: PDFName.of('Helvetica'),
  }))
  page.node.set(PDFName.of('Resources'), d.context.obj({ Font: d.context.obj({ F1: noWidths }) }))
  page.node.set(PDFName.of('Contents'), d.context.register(d.context.stream('BT /F1 24 Tf 100 700 Td (Hello world) Tj ET')))
  const t = walkPageContent(d, page).elements.find((e) => e.kind === 'text')
  const ok = t && t.detail.measurable === true && Math.abs(t.userBox.w - 118.7) < 1.5
  rec('base14-metrics', ok, t ? `w=${t.userBox.w.toFixed(1)} (want 118.7, the real Helvetica width; the old guess said 132) measurable=${t.detail.measurable}` : 'no text')
}

// filled rectangle, device red
{
  const { doc, page } = await mkDoc({ content: '1 0 0 rg 100 600 200 50 re f' })
  const els = walkPageContent(doc, page).elements
  const r = els.find((e) => e.kind === 'fill-rect')
  const ok = els.length === 1 && r && boxNear(r.userBox, 100, 600, 200, 50) && r.detail.fill && r.detail.fill[0] === 1 && r.detail.fill[1] === 0
  rec('fill-rect', ok, r ? `box=${JSON.stringify(r.userBox)} fill=${JSON.stringify(r.detail.fill)}` : 'no fill-rect')
}

// stroked line, device blue
{
  const { doc, page } = await mkDoc({ content: '0 0 1 RG 2 w 100 500 m 300 520 l S' })
  const els = walkPageContent(doc, page).elements
  const l = els.find((e) => e.kind === 'stroke-line')
  const ok = l && l.detail.p1 && near(l.detail.p1[0], 100) && near(l.detail.p1[1], 500) &&
    near(l.detail.p2[0], 300) && near(l.detail.p2[1], 520) && l.detail.stroke[2] === 1
  rec('stroke-line', ok, l ? `p1=${l.detail.p1} p2=${l.detail.p2} stroke=${l.detail.stroke}` : 'no stroke-line')
}

// image XObject placed by cm
{
  const { doc, page } = await mkDoc({ content: 'q 200 0 0 100 100 400 cm /Im1 Do Q' })
  page.node.Resources().set(PDFName.of('XObject'), doc.context.obj({ Im1: imageXObject(doc) }))
  const els = walkPageContent(doc, page).elements
  const im = els.find((e) => e.kind === 'image')
  const ok = im && boxNear(im.userBox, 100, 400, 200, 100)
  rec('image', ok, im ? `box=${JSON.stringify(im.userBox)}` : 'no image')
}

// form wrapping the whole page, and RECURSION into it: the run inside the form
// is found at depth 1, tagged with the form it came through
{
  const { doc, page } = await mkDoc({ content: '/Fm1 Do' })
  page.node.Resources().set(PDFName.of('XObject'), doc.context.obj({ Fm1: formXObject(doc, 'BT /F1 24 Tf 100 700 Td (HELLO) Tj ET') }))
  const els = walkPageContent(doc, page).elements
  const f = els.find((e) => e.kind === 'form')
  const ok = f && boxNear(f.userBox, 0, 0, 612, 792, 1) && f.depth === 0
  rec('form', ok, f ? `box=${JSON.stringify(f.userBox)} depth=${f.depth}` : 'no form')
  const inner = els.find((e) => e.kind === 'text' && e.depth === 1)
  const innerOk = inner && inner.formPath.join() === '/Fm1' && near(inner.userBox.x, 100) && near(inner.userBox.y, 700, 2)
  rec('form-recurse', innerOk, inner ? `text depth=${inner.depth} path=${inner.formPath.join()} box=(${Math.round(inner.userBox.x)},${Math.round(inner.userBox.y)})` : 'inner run not found')
  // a click inside the form yields the form first, then descends to the run
  const hits = layersAt(els, G0, 110, viewYForUser(710))
  rec('form-pick-order', hits.length >= 2 && hits[0].kind === 'form' && hits.some((h) => h.kind === 'text'),
    `stack=${hits.map((h) => `${h.kind}@${h.depth}`).join(' > ')}`)
}

// curve -> path (not a shape tier)
{
  const { doc, page } = await mkDoc({ content: '100 300 m 150 350 200 300 250 350 c S' })
  const els = walkPageContent(doc, page).elements
  const p = els.find((e) => e.kind === 'path')
  rec('curve-path', !!p && els.length === 1, p ? `painted=${p.detail.painted}` : 'no path; got ' + els.map((e) => e.kind).join(','))
}

// a curved fill must be pickable: its box has to bound the whole curve, not
// just the anchor points (the cubic peaks well above its endpoints)
{
  const { doc, page } = await mkDoc({ content: '1 0 0 rg 100 700 m 100 760 200 760 200 700 c f' })
  const els = walkPageContent(doc, page).elements
  const p = els.find((e) => e.kind === 'path')
  // the curve peaks near user y 745; a click at (150, 740) must land in the box
  const hits = layersAt(els, G0, 150, viewYForUser(740))
  rec('curve-box', !!p && p.userBox.h > 30 && hits.some((h) => h.kind === 'path'),
    p ? `box h=${Math.round(p.userBox.h)} pickable=${hits.some((h) => h.kind === 'path')}` : 'no path')
}

// a shape that both clips and paints (`re W f`) must still be emitted
{
  const { doc, page } = await mkDoc({ content: '1 0 0 rg 50 50 200 100 re W f' })
  const els = walkPageContent(doc, page).elements
  const r = els.find((e) => e.kind === 'fill-rect')
  rec('clip-and-paint', !!r && boxNear(r.userBox, 50, 50, 200, 100), r ? `box=${JSON.stringify(r.userBox)}` : 'dropped (only got ' + els.map((e) => e.kind).join(',') + ')')
}

// non-device colour -> fill absent (must NOT become a coloured shape).
// The `cs` operator selects a named colour space; the walk can't resolve it to
// device RGB, so it drops the colour to null and the tier will raster.
{
  const { doc, page } = await mkDoc({ content: '/Sep1 cs 0.5 scn 100 100 50 50 re f' })
  const els = walkPageContent(doc, page).elements
  const r = els.find((e) => e.kind === 'fill-rect')
  const ok = r && !r.detail.fill
  rec('nondevice-colour', ok, r ? `fill=${JSON.stringify(r.detail.fill)}` : 'no fill-rect')
}

// rotated text -> axisAligned false (box is only a bound)
{
  const { doc, page } = await mkDoc({ content: 'BT /F1 24 Tf 0 1 -1 0 300 400 Tm (R) Tj ET' })
  const els = walkPageContent(doc, page).elements
  const t = els.find((e) => e.kind === 'text')
  rec('rotated-text', t && t.axisAligned === false, t ? `aa=${t.axisAligned}` : 'no text')
}

// removeSpans (destructive lift's true-background): dropping a run's span takes
// its string out of the stream, leaving the advance stand-in so the line holds
{
  const { doc, page } = await mkDoc({ content: 'BT /F1 12 Tf 100 700 Td (KEEP) Tj (GONE) Tj ET' })
  const runs = walkPageContent(doc, page).elements.filter((e) => e.kind === 'text')
  const target = runs[1] // (GONE)
  removeSpans(doc, page, [{ span: target.span, replacement: target.detail.synth }])
  const src = pageSrc(doc, page)
  rec('removeSpans-page', !src.includes('(GONE)') && src.includes('(KEEP)'), `gone=${!src.includes('(GONE)')} kept=${src.includes('(KEEP)')}`)
}

// removeSpans INSIDE a form (copy-on-write): the span indexes the form's own
// tokens, so it must be removed from the form's stream, not the page's
{
  const { doc, page } = await mkDoc({ content: '/Fm1 Do' })
  page.node.Resources().set(PDFName.of('XObject'), doc.context.obj({ Fm1: formXObject(doc, 'BT /F1 24 Tf 100 700 Td (INFORM) Tj ET') }))
  const inner = walkPageContent(doc, page).elements.find((e) => e.kind === 'text' && e.depth === 1)
  removeSpans(doc, page, [{ span: inner.span, replacement: inner.detail.synth, formPath: inner.formPath }])
  const fsrc = formSrc(doc, page, 'Fm1')
  rec('removeSpans-form', !fsrc.includes('(INFORM)'), `form still has text: ${fsrc.includes('(INFORM)')}`)
}

// removeSpans must NOT destroy an inline image sharing the stream with a lifted
// run — its BI…EI (binary and all) has to survive the rewrite verbatim
{
  const { doc, page } = await mkDoc({ content: 'BT /F1 12 Tf 100 700 Td (GONE) Tj ET q 20 0 0 20 300 400 cm BI /W 1 /H 1 /CS /RGB /BPC 8 ID XYZ EI Q' })
  const t = walkPageContent(doc, page).elements.find((e) => e.kind === 'text')
  removeSpans(doc, page, [{ span: t.span, replacement: t.detail.synth }])
  const src = pageSrc(doc, page)
  rec('removeSpans-inline-image', !src.includes('(GONE)') && src.includes('BI /W 1') && src.includes('ID XYZ'),
    `gone=${!src.includes('(GONE)')} imageKept=${src.includes('BI /W 1') && src.includes('ID XYZ')}`)
}

// picking + descend: a small text, then a LATER full-page rect painted over it
{
  const { doc, page } = await mkDoc({ content: 'BT /F1 24 Tf 100 700 Td (Hi) Tj ET 1 1 0 rg 0 0 612 792 re f' })
  const els = walkPageContent(doc, page).elements
  // click over the text (user ~120,710)
  const hits = layersAt(els, G0, 120, viewYForUser(710))
  const topIsRect = hits[0] && hits[0].kind === 'fill-rect'
  const descendIsText = hits[1] && hits[1].kind === 'text'
  rec('pick-descend', hits.length === 2 && topIsRect && descendIsText, `stack=${hits.map((h) => h.kind).join(' > ')}`)
}

// picking outside any element -> empty
{
  const { doc, page } = await mkDoc({ content: 'BT /F1 24 Tf 100 700 Td (Hi) Tj ET' })
  const els = walkPageContent(doc, page).elements
  const hits = layersAt(els, G0, 400, viewYForUser(100))
  rec('pick-empty', hits.length === 0, `hits=${hits.length}`)
}

// removeSpans across a MULTI-stream /Contents array: drop the run in the 2nd
// stream, the 1st stays — exercises per-ref offset tracking
{
  const d = await PDFDocument.create()
  const page = d.addPage([612, 792])
  page.node.set(PDFName.of('Resources'), d.context.obj({ Font: d.context.obj({ F1: simpleFont(d) }) }))
  const r1 = d.context.register(d.context.stream('BT /F1 24 Tf 100 700 Td (KEEPA) Tj ET'))
  const r2 = d.context.register(d.context.stream('BT /F1 24 Tf 100 600 Td (DROPB) Tj ET'))
  const arr = PDFArray.withContext(d.context); arr.push(r1); arr.push(r2)
  page.node.set(PDFName.of('Contents'), arr)
  const els = walkPageContent(d, page).elements
  const drop = els.find((e) => e.kind === 'text' && e.userBox.y < 650)
  removeSpans(d, page, [{ span: drop.span, replacement: drop.detail.synth }])
  const src = pageSrc(d, page)
  rec('removeSpans-multistream', !src.includes('(DROPB)') && src.includes('(KEEPA)'), `gone=${!src.includes('(DROPB)')} kept=${src.includes('(KEEPA)')}`)
}

// removeSpans dropping an IMAGE span (single Do token, no stand-in)
{
  const { doc, page } = await mkDoc({ content: 'q 200 0 0 100 100 400 cm /Im1 Do Q BT /F1 24 Tf 100 700 Td (KEEP) Tj ET' })
  page.node.Resources().set(PDFName.of('XObject'), doc.context.obj({ Im1: imageXObject(doc) }))
  const im = walkPageContent(doc, page).elements.find((e) => e.kind === 'image')
  removeSpans(doc, page, [{ span: im.span }])
  const src = pageSrc(doc, page)
  rec('removeSpans-image', !src.includes('/Im1 Do') && src.includes('(KEEP)'), `imgGone=${!src.includes('/Im1 Do')} kept=${src.includes('(KEEP)')}`)
}

// removeSpans dropping a SHAPE span — a MULTI-token span (`re ... f`)
{
  const { doc, page } = await mkDoc({ content: '1 0 0 rg 100 600 200 50 re f BT /F1 24 Tf 100 700 Td (KEEP) Tj ET' })
  const r = walkPageContent(doc, page).elements.find((e) => e.kind === 'fill-rect')
  removeSpans(doc, page, [{ span: r.span }])
  const src = pageSrc(doc, page)
  const rectGone = !/\bre\b/.test(src) && !/\d\s+f\b/.test(src)
  rec('removeSpans-shape', rectGone && src.includes('(KEEP)'), `rectGone=${rectGone} kept=${src.includes('(KEEP)')}`)
}

// the advance stand-in is actually PRESENT and correctly valued, so text after
// the dropped run keeps its place (6 glyphs at 0.5em, fs 24 -> advance 72)
{
  const { doc, page } = await mkDoc({ content: 'BT /F1 24 Tf 100 700 Td (SECRET) Tj (AFTER) Tj ET' })
  const t = walkPageContent(doc, page).elements.find((e) => e.kind === 'text')
  removeSpans(doc, page, [{ span: t.span, replacement: t.detail.synth }])
  const src = pageSrc(doc, page)
  const m = src.match(/\[\s*(-?\d+(?:\.\d+)?)\s*\]\s*TJ/)
  const n = m ? Number(m[1]) : NaN
  // advance 72 in text space -> TJ number = -advance*1000/(fs*th) = -3000
  rec('removeSpans-advance', !src.includes('(SECRET)') && Math.abs(n + 3000) < 1, `standIn=${m ? m[0] : 'none'}`)
}

// COPY-ON-WRITE ISOLATION: removing a span on a copied page must NOT touch the
// source doc's form — the core safety claim of destructive lift inside a form
{
  const src = await PDFDocument.create()
  const sp = src.addPage([612, 792])
  sp.node.set(PDFName.of('Resources'), src.context.obj({ XObject: src.context.obj({ Fm1: formXObject(src, 'BT /F1 24 Tf 100 700 Td (SHARED) Tj ET') }) }))
  sp.node.set(PDFName.of('Contents'), src.context.register(src.context.stream('/Fm1 Do')))
  // work on a COPY, as renderPageWithoutSpans does
  const tmp = await PDFDocument.create()
  const [copied] = await tmp.copyPages(src, [0])
  tmp.addPage(copied)
  const inner = walkPageContent(tmp, tmp.getPage(0)).elements.find((e) => e.kind === 'text' && e.depth === 1)
  removeSpans(tmp, tmp.getPage(0), [{ span: inner.span, replacement: inner.detail.synth, formPath: inner.formPath }])
  const tmpGone = !formSrc(tmp, tmp.getPage(0), 'Fm1').includes('(SHARED)')
  const srcIntact = formSrc(src, src.getPage(0), 'Fm1').includes('(SHARED)')
  rec('removeSpans-isolation', tmpGone && srcIntact, `copyGone=${tmpGone} sourceIntact=${srcIntact}`)
}

// nested form (depth 2): a form that draws another form; the deep run is found
// at depth 2 with a two-name path, through both matrices
{
  const d = await PDFDocument.create()
  const page = d.addPage([612, 792])
  const fm2 = formXObject(d, 'BT /F1 24 Tf 50 700 Td (DEEP) Tj ET')
  const fm1 = d.context.register(d.context.stream('/Fm2 Do', {
    Type: PDFName.of('XObject'), Subtype: PDFName.of('Form'), BBox: [0, 0, 612, 792], Matrix: [1, 0, 0, 1, 0, 0],
    Resources: d.context.obj({ XObject: d.context.obj({ Fm2: fm2 }) }),
  }))
  page.node.set(PDFName.of('Resources'), d.context.obj({ XObject: d.context.obj({ Fm1: fm1 }) }))
  page.node.set(PDFName.of('Contents'), d.context.register(d.context.stream('/Fm1 Do')))
  const deep = walkPageContent(d, page).elements.find((e) => e.kind === 'text' && e.depth === 2)
  rec('nested-form-depth2', deep && deep.formPath.join(',') === '/Fm1,/Fm2', deep ? `depth=${deep.depth} path=${deep.formPath.join(',')}` : 'not found')
}

// a form placed with a NON-identity /Matrix (scale 2, translate) transforms its
// inner geometry: inner text drawn at (10,10) lands at (2*10+40, 2*10+30)
{
  const d = await PDFDocument.create()
  const page = d.addPage([612, 792])
  const fm = formXObject(d, 'BT /F1 10 Tf 10 10 Td (X) Tj ET', { matrix: [2, 0, 0, 2, 40, 30] })
  page.node.set(PDFName.of('Resources'), d.context.obj({ XObject: d.context.obj({ Fm1: fm }) }))
  page.node.set(PDFName.of('Contents'), d.context.register(d.context.stream('/Fm1 Do')))
  const t = walkPageContent(d, page).elements.find((e) => e.kind === 'text' && e.depth === 1)
  rec('form-matrix', t && near(t.userBox.x, 60) && near(t.userBox.y, 50, 2), t ? `box=(${Math.round(t.userBox.x)},${Math.round(t.userBox.y)})` : 'no inner text')
}

// a form with NO /Resources inherits the parent's fonts, so its run measures
{
  const d = await PDFDocument.create()
  const page = d.addPage([612, 792])
  const fm = d.context.register(d.context.stream('BT /F1 24 Tf 100 700 Td (INHERIT) Tj ET', {
    Type: PDFName.of('XObject'), Subtype: PDFName.of('Form'), BBox: [0, 0, 612, 792], Matrix: [1, 0, 0, 1, 0, 0],
  })) // deliberately no /Resources
  page.node.set(PDFName.of('Resources'), d.context.obj({ Font: d.context.obj({ F1: simpleFont(d) }), XObject: d.context.obj({ Fm1: fm }) }))
  page.node.set(PDFName.of('Contents'), d.context.register(d.context.stream('/Fm1 Do')))
  const t = walkPageContent(d, page).elements.find((e) => e.kind === 'text' && e.depth === 1)
  rec('form-resources-fallback', t && t.detail.measurable === true && t.userBox.w > 40, t ? `measurable=${t.detail.measurable} w=${Math.round(t.userBox.w)}` : 'no inner text')
}

// cycle safety: a form that draws ITSELF must terminate (bounded by maxDepth),
// not hang or overflow
{
  const d = await PDFDocument.create()
  const page = d.addPage([612, 792])
  const ref = d.context.nextRef()
  const fm = PDFRawStream.of(d.context.obj({
    Type: PDFName.of('XObject'), Subtype: PDFName.of('Form'), BBox: [0, 0, 612, 792], Matrix: [1, 0, 0, 1, 0, 0],
    Resources: d.context.obj({ XObject: d.context.obj({ Fm1: ref }) }), // points at itself
  }), new TextEncoder().encode('/Fm1 Do'))
  d.context.assign(ref, fm)
  page.node.set(PDFName.of('Resources'), d.context.obj({ XObject: d.context.obj({ Fm1: ref }) }))
  page.node.set(PDFName.of('Contents'), d.context.register(d.context.stream('/Fm1 Do')))
  let terminated = false, forms = 0
  try { const els = walkPageContent(d, page, { maxDepth: 5 }).elements; terminated = true; forms = els.filter((e) => e.kind === 'form').length } catch { terminated = false }
  rec('form-cycle-safe', terminated && forms > 0 && forms <= 6, `terminated=${terminated} forms=${forms}`)
}

// an inline image whose binary payload CONTAINS the bytes 'EI' must not
// terminate early: the walk still finds the text after it, and a rewrite keeps
// the image whole. 'AEIB' has an EI not preceded by whitespace (correctly
// skipped); the real ' EI' ends the image.
{
  const { doc, page } = await mkDoc({ content: 'q BI /W 4 /H 1 /CS /DeviceGray /BPC 8 ID AEIB EI Q BT /F1 24 Tf 100 700 Td (AFTER) Tj ET' })
  const els = walkPageContent(doc, page).elements
  const t = els.find((e) => e.kind === 'text')
  const img = els.find((e) => e.kind === 'inline-image')
  const okWalk = !!img && !!t && near(t.userBox.x, 100) && near(t.userBox.y, 700, 2)
  // and removing the text must leave the inline image (with its AEIB data) intact
  let okKeep = false
  if (t) { removeSpans(doc, page, [{ span: t.span, replacement: t.detail.synth }]); const src = pageSrc(doc, page); okKeep = src.includes('ID AEIB EI') && !src.includes('(AFTER)') }
  rec('inline-image-EI-in-data', okWalk && okKeep, `img=${!!img} textAfter=${!!t} imgKept=${okKeep}`)
}

// an inline image whose payload's last byte ABUTS the terminating EI (no
// whitespace between them, which ISO 32000 permits) must still terminate at that
// EI — the exact payload length pins it. A whitespace-before rule alone would
// reject it and swallow the rest of the stream.
{
  const { doc, page } = await mkDoc({ content: 'q BI /W 4 /H 1 /CS /DeviceGray /BPC 8 ID wxyzEI Q BT /F1 24 Tf 100 700 Td (AFTER) Tj ET' })
  const els = walkPageContent(doc, page).elements
  const t = els.find((e) => e.kind === 'text')
  const img = els.find((e) => e.kind === 'inline-image')
  let okKeep = false
  if (t) { removeSpans(doc, page, [{ span: t.span, replacement: t.detail.synth }]); const src = pageSrc(doc, page); okKeep = src.includes('ID wxyzEI') && !src.includes('(AFTER)') }
  rec('inline-image-EI-abuts', !!img && !!t && okKeep, `img=${!!img} textAfter=${!!t} imgKept=${okKeep}`)
}

// a FILTERED inline image has no computable length, so the terminator falls back
// to the whitespace/boundary scan — the image and the text after it both survive
{
  const { doc, page } = await mkDoc({ content: 'q BI /W 2 /H 2 /CS /RGB /F /AHx ID 00ff00 ff00ff> EI Q BT /F1 24 Tf 100 700 Td (TAIL) Tj ET' })
  const els = walkPageContent(doc, page).elements
  const img = els.find((e) => e.kind === 'inline-image')
  const t = els.find((e) => e.kind === 'text')
  rec('inline-image-filtered', !!img && !!t && near(t.userBox.x, 100), `img=${!!img} textAfter=${!!t}`)
}

// the hardest case: the payload contains a whitespace-framed ' EI ' EARLY, then
// the real EI abuts its last byte. A scan for a ws-delimited EI (the old rule)
// matches the decoy and truncates the image; only the exact payload length pins
// the real terminator. W6 H1 gray 8bpc -> exactly 6 data bytes ("x EI z").
{
  const { doc, page } = await mkDoc({ content: 'q BI /W 6 /H 1 /CS /DeviceGray /BPC 8 ID x EI zEI Q BT /F1 24 Tf 100 700 Td (END) Tj ET' })
  const els = walkPageContent(doc, page).elements
  const img = els.find((e) => e.kind === 'inline-image')
  const t = els.find((e) => e.kind === 'text')
  let okKeep = false
  if (t) { removeSpans(doc, page, [{ span: t.span, replacement: t.detail.synth }]); const src = pageSrc(doc, page); okKeep = src.includes('ID x EI zEI') && !src.includes('(END)') }
  rec('inline-image-EI-decoy', !!img && !!t && okKeep, `img=${!!img} textAfter=${!!t} imgKept=${okKeep}`)
}

// a multi-row image: byte-aligned rows mean length = ceil(W*comps*bpc/8)*H.
// W2 H3 RGB 8bpc -> 6 bytes/row * 3 = 18 bytes; the EI after them terminates it
{
  const data = 'abcdefghijklmnopqr' // 18 bytes, no 'EI' inside
  const { doc, page } = await mkDoc({ content: `q BI /W 2 /H 3 /CS /RGB /BPC 8 ID ${data}EI Q BT /F1 24 Tf 100 700 Td (ROWS) Tj ET` })
  const els = walkPageContent(doc, page).elements
  const img = els.find((e) => e.kind === 'inline-image')
  const t = els.find((e) => e.kind === 'text')
  rec('inline-image-multirow', !!img && !!t && near(t.userBox.x, 100), `img=${!!img} textAfter=${!!t}`)
}

// formStreamShared: a form drawn twice on the page shares one stream, so a
// destructive lift must detect it and NOT edit in place (the second copy would
// lose its ink); a form drawn once is safe (copy-on-write isolates the copy)
{
  const { doc, page } = await mkDoc({ content: '/Fm1 Do 1 0 0 1 200 0 cm /Fm1 Do' })
  page.node.Resources().set(PDFName.of('XObject'), doc.context.obj({ Fm1: formXObject(doc, 'BT /F1 24 Tf 100 700 Td (TWICE) Tj ET') }))
  rec('form-shared-twice', formStreamShared(doc, page, ['/Fm1']) === true, `shared=${formStreamShared(doc, page, ['/Fm1'])}`)
}
{
  const { doc, page } = await mkDoc({ content: '/Fm1 Do' })
  page.node.Resources().set(PDFName.of('XObject'), doc.context.obj({ Fm1: formXObject(doc, 'BT /F1 24 Tf 100 700 Td (ONCE) Tj ET') }))
  rec('form-shared-once', formStreamShared(doc, page, ['/Fm1']) === false, `shared=${formStreamShared(doc, page, ['/Fm1'])}`)
}
// the hard case: the target is nested UNDER an intermediate form (A) that is
// itself drawn twice. A's stream (and the target T inside it) is shared across
// both occurrences, so a destructive edit would corrupt one — must be caught. A
// per-form-memoised count gets this; a global visited-set would skip A's second
// invocation and undercount to 1.
{
  const { doc, page } = await mkDoc({ content: '/A Do 1 0 0 1 200 0 cm /A Do' })
  const inner = formXObject(doc, 'BT /F1 24 Tf 50 700 Td (NESTED) Tj ET') // target T
  const outer = doc.context.register(doc.context.stream('/T Do', {
    Type: PDFName.of('XObject'), Subtype: PDFName.of('Form'), BBox: [0, 0, 612, 792], Matrix: [1, 0, 0, 1, 0, 0],
    Resources: doc.context.obj({ XObject: doc.context.obj({ T: inner }) }),
  }))
  page.node.Resources().set(PDFName.of('XObject'), doc.context.obj({ A: outer }))
  rec('form-shared-nested', formStreamShared(doc, page, ['/A', '/T']) === true, `shared=${formStreamShared(doc, page, ['/A', '/T'])}`)
}
// and the mirror: an intermediate drawn ONCE with the target once inside is not
// shared (the memoised count must not spuriously multiply)
{
  const { doc, page } = await mkDoc({ content: '/A Do' })
  const inner = formXObject(doc, 'BT /F1 24 Tf 50 700 Td (SOLO) Tj ET')
  const outer = doc.context.register(doc.context.stream('/T Do', {
    Type: PDFName.of('XObject'), Subtype: PDFName.of('Form'), BBox: [0, 0, 612, 792], Matrix: [1, 0, 0, 1, 0, 0],
    Resources: doc.context.obj({ XObject: doc.context.obj({ T: inner }) }),
  }))
  page.node.Resources().set(PDFName.of('XObject'), doc.context.obj({ A: outer }))
  rec('form-shared-nested-once', formStreamShared(doc, page, ['/A', '/T']) === false, `shared=${formStreamShared(doc, page, ['/A', '/T'])}`)
}
// mutual recursion (A draws B, B draws A): the target T is reachable via TWO
// acyclic paths — Page→A→T and Page→B→A→T — so its stream is genuinely shared.
// Only the cyclic continuations (…A→B→A…) are blocked. A per-form count MEMO
// would freeze B's cycle-context count at 0 and undercount to 1 (→ corruption);
// an un-memoised ancestor-stack count gets it right.
{
  const { doc, page } = await mkDoc({ content: '/A Do /B Do' })
  const T = formXObject(doc, 'BT /F1 24 Tf 50 700 Td (MUT) Tj ET')
  const Aref = doc.context.nextRef()
  const Bref = doc.context.nextRef()
  const formDict = (res) => ({ Type: PDFName.of('XObject'), Subtype: PDFName.of('Form'), BBox: [0, 0, 612, 792], Matrix: [1, 0, 0, 1, 0, 0], Resources: res })
  doc.context.assign(Aref, doc.context.stream('/T Do /B Do', formDict(doc.context.obj({ XObject: doc.context.obj({ T, B: Bref }) }))))
  doc.context.assign(Bref, doc.context.stream('/A Do', formDict(doc.context.obj({ XObject: doc.context.obj({ A: Aref }) }))))
  page.node.Resources().set(PDFName.of('XObject'), doc.context.obj({ A: Aref, B: Bref }))
  rec('form-shared-mutual', formStreamShared(doc, page, ['/A', '/T']) === true, `shared=${formStreamShared(doc, page, ['/A', '/T'])}`)
}
// a Contents ARRAY split mid-invocation: stream 1 ends at the operand `/Fm0`,
// stream 2 begins with `Do`. Tokenizing each stream alone drops that invocation
// (its operand or its operator), undercounting to 1 and corrupting the shared
// form. Concatenating the decoded bytes before tokenizing sees both draws.
{
  const { doc, page } = await mkDoc({ content: '' })
  const s1 = doc.context.register(doc.context.stream('q 1 0 0 1 100 100 cm /Fm0'))
  const s2 = doc.context.register(doc.context.stream('Do Q q 1 0 0 1 300 300 cm /Fm0 Do Q'))
  page.node.set(PDFName.of('Contents'), doc.context.obj([s1, s2]))
  page.node.Resources().set(PDFName.of('XObject'), doc.context.obj({ Fm0: formXObject(doc, 'BT /F1 24 Tf 10 700 Td (SPLIT) Tj ET') }))
  rec('form-shared-split-contents', formStreamShared(doc, page, ['/Fm0']) === true, `shared=${formStreamShared(doc, page, ['/Fm0'])}`)
}

// layersAt z-tiebreak: two overlapping fill-rects at the SAME depth — the one
// painted LATER (higher z) is picked first
{
  const { doc, page } = await mkDoc({ content: '1 0 0 rg 100 600 200 100 re f 0 0 1 rg 120 620 100 40 re f' })
  const els = walkPageContent(doc, page).elements
  const hits = layersAt(els, G0, 150, viewYForUser(640)) // inside both
  const firstIsLater = hits.length >= 2 && hits[0].z > hits[1].z
  rec('z-tiebreak', firstIsLater, `stack z=${hits.map((h) => h.z).join(',')}`)
}

// A TRUNCATED content stream must not hang the tokenizer. An unterminated hex
// string has no '>', so indexOf returned -1 and `i = j + 1` rewound the cursor to
// 0 and restarted the scan forever — a damaged-but-renderable PDF froze the
// renderer to a multi-GB OOM on the first Lift click (redaction shares this
// tokenizer). Run in a CHILD process with a timeout: if the fix regresses, the
// case must FAIL, never hang this suite.
{
  const runner = join(TMP, 'tok-runner.mjs')
  writeFileSync(runner, `
import { tokenize } from 'file://${join(TMP, 'src_pdf_contentwalk_ts.mjs')}'
const SRC = { hex: 'BT /F1 12 Tf 72 700 Td (hi) Tj ET\\n<41', tj: 'BT [(a) <41 ] TJ ET' }
console.log(tokenize(SRC[process.argv[2]]).length)
`)
  for (const [id, arg] of [['tokenize-truncated-hex', 'hex'], ['tokenize-truncated-tj-hex', 'tj']]) {
    const r = spawnSync(process.execPath, [runner, arg], { timeout: 20000, encoding: 'utf8' })
    const hung = r.signal != null || r.status === null
    rec(id, !hung && r.status === 0, hung ? 'HUNG/killed — tokenizer does not terminate' : `terminated, ${String(r.stdout).trim()} tokens`)
  }
}

/* ---- report ---- */
let bad = 0
console.log('\n  content-walk check\n  ' + '-'.repeat(60))
for (const r of results) {
  if (!r.ok) bad++
  console.log(`  ${r.ok ? '·' : '✗'} ${r.id.padEnd(18)} ${r.detail}`)
}
console.log('  ' + '-'.repeat(60))
console.log(`  ${results.length - bad}/${results.length} pass\n`)
writeFileSync(join(TMP, 'report.json'), JSON.stringify(results, null, 2))
if (process.argv.includes('--ci') && bad > 0) process.exit(1)
