#!/usr/bin/env node
/*
 * Build the erase corpus — documents this project owns outright.
 *
 * The suite used to run against two real documents: a named individual's CV
 * (photograph included) and a company's internal event email. They were the
 * honest choice while the repo was private — real type, real colour, real
 * artefacts — and exactly the wrong thing to publish. A public repository is
 * forever and worldwide, and neither person ever agreed to that.
 *
 * So the corpus is generated instead. That costs a little realism and buys two
 * things back: nobody's data ships, and every target's geometry is EXACT rather
 * than measured off a render — the coordinates below are the ones the text was
 * drawn at, so a failing case means the eraser missed, never that the rect was
 * a pixel out.
 *
 * What the pages deliberately contain, because each one broke something once:
 *   · a bold coloured run with punctuation immediately after it — an over-wide
 *     erase eats the "!"
 *   · a short bold heading — a small target must not be over-erased
 *   · coloured text WITH an underline rule beneath it — the rule is not part of
 *     the text and must survive
 *   · a run inside a filled colour band — the patch has to match the band, not
 *     the paper
 *   · a raster strip with speckled grain and white lettering baked in — nothing
 *     can recover that background, which is what tier 2 measures
 *
 *   node tests/fixtures/make-fixtures.mjs
 */
import { writeFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'

const HERE = dirname(fileURLToPath(import.meta.url))
const W = 595, H = 842                       // A4 in points
const hex = (h) => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255)

/** A 1-bit-ish speckled band, drawn as an image so its words are pixels. */
function speckledBand(width, height, seed = 7) {
  // deterministic noise — the same corpus on every machine and every run
  let s = seed
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  const px = new Uint8Array(width * height * 3)
  for (let i = 0; i < width * height; i++) {
    const n = 26 + Math.floor(rnd() * 22)      // dark ground with grain
    px[i * 3] = n; px[i * 3 + 1] = n + 2; px[i * 3 + 2] = n + 6
  }
  return px
}

/** Wrap raw RGB into a minimal PNG (no deps: store-mode deflate + CRC). */
function toPng(px, w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf) => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, cr])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  // raw scanlines, each prefixed with filter byte 0
  const raw = Buffer.alloc(h * (1 + w * 3))
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0
    Buffer.from(px.buffer, px.byteOffset + y * w * 3, w * 3).copy(raw, y * (1 + w * 3) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}

const doc = await PDFDocument.create()
const page = doc.addPage([W, H])
const body = await doc.embedFont(StandardFonts.Helvetica)
const bold = await doc.embedFont(StandardFonts.HelveticaBold)

// A REAL EMBEDDED, SUBSET FONT — the single most important thing in this file.
//
// Everything else here is base-14 Helvetica, which pdf-lib does not embed: the
// PDF just names it and the reader supplies it. Almost no real document works
// that way. Real documents embed a subset of a real font program, and that puts
// the editor down a completely different path — `usableFace`, where the page's
// own typeface is harvested and used to re-set the words, rather than a
// metric-compatible stand-in from the palette.
//
// That path had NO coverage here at all, which is how a change to it shipped
// having been "verified" against a corpus that cannot reach it. Arimo, because
// it is Apache-2.0 (see THIRD-PARTY.md) and metric-compatible with Helvetica,
// so the same sentence can be set both ways and compared.
doc.registerFontkit(fontkit)
const realBytes = readFileSync(join(HERE, '..', '..', 'public', 'fonts', 'arimo-400.ttf'))
const realBold = readFileSync(join(HERE, '..', '..', 'public', 'fonts', 'arimo-700.ttf'))
const embedded = await doc.embedFont(realBytes, { subset: true })
const embeddedBold = await doc.embedFont(realBold, { subset: true })

const INK = hex('#2f2f33')
const BLUE = hex('#12408a')
const GREEN = hex('#1f7a4d')

page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: rgb(1, 1, 1) })

// ---- the raster strip: white lettering baked into speckled pixels (tier 2)
const bandW = 1100, bandH = 190
const png = await doc.embedPng(toPng(speckledBand(bandW, bandH), bandW, bandH))
page.drawImage(png, { x: 0, y: H - 96, width: W, height: 96 })
// "printed" into the raster region: drawn as text but over the band, so the
// eraser has no clean background to recover — the tier-2 condition
page.drawText('WORKS OUTING', { x: 40, y: H - 56, size: 22, font: bold, color: rgb(1, 1, 1) })
page.drawText('summer programme', { x: 40, y: H - 80, size: 12, font: body, color: hex('#7fd4a6') })

// ---- tier 1: an ordinary letter, with the four awkward shapes
let y = H - 150
const line = (text, opts = {}) => {
  page.drawText(text, { x: opts.x ?? 56, y, size: opts.size ?? 11, font: opts.font ?? body, color: opts.color ?? INK })
  y -= opts.gap ?? 22
}

line('Dear all,', { font: bold, gap: 30 })
line('The date is fixed and the coach is booked. Please read the whole note before', { gap: 18 })
line('you reply, because two of the details changed since the last one.', { gap: 30 })

// a bold coloured run with '!' hard against it
page.drawText('The trip is ', { x: 56, y, size: 11, font: body, color: INK })
page.drawText('confirmed', { x: 121, y, size: 11, font: bold, color: BLUE })
page.drawText('! Everything below follows from that.', { x: 178, y, size: 11, font: body, color: INK })
const RUN_CONFIRMED = [121, y, bold.widthOfTextAtSize('confirmed', 11), 11]
y -= 34

// a short bold heading
page.drawText('Saturday', { x: 56, y, size: 11, font: bold, color: INK })
const RUN_SATURDAY = [56, y, bold.widthOfTextAtSize('Saturday', 11), 11]
y -= 22
line('Coach leaves at eight from the yard. Bring something warm for the evening.', { gap: 30 })

