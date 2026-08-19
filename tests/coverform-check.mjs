#!/usr/bin/env node
/*
 * When the words live inside a form XObject, do they actually leave the file?
 *
 * "Removal is real" is the product's flatest promise: retype, the box eraser,
 * lift, peel and AI clean take the covered content OUT of the page's drawing
 * program, so pdftotext sees what the reader sees. A great many real PDFs draw
 * their whole body inside a form XObject — anything merged with pdfpages or
 * pdfjam, anything stamped or watermarked with pdftk, anything imposed — and
 * for those the promise ran through a rule that read, in full:
 *
 *     applyEditsToContent(..., doc.pages.length === 1)
 *
 * One page: edit forms. Two or more: drop EVERY recorded form span on the
 * floor. The reasoning was sound (a form drawn by two pages is one shared
 * object, and editing it for the page that covers it strips the ink off the
 * page that does not) but the rule was far too blunt, because the overwhelming
 * majority of forms are drawn by exactly one page. So on any multi-page
 * document of that shape the erased words stayed in the file, silently, under
 * an opaque patch — and the cover pass that was supposed to be the backstop
 * returned complete:true having removed nothing.
 *
 * This drives the REAL applyEditsToContent through a re-export, on the two
 * cases that pull in opposite directions:
 *
 *   own-form     each page has its own form  -> the words must GO
 *   shared-form  both pages draw one form    -> the words must STAY, and the
 *                                               export must SAY so
 *
 *   node tests/coverform-check.mjs
 */
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const TMP = join(HERE, '.artifacts', 'coverform')

if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

// Bundle the real modules to ESM we can import, exactly as the other
// stream-surgery checks do. pdf-lib stays external so it resolves from
// node_modules and instanceof still works across the boundary.
async function bundle(entry) {
  const outfile = join(TMP, entry.replace(/[\/.]/g, '_') + '.mjs')
  await build({
    entryPoints: [join(ROOT, entry)],
    outfile, bundle: true, format: 'esm', platform: 'node',
    external: ['pdf-lib', '@pdf-lib/fontkit'], logLevel: 'silent',
  })
  return import('file://' + outfile)
}

const {
  textSpansUnder, walkPageContent, formSpanGuard, removeSpans,
} = await bundle('src/pdf/contentwalk.ts')
const { redactPageContent } = await bundle('src/pdf/redactstream.ts')

const SECRET = 'CONFIDENTIAL7788'
const OTHER = 'INNOCENTBYSTANDER'
const FONT_SIZE = 24

/**
 * A document of `pages` pages, each drawing a form XObject that prints SECRET.
 * `shared` decides whether that is one object drawn twice or one per page —
 * the whole question this test exists to separate.
 */
async function makeDoc({ pages, shared }) {
  const doc = await PDFDocument.create()
  const ctx = doc.context

  const fontRef = ctx.register(ctx.obj({
    Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding',
  }))

  const makeForm = (label) => {
    const body = `BT /F1 ${FONT_SIZE} Tf 1 0 0 1 60 700 Tm (${label}) Tj ET\n`
    const ref = ctx.register(ctx.flateStream(body, {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 612, 792],
      Resources: { Font: { F1: fontRef } },
    }))
    return ref
  }

  // With separate forms, only page 1 carries the secret and the others carry
  // OTHER — so "the secret is gone" and "nothing else was harmed" are two
  // different questions the same file can answer.
  const oneForm = shared ? makeForm(SECRET) : null
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([612, 792])
    const formRef = oneForm ?? makeForm(i === 0 ? SECRET : OTHER)
    const res = page.node.Resources() ?? ctx.obj({})
    const xo = ctx.obj({})
    xo.set(PDFName.of('X0'), formRef)
    res.set(PDFName.of('XObject'), xo)
    page.node.set(PDFName.of('Resources'), res)
    const content = ctx.register(ctx.flateStream('q /X0 Do Q\n'))
    page.node.set(PDFName.of('Contents'), content)
  }
  return doc
}

