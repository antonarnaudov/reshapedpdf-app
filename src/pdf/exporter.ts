import {
  BlendMode, LineCapStyle, PDFArray, PDFBool, PDFDict, PDFDocument, PDFFont, PDFHexString, PDFName, PDFNumber,
  PDFObject, PDFPage, PDFRef, PDFStream, StandardFonts, TextRenderingMode, concatTransformationMatrix, degrees,
  popGraphicsState, pushGraphicsState, rgb, setTextRenderingMode,
} from 'pdf-lib'
import type { RGB } from 'pdf-lib'
import { getSrc, pageGeom, totalRotation } from './registry'
import { renderPageToDataUrl, getPageTextRuns } from './render'
import { PROTECTED_MESSAGE } from './loader'
import { redactPageContent } from './redactstream'
import { removeSpans, formSpanGuard } from './contentwalk'
import { frameMatrix, userRectToView, viewRectToUser, viewDims, arrowHead, inkPath } from '../core/geometry'
import type { PageGeom } from '../core/geometry'
import { rasterizeText, wrapLines, LINE_HEIGHT, isWinAnsi, BASELINE_EM} from '../core/measure'
import fontkit from '@pdf-lib/fontkit'
import { embeddedFontProgram, faceCoversChar } from './embeddedfonts'
import { FONTS, NOTE_SIZE } from '../core/types'
import type {
  AnyObj, DocState, ExportOptions, FontId, FormField, FormValues, PageRef, Rect, Rotation, TextObj, WhiteoutObj,
} from '../core/types'

/* ---------------- small utils ---------------- */

const hexToRgb = (hex: string): RGB => {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16)
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
}

const hexToRgbTuple = (hex: string): [number, number, number] => {
  const c = hexToRgb(hex)
  return [c.red, c.green, c.blue]
}

const dataUrlToBytes = (dataUrl: string): Uint8Array => {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

interface FontKit {
  get: (font: FontId, bold: boolean, matchFace?: string, matchWeight?: number) => Promise<PDFFont>
  getStd: (name: string) => Promise<PDFFont> | null
  /** the document's OWN embedded face, re-embedded verbatim */
  getEmbedded: (family: string) => Promise<PDFFont> | null
}

// pdf.js base-14 name → pdf-lib StandardFont (pixel-identical, no embedding needed)
const STD_FONTS: Record<string, StandardFonts> = {
  'Helvetica': StandardFonts.Helvetica,
  'Helvetica-Bold': StandardFonts.HelveticaBold,
  'Helvetica-Oblique': StandardFonts.HelveticaOblique,
  'Helvetica-BoldOblique': StandardFonts.HelveticaBoldOblique,
  'Times-Roman': StandardFonts.TimesRoman,
  'Times-Bold': StandardFonts.TimesRomanBold,
  'Times-Italic': StandardFonts.TimesRomanItalic,
  'Times-BoldItalic': StandardFonts.TimesRomanBoldItalic,
  'Courier': StandardFonts.Courier,
  'Courier-Bold': StandardFonts.CourierBold,
  'Courier-Oblique': StandardFonts.CourierOblique,
  'Courier-BoldOblique': StandardFonts.CourierBoldOblique,
}

const fontBytesCache = new Map<string, Promise<Uint8Array>>()
const fetchFontBytes = (font: FontId, bold: boolean, matchFace?: string, matchWeight?: number): Promise<Uint8Array> => {
  // A face identified by matching is fetched by its own name and weight. It is
  // not in the palette — it exists so that type which only survived as pixels
  // can be re-set in the face it was actually printed in, which is the only way
  // an edit to those words can use characters the original line did not contain.
  const key = matchFace ? `${matchFace}-${matchWeight ?? (bold ? 700 : 400)}` : `${FONTS[font].file}-${bold ? 700 : 400}`
  let p = fontBytesCache.get(key)
  if (!p) {
    p = fetch(new URL(`fonts/${key}.ttf`, document.baseURI)).then(async (r) => {
      if (!r.ok) throw new Error(`font ${key}: HTTP ${r.status}`)
      return new Uint8Array(await r.arrayBuffer())
    })
    fontBytesCache.set(key, p)
    p.catch(() => fontBytesCache.delete(key))
  }
  return p
}

// last-resort metric cousins when a palette TTF can't be fetched/embedded
const STANDARD_FALLBACK: Record<FontId, [StandardFonts, StandardFonts]> = {
  sans: [StandardFonts.Helvetica, StandardFonts.HelveticaBold],
  serif: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold],
  mono: [StandardFonts.Courier, StandardFonts.CourierBold],
  geo: [StandardFonts.Helvetica, StandardFonts.HelveticaBold],
  humanist: [StandardFonts.Helvetica, StandardFonts.HelveticaBold],
  condensed: [StandardFonts.Helvetica, StandardFonts.HelveticaBold],
  rounded: [StandardFonts.Helvetica, StandardFonts.HelveticaBold],
  slab: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold],
  grotesk: [StandardFonts.Helvetica, StandardFonts.HelveticaBold],
}

const makeFontKit = (doc: PDFDocument): FontKit => {
  const cache = new Map<string, Promise<PDFFont>>()
  doc.registerFontkit(fontkit)
  return {
    get: (font, bold, matchFace, matchWeight) => {
      const key = `${matchFace ?? font}-${matchWeight ?? (bold ? 1 : 0)}`
      let f = cache.get(key)
      if (!f) {
        f = fetchFontBytes(font, bold, matchFace, matchWeight)
          .then((bytes) => doc.embedFont(bytes, { subset: true }))
          .catch(() => doc.embedFont(STANDARD_FALLBACK[font][bold ? 1 : 0]))
        cache.set(key, f)
      }
      return f
    },
    // The face the page was printed with, put back into the file it came from.
    // Not a lookalike chosen by metrics — the same font program, so the edited
    // words are set in the document's own type in every viewer, at every zoom.
    getEmbedded: (family) => {
      const bytes = embeddedFontProgram(family)
      if (!bytes) return null
      const key = `emb:${family}`
      let f = cache.get(key)
      if (!f) {
        // no subsetting: the program is already a subset of the original, and
        // re-subsetting a subset is where fontkit is most likely to trip
        f = doc.embedFont(bytes, { subset: false })
        cache.set(key, f)
      }
      return f
    },
    getStd: (name) => {
      const std = STD_FONTS[name]
      if (!std) return null
      const key = `std:${name}`
      let f = cache.get(key)
      if (!f) { f = doc.embedFont(std); cache.set(key, f) }
      return f
    },
  }
}

/* ---------------- object drawing (inside the view-frame cm) ----------------
 * All coordinates below are view-space (top-left origin) converted to the
 * flipped frame F: fx = x, fyUp = viewH - y. The frame matrix pushed before
 * drawing maps F to user space for any page rotation.
 */

/**
 * A text/image can carry a content rotation (obj.rot) set when its page was
 * rotated: the box stays axis-aligned, the content is turned inside it. Push a
 * graphics-state matrix that rotates the frame around the box centre, and return
 * the NATURAL (un-swapped) box to draw the content into upright — the matrix then
 * lands it turned inside the real box. `pushed` says whether to pop afterwards.
 * A view-space clockwise turn is a clockwise turn in this flipped frame too, i.e.
 * a negative angle in the CCW matrix convention.
 */
function beginContentRotation(
  page: PDFPage, viewH: number, obj: { x: number; y: number; w: number; h: number; rot?: Rotation },
): { pushed: boolean; nx: number; ny: number; nw: number; nh: number } {
  const rot = (obj.rot ?? 0) as number
  const nw = rot % 180 === 0 ? obj.w : obj.h
  const nh = rot % 180 === 0 ? obj.h : obj.w
  const cx = obj.x + obj.w / 2, cy = obj.y + obj.h / 2
  const nx = cx - nw / 2, ny = cy - nh / 2
  if (!rot) return { pushed: false, nx: obj.x, ny: obj.y, nw: obj.w, nh: obj.h }
  const a = (-rot * Math.PI) / 180
  const cyF = viewH - cy
  const cos = Math.cos(a), sin = Math.sin(a)
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(cos, sin, -sin, cos, cx - cx * cos + cyF * sin, cyF - cx * sin - cyF * cos),
  )
  return { pushed: true, nx, ny, nw, nh }
}