// coloured text with a rule under it — the rule must survive the erase
page.drawText('Dinner is at ', { x: 56, y, size: 11, font: body, color: INK })
page.drawText('the old mill house', { x: 124, y, size: 11, font: body, color: GREEN })
page.drawLine({ start: { x: 124, y: y - 2 }, end: { x: 218, y: y - 2 }, thickness: 0.7, color: GREEN })
page.drawText(', booked for nine.', { x: 219, y, size: 11, font: body, color: INK })
const RUN_LINK = [124, y, body.widthOfTextAtSize('the old mill house', 11), 11]
y -= 40

// a run inside a filled colour band — the patch must match the band
page.drawRectangle({ x: 48, y: y - 8, width: W - 96, height: 30, color: hex('#f3e7d4') })
page.drawText('Dress code: something warm.', { x: 56, y, size: 11, font: body, color: hex('#6b4b16') })
const RUN_DRESS = [56, y, body.widthOfTextAtSize('Dress code: something warm.', 11), 11]
y -= 44

line('If you cannot make it, say so before the end of the week so the numbers', { gap: 18 })
line('are right for the kitchen.', { gap: 30 })

// ---- a CURVE: the shape a vectoriser has to handle
//
// Every other mark on this page is a rectangle, a straight rule or type — all
// of which the lift tool can already name. A curve cannot be called a rect or a
// line, so before vectorisation it could only be handed back as a picture of
// itself. pdf-lib draws an ellipse as Bezier segments, which is exactly the
// `c` operator the walker now records.
page.drawEllipse({ x: 470, y, xScale: 46, yScale: 26, color: hex('#b8462f'), opacity: 1 })
const CURVE_VIEW = [470 - 46, H - (y + 26), 92, 52].map((n) => +n.toFixed(1))
y -= 34

// ---- one word drawn as TWO adjacent pieces
//
// pdf.js emits a line as however many items the file's show operators imply, and
// a word split across two of them is extremely common in real PDFs (kerning
// pairs, a colour change, a subset boundary). The editor grows the clicked
// piece into the whole run — so a click lifts the word — while the removal patch
// was built from the single walked element, i.e. one piece. Nothing compared
// them, and the other half stayed printed on the page under the copy.
//
// Everything else in this file is written as one drawText per line, which is
// exactly the case where the two readings agree, so the corpus could not see it.
page.drawText('Adapt', { x: 56, y, size: 11, font: bold, color: INK })
page.drawText('ability', { x: 56 + bold.widthOfTextAtSize('Adapt', 11), y, size: 11, font: bold, color: INK })
const RUN_SPLIT = [56, y, bold.widthOfTextAtSize('Adaptability', 11), 11]
y -= 30

// ---- light type on a panel, hemmed in by dark lines above and below
//
// The shape that made retype reprint words in the colour of the thing behind
// them. sampleInkColor decides ink-vs-paper by comparing the band's extremes
// against the median of a frame around it — and when that frame reaches into
// darker neighbours, the median comes out dark, the LIGHTER tone wins, and the
// "ink" it returns is the panel. The words are erased and redrawn invisible.
page.drawText('Darker line above the panel', { x: 56, y, size: 10, font: bold, color: hex('#1a1a1f') })
y -= 16
page.drawRectangle({ x: 48, y: y - 7, width: W - 96, height: 26, color: hex('#3aa79a') })
page.drawText('Light type on a coloured panel', { x: 56, y, size: 11, font: body, color: hex('#fff1d6') })
const RUN_PANEL = [56, y, body.widthOfTextAtSize('Light type on a coloured panel', 11), 11]
y -= 26
page.drawText('Darker line below the panel', { x: 56, y, size: 10, font: bold, color: hex('#1a1a1f') })
y -= 34

// ---- the embedded-font block (see above): the path real PDFs take
y -= 10
page.drawText('Set in the document\u2019s own embedded face', { x: 56, y, size: 11, font: embedded, color: INK })
const RUN_EMBEDDED = [56, y, embedded.widthOfTextAtSize('Set in the document\u2019s own embedded face', 11), 11]
y -= 46

// Display type in the embedded face. Big type is where a width error stops
// being invisible: the same per-character drift that is a whisker at 11pt is a
// whole letterform at 34, which is exactly how the CV benchmark failed.
page.drawText('EMBEDDED DISPLAY', { x: 56, y, size: 34, font: embeddedBold, color: BLUE })
const RUN_DISPLAY = [56, y, embeddedBold.widthOfTextAtSize('EMBEDDED DISPLAY', 34), 34]
y -= 40

line('\u2014 the office', { color: hex('#7a7a80') })

writeFileSync(join(HERE, 'letter.pdf'), await doc.save())

// pdf-lib places text by BASELINE and the suite wants a top-left box in PDF
// points, so hand the rects over the way cases.json needs them.
const box = ([x, base, w, size]) => [x, H - (base + size * 0.78), w, size].map((n) => +n.toFixed(1))
console.log('letter.pdf written. cases.json rects (view space, x/y from top-left):')
console.log('  (the ellipse is a shape, not a baseline run, so its view rect is a plain flip)')
for (const [id, r] of [['bold-blue', RUN_CONFIRMED], ['short-heading', RUN_SATURDAY],
  ['ruled-link', RUN_LINK], ['on-band', RUN_DRESS],
  ['embedded-run', RUN_EMBEDDED], ['embedded-display', RUN_DISPLAY], ['panel-light', RUN_PANEL],
  ['split-word', RUN_SPLIT]])
  console.log(' ', id.padEnd(17), JSON.stringify(box(r)))
console.log(' ', 'curve'.padEnd(17), JSON.stringify(CURVE_VIEW))