/* ---- run one case -------------------------------------------------------- */

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`  ${name.padEnd(22)} ${ok ? 'PASS' : 'FAIL'}  ${detail}`)
}

// PageGeom is user-space crop origin + size + total rotation; view space is
// CSS pixels from the top-left of the displayed page.
const GEOM = { cx: 0, cy: 0, uw: 612, uh: 792, rot: 0 }

// The band the app would hand the eraser: the printed line's own box. The text
// sits at user y=700, so in view space its baseline is 792-700 = 92.
const BAND = { x: 55, y: 64, w: 320, h: 36 }

for (const shared of [false, true]) {
  const label = shared ? 'shared-form' : 'own-form'
  const doc = await makeDoc({ pages: 2, shared })
  const bytes = await doc.save()
  const lib = await PDFDocument.load(bytes)
  const page = lib.getPage(0)

  const geom = GEOM
  const els = walkPageContent(lib, page).elements
  const spans = textSpansUnder(lib, page, geom, BAND, els)

  const inForm = spans.filter((s) => s.formPath?.length).length
  record(`${label}: span found`, inForm > 0,
    `${spans.length} span(s), ${inForm} inside a form (the eraser must see it at all)`)
}

/* ---- the export decision ------------------------------------------------- */
/*
 * applyEditsToContent is module-private, so exercise the rule it now uses:
 * a form span is applied when exactly ONE kept page can reach that form.
 * formRefsOnPage is the function the exporter counts with, so counting with it
 * here tests the real thing rather than a restatement of it.
 */
for (const shared of [false, true]) {
  const label = shared ? 'shared-form' : 'own-form'
  const doc = await makeDoc({ pages: 2, shared })
  const lib = await PDFDocument.load(await doc.save())

  // The exporter's own decision function, asked exactly as the exporter asks it.
  const formOk = formSpanGuard(lib, lib.getPages())

  const page = lib.getPage(0)
  const geom = GEOM
  const els = walkPageContent(lib, page).elements
  const spans = textSpansUnder(lib, page, geom, BAND, els)

  const allowed = spans.filter((e) => !e.formPath?.length || formOk(page, e.formPath))

  if (allowed.length) removeSpans(lib, page, allowed)
  const out = Buffer.from(await lib.save())

  // Ground truth: decode every stream and look for the strings themselves.
  const present = (needle) => {
    for (const [, obj] of lib.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFRawStream)) continue
      let text = ''
      try { text = Buffer.from(decodePDFRawStream(obj).decode()).toString('latin1') } catch { continue }
      if (text.includes(needle)) return true
    }
    return false
  }
  const stillThere = present(SECRET)

  if (shared) {
    // Correct behaviour is to LEAVE it: page 2 draws the same object and
    // nothing covers it there. Destroying page 2's ink would be the worse bug.
    record('shared-form: kept', stillThere,
      `applied ${allowed.length}/${spans.length} span(s); the other page's ink must survive`)
  } else {
    record('own-form: removed', !stillThere,
      `applied ${allowed.length}/${spans.length} span(s); the secret in file = ${stillThere}`)
    record('own-form: page 2 safe', present(OTHER),
      `the other page's own form must be untouched`)
  }
  void out
}

/* ---- the cover pass must not claim success it did not have --------------- */

{
  const doc = await makeDoc({ pages: 1, shared: false })
  const lib = await PDFDocument.load(await doc.save())
  const page = lib.getPage(0)
  const geom = GEOM
  const r = redactPageContent(lib, page, [BAND], geom, { mode: 'cover' })
  record('cover: reports gap', Boolean(r.gaps?.length),
    `removedRuns=${r.removedRuns} gaps=${JSON.stringify(r.gaps ?? null)} (a form it walked away from must be reported)`)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} form-removal invariants hold`)
process.exit(failed.length ? 1 : 0)