async function drawObjectsOnPage(
  out: PDFDocument,
  page: PDFPage,
  geom: PageGeom,
  objs: AnyObj[],
  fonts: FontKit,
  opts: { skipRedact?: boolean },
): Promise<void> {
  if (objs.length === 0) return
  const { h: viewH } = viewDims(geom)
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...frameMatrix(geom)))

  try {
    // The screen stacks objects in two CSS layers, not in objOrder: the SVG layer
    // (ink, shapes, markup, erase, redact — z-index 3) always paints UNDER the HTML
    // layer (images, text, notes — z-index 4). Painting the export in strict
    // objOrder therefore delivered a different picture than the one on screen: a pen
    // stroke drawn over a photo was invisible while editing but sat on top in the
    // file, "Send to back" on an image did nothing visible yet still changed the
    // export, and an erase over an image looked like a no-op but whited it out.
    // Paint the same two buckets, keeping objOrder within each, so the delivered
    // file matches what the user was looking at.
    const inHtmlLayer = (k: AnyObj['kind']): boolean => k === 'image' || k === 'text' || k === 'note'
    const ordered = [...objs.filter((o) => !inHtmlLayer(o.kind)), ...objs.filter((o) => inHtmlLayer(o.kind))]
    for (const obj of ordered) {
      switch (obj.kind) {
        case 'markup': {
          const color = hexToRgb(obj.color)
          for (const r of obj.rects) {
            if (obj.mode === 'highlight') {
              page.drawRectangle({
                x: r.x, y: viewH - r.y - r.h, width: r.w, height: r.h,
                color, opacity: 0.42 * obj.opacity, blendMode: BlendMode.Multiply,
              })
            } else if (obj.mode === 'underline') {
              page.drawRectangle({
                x: r.x, y: viewH - (r.y + r.h) - 0.6, width: r.w, height: 1.7,
                color, opacity: obj.opacity,
              })
            } else {
              // Centre the 1.7pt bar on the same line the screen centres it on
              // (screen: top at r.y+r.h*0.58 − 0.85). drawRectangle's y is the
              // bar's BOTTOM, so drop it half its height, or the strike exports
              // ~0.85pt high of where it sat on screen.
              page.drawRectangle({
                x: r.x, y: viewH - (r.y + r.h * 0.58) - 0.85, width: r.w, height: 1.7,
                color, opacity: obj.opacity,
              })
            }
          }
          break
        }
        case 'ink': {
          page.drawSvgPath(inkPath(obj.points), {
            x: 0, y: viewH,
            borderColor: hexToRgb(obj.color),
            borderWidth: obj.width,
            borderOpacity: obj.opacity,
            borderLineCap: LineCapStyle.Round,
          })
          break
        }
        case 'vector': {
          // Out as INSTRUCTIONS, not pixels. drawSvgPath places the path with y
          // running DOWN from the given origin, which is the same convention the
          // path was authored in (local space, 0,0 at the object's top-left), so
          // the only work here is the top-left corner and the scale.
          const vs = obj.stroke ? hexToRgb(obj.stroke) : undefined
          const vf = obj.fill ? hexToRgb(obj.fill) : undefined
          const sx = obj.srcW > 0.01 ? obj.w / obj.srcW : 1
          const sy = obj.srcH > 0.01 ? obj.h / obj.srcH : 1
          try {
            page.drawSvgPath(obj.d, {
              x: obj.x, y: viewH - obj.y,
              scale: Math.abs(sx - sy) < 1e-6 ? sx : undefined,
              ...(Math.abs(sx - sy) < 1e-6 ? {} : { scale: sx }),
              color: vf, opacity: vf ? obj.opacity : undefined,
              borderColor: vs, borderWidth: vs ? obj.strokeWidth : undefined,
              borderOpacity: vs ? obj.opacity : undefined,
            })
          } catch { /* a path pdf-lib cannot parse is skipped rather than fatal */ }
          break
        }
        case 'shape': {
          const stroke = obj.stroke ? hexToRgb(obj.stroke) : undefined
          const fill = obj.fill ? hexToRgb(obj.fill) : undefined
          if (obj.mode === 'rect') {
            page.drawRectangle({
              x: obj.x, y: viewH - obj.y - obj.h, width: obj.w, height: obj.h,
              borderColor: stroke, borderWidth: stroke ? obj.strokeWidth : undefined,
              color: fill, opacity: fill ? obj.opacity : undefined, borderOpacity: obj.opacity,
            })
          } else if (obj.mode === 'ellipse') {
            page.drawEllipse({
              x: obj.x + obj.w / 2, y: viewH - obj.y - obj.h / 2,
              xScale: obj.w / 2, yScale: obj.h / 2,
              borderColor: stroke, borderWidth: stroke ? obj.strokeWidth : undefined,
              color: fill, opacity: fill ? obj.opacity : undefined, borderOpacity: obj.opacity,
            })
          } else {
            const x1 = obj.x, y1 = obj.y, x2 = obj.x + obj.w, y2 = obj.y + obj.h
            const lineColor = stroke ?? rgb(0.09, 0.09, 0.11)
            page.drawLine({
              start: { x: x1, y: viewH - y1 }, end: { x: x2, y: viewH - y2 },
              thickness: obj.strokeWidth, color: lineColor, opacity: obj.opacity,
              lineCap: LineCapStyle.Round,
            })
            if (obj.mode === 'arrow') {
              for (const [hx, hy] of arrowHead(x1, y1, x2, y2, obj.strokeWidth)) {
                page.drawLine({
                  start: { x: x2, y: viewH - y2 }, end: { x: hx, y: viewH - hy },
                  thickness: obj.strokeWidth, color: lineColor, opacity: obj.opacity,
                  lineCap: LineCapStyle.Round,
                })
              }
            }
          }
          break
        }
        case 'text': {
          const rg = beginContentRotation(page, viewH, obj)
          if (rg.pushed) {
            const pseudo: TextObj = { ...obj, rot: 0, x: rg.nx, y: rg.ny, w: rg.nw, h: rg.nh, ...(obj.boxW ? { boxW: rg.nw } : {}) }
            await drawTextBlock(out, page, viewH, pseudo, fonts)
            page.pushOperators(popGraphicsState())
          } else {
            await drawTextBlock(out, page, viewH, obj, fonts)
          }
          break
        }
        case 'image': {
          const bytes = dataUrlToBytes(obj.src)
          // Intake re-encodes anything exotic to PNG, but never let a single bad
          // picture abort the whole export: try the other embedder, then give up on
          // just this object. Losing one stamp beats losing the document.
          let img
          try {
            img = obj.src.startsWith('data:image/png') ? await out.embedPng(bytes) : await out.embedJpg(bytes)
          } catch {
            try {
              img = obj.src.startsWith('data:image/png') ? await out.embedJpg(bytes) : await out.embedPng(bytes)
            } catch {
              console.warn('skipping an image this PDF cannot carry', obj.id)
              break
            }
          }
          const rg = beginContentRotation(page, viewH, obj)
          page.drawImage(img, {
            x: rg.nx, y: viewH - rg.ny - rg.nh, width: rg.nw, height: rg.nh, opacity: obj.opacity,
          })
          if (rg.pushed) page.pushOperators(popGraphicsState())
          break
        }
        case 'whiteout': {
          if (obj.src) {
            const img = await out.embedPng(dataUrlToBytes(obj.src))
            const rg = beginContentRotation(page, viewH, obj)
            page.drawImage(img, { x: rg.nx, y: viewH - rg.ny - rg.nh, width: rg.nw, height: rg.nh, opacity: obj.opacity })
            if (rg.pushed) page.pushOperators(popGraphicsState())
          } else {
            page.drawRectangle({
              x: obj.x, y: viewH - obj.y - obj.h, width: obj.w, height: obj.h,
              color: hexToRgb(obj.color), opacity: obj.opacity,
            })
          }
          break
        }
        case 'redact': {
          if (!opts.skipRedact) {
            page.drawRectangle({
              x: obj.x, y: viewH - obj.y - obj.h, width: obj.w, height: obj.h,
              color: rgb(0.04, 0.04, 0.05),
            })
          }
          break
        }
        case 'note':
          break // handled as a real /Text annotation afterwards
      }
    }
  } finally {
    page.pushOperators(popGraphicsState())
  }
}

async function drawTextBlock(
  out: PDFDocument,
  page: PDFPage,
  viewH: number,
  obj: TextObj,
  fonts: FontKit,
): Promise<void> {
  if (!obj.text.trim()) return
  // pixel-identical cloned rendering: draw the composed glyph bitmap as-is
  if (obj.glyphSrc) {
    const img = await out.embedPng(dataUrlToBytes(obj.glyphSrc))
    const w = obj.glyphW ?? obj.w
    const h = obj.glyphH ?? obj.h
    page.drawImage(img, { x: obj.x, y: viewH - obj.y - h, width: w, height: h, opacity: obj.opacity })
    return
  }
  const track = obj.tracking ?? 0
  // A slanted run whose face isn't a base-14 italic has no italic vector font to
  // reference — the palette twins ship regular/bold only. Drawing it as vectors
  // would export upright while the screen shows the browser's synthesised
  // oblique. Take the raster path instead: it paints with the SAME css spec the
  // screen uses, so the two agree.
  // Decide raster-vs-vector BEFORE drawing anything. The vector path emits line
  // by line, so a glyph the face can't encode used to throw midway — after some
  // lines were already on the page — and the catch then rasterized the whole
  // block on top of them, double-printing the earlier lines.
  const needsSyntheticItalic = !!obj.italic && !/italic|oblique/i.test(obj.stdFont ?? '')
  if (needsSyntheticItalic || !isWinAnsi(obj.text)) {
    const raster = rasterizeText(obj.text, obj.font, obj.size, obj.bold, obj.color, 3, obj.boxW, track, !!obj.italic, undefined, obj.align ?? 'left')
    const img = await out.embedPng(dataUrlToBytes(raster.dataUrl))
    // rasterizeText insets the ink 1 unit from the bitmap's left (and pads the
    // width by 2) to give a slanted glyph room; drawing the bitmap at obj.x then
    // lands the ink 1pt right of where the screen shows it. Shift back by that pad.
    page.drawImage(img, {
      x: obj.x - 1, y: viewH - obj.y - raster.h, width: raster.w, height: raster.h, opacity: obj.opacity,
    })
    return
  }
  try {
    // when the retype was lifted off a base-14 font, reference that exact
    // standard font — pixel-identical in every viewer. Falls to the metric
    // twin if a glyph isn't WinAnsi-encodable (Cyrillic etc.) via the catch.
    // Draw from obj.x, the same place the screen draws from. A point of padding
    // here and none there means the exported file does not match the preview it
    // was approved in — and on a retype, where the whole point is landing back
    // exactly where the old words were, a point is the entire budget.
    const embedded = obj.pdfFont ? fonts.getEmbedded(obj.pdfFont) : null
    const stdFont = obj.stdFont ? fonts.getStd(obj.stdFont) : null
    const font = embedded
      ? await embedded.catch(() => (stdFont ? stdFont : fonts.get(obj.font, obj.bold, obj.matchFace, obj.matchWeight)))
      : stdFont ? await stdFont : await fonts.get(obj.font, obj.bold, obj.matchFace, obj.matchWeight)
    const color = hexToRgb(obj.color)
    // fixed-width boxes wrap with the same canvas metrics the editor showed —
    // including slant, embedded face and tracking, so the export breaks lines
    // exactly where the screen did
    const lines = obj.boxW ? wrapLines(obj.text, obj.font, obj.size, obj.bold, obj.boxW, !!obj.italic, obj.pdfFont, track) : obj.text.split('\n')
    // A face lifted off the page is a SUBSET — it carries the glyphs the document
    // used and no others, and very often that excludes the space, because PDFs
    // usually put the gaps between words in as position offsets rather than
    // drawing a space at all. Handing the whole line to that font prints a
    // .notdef box in every gap: "Teambuilding□weekend□in□Sozopol".
    //
    // So set each character in a font that can actually set it, exactly as the
    // browser does on screen — the document's own face where it reaches, the
    // metric twin for the rest. The words stay in the real type, the gaps are
    // gaps, and the text is still text: selectable, searchable, copyable.
    const twin = obj.pdfFont ? await fonts.get(obj.font, obj.bold, obj.matchFace, obj.matchWeight) : null
    const family = obj.pdfFont
    const runs = (line: string): { text: string; font: PDFFont; spaced: boolean }[] => {
      if (!family || !twin) return [{ text: line, font, spaced: false }]
      const out: { text: string; font: PDFFont; spaced: boolean }[] = []
      let i = 0
      while (i < line.length) {
        const covered = faceCoversChar(family, line[i])
        let j = i + 1
        while (j < line.length && faceCoversChar(family, line[j]) === covered) j++
        const text = line.slice(i, j)
        out.push({ text, font: covered ? font : twin, spaced: !covered && /^ +$/.test(text) })
        i = j
      }
      return out
    }
    // How wide a line draws, in the same metrics the pen uses below — so a
    // right/centre-aligned line can be offset inside its fixed box to match the
    // screen. Only fixed-width (boxW) blocks align per line; an auto-grow block
    // hugs its text, so its alignment lives entirely in obj.x (set when edited).
    const lineWidth = (line: string): number => {
      if (track) {
        let w = 0
        for (const ch of line) {
          const f = family && twin && !faceCoversChar(family, ch) ? twin : font
          w += f.widthOfTextAtSize(ch, obj.size) + track
        }
        return Math.max(0, w - (line.length ? track : 0))
      }
      let w = 0
      for (const run of runs(line)) {
        w += run.spaced && obj.pdfSpace
          ? run.text.length * obj.pdfSpace * obj.size
          : run.font.widthOfTextAtSize(run.text, obj.size)
      }
      return w
    }
    const alignDx = (line: string): number => {
      if (!obj.boxW || !obj.align || obj.align === 'left') return 0
      const extra = obj.boxW - lineWidth(line)
      return extra <= 0 ? 0 : obj.align === 'right' ? extra : extra / 2
    }
    for (const [i, line] of lines.entries()) {
      if (!line) continue
      const y = viewH - (obj.y + obj.size * BASELINE_EM + obj.size * LINE_HEIGHT * i)
      if (track) {
        let x = obj.x + alignDx(line)
        for (const ch of line) {
          const f = family && twin && !faceCoversChar(family, ch) ? twin : font
          page.drawText(ch, { x, y, size: obj.size, font: f, color, opacity: obj.opacity })
          x += f.widthOfTextAtSize(ch, obj.size) + track
        }
      } else {
        let x = obj.x + alignDx(line)
        for (const run of runs(line)) {
          page.drawText(run.text, { x, y, size: obj.size, font: run.font, color, opacity: obj.opacity })
          // A space set in the stand-in font is invisible, so what it looks like
          // doesn't matter — but how far it moves the pen does, and that has to
          // be the PRINT'S space, not the stand-in's, or the words drift apart
          // from where they sat on the page.
          x += run.spaced && obj.pdfSpace
            ? run.text.length * obj.pdfSpace * obj.size
            : run.font.widthOfTextAtSize(run.text, obj.size)
        }
      }
    }
  } catch {
    // glyphs outside the face (CJK, emoji…): rasterize at 3x — crisp and universal
    const raster = rasterizeText(obj.text, obj.font, obj.size, obj.bold, obj.color, 3, obj.boxW, track, !!obj.italic, undefined, obj.align ?? 'left')
    const img = await out.embedPng(dataUrlToBytes(raster.dataUrl))
    page.drawImage(img, {
      x: obj.x - 1, y: viewH - obj.y - raster.h, width: raster.w, height: raster.h, opacity: obj.opacity,
    })
  }
}

/* ---------------- sticky notes as real PDF annotations ---------------- */

function addNoteAnnotation(
  out: PDFDocument,
  page: PDFPage,
  geom: PageGeom,
  note: { x: number; y: number; text: string; color: string },
): void {
  const rect = viewRectToUser(geom, { x: note.x, y: note.y, w: NOTE_SIZE, h: NOTE_SIZE })
  const annot = out.context.obj({
    Type: 'Annot',
    Subtype: 'Text',
    Rect: [rect[0], rect[1], rect[2], rect[3]],
    Contents: PDFHexString.fromText(note.text),
    Name: 'Comment',
    Open: false,
    F: 4,
    C: hexToRgbTuple(note.color),
    T: PDFHexString.fromText('ReshapedPDF'),
  })
  const ref = out.context.register(annot)
  const existing = page.node.lookup(PDFName.of('Annots'))
  if (existing instanceof PDFArray) {
    existing.push(ref)
  } else {
    page.node.set(PDFName.of('Annots'), out.context.obj([ref]))
  }
}

/* ---------------- form fields ---------------- */

function fillFormValues(lib: PDFDocument, fields: FormField[], values: FormValues): void {
  let form
  try {
    form = lib.getForm()
  } catch {
    return
  }
  const seen = new Set<string>()
  for (const f of fields) {
    if (seen.has(f.name)) continue
    seen.add(f.name)
    const v = values[f.name]
    if (v === undefined) continue
    // `name` is the app's key; the FILE still knows the field by its own name,
    // which differs when a merge had to rename it around a collision.
    const pdfName = f.exportName ?? f.name
    try {
      if (f.type === 'text') {
        form.getTextField(pdfName).setText(String(v))
      } else if (f.type === 'checkbox') {
        const cb = form.getCheckBox(pdfName)
        if (v) cb.check()
        else cb.uncheck()
      } else if (f.type === 'radio') {
        if (typeof v === 'string' && v) {
          const rg = form.getRadioGroup(pdfName)
          try {
            rg.select(v)
          } catch {
            // widget appearance states are often index names ("0", "1") while
            // pdf-lib expects the /Opt export value — map by index
            const opts = rg.getOptions()
            const idx = Number(v)
            if (Number.isInteger(idx) && opts[idx] !== undefined) rg.select(opts[idx])
            else throw new Error(`no radio option "${v}"`)
          }
        }
      } else if (f.type === 'choice') {
        const val = String(v)
        try {
          form.getDropdown(pdfName).select(val)
        } catch {
          form.getOptionList(pdfName).select(val)
        }
      }
    } catch (err) {
      console.warn(`form field "${f.name}" could not be set`, err)
    }
  }
}

function finalizeFormAppearances(lib: PDFDocument, helv: PDFFont, flatten: boolean): void {
  try {
    const form = lib.getForm()
    try {
      form.updateFieldAppearances(helv)
    } catch {
      // unicode values the standard font can't encode: let the viewer regenerate
      form.acroForm.dict.set(PDFName.of('NeedAppearances'), PDFBool.True)
    }
    if (flatten) {
      try {
        form.flatten()
      } catch (err) {
        console.warn('form flatten failed; leaving fields interactive', err)
      }
    }
  } catch {
    /* no form */
  }
}

/**
 * Draw form values as static content (compose path, where AcroForm structure is dropped).
 * `frameGeom` describes the page being drawn on; `rectGeom` maps the widgets' user-space
 * rects into view space. They differ only for rasterized (true-redact) replacement pages.
 */
async function drawFormValuesStatic(
  out: PDFDocument,
  page: PDFPage,
  frameGeom: PageGeom,
  rectGeom: PageGeom,
  fields: FormField[],
  values: FormValues,
  fonts: FontKit,
  redactUser?: number[][],
): Promise<void> {
  // A field value whose widget sits under a redaction mark must NOT be redrawn:
  // the static glyphs land in the content stream and the black box only covers
  // them visually — pdftotext recovers the value from underneath. Skip it.
  const drawable = fields.filter(
    (f) => values[f.name] !== undefined && !(redactUser?.length && redactUser.some((m) => userRectsOverlap(f.urect, m))),
  )
  if (drawable.length === 0) return
  const { h: viewH } = viewDims(frameGeom)
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...frameMatrix(frameGeom)))
  const ink = rgb(0.08, 0.08, 0.1)
  try {
    for (const f of drawable) {
      const v = values[f.name]
      const r = userRectToView(rectGeom, f.urect)
      if (f.type === 'checkbox') {
        if (v === true) {
          const s = Math.min(r.w, r.h)
          page.drawSvgPath(`M ${s * 0.22} ${s * 0.52} L ${s * 0.44} ${s * 0.74} L ${s * 0.8} ${s * 0.26}`, {
            x: r.x, y: viewH - r.y,
            borderColor: ink, borderWidth: Math.max(1.4, s * 0.13), borderLineCap: LineCapStyle.Round,
          })
        }
      } else if (f.type === 'radio') {
        if (typeof v === 'string' && v === f.radioValue) {
          page.drawEllipse({
            x: r.x + r.w / 2, y: viewH - r.y - r.h / 2,
            xScale: r.w * 0.26, yScale: r.h * 0.26, color: ink,
          })
        }
      } else {
        let text = String(v ?? '')
        if (f.type === 'choice' && f.options) {
          text = f.options.find((o) => o.value === v)?.label ?? text
        }
        // A single-line field shows one line on screen and on the fast/flatten path;
        // a stray newline in the value must not make the compose path draw several
        // overflowing lines. Only a multiline field keeps its line breaks.
        if (!f.multiline) text = text.replace(/[\r\n]+/g, ' ')
        if (!text) continue
        const size = Math.max(7, Math.min(12, f.multiline ? 11 : r.h * 0.62))
        const pseudo: TextObj = {
          id: '', page: '', kind: 'text', opacity: 1,
          x: r.x + 2, y: f.multiline ? r.y + 2 : r.y + (r.h - size * LINE_HEIGHT) / 2,
          w: r.w, h: r.h, text, color: '#141416', size, font: 'sans', bold: false,
          // A multiline field wraps within its box on screen and on the fast/flatten
          // export; the compose path must too, or a typed paragraph (no explicit
          // newlines) draws as one line that runs off the page and is clipped.
          ...(f.multiline ? { boxW: Math.max(8, r.w - 4) } : {}),
        }
        await drawTextBlock(out, page, viewH, pseudo, fonts)
      }
    }
  } finally {
    page.pushOperators(popGraphicsState())
  }
}

// User-space AABB overlap. Rects are [x1,y1,x2,y2] (y-up), as pdf-lib /Rect and
// viewRectToUser both produce.
function userRectsOverlap(a: readonly number[], b: readonly number[]): boolean {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
}

// Drop all /Widget annotations (their values are redrawn statically) and — when
// redaction marks are supplied — any OTHER annotation whose /Rect overlaps a mark.
// An annotation paints ABOVE the page content in every viewer, so the redaction
// box drawn into the content stream cannot cover a FreeText / Stamp / Link sitting
// over the marked area — its text would show and extract on top of the black box.
function stripWidgetAnnotations(out: PDFDocument, page: PDFPage, redactUser?: number[][]): void {
  const annots = page.node.lookup(PDFName.of('Annots'))
  if (!(annots instanceof PDFArray)) return
  const keep: PDFObject[] = []
  for (let i = 0; i < annots.size(); i++) {
    try {
      const dict = annots.lookup(i)
      if (dict instanceof PDFDict) {
        if (dict.get(PDFName.of('Subtype')) === PDFName.of('Widget')) continue
        if (redactUser?.length) {
          const rect = dict.lookup(PDFName.of('Rect'))
          if (rect instanceof PDFArray && rect.size() >= 4) {
            const c = [0, 1, 2, 3].map((k) => (rect.lookup(k) as PDFNumber).asNumber())
            const box = [Math.min(c[0], c[2]), Math.min(c[1], c[3]), Math.max(c[0], c[2]), Math.max(c[1], c[3])]
            if (redactUser.some((m) => userRectsOverlap(box, m))) continue // covered by a mark: drop
          }
        }
      }
    } catch {
      /* keep malformed annots */
    }
    keep.push(annots.get(i))
  }
  page.node.set(PDFName.of('Annots'), out.context.obj(keep))
}

/* ---------------- export paths ---------------- */

const objsForPage = (doc: DocState, pageId: string): AnyObj[] =>
  doc.objOrder.map((id) => doc.objects[id]).filter((o): o is AnyObj => Boolean(o) && o.page === pageId)

const pageHasRedactions = (doc: DocState, pageId: string): boolean =>
  objsForPage(doc, pageId).some((o) => o.kind === 'redact')

/* ----- making the file agree with the picture -------------------------------

   Every edit that removes printed content works by painting over it: retype
   fills the run's own background and sets the new words on top, the rubber
   fills a box, peel and lift patch the hole they cut. On screen and on paper
   that is the whole job — the print is gone.

   In the FILE it is not. The glyphs are still in the page's drawing program
   under the patch, so pdftotext, copy-paste, search and every indexer read back
   the words the user believes they replaced. An "edited" contract still says
   the old number. That is the redaction leak wearing a different hat, and it
   sits in the feature this editor is sold on.

   So before the patches are drawn, the page's own program is edited to match:

   1. A lift and a retype both know exactly which operators their patch stands in
      for (WhiteoutObj.removedSpans, recorded when the patch was cut) — that is
      exact, covers vector art and images as well as text, and is the only
      mechanism that reaches inside a form XObject.
   2. Everything else is geometric: cover mode (see RedactOpts) deletes the ink
      that lies ENTIRELY under an opaque patch. Fully covered means invisible,
      so the rendered page cannot change — which is what makes it safe to run on
      every export, including over boxes the user drew freehand.                */

/** the object numbers of a page's content streams */
const contentRefsOf = (page: PDFPage): number[] => {
  const contents = page.node.Contents()
  if (!contents) return []
  const refs = contents instanceof PDFArray
    ? (contents.asArray() as PDFRef[])
    : [page.node.get(PDFName.of('Contents'))]
  return refs.filter((r): r is PDFRef => r instanceof PDFRef).map((r) => r.objectNumber)
}

/** the opaque patches an edit painted over the page, in view space */
const coverRects = (objs: AnyObj[]): Rect[] =>
  objs
    // A translucent patch still shows what is beneath it, so nothing beneath it
    // may be deleted — the removal is only invisible while the cover is total.
    // And a SHAPED patch (a brush sweep, a retouch stroke) covers only where its
    // own alpha paints: its rectangle is a bounding box, not a promise, so it
    // never speaks for the print inside it. See WhiteoutObj.shaped.
    .filter((o): o is WhiteoutObj => o.kind === 'whiteout' && o.opacity >= 0.99 && !o.shaped)
    .map((o) => ({ x: o.x, y: o.y, w: o.w, h: o.h }))

/**
 * Take out of the page's own content stream what the edits have painted over.
 * Call BEFORE drawing the objects (the spans are indexed against the page as it
 * was walked) and before any redaction (which re-walks whatever is left).
 *
 * `formSpanOk` decides, per span, whether a form XObject may be edited. On the
 * fast path the source document is edited in place, so a form drawn by two kept
 * pages must be left alone: removing the print one page covers would take it off
 * the other page, where nothing covers it. The compose path copies each page
 * separately, so there every form is the copy's own and the answer is always yes.
 *
 * This used to be one boolean — `doc.pages.length === 1` — which meant that on
 * ANY document of more than one page, EVERY form span was dropped and the erased
 * words stayed in the file. Most forms are drawn by exactly one page (a stamped
 * or imposed document gives each page its own), so the blanket rule was throwing
 * away the common case to be safe about the rare one. It is per-form now.
 */
function applyEditsToContent(
  out: PDFDocument, page: PDFPage, geom: PageGeom, objs: AnyObj[],
  formSpanOk: (formPath: string[]) => boolean = () => true,
): void {
  const recorded = objs
    .filter((o): o is WhiteoutObj => o.kind === 'whiteout' && !!o.removedSpans?.length)
    .flatMap((o) => o.removedSpans!)
  const lifted = recorded.filter((e) => !e.formPath?.length || formSpanOk(e.formPath))
  if (lifted.length !== recorded.length) {
    noteExport('some text sits in a drawing shared with another page, so it was covered rather than removed')
  }
  // Every span was indexed against the PRISTINE stream, so they are removed in
  // ONE call: a second call would be reading indices into a stream the first has
  // already rewritten, and would cut the wrong operators out.
  if (lifted.length) {
    try { removeSpans(out, page, lifted) } catch (e) { console.warn('lifted spans left in the file', e) }
  }
  const covers = coverRects(objs)
  if (covers.length) {
    try {
      const r = redactPageContent(out, page, covers, geom, { mode: 'cover' })
      // Cover mode used to return complete:true whatever happened, so a page
      // where nothing could be removed looked exactly like a page where
      // everything was. If it walked away from something, say so.
      if (r.gaps?.length) noteExport(r.gaps[0])
    } catch (e) {
      noteExport('the covered print could not be read')
      console.warn('covered print left in the file', e)
    }
  }
}

/**
 * Things the user should know about the file they just exported — specifically,
 * places where covered content stayed in it. Collected here rather than returned
 * up the stack because every export path funnels through exportDoc, and threading
 * a second return value through eight call sites to carry a rare warning would
 * cost more than it is worth. Reset per export; read once, straight after.
 */
let pendingNotes: string[] = []
function noteExport(why: string): void {
  if (!pendingNotes.includes(why)) pendingNotes.push(why)
}
/** Take (and clear) the notes from the export that just finished. */
export function takeExportNotes(): string[] {
  const out = pendingNotes
  pendingNotes = []
  return out
}

export function canUseFastPath(doc: DocState, opts: ExportOptions): boolean {
  // Count the sources the LIVE pages actually reference, not doc.srcIds — a merge
  // appends a srcId that undo/delete never prunes (srcIds isn't in the undo
  // snapshot), so a doc that is once again single-source would otherwise be forced
  // onto the compose path and its interactive form silently flattened.
  if (new Set(doc.pages.map((p) => p.srcId)).size !== 1) return false
  if (opts.trueRedact && doc.pages.some((p) => pageHasRedactions(doc, p.id))) return false
  let last = -1
  for (const p of doc.pages) {
    if (p.srcIndex <= last) return false // reordered or duplicated
    last = p.srcIndex
  }
  return true
}

function applyMetadata(lib: PDFDocument, doc: DocState): void {
  const m = doc.meta
  // Write unconditionally. The old truthiness guards meant a field the user had
  // deliberately CLEARED kept the source value, so scrubbing a title was
  // impossible. doc.meta is seeded from the file's own /Info on open, so an empty
  // string here really does mean "the user emptied it".
  lib.setTitle(m.title ?? '')
  lib.setAuthor(m.author ?? '')
  lib.setSubject(m.subject ?? '')
  lib.setKeywords((m.keywords ?? '').split(/[,;]\s*/).filter(Boolean))
  // …and drop the source XMP packet. The fast path loads with
  // updateMetadata:false, so /Metadata survived verbatim: a user who scrubbed
  // Title and Author still shipped dc:title "Secret Internal Draft" and
  // dc:creator to every XMP-aware reader, while the visible Properties looked
  // clean. pdf-lib writes /Info, not XMP, so removing the stale packet is what
  // makes the scrub real.
  try {
    // Unlinking it from the catalog is NOT enough: pdf-lib writes every indirect
    // object it holds, so the packet would still travel in the file with only its
    // reference removed — the same orphan trap as a deleted page. Delete the object.
    const xmp = lib.catalog.get(PDFName.of('Metadata'))
    lib.catalog.delete(PDFName.of('Metadata'))
    if (xmp instanceof PDFRef) lib.context.delete(xmp)
  } catch { /* nothing to drop */ }
  lib.setProducer('ReshapedPDF Studio')
  lib.setModificationDate(new Date())
}

/** Stamp "n / total" centered in the footer, oriented with the displayed page. */
async function stampPageNumber(
  out: PDFDocument,
  page: PDFPage,
  geom: PageGeom,
  n: number,
  total: number,
  fonts: FontKit,
): Promise<void> {
  const font = await fonts.get('sans', false)
  const label = `${n} / ${total}`
  const size = 9
  const { w: viewW, h: viewH } = viewDims(geom)
  const tw = font.widthOfTextAtSize(label, size)
  void viewH
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...frameMatrix(geom)))
  try {
    // frame is y-up: baseline 18 units above the displayed bottom edge, centered
    page.drawText(label, {
      x: (viewW - tw) / 2,
      y: 18,
      size,
      font,
      color: rgb(0.45, 0.45, 0.47),
    })
  } finally {
    page.pushOperators(popGraphicsState())
  }
}

/**
 * pdf-lib's `removePage` only unlinks the leaf from the page tree: the page dict,
 * its content stream and any image or font it alone owned stay in the context and
 * are written out verbatim. A "deleted" page's text and pictures are therefore
 * still recoverable from the exported file (qpdf, or any stream scanner) — not
 * what "delete this page, then send it" is supposed to mean.
 *
 * Purge exactly what the removed pages owned and nothing else: walk everything
 * reachable FROM the dead pages, walk everything reachable from the LIVE document
 * (catalog + trailer), and delete only the difference. Anything still referenced
 * anywhere — a shared font, an image also used by a surviving page, a widget the
 * AcroForm still lists — is in the live set by construction and is left alone.
 */
function purgeRemovedPages(lib: PDFDocument, deadPageRefs: PDFRef[]): void {
  if (!deadPageRefs.length) return
  const ctx = lib.context
  const key = (r: PDFRef): string => `${r.objectNumber} ${r.generationNumber}`
  const reachable = (roots: unknown[]): Map<string, PDFRef> => {
    const seen = new Map<string, PDFRef>()
    const stack: unknown[] = [...roots]
    while (stack.length) {
      const cur = stack.pop()
      if (cur == null) continue
      if (cur instanceof PDFRef) {
        const k = key(cur)
        if (seen.has(k)) continue
        seen.set(k, cur)
        stack.push(ctx.lookup(cur))
      } else if (cur instanceof PDFArray) {
        for (let i = 0; i < cur.size(); i++) stack.push(cur.get(i))
      } else if (cur instanceof PDFStream) {
        stack.push(cur.dict)
      } else if (cur instanceof PDFDict) {
        for (const [, v] of cur.entries()) stack.push(v)
      }
    }
    return seen
  }
  // A form field whose widget sat on a removed page keeps the whole page dict
  // alive through its /P back-pointer (and keeps the field's own VALUE in the
  // file). The field belongs to a page that no longer exists, so drop it from
  // /AcroForm /Fields first — then the page and its widgets become purgeable.
  const deadKeys = new Set(deadPageRefs.map(key))
  const onDeadPage = (o: PDFObject | undefined): boolean => {
    if (!(o instanceof PDFDict)) return false
    const p = o.get(PDFName.of('P'))
    if (p instanceof PDFRef && deadKeys.has(key(p))) return true
    const kids = o.lookupMaybe(PDFName.of('Kids'), PDFArray)
    if (!kids || kids.size() === 0) return false
    for (let i = 0; i < kids.size(); i++) if (!onDeadPage(ctx.lookup(kids.get(i)) as PDFObject)) return false
    return true // every widget of this field lived on a removed page
  }
  const acro = lib.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)
  const fields = acro?.lookupMaybe(PDFName.of('Fields'), PDFArray)
  if (fields) {
    const keep = []
    for (let i = 0; i < fields.size(); i++) {
      const f = fields.get(i)
      if (!onDeadPage(ctx.lookup(f) as PDFObject)) keep.push(f)
    }
    if (keep.length !== fields.size()) acro!.set(PDFName.of('Fields'), ctx.obj(keep))
  }

  // A Link annotation on a page we KEPT can hold an explicit destination
  // ([<pageRef> /XYZ …], what Chrome and Word print-to-PDF emit) into a page we
  // removed. That reference keeps the removed page reachable, so the purge below
  // correctly spares it — and "keep only this page, then send it" ships every
  // section the table of contents pointed at. Cut those links first.
  const pointsAtDead = (o: PDFObject | undefined): boolean =>
    o instanceof PDFArray && o.size() > 0 && o.get(0) instanceof PDFRef && deadKeys.has(key(o.get(0) as PDFRef))
  const annotIsDangling = (a: PDFObject | undefined): boolean => {
    if (!(a instanceof PDFDict)) return false
    if (pointsAtDead(a.get(PDFName.of('Dest')))) return true
    const act = a.lookupMaybe(PDFName.of('A'), PDFDict)
    return !!act && pointsAtDead(act.get(PDFName.of('D')))
  }
  for (const page of lib.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray)
    if (!annots) continue
    const keep = []
    for (let i = 0; i < annots.size(); i++) {
      const r = annots.get(i)
      if (!annotIsDangling(ctx.lookup(r))) keep.push(r)
    }
    if (keep.length !== annots.size()) page.node.set(PDFName.of('Annots'), ctx.obj(keep))
  }

  // NB: a dead page's /Parent still points into the live tree, so `dead` reaches
  // live objects too — the subtraction below is what makes this safe.
  const dead = reachable(deadPageRefs)

  // Belt and braces: strip each removed page's own content AFTER `dead` has been
  // collected (so its streams stay in the purge set) and BEFORE `live` is walked.
  // If some reference we did not anticipate — an outline, a named destination —
  // still holds the page dict, it survives as an EMPTY page instead of carrying
  // the words we were told to remove.
  for (const ref of deadPageRefs) {
    const pd = ctx.lookup(ref)
    if (!(pd instanceof PDFDict)) continue
    pd.delete(PDFName.of('Contents'))
    pd.delete(PDFName.of('Annots'))
    pd.delete(PDFName.of('Resources'))
  }

  const live = reachable([ctx.trailerInfo.Root, ctx.trailerInfo.Info])
  for (const [k, ref] of dead) if (!live.has(k)) ctx.delete(ref)
}

async function exportFast(doc: DocState, opts: ExportOptions): Promise<Uint8Array> {
  // The live single source, from the pages themselves — doc.srcIds can still hold
  // a stale entry from an undone merge (see canUseFastPath).
  const src = getSrc(doc.pages[0].srcId)
  const lib = await PDFDocument.load(src.bytes, { ignoreEncryption: true, updateMetadata: false })
  const fonts = makeFontKit(lib)

  // Snapshot the pages BEFORE any removal and index by srcIndex from here on:
  // pdf-lib's removePage unlinks the leaf from the catalog but never invalidates
  // its page cache, so a later getPage(i) still indexes the ORIGINAL list. Every
  // per-page edit below would land N pages early (N = deleted pages before it) and
  // the work aimed at the first survivor would be drawn onto an orphaned dict and
  // silently dropped at save. The snapshot entries stay valid across removals.
  const allPages = lib.getPages()
  const kept = new Set(doc.pages.map((p) => p.srcIndex))
  const deadPageRefs: PDFRef[] = []
  for (let i = allPages.length - 1; i >= 0; i--) {
    if (!kept.has(i)) { deadPageRefs.push(allPages[i].ref); lib.removePage(i) }
  }

  // forms before drawing so flatten output sits under annotations
  fillFormValues(lib, doc.fields, doc.formValues)
  finalizeFormAppearances(lib, await fonts.get('sans', false), opts.flattenForms)

  // This path edits the SOURCE document in place, so a content stream two kept
  // pages happen to share (a duplicated page in the original) must be left alone:
  // removing the print one page covers would take it off the other page too,
  // where nothing covers it. Count first, then skip those pages' content edits.
  const refUse = new Map<number, number>()
  for (const p of doc.pages) for (const r of contentRefsOf(allPages[p.srcIndex])) refUse.set(r, (refUse.get(r) ?? 0) + 1)

  // The same question for form XObjects, which are the other kind of stream two
  // kept pages can share. Counted once over the whole export rather than per
  // page: a form is safe to edit here when exactly one kept page can reach it.
  const formOk = formSpanGuard(lib, doc.pages.map((p) => allPages[p.srcIndex]))

  for (let i = 0; i < doc.pages.length; i++) {
    const ref = doc.pages[i]
    const page = allPages[ref.srcIndex]
    page.setRotation(degrees(totalRotation(ref)))
    const geom = pageGeom(ref)
    const objs = objsForPage(doc, ref.id)
    // A form XObject can be shared across pages here (see applyEditsToContent);
    // it cannot be if this export is a single page.
    if (contentRefsOf(page).every((r) => (refUse.get(r) ?? 0) < 2)) {
      applyEditsToContent(lib, page, geom, objs, (formPath) => formOk(page, formPath))
    }
    await drawObjectsOnPage(lib, page, geom, objs, fonts, {})
    if (opts.pageNumbers) await stampPageNumber(lib, page, geom, i + 1, doc.pages.length, fonts)
    for (const o of objs) if (o.kind === 'note') addNoteAnnotation(lib, page, geom, o)
  }

  applyMetadata(lib, doc)
  purgeRemovedPages(lib, deadPageRefs)
  return lib.save({ useObjectStreams: opts.optimize })
}

/**
 * Lay the page's own text back over a rasterised redaction page as invisible,
 * still-selectable glyphs, so search and copy keep working on the words the marks
 * did NOT cover (a raster page is otherwise flat pixels with no extractable text).
 *
 * SAFETY-CRITICAL: any run that touches a mark is dropped — its text would be
 * recoverable from under the black box otherwise. The layer only ever ADDS runs
 * that are provably clear of every mark; anything uncertain (touching a mark,
 * non-WinAnsi, sheared/rotated, unmeasurable) is simply left out, never leaked.
 *
 * Only meaningful for un-rotated pages: the rasterised output page is [dims.w,
 * dims.h] with no rotation, i.e. the page's own view space, so a run's view-space
 * baseline (vx, vy from the top) draws straight at (vx, dims.h - vy).
 */
async function drawInvisibleTextLayer(
  page: PDFPage, ref: PageRef, dims: { w: number; h: number },
  marks: { x: number; y: number; w: number; h: number }[], helv: PDFFont | null,
): Promise<void> {
  if (!helv) return
  let runs
  try { runs = await getPageTextRuns(ref) } catch { return }
  const draw: typeof runs = []
  for (const r of runs) {
    if (Math.abs(r.angle) > 0.02) continue            // not axis-aligned: an invisible horizontal drawText would misplace it
    if (!r.str.trim() || !isWinAnsi(r.str)) continue  // nothing selectable, or Helvetica can't encode it
    // the run's view-space box (top-left origin), taken as the baseline ± the font
    // height: that brackets ascenders AND anything below the baseline (descenders,
    // or a vertically-flipped text matrix that renders glyphs downward), so a mark
    // clipping ANY of it drops the whole run. Over-exclusion is safe; missing a
    // covered run is a leak, so the box is deliberately generous.
    const rx = r.vx, ry = r.vy - r.fs, rw = Math.max(r.w, 1), rh = r.fs * 2
    const covered = marks.some((m) =>
      rx < m.x + m.w + 2 && rx + rw > m.x - 2 && ry < m.y + m.h + 2 && ry + rh > m.y - 2)
    if (!covered) draw.push(r)
  }
  if (!draw.length) return
  // Emit the whole layer under text rendering mode 3 (invisible): one `q … 3 Tr`
  // makes every run non-painting with no per-run ExtGState (drawText's opacity
  // option allocates a fresh /ca 0 state on EVERY call — thousands on a dense
  // page). The closing `Q` restores fill mode, so the later VISIBLE drawing (form
  // values, objects) on this page is unaffected. Mode-3 text is still fully
  // selectable/extractable — it is the standard OCR text-layer technique.
  page.pushOperators(pushGraphicsState(), setTextRenderingMode(TextRenderingMode.Invisible))
  for (const r of draw) {
    try {
      page.drawText(r.str, { x: r.vx, y: dims.h - r.vy, size: r.fs, font: helv })
    } catch { /* a glyph Helvetica still rejects — skip this run, never fail the export */ }
  }
  page.pushOperators(popGraphicsState())
}

/**
 * Drop Link annotations whose explicit destination points at a page this export
 * is NOT keeping from this source. `copyPages` deep-copies whatever a copied page
 * references, so such a link drags the excluded page — its whole content — into
 * the output. Runs on the per-export `libFor` document (loaded fresh each time),
 * never on the shared source cache.
 */
function severLinksOutsideSubset(lib: PDFDocument, keptSrcIndices: Set<number>): void {
  const ctx = lib.context
  const pages = lib.getPages()
  const refKey = (r: PDFRef): string => `${r.objectNumber} ${r.generationNumber}`
  const allowed = new Set<string>()
  pages.forEach((p, i) => { if (keptSrcIndices.has(i)) allowed.add(refKey(p.ref)) })
  const outside = (o: PDFObject | undefined): boolean =>
    o instanceof PDFArray && o.size() > 0 && o.get(0) instanceof PDFRef && !allowed.has(refKey(o.get(0) as PDFRef))
  for (const i of keptSrcIndices) {
    const page = pages[i]
    if (!page) continue
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray)
    if (!annots) continue
    const keep = []
    for (let j = 0; j < annots.size(); j++) {
      const r = annots.get(j)
      const a = ctx.lookup(r)
      let dangling = false
      if (a instanceof PDFDict) {
        if (outside(a.get(PDFName.of('Dest')))) dangling = true
        else {
          const act = a.lookupMaybe(PDFName.of('A'), PDFDict)
          if (act && outside(act.get(PDFName.of('D')))) dangling = true
        }
      }
      if (!dangling) keep.push(r)
    }
    if (keep.length !== annots.size()) page.node.set(PDFName.of('Annots'), ctx.obj(keep))
  }
}


/**
 * Carry the document's bookmarks across a compose export.
 *
 * exportCompose starts a brand-new PDFDocument and copies pages into it, and
 * nothing ever brought /Outlines with them — so every edit that forces the
 * compose path silently threw the whole navigation tree away. The Export sheet
 * ticks True redaction by default and that alone forces the path, so redacting
 * one line of a 200-page report deleted every bookmark in it. Measured on a
 * 4-page fixture with 4 bookmarks: `mutool show out.pdf outline` printed
 * nothing, and /Outlines was absent from the file.
 *
 * Only items whose destination resolves to a page this export KEPT can survive;
 * the rest are pruned, because a bookmark pointing at a page that is no longer
 * there is worse than no bookmark. `pageAt` maps a source page index to the ref
 * it was copied to.
 *
 * Named destinations are resolved through the catalog's /Dests and
 * /Names/Dests. Anything that still cannot be resolved is dropped rather than
 * guessed at.
 */
function carryOutlines(
  out: PDFDocument, lib: PDFDocument, pageAt: Map<number, PDFRef>,
): number {
  const srcCat = lib.catalog
  const outlinesRef = srcCat.get(PDFName.of('Outlines'))
  const root = outlinesRef ? lib.context.lookup(outlinesRef) : undefined
  if (!(root instanceof PDFDict)) return 0

  // source page ref (by object number) -> index, so a /Dest can be placed
  const indexOfPage = new Map<number, number>()
  lib.getPages().forEach((pg, i) => { indexOfPage.set(pg.ref.objectNumber, i) })

  // named destinations, both of the two places they live
  const named = new Map<string, PDFArray>()
  const addNamed = (dict: PDFDict | undefined): void => {
    if (!(dict instanceof PDFDict)) return
    for (const [k, v] of dict.entries()) {
      const val = lib.context.lookup(v)
      const arr = val instanceof PDFArray ? val
        : val instanceof PDFDict ? (lib.context.lookup(val.get(PDFName.of('D'))) as PDFArray | undefined)
        : undefined
      if (arr instanceof PDFArray) named.set(k.asString().replace(/^\//, ''), arr)
    }
  }
  addNamed(lib.context.lookup(srcCat.get(PDFName.of('Dests'))) as PDFDict | undefined)
  const names = lib.context.lookup(srcCat.get(PDFName.of('Names'))) as PDFDict | undefined
  if (names instanceof PDFDict) {
    const dests = lib.context.lookup(names.get(PDFName.of('Dests'))) as PDFDict | undefined
    // a name TREE, which may be one level or many; walk /Kids and /Names
    const treeSeen = new Set<PDFDict>()
    const walkTree = (node: PDFDict | undefined, depth = 0): void => {
      if (!(node instanceof PDFDict) || depth > 8) return
      if (treeSeen.has(node)) return // a /Kids list that points back at an ancestor
      treeSeen.add(node)
      const pairs = lib.context.lookup(node.get(PDFName.of('Names'))) as PDFArray | undefined
      if (pairs instanceof PDFArray) {
        for (let i = 0; i + 1 < pairs.size(); i += 2) {
          const key = pairs.lookup(i)
          const val = lib.context.lookup(pairs.get(i + 1))
          const arr = val instanceof PDFArray ? val
            : val instanceof PDFDict ? (lib.context.lookup(val.get(PDFName.of('D'))) as PDFArray | undefined)
            : undefined
          const k = key && 'asString' in key ? String((key as { asString(): string }).asString()) : null
          if (k && arr instanceof PDFArray) named.set(k.replace(/^\(|\)$/g, ''), arr)
        }
      }
      const kids = lib.context.lookup(node.get(PDFName.of('Kids'))) as PDFArray | undefined
      if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) {
        walkTree(lib.context.lookup(kids.get(i)) as PDFDict | undefined, depth + 1)
      }
    }
    walkTree(dests)
  }

  /** the kept-page ref an outline item points at, or null */
  const destOf = (item: PDFDict): PDFRef | null => {
    let arr: PDFArray | undefined
    const d = lib.context.lookup(item.get(PDFName.of('Dest')))
    if (d instanceof PDFArray) arr = d
    else if (d && 'asString' in d) {
      const key = String((d as { asString(): string }).asString()).replace(/^\/|^\(|\)$/g, '')
      arr = named.get(key)
    }
    if (!arr) {
      const a = lib.context.lookup(item.get(PDFName.of('A'))) as PDFDict | undefined
      if (a instanceof PDFDict) {
        const dd = lib.context.lookup(a.get(PDFName.of('D')))
        if (dd instanceof PDFArray) arr = dd
        else if (dd && 'asString' in dd) {
          arr = named.get(String((dd as { asString(): string }).asString()).replace(/^\/|^\(|\)$/g, ''))
        }
      }
    }
    if (!arr || arr.size() === 0) return null
    const first = arr.get(0)
    const idx = first instanceof PDFRef ? indexOfPage.get(first.objectNumber)
      : first instanceof PDFNumber ? first.asNumber()
      : undefined
    if (idx === undefined) return null
    return pageAt.get(idx) ?? null
  }

  let kept = 0
  // TWO HARD STOPS, because an outline is a linked structure a file is free to
  // make cyclic and nothing here can trust it.
  //
  // The first version had a per-level counter only. That bounds one chain, not
  // the tree: every item recurses into its own children, so a cycle multiplies
  // instead of terminating, and the export simply never returned — the app hung
  // on a document whose outline pointed back at itself, which is a far worse
  // failure than losing the bookmarks would have been.
  const seen = new Set<number>()
  let budget = 4000
  /** copy one level of the tree; returns [firstRef, lastRef, count] */
  const copyLevel = (parentRef: PDFRef, firstItem: unknown, depth: number): [PDFRef | null, PDFRef | null, number] => {
    if (depth > 12 || budget <= 0) return [null, null, 0]
    const made: PDFRef[] = []
    let node = firstItem instanceof PDFRef ? lib.context.lookup(firstItem) : undefined
    let guard = 0
    let cursor: PDFRef | null = firstItem instanceof PDFRef ? firstItem : null
    while (node instanceof PDFDict && guard++ < 4096 && budget-- > 0) {
      // An item reached twice is a cycle; walking it again would never end.
      if (cursor instanceof PDFRef) {
        if (seen.has(cursor.objectNumber)) break
        seen.add(cursor.objectNumber)
      }
      const target = destOf(node)
      const title = node.get(PDFName.of('Title'))
      if (target && title) {
        const dict = out.context.obj({}) as PDFDict
        dict.set(PDFName.of('Title'), out.context.obj(String((title as { decodeText?(): string }).decodeText?.() ?? '')))
        const dest = out.context.obj([]) as PDFArray
        dest.push(target)
        dest.push(PDFName.of('Fit'))
        dict.set(PDFName.of('Dest'), dest)
        dict.set(PDFName.of('Parent'), parentRef)
        const ref = out.context.register(dict)
        made.push(ref)
        kept++
        const [kf, kl, kc] = copyLevel(ref, node.get(PDFName.of('First')), depth + 1)
        if (kf && kl) {
          dict.set(PDFName.of('First'), kf)
          dict.set(PDFName.of('Last'), kl)
          dict.set(PDFName.of('Count'), out.context.obj(kc))
        }
      }
      const next: unknown = node.get(PDFName.of('Next'))
      cursor = next instanceof PDFRef ? next : null
      node = cursor ? lib.context.lookup(cursor) : undefined
    }
    for (let i = 0; i < made.length; i++) {
      const d = out.context.lookup(made[i]) as PDFDict
      if (i > 0) d.set(PDFName.of('Prev'), made[i - 1])
      if (i + 1 < made.length) d.set(PDFName.of('Next'), made[i + 1])
    }
    return [made[0] ?? null, made[made.length - 1] ?? null, made.length]
  }

  const rootDict = out.context.obj({ Type: 'Outlines' }) as PDFDict
  const rootRef = out.context.register(rootDict)
  const [first, last, count] = copyLevel(rootRef, root.get(PDFName.of('First')), 0)
  if (!first || !last) return 0
  rootDict.set(PDFName.of('First'), first)
  rootDict.set(PDFName.of('Last'), last)
  rootDict.set(PDFName.of('Count'), out.context.obj(count))
  out.catalog.set(PDFName.of('Outlines'), rootRef)
  const mode = srcCat.get(PDFName.of('PageMode'))
  if (mode) out.catalog.set(PDFName.of('PageMode'), mode)
  return kept
}

async function exportCompose(doc: DocState, opts: ExportOptions): Promise<Uint8Array> {
  const out = await PDFDocument.create()
  const fonts = makeFontKit(out)
  const libs = new Map<string, PDFDocument>()
  /** source page index -> the ref it was copied to, for the outline rebuild */
  const copiedFrom = new Map<number, PDFRef>()
  const libFor = async (srcId: string): Promise<PDFDocument> => {
    let lib = libs.get(srcId)
    if (!lib) {
      lib = await PDFDocument.load(getSrc(srcId).bytes, { ignoreEncryption: true, updateMetadata: false })
      // before anything is copied out of it: cut links into pages this export
      // does not keep, or copyPages drags those excluded pages in wholesale
      severLinksOutsideSubset(lib, new Set(doc.pages.filter((p) => p.srcId === srcId).map((p) => p.srcIndex)))
      libs.set(srcId, lib)
    }
    return lib
  }

  const fieldsByPage = new Map<string, FormField[]>()
  for (const f of doc.fields) {
    const arr = fieldsByPage.get(f.page) ?? []
    arr.push(f)
    fieldsByPage.set(f.page, arr)
  }

  for (const ref of doc.pages) {
    const geom = pageGeom(ref)
    const objs = objsForPage(doc, ref.id)
    const redacting = opts.trueRedact && objs.some((o) => o.kind === 'redact')

    if (redacting) {
      const dims = viewDims(geom)
      const redactRects = objs.filter((o) => o.kind === 'redact')
      // the marks in PDF user space, to strip annotations and skip field values
      // that sit under them (both would otherwise paint over the black box)
      const userMarks = redactRects.map((r) => viewRectToUser(geom, { x: r.x, y: r.y, w: r.w, h: r.h }) as number[])

      // First try taking the covered content out of the page's own drawing
      // instructions. That keeps the page a page — vector artwork stays vector,
      // the rest of the text stays text — and the redacted words are not in the
      // file at all rather than hidden under a rectangle.
      const pagesBefore = out.getPageCount()
      try {
        const lib0 = await libFor(ref.srcId)
        const [copied0] = await out.copyPages(lib0, [ref.srcIndex])
        const page0 = out.addPage(copied0)
        page0.setRotation(degrees(totalRotation(ref)))
        stripWidgetAnnotations(out, page0, userMarks)
        // the edits first: a redaction re-walks whatever they leave behind
        applyEditsToContent(out, page0, geom, objs)
        const cut = redactPageContent(
          out, page0,
          redactRects.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h })),
          geom,
        )
        if (cut.complete) {
          // the surgery worked, so this copy IS the page — record it before the
          // early `continue`, or its bookmark is pruned as pointing nowhere
          copiedFrom.set(ref.srcIndex, page0.ref)
          await drawFormValuesStatic(out, page0, geom, geom, fieldsByPage.get(ref.id) ?? [], doc.formValues, fonts, userMarks)
          await drawObjectsOnPage(out, page0, geom, objs, fonts, {})
          if (opts.pageNumbers) await stampPageNumber(out, page0, geom, doc.pages.indexOf(ref) + 1, doc.pages.length, fonts)
          for (const o of objs) if (o.kind === 'note') addNoteAnnotation(out, page0, geom, o)
          continue
        }
        // could not remove everything the marks cover — better to lose the
        // page's quality than to promise a redaction and leave the words behind
        while (out.getPageCount() > pagesBefore) out.removePage(out.getPageCount() - 1)
      } catch {
        while (out.getPageCount() > pagesBefore) out.removePage(out.getPageCount() - 1)
      }

      const { dataUrl } = await renderPageToDataUrl(ref, Math.min(dims.w * 2.5, 4200), (ctx, scale) => {
        ctx.fillStyle = '#0A0A0C'
        for (const r of redactRects) {
          if ('x' in r && 'w' in r) ctx.fillRect(r.x * scale, r.y * scale, r.w * scale, r.h * scale)
        }
      })
      const img = await out.embedJpg(dataUrlToBytes(dataUrl))
      const page = out.addPage([dims.w, dims.h])
      // A page that had to be re-forged as an image is still THIS page, and a
      // bookmark pointing at it must still land here. Recording the mapping only
      // on the copy path pruned the bookmark of every redacted page — which is
      // precisely the page the user was working on.
      copiedFrom.set(ref.srcIndex, page.ref)
      page.drawImage(img, { x: 0, y: 0, width: dims.w, height: dims.h })
      // Put the uncovered words back as an invisible, selectable layer so the
      // rasterised page stays searchable/copyable. Skipped on rotated pages (the
      // output page is unrotated view space; a horizontal layer would misplace).
      if (totalRotation(ref) % 360 === 0) {
        // The patches an edit painted count as marks here too. The raster carries
        // the print underneath them as pixels, which is fine — but re-laying the
        // page's own words over it would put the replaced text back as selectable
        // characters, which is the very leak the cover pass just closed.
        const hidden = [...redactRects.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h })), ...coverRects(objs)]
        await drawInvisibleTextLayer(page, ref, dims, hidden, await fonts.getStd('Helvetica'))
      }
      const flatGeom: PageGeom = { cx: 0, cy: 0, uw: dims.w, uh: dims.h, rot: 0 }
      const rest = objs.filter((o) => o.kind !== 'redact')
      await drawFormValuesStatic(out, page, flatGeom, geom, fieldsByPage.get(ref.id) ?? [], doc.formValues, fonts, userMarks)
      await drawObjectsOnPage(out, page, flatGeom, rest, fonts, { skipRedact: true })
      if (opts.pageNumbers) await stampPageNumber(out, page, flatGeom, doc.pages.indexOf(ref) + 1, doc.pages.length, fonts)
      for (const o of rest) if (o.kind === 'note') addNoteAnnotation(out, page, flatGeom, o)
      continue
    }

    const lib = await libFor(ref.srcId)
    const [copied] = await out.copyPages(lib, [ref.srcIndex])
    const page = out.addPage(copied)
    copiedFrom.set(ref.srcIndex, page.ref)
    page.setRotation(degrees(totalRotation(ref)))
    stripWidgetAnnotations(out, page)
    applyEditsToContent(out, page, geom, objs)
    await drawFormValuesStatic(out, page, geom, geom, fieldsByPage.get(ref.id) ?? [], doc.formValues, fonts)
    await drawObjectsOnPage(out, page, geom, objs, fonts, {})
    if (opts.pageNumbers) await stampPageNumber(out, page, geom, doc.pages.indexOf(ref) + 1, doc.pages.length, fonts)
    for (const o of objs) if (o.kind === 'note') addNoteAnnotation(out, page, geom, o)
  }

  // The bookmarks, if this export is of ONE source. With several there is no
  // single tree to carry and merging them is a different feature; say so rather
  // than quietly dropping them.
  const srcIds = new Set(doc.pages.map((p) => p.srcId))
  if (srcIds.size === 1 && copiedFrom.size) {
    try {
      const lib0 = await libFor([...srcIds][0])
      const hadOutlines = Boolean(lib0.catalog.get(PDFName.of('Outlines')))
      const kept = carryOutlines(out, lib0, copiedFrom)
      if (hadOutlines && !kept) noteExport('the bookmarks pointed only at pages this export does not keep, so they were dropped')
    } catch {
      noteExport('the bookmarks could not be carried across')
    }
  } else if (srcIds.size > 1) {
    const anyOutlines = await (async () => {
      for (const id of srcIds) { try { if ((await libFor(id)).catalog.get(PDFName.of('Outlines'))) return true } catch { /* skip */ } }
      return false
    })()
    if (anyOutlines) noteExport('merged documents keep their pages but not their bookmarks')
  }

  applyMetadata(out, doc)
  return out.save({ useObjectStreams: opts.optimize })
}

/**
 * Refuse to write a file we would only mangle.
 *
 * pdf-lib's `ignoreEncryption` suppresses the throw without decrypting, so
 * copyPages would deep-copy still-encrypted bytes into an unencrypted output —
 * garbage pages — and an encrypted-object-stream source cannot be parsed at all.
 * The app displayed the file happily because pdf.js decrypts; this is where that
 * divergence has to be caught.
 *
 * Intake refuses these documents now (assertUsable in loader.ts), so reaching
 * here means a source arrived by some path that skipped it. Every way OUT of the
 * app — export, extract, print — goes through this, so none of them can emit
 * pdf-lib's internals as a user-facing message.
 */
export async function assertExportable(doc: DocState): Promise<void> {
  for (const srcId of new Set(doc.pages.map((p) => p.srcId))) {
    let encrypted = false
    try {
      encrypted = (await PDFDocument.load(getSrc(srcId).bytes, { ignoreEncryption: true, updateMetadata: false })).isEncrypted
    } catch {
      encrypted = true // couldn't parse it (encrypted object streams) — treat as protected
    }
    if (encrypted) throw new Error(PROTECTED_MESSAGE)
  }
}

export async function exportDoc(doc: DocState, opts: ExportOptions): Promise<Uint8Array> {
  await assertExportable(doc)
  pendingNotes = []
  return canUseFastPath(doc, opts) ? exportFast(doc, opts) : exportCompose(doc, opts)
}

/** Export a subset of pages as a fresh document (Extract…). */
export async function extractPages(doc: DocState, pageIds: string[], opts?: Partial<ExportOptions>): Promise<Uint8Array> {
  const keep = new Set(pageIds)
  const subset: DocState = {
    ...doc,
    pages: doc.pages.filter((p) => keep.has(p.id)),
    fields: doc.fields.filter((f) => keep.has(f.page)),
  }
  await assertExportable(subset)
  // Extract must honour the Redact tool's promise ("permanently remove content
  // on export") — not ship a cosmetic black box over live, selectable text.
  // Default trueRedact to on whenever a kept page carries a redaction; a caller
  // can still override via opts.
  return exportCompose(subset, {
    flattenForms: false, optimize: true,
    trueRedact: subset.pages.some((p) => pageHasRedactions(subset, p.id)),
    ...opts,
  })
}

export const suggestedFileName = (doc: DocState, suffix = 'reshaped'): string =>
  `${doc.name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'document'} (${suffix}).pdf`
