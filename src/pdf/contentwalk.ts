import {
  PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFObject, PDFPage, PDFRawStream, PDFRef,
  decodePDFRawStream,
} from 'pdf-lib'
import { Font as StandardFontLoader, FontNames as StandardFontNames, Encodings as StandardEncodings } from '@pdf-lib/standard-fonts'
import type { Rect } from '../core/types'
import { viewToUser, userRectToView } from '../core/geometry'
import type { PageGeom } from '../core/geometry'

/* ----- reading a page's own drawing program ---------------------------------

   A PDF page is not a picture, it is a little program: a stream of operators
   that move a pen, set a font, and paint glyphs, lines and images. Both editing
   features that touch that program — redaction (take the covered operators OUT)
   and layer extraction (lift one element and hand it back editable) — have to
   walk the same stream the same way: split it into tokens, track the graphics
   state, and work out where each thing lands on the page.

   These are the shared pieces of that walk. Keeping one copy means a fix to the
   tokenizer or the width tables helps both, and a page that redacts cleanly and
   a page that extracts cleanly are judged by the same understanding of the
   stream. Everything here is pure: it reads the document, it never mutates it. */

export interface Tok {
  op: string
  args: (number | string | number[])[]
  /** for an inline image (BI…EI): the whole run kept verbatim, binary and all */
  raw?: string
}

// content-stream lexical classes, shared by the tokenizer and the inline-image
// terminator. A PDF token ends at whitespace or one of the delimiter characters.
const isWs = (c: string | undefined): boolean =>
  c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0' || c === undefined
const isBound = (c: string | undefined): boolean =>
  isWs(c) || (c !== undefined && '()<>[]{}/%'.includes(c))

// component count for a device/CIE colour space named directly on an inline
// image (/CS /DeviceRGB, /CS /RGB, …). An indexed or named-resource space is
// returned as null so the caller falls back to the whitespace scan.
function inlineComps(name: string): number | null {
  switch (name) {
    case 'DeviceGray': case 'G': case 'CalGray': return 1
    case 'DeviceRGB': case 'RGB': case 'CalRGB': case 'Lab': return 3
    case 'DeviceCMYK': case 'CMYK': return 4
    default: return null // Indexed, ICCBased, or a /CSn resource — can't size here
  }
}

// The exact byte length of an inline image's payload, or null when it can't be
// known from the dict alone (a filter is present, or the colour space isn't a
// device space). `dict` is the text between BI and ID.
function inlineDataLength(dict: string): number | null {
  if (/\/(?:F|Filter)\b/.test(dict)) return null // filtered — length needs a decode
  const intOf = (re: RegExp): number | null => { const m = dict.match(re); return m ? parseInt(m[1], 10) : null }
  const w = intOf(/\/(?:W|Width)\s+(\d+)/)
  const h = intOf(/\/(?:H|Height)\s+(\d+)/)
  if (!w || !h) return null
  let bpc: number | null, comps: number | null
  if (/\/(?:IM|ImageMask)\s+true\b/.test(dict)) { bpc = 1; comps = 1 } // a mask is 1-bit, 1-component
  else {
    bpc = intOf(/\/(?:BPC|BitsPerComponent)\s+(\d+)/)
    const csm = dict.match(/\/(?:CS|ColorSpace)\s+\/(\w+)/)
    comps = csm ? inlineComps(csm[1]) : null
  }
  if (!bpc || !comps) return null
  const bytesPerRow = Math.ceil((w * comps * bpc) / 8) // each row is byte-aligned
  return bytesPerRow * h
}

// Find the terminating EI of an inline image and return the index just past it.
// `from` is the index right after the BI operator. The ID payload is binary and
// may contain the bytes 'EI', so a bare indexOf('EI') can truncate the image;
// but a valid EI may also directly abut non-whitespace data, so a
// whitespace-before rule alone would mis-terminate. Prefer the exact payload
// length computed from the dict (deterministic for an unfiltered image); fall
// back to a whitespace/boundary scan when the length is unknowable.
function inlineImageEnd(src: string, from: number, n: number): number {
  // the ID operator: a bare 'ID' framed by a boundary, then exactly one
  // whitespace, after which the binary payload begins
  let idPos = -1
  for (let p = src.indexOf('ID', from); p >= 0 && p < n; p = src.indexOf('ID', p + 2)) {
    if (isBound(src[p - 1]) && isWs(src[p + 2])) { idPos = p; break }
  }
  const scanFrom = idPos < 0 ? from : idPos + 3 // 'ID' + one whitespace
  if (idPos >= 0) {
    const len = inlineDataLength(src.slice(from, idPos))
    if (len != null) {
      let p = scanFrom + len
      if (isWs(src[p])) p++ // an optional single whitespace before EI
      if (src[p] === 'E' && src[p + 1] === 'I' && isBound(src[p + 2])) return p + 2
      // the computed length didn't line up — distrust it, fall through to scan
    }
  }
  // no reliable length: prefer an EI framed by whitespace on the left and a
  // boundary on the right, then an EI merely bounded on the right (a terminator
  // abutting binary data), then any EI, then the rest of the stream
  for (let p = src.indexOf('EI', scanFrom); p >= 0; p = src.indexOf('EI', p + 2))
    if (isWs(src[p - 1]) && isBound(src[p + 2])) return p + 2
  for (let p = src.indexOf('EI', scanFrom); p >= 0; p = src.indexOf('EI', p + 2))
    if (isBound(src[p + 2])) return p + 2
  const any = src.indexOf('EI', scanFrom)
  return any < 0 ? n : any + 2
}

/** Split a content stream into operators and their operands. */
export function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let args: (number | string | number[])[] = []
  let i = 0
  const n = src.length

  const readString = (): string => {
    // (...) with balanced parens and backslash escapes
    let depth = 0
    const start = i
    for (; i < n; i++) {
      const c = src[i]
      if (c === '\\') { i++; continue }
      if (c === '(') depth++
      else if (c === ')') { depth--; if (depth === 0) { i++; return src.slice(start, i) } }
    }
    return src.slice(start, i)
  }

  let lastI = -1
  while (i < n) {
    // Defence in depth: every branch below must ADVANCE the cursor. If one ever
    // fails to — a malformed operand reaching a path that doesn't consume — step
    // forward rather than spin. A damaged content stream must never hang the app.
    if (i <= lastI) { i = lastI + 1; continue }
    lastI = i
    const c = src[i]
    if (c === '%') { while (i < n && src[i] !== '\n') i++; continue }
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0') { i++; continue }
    if (c === '(') { args.push(readString()); continue }
    // An UNTERMINATED hex string (a truncated/damaged stream) has no '>': indexOf
    // returns -1, and `i = j + 1` would rewind the cursor to 0 and restart the scan
    // forever — a hard freeze of the renderer, not a bad parse. Take the rest instead.
    if (c === '<' && src[i + 1] !== '<') {
      const j = src.indexOf('>', i)
      const end = j < 0 ? n : j + 1
      args.push(src.slice(i, end)); i = end; continue
    }
    if (c === '<' && src[i + 1] === '<') {
      // a dictionary operand (BDC properties, inline image params) — kept verbatim
      let depth = 0, start = i
      for (; i < n; i++) {
        if (src[i] === '<' && src[i + 1] === '<') { depth++; i++ }
        else if (src[i] === '>' && src[i + 1] === '>') { depth--; i++; if (depth === 0) { i++; break } }
      }
      args.push(src.slice(start, i))
      continue
    }
    if (c === '[') {
      // TJ array: numbers and strings
      const arr: (number | string)[] = []
      i++
      for (;;) {
        while (i < n && /[\s]/.test(src[i])) i++
        if (i >= n || src[i] === ']') { i++; break }
        if (src[i] === '(') { arr.push(readString()); continue }
        if (src[i] === '<') { const j = src.indexOf('>', i); const end = j < 0 ? n : j + 1; arr.push(src.slice(i, end)); i = end; continue }
        let j = i
        while (j < n && !/[\s\]]/.test(src[j])) j++
        // A TJ array holds only strings and numbers; a malformed element (a stray
        // /Name, garbage) would parseFloat to NaN, and a NaN "kern" poisons the text
        // matrix so every later glyph box lands at NaN — never intersecting a mark,
        // so covered glyphs ship live. Treat a non-number as a 0 (no-op) advance.
        const numv = parseFloat(src.slice(i, j))
        arr.push(Number.isNaN(numv) ? 0 : numv)
        i = j
      }
      args.push(arr as unknown as number[])
      continue
    }
    // a token: number, name, or operator
    let j = i
    while (j < n && !/[\s()<>[\]{}/%]/.test(src[j])) j++
    if (src[i] === '/') { j = i + 1; while (j < n && !/[\s()<>[\]{}/%]/.test(src[j])) j++; args.push(src.slice(i, j)); i = j; continue }
    if (j === i) { i++; continue }
    const word = src.slice(i, j)
    i = j
    if (/^[-+.\d]/.test(word) && !Number.isNaN(parseFloat(word))) { args.push(parseFloat(word)); continue }
    out.push({ op: word, args })
    args = []
    if (word === 'BI') {
      // inline image: keep the whole BI…EI run verbatim on this one token. Its
      // ID payload is binary — it must not be tokenized, and a rewrite that drops
      // a neighbouring span has to reproduce the image byte-for-byte, not as a
      // bare BI/EI that loses the pixels. inlineImageEnd finds the real EI (from
      // the exact payload length when the image is unfiltered, else a
      // whitespace/boundary scan) so the binary is never mistaken for tokens.
      const biStart = i - word.length
      const end = inlineImageEnd(src, i, n)
      out[out.length - 1].raw = src.slice(biStart, end)
      i = end
    }
  }
  return out
}

/** A 2-D affine transform [a b c d e f], row-vector convention. */
export type M = [number, number, number, number, number, number]
/** The slice of graphics state that q/Q save and restore and the walk tracks. */
export interface GState { ctm: M; font: string; fs: number; tc: number; tw: number; th: number; tl: number; trise: number }

export const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
]
export const apply = (m: M, x: number, y: number): [number, number] =>
  [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]

/** Glyph advance widths, in 1/1000 em, for one font resource. `unsafe` marks a
 *  composite font this code cannot measure reliably (vertical writing, or a CMap
 *  that remaps code→CID) so redaction must rasterise rather than trust the boxes. */
export interface Widths { get(code: number): number; twoByte: boolean; unsafe?: boolean }

/** the fourteen fonts every PDF viewer is required to have, by their PDF names */
const STANDARD_FONT_BY_NAME: Record<string, StandardFontNames> = {
  'Helvetica': StandardFontNames.Helvetica,
  'Helvetica-Bold': StandardFontNames.HelveticaBold,
  'Helvetica-Oblique': StandardFontNames.HelveticaOblique,
  'Helvetica-BoldOblique': StandardFontNames.HelveticaBoldOblique,
  'Courier': StandardFontNames.Courier,
  'Courier-Bold': StandardFontNames.CourierBold,
  'Courier-Oblique': StandardFontNames.CourierOblique,
  'Courier-BoldOblique': StandardFontNames.CourierBoldOblique,
  'Times-Roman': StandardFontNames.TimesRoman,
  'Times-Bold': StandardFontNames.TimesRomanBold,
  'Times-Italic': StandardFontNames.TimesRomanItalic,
  'Times-BoldItalic': StandardFontNames.TimesRomanBoldItalic,
  'Symbol': StandardFontNames.Symbol,
  'ZapfDingbats': StandardFontNames.ZapfDingbats,
  // the three aliases Acrobat maps to the same faces
  'Arial': StandardFontNames.Helvetica,
  'Arial-Bold': StandardFontNames.HelveticaBold,
  'ArialMT': StandardFontNames.Helvetica,
}

export function readWidths(doc: PDFDocument, fontDict: PDFDict | undefined): Widths | null {
  try {
    if (!fontDict) return null
    const sub = fontDict.lookup(PDFName.of('Subtype')) as PDFName | undefined
    const subtype = sub?.asString() ?? ''
    if (subtype === '/Type0') {
      const descFonts = fontDict.lookup(PDFName.of('DescendantFonts')) as PDFArray | undefined
      const d0 = descFonts ? (doc.context.lookup(descFonts.get(0)) as PDFDict) : undefined
      const dw = (d0?.lookup(PDFName.of('DW')) as PDFNumber | undefined)?.asNumber() ?? 1000
      const table = new Map<number, number>()
      const W = d0?.lookup(PDFName.of('W')) as PDFArray | undefined
      if (W) {
        const a = W.asArray().map((x) => doc.context.lookup(x))
        for (let i = 0; i < a.length;) {
          const first = (a[i] as PDFNumber)?.asNumber?.()
          const next = a[i + 1]
          if (next instanceof PDFArray) {
            const list = next.asArray().map((v) => (doc.context.lookup(v) as PDFNumber).asNumber())
            list.forEach((w, k) => table.set(first + k, w))
            i += 2
          } else {
            const last = (next as PDFNumber)?.asNumber?.()
            const w = (a[i + 2] as PDFNumber)?.asNumber?.()
            for (let c = first; c <= last && c - first < 65536; c++) table.set(c, w)
            i += 3
          }
        }
      }
      // Only Identity-H is safely measurable here: code==CID (so /W keyed by CID
      // is looked up with the raw 2-byte code) and the pen advances horizontally.
      // Identity-V advances DOWNWARD and a named/embedded CMap remaps code→CID, so
      // measuring by raw code lands the glyph boxes in the wrong place and a
      // covered glyph is judged uncovered — flag it so redaction rasterises.
      const enc = fontDict.lookup(PDFName.of('Encoding'))
      const unsafe = !(enc instanceof PDFName) || enc.asString() !== '/Identity-H'
      return { get: (c) => table.get(c) ?? dw, twoByte: true, unsafe }
    }
    if (subtype === '/Type3') {
      // Type3 /Widths are in glyph space; /FontMatrix maps glyph space to text
      // space, and it is not the 1/1000 the base fonts use — a bitmap Type3 with
      // FontMatrix [.01 …] advances 10x what a 1/1000 read would compute, so the
      // run collapsed toward its origin and slipped out from under the mark.
      // Re-express here in the module's 1/1000-em contract: (w * a) em * 1000.
      const fm = fontDict.lookup(PDFName.of('FontMatrix')) as PDFArray | undefined
      const a = fm ? ((doc.context.lookup(fm.get(0)) as PDFNumber)?.asNumber?.() ?? 0.001) : 0.001
      const first3 = (fontDict.lookup(PDFName.of('FirstChar')) as PDFNumber | undefined)?.asNumber() ?? 0
      const arr3 = fontDict.lookup(PDFName.of('Widths')) as PDFArray | undefined
      if (!arr3) return null
      const list3 = arr3.asArray().map((x) => (doc.context.lookup(x) as PDFNumber)?.asNumber?.() ?? 0)
      return {
        get: (c) => (c >= first3 && c - first3 < list3.length ? list3[c - first3] * a * 1000 : 0),
        twoByte: false,
      }
    }
    const first = (fontDict.lookup(PDFName.of('FirstChar')) as PDFNumber | undefined)?.asNumber() ?? 0
    const arr = fontDict.lookup(PDFName.of('Widths')) as PDFArray | undefined
    // A base-14 font is allowed to declare no /Widths at all, and plenty do —
    // including the sample this app ships. Their metrics are not unknown, though:
    // they are the standard 14, published, exact, and already in the bundle
    // (pdf-lib embeds them to WRITE these fonts). Reading them here turns a whole
    // class of run from "estimated at half an em a glyph" — which is off by a
    // fifth on lower case and by nearly half on caps — into measured, so every
    // box a lift, a peel or a cover pass draws around such a run is the real one.
    if (!arr) return standardWidths(fontDict)
    const list = arr.asArray().map((x) => (doc.context.lookup(x) as PDFNumber)?.asNumber?.() ?? 0)
    const descr = fontDict.lookup(PDFName.of('FontDescriptor')) as PDFDict | undefined
    const missing = (descr?.lookup(PDFName.of('MissingWidth')) as PDFNumber | undefined)?.asNumber() ?? 0
    return { get: (c) => (c >= first && c - first < list.length ? list[c - first] : missing), twoByte: false }
  } catch {
    return null
  }
}


/** code -> glyph name for an encoding, memoised (the library exposes the inverse) */
const codeNameCache = new Map<string, Map<number, string>>()
function codeToGlyphName(enc: { name: string; supportedCodePoints: number[]; encodeUnicodeCodePoint(u: number): { code: number; name: string } }): Map<number, string> {
  let m = codeNameCache.get(enc.name)
  if (m) return m
  m = new Map<number, string>()
  for (const u of enc.supportedCodePoints) {
    const g = enc.encodeUnicodeCodePoint(u)
    if (!m.has(g.code)) m.set(g.code, g.name)
  }
  codeNameCache.set(enc.name, m)
  return m
}

/**
 * Widths for a base-14 font that declares none, from the published metrics.
 *
 * Only the fonts the spec guarantees every viewer has; anything else (an
 * embedded face missing its /Widths, which is invalid anyway) stays unmeasurable
 * rather than being measured against the wrong metrics. Codes are mapped through
 * the font's encoding, defaulting to WinAnsi — what /Encoding /WinAnsiEncoding
 * and the overwhelming majority of untagged Latin text mean in practice.
 */
function standardWidths(fontDict: PDFDict): Widths | null {
  try {
    const base = (fontDict.lookup(PDFName.of('BaseFont')) as PDFName | undefined)?.asString()?.slice(1)
    if (!base) return null
    // a subset prefix (ABCDEF+Helvetica) never appears on a true base-14, but
    // strip it before matching rather than fail on a producer that adds one
    const name = base.replace(/^[A-Z]{6}\+/, '')
    const std = STANDARD_FONT_BY_NAME[name] ?? STANDARD_FONT_BY_NAME[name.replace(/,/g, '-')]
    if (!std) return null
    const font = StandardFontLoader.load(std)
    // Symbol and ZapfDingbats carry their own built-in encoding; everything else
    // is read through WinAnsi, which is what untagged Latin text means in practice
    // (and MacRoman differs from it only above 127, where widths mostly agree).
    const table = std === STANDARD_FONT_BY_NAME.Symbol ? StandardEncodings.Symbol
      : std === STANDARD_FONT_BY_NAME.ZapfDingbats ? StandardEncodings.ZapfDingbats
        : StandardEncodings.WinAnsi
    const byCode = codeToGlyphName(table)
    const cache = new Map<number, number>()
    return {
      get: (c) => {
        let w = cache.get(c)
        if (w !== undefined) return w
        const glyph = byCode.get(c)
        // a code the encoding doesn't name (an unused slot) advances like a space
        // rather than zero, which keeps the rest of the line in roughly its place
        w = (glyph ? font.getWidthOfGlyph(glyph) : 0) || font.getWidthOfGlyph('space') || 500
        cache.set(c, w)
        return w
      },
      twoByte: false,
    }
  } catch {
    return null
  }
}

/** Character codes in a PDF string operand. */
export function codes(raw: string, twoByte: boolean): number[] {
  const out: number[] = []
  if (raw.startsWith('<')) {
    const hex = raw.slice(1, -1).replace(/[^0-9a-fA-F]/g, '')
    const step = twoByte ? 4 : 2
    for (let i = 0; i + step <= hex.length; i += step) out.push(parseInt(hex.slice(i, i + step), 16))
    return out
  }
  const body = raw.slice(1, -1)
  const bytes: number[] = []
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') { bytes.push(body.charCodeAt(i)); continue }
    const c = body[++i]
    const map: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 }
    if (c in map) bytes.push(map[c])
    else if (c >= '0' && c <= '7') {
      let oct = c
      while (oct.length < 3 && body[i + 1] >= '0' && body[i + 1] <= '7') oct += body[++i]
      bytes.push(parseInt(oct, 8))
    } else bytes.push(body.charCodeAt(i))
  }
  if (!twoByte) return bytes
  const out2: number[] = []
  for (let i = 0; i + 1 < bytes.length; i += 2) out2.push((bytes[i] << 8) | bytes[i + 1])
  return out2
}

/**
 * Re-encode glyph codes into a PDF string literal — the inverse of `codes`. Used
 * by redaction when it splits a show operator so the uncovered glyphs can be
 * re-emitted as ink while the covered ones become a bare pen advance.
 */
export function encodeCodes(cs: number[], twoByte: boolean): string {
  if (twoByte) return '<' + cs.map((c) => (c & 0xffff).toString(16).padStart(4, '0')).join('') + '>'
  let s = '('
  for (const c of cs) {
    if (c === 0x28) s += '\\('
    else if (c === 0x29) s += '\\)'
    else if (c === 0x5c) s += '\\\\'
    else if (c >= 32 && c < 127) s += String.fromCharCode(c)
    else s += '\\' + (c & 0xff).toString(8).padStart(3, '0')
  }
  return s + ')'
}

/** Do two axis-aligned rectangles overlap? */
export const intersects = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

/** Does `outer` completely contain `inner`? */
export const contains = (outer: Rect, inner: Rect): boolean =>
  inner.x >= outer.x && inner.y >= outer.y
  && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h

/* ----- reading the page as a list of elements -------------------------------

   The same walk redaction uses to decide what to DROP can instead be used to
   decide what is THERE: every glyph run, image, form, filled rectangle and
   stroked line the page paints, with the box it lands in and the token span
   that draws it. Layer extraction picks one of these and hands it back as an
   editable object; the span is what a later, destructive "lift" would remove.

   The boxes come out in user space (media box, offset by the crop origin),
   built the same way redaction builds glyph boxes — apply(mul(tm,ctm), …) —
   so a picker converts a view click to user space once and compares. */

type RGB = [number, number, number]

export type ElementKind =
  | 'text' | 'image' | 'inline-image' | 'form' | 'fill-rect' | 'stroke-line' | 'path'

export interface TextDetail {
  kind: 'text'
  font: string
  fs: number
  startTm: M
  advLocal: number
  /** the "[ n ] TJ" (plus the line-move/spacing) advance stand-in a destructive lift would leave behind */
  synth: string
  /** false when the font carries no width table — box is a guess, lift must raster */
  measurable: boolean
}
export interface ImageDetail { kind: 'image'; name: string; subtype: '/Image' | '/Form' }
export interface FormDetail { kind: 'form'; name: string }
export interface ShapeDetail {
  kind: 'shape'
  shape: 'rect' | 'line'
  fill?: RGB          // device RGB 0..1; absent when the colour space is not a device one
  stroke?: RGB
  strokeWidth?: number // user space, scaled by the CTM
  p1?: [number, number] // line only, user space
  p2?: [number, number]
}
export interface PathDetail {
  kind: 'path'
  subpaths: number
  painted: 'fill' | 'stroke' | 'both'
  /**
   * The path itself, as SVG in USER space — the geometry the page was drawn
   * with, transformed by the CTM in force, so it needs only the page's own
   * user→view mapping to be drawn or exported anywhere else.
   *
   * Without this a path could only ever be lifted as a picture of itself. With
   * it, a logo or a curve becomes a real vector object: movable, resizable,
   * recolourable, and exported as instructions rather than as pixels.
   */
  d?: string
  fill?: RGB
  stroke?: RGB
  strokeWidth?: number
  evenOdd?: boolean
}

export type ElementDetail = TextDetail | ImageDetail | FormDetail | ShapeDetail | PathDetail

export interface PageElement {
  kind: ElementKind
  /** user-space axis-aligned box */
  userBox: Rect
  /** paint order; larger = drawn later = on top */
  z: number
  /** 0 = page content stream; >0 = inside a form XObject, that many levels deep */
  depth: number
  /** the form names this element was reached through, e.g. ['/Fm1', '/Fm3'] */
  formPath: string[]
  /** [firstTok, lastTokExclusive] into THIS stream's tokens (the page's, or the form's) */
  span: [number, number]
  /**
   * What has to stand in for this element when its span is removed, beyond what
   * its detail already says. A path that ALSO set a clip (`… re W f`) is only its
   * painter here, and that painter must become `n`: the clip is not this
   * element's ink, it governs everything drawn after it, and deleting the paint
   * outright would both lose the clip and leave a path with no painting operator
   * at all — a malformed stream.
   */
  standIn?: string
  ctm: M
  /** the effective matrix has no rotation/skew (b==c==0); false ⇒ the box is only a bound */
  axisAligned: boolean
  detail: ElementDetail
}

export interface WalkResult { elements: PageElement[]; incomplete?: string }

const isAA = (m: M): boolean => Math.abs(m[1]) < 1e-6 && Math.abs(m[2]) < 1e-6
const clampBox = (xs: number[], ys: number[]): Rect => ({
  x: Math.min(...xs), y: Math.min(...ys),
  w: (Math.max(...xs) - Math.min(...xs)) || 0.1, h: (Math.max(...ys) - Math.min(...ys)) || 0.1,
})
const cmykToRgb = (c: number, m: number, y: number, k: number): RGB =>
  [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)]

/** A device-RGB triple (0..1) as a #rrggbb string. */
export const rgbToHex = (r: number, g: number, b: number): string => {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

/**
 * Every element a page's own drawing program paints, in paint order.
 *
 * This is redaction's first pass with the decision removed: instead of asking
 * "does this land under a mark, so drop it", it records the box and the token
 * span of every run, image, form, rectangle-fill and line-stroke. Pure — it
 * reads the document and never mutates it.
 */
export function walkPageContent(doc: PDFDocument, page: PDFPage, opts?: { maxDepth?: number }): WalkResult {
  const contents = page.node.Contents()
  if (!contents) return { elements: [], incomplete: 'no content stream' }
  const refs: PDFRef[] = contents instanceof PDFArray
    ? (contents.asArray() as PDFRef[])
    : [page.node.get(PDFName.of('Contents')) as PDFRef]

  const maxDepth = opts?.maxDepth ?? 6
  const elements: PageElement[] = []
  let incomplete: string | undefined

  const tokensOf = (stream: unknown): Tok[] => {
    if (!(stream instanceof PDFRawStream)) return []
    const raw = decodePDFRawStream(stream).decode()
    let src = ''
    for (let i = 0; i < raw.length; i += 0x8000) src += String.fromCharCode(...raw.subarray(i, i + 0x8000))
    return tokenize(src)
  }

  // Walk one content stream. A form XObject is recursed with the composed CTM
  // and its own resources (the parent's as a fallback), so an element inside a
  // form is found just like one on the page — tagged with how deep it sits and
  // the form names it was reached through.
  const run = (toks: Tok[], resources: PDFDict | undefined, baseCtm: M, depth: number, formPath: string[]): void => {
    const fontRes = resources?.lookup(PDFName.of('Font')) as PDFDict | undefined
    const xobjRes = resources?.lookup(PDFName.of('XObject')) as PDFDict | undefined
    const widthCache = new Map<string, Widths | null>()
    const widthsFor = (name: string): Widths | null => {
      if (!widthCache.has(name)) {
        const d = fontRes?.lookup(PDFName.of(name.slice(1))) as PDFDict | undefined
        widthCache.set(name, readWidths(doc, d))
      }
      return widthCache.get(name) ?? null
    }
    const emit = (kind: ElementKind, userBox: Rect, span: [number, number], ctm: M, axisAligned: boolean, detail: ElementDetail, standIn?: string) =>
      elements.push({ kind, userBox, z: elements.length, depth, formPath: [...formPath], span, ctm, axisAligned, detail, ...(standIn ? { standIn } : {}) })

    const stack: (GState & { fill: RGB | null; stroke: RGB | null; lw: number })[] = []
    let ctm: M = baseCtm
    let tm: M = [1, 0, 0, 1, 0, 0]
    let tlm: M = [1, 0, 0, 1, 0, 0]
    let font = ''
    let fs = 0, tc = 0, tw = 0, th = 1, tl = 0, trise = 0
    let fill: RGB | null = [0, 0, 0], stroke: RGB | null = [0, 0, 0], lw = 1

    // current path being constructed, in user space
    let pathStart = -1
    let pts: [number, number][] = []
    let ops: string[] = []
    // `… W f` both paints and sets a clip for everything drawn after it. The clip
    // is not this element's ink, so a removal must leave it standing.
    let pathClips = false
    const resetPath = () => { pathStart = -1; pts = []; ops = []; pathClips = false }

    for (let t = 0; t < toks.length; t++) {
      const { op, args } = toks[t]
      const num = (k: number) => (typeof args[k] === 'number' ? (args[k] as number) : 0)
      switch (op) {
        case 'q': stack.push({ ctm, font, fs, tc, tw, th, tl, trise, fill, stroke, lw }); break
        case 'Q': { const s = stack.pop(); if (s) ({ ctm, font, fs, tc, tw, th, tl, trise, fill, stroke, lw } = s); break }
        case 'cm': ctm = mul([num(0), num(1), num(2), num(3), num(4), num(5)], ctm); break
        case 'BT': tm = [1, 0, 0, 1, 0, 0]; tlm = tm; break
        case 'Tf': font = String(args[0] ?? ''); fs = num(1); break
        case 'Tc': tc = num(0); break
        case 'Tw': tw = num(0); break
        case 'Tz': th = num(0) / 100; break
        case 'TL': tl = num(0); break
        case 'Ts': trise = num(0); break
        case 'Tm': tm = [num(0), num(1), num(2), num(3), num(4), num(5)]; tlm = tm; break
        case 'Td': tlm = mul([1, 0, 0, 1, num(0), num(1)], tlm); tm = tlm; break
        case 'TD': tl = -num(1); tlm = mul([1, 0, 0, 1, num(0), num(1)], tlm); tm = tlm; break
        case 'T*': tlm = mul([1, 0, 0, 1, 0, -tl], tlm); tm = tlm; break

        // device colour; a non-device space (pattern/ICC/Separation) reads as unknown
        case 'g': fill = [num(0), num(0), num(0)]; break
        case 'G': stroke = [num(0), num(0), num(0)]; break
        case 'rg': fill = [num(0), num(1), num(2)]; break
        case 'RG': stroke = [num(0), num(1), num(2)]; break
        case 'k': fill = cmykToRgb(num(0), num(1), num(2), num(3)); break
        case 'K': stroke = cmykToRgb(num(0), num(1), num(2), num(3)); break
        case 'cs': case 'sc': case 'scn': fill = null; break
        case 'CS': case 'SC': case 'SCN': stroke = null; break
        case 'w': lw = num(0); break

        case 'Tj': case 'TJ': case "'": case '"': {
          if (op === '"') { tw = num(0); tc = num(1) }
          if (op === "'" || op === '"') { tlm = mul([1, 0, 0, 1, 0, -tl], tlm); tm = tlm }
          const w = widthsFor(font)
          const parts: (number | string)[] = op === 'TJ'
            ? ((args[0] as unknown as (number | string)[]) ?? [])
            : [String(args[args.length - 1] ?? '')]
          let advLocal = 0
          const startTm: M = tm
          let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
          let measurable = true
          for (const part of parts) {
            if (typeof part === 'number') { const d = (-part / 1000) * fs * th; tm = mul([1, 0, 0, 1, d, 0], tm); advLocal += d; continue }
            // With a width table, box each glyph exactly. Without one (a base-14
            // font that declares no /Widths), estimate a typical half-em advance
            // so the run is still a pickable box — the text tier recovers the
            // exact geometry from pdf.js, and a destructive lift bails on
            // !measurable rather than trusting the estimate.
            if (!w) measurable = false
            for (const code of codes(part, w ? w.twoByte : false)) {
              const adv = w
                ? (w.get(code) / 1000) * fs + tc + (code === 32 && !w.twoByte ? tw : 0)
                : 0.5 * fs + tc + (code === 32 ? tw : 0)
              const [px, py] = apply(mul(tm, ctm), 0, trise)
              const [qx, qy] = apply(mul(tm, ctm), adv * th, trise + fs)
              x1 = Math.min(x1, px, qx); y1 = Math.min(y1, py, qy); x2 = Math.max(x2, px, qx); y2 = Math.max(y2, py, qy)
              const d = adv * th; tm = mul([1, 0, 0, 1, d, 0], tm); advLocal += d
            }
          }
          const round = (x: number) => String(Math.round(x * 1e6) / 1e6)
          const n = fs * th !== 0 ? (-advLocal * 1000) / (fs * th) : 0
          const advOp = Math.abs(n) > 1e-6 ? `[ ${round(n)} ] TJ` : ''
          const pre = op === '"' ? `${round(num(0))} Tw ${round(num(1))} Tc T* ` : op === "'" ? 'T* ' : ''
          const box: Rect = x2 > x1
            ? { x: x1, y: y1, w: (x2 - x1) || 0.1, h: (y2 - y1) || 0.1 }
            : (() => { const [ox, oy] = apply(mul(startTm, ctm), 0, 0); return { x: ox, y: oy - fs * 0.2, w: 0.1, h: fs || 0.1 } })()
          emit('text', box, [t, t + 1], ctm, isAA(mul(startTm, ctm)), {
            kind: 'text', font, fs, startTm, advLocal, synth: (pre + advOp).trim(), measurable,
          })
          break
        }

        case 're': {
          if (pathStart < 0) pathStart = t
          const x = num(0), y = num(1), rw = num(2), rh = num(3)
          for (const [px, py] of [[x, y], [x + rw, y], [x + rw, y + rh], [x, y + rh]] as [number, number][]) pts.push(apply(ctm, px, py))
          ops.push('re'); break
        }
        case 'm': case 'l': { if (pathStart < 0) pathStart = t; pts.push(apply(ctm, num(0), num(1))); ops.push(op); break }
        // a Bézier lies inside the convex hull of its control points, so bounding
        // the control points bounds the curve — recording only the endpoint gave a
        // curved fill a collapsed box that no click could land on
        case 'c': { if (pathStart < 0) pathStart = t; pts.push(apply(ctm, num(0), num(1)), apply(ctm, num(2), num(3)), apply(ctm, num(4), num(5))); ops.push('c'); break }
        case 'v': case 'y': { if (pathStart < 0) pathStart = t; pts.push(apply(ctm, num(0), num(1)), apply(ctm, num(2), num(3))); ops.push(op); break }
        case 'h': ops.push('h'); break
        case 'W': case 'W*': pathClips = true; break // paints nothing itself, but governs what follows

        case 'n': resetPath(); break // clip-only / no paint
        case 'f': case 'F': case 'f*':
        case 'S': case 's': case 'B': case 'B*': case 'b': case 'b*': {
          // reaching a painter means the path IS painted, even if it also set a clip
          // (`re W f`) — the clip is a side effect; clip-only `... W n` goes to the
          // `n` case above and never arrives here
          if (pathStart >= 0 && pts.length) {
            const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
            const box = clampBox(xs, ys)
            // A clipping path keeps its construction and its W; only the paint
            // may go, and it has to become `n` — a path with no painting operator
            // at all is a malformed stream, and dropping the W would unclip
            // everything drawn after it.
            const span: [number, number] = pathClips ? [t, t + 1] : [pathStart, t + 1]
            const standIn = pathClips ? 'n' : undefined
            const aa = isAA(ctm)
            const fills = /^(f|F|f\*|B|B\*|b|b\*)$/.test(op)
            const strokes = /^(S|s|B|B\*|b|b\*)$/.test(op)
            const rectOnly = ops.filter((o) => o !== 'h').length === 1 && ops[0] === 're'
            const lineOnly = ops.every((o) => o === 'm' || o === 'l') && pts.length === 2
            if (fills && rectOnly && aa) {
              emit('fill-rect', box, span, ctm, true, {
                kind: 'shape', shape: 'rect',
                ...(fill ? { fill } : {}),
                ...(strokes && stroke ? { stroke, strokeWidth: lw * Math.hypot(ctm[0], ctm[1]) } : {}),
              }, standIn)
            } else if (strokes && !fills && lineOnly) {
              emit('stroke-line', box, span, ctm, aa, {
                kind: 'shape', shape: 'line',
                ...(stroke ? { stroke } : {}), strokeWidth: lw * Math.hypot(ctm[0], ctm[1]),
                p1: pts[0], p2: pts[1],
              }, standIn)
            } else {
              // Replay the construction operators against the points already
              // transformed into user space. `pts` was collected in the same
              // order the operators consumed their operands, so walking the two
              // together reproduces the path exactly — including the Bézier
              // control points, which are in there because bounding a curve
              // needs them.
              const r6 = (x: number): string => String(Math.round(x * 1e6) / 1e6)
              let d = ''
              let i = 0
              const P = (n: number): string => {
                const [px, py] = pts[i++] ?? [0, 0]
                void n
                return `${r6(px)} ${r6(py)}`
              }
              for (const o of ops) {
                if (o === 're') {
                  const a = pts[i], b = pts[i + 1], c = pts[i + 2], e = pts[i + 3]
                  i += 4
                  if (a && b && c && e) {
                    d += `M ${r6(a[0])} ${r6(a[1])} L ${r6(b[0])} ${r6(b[1])}`
                      + ` L ${r6(c[0])} ${r6(c[1])} L ${r6(e[0])} ${r6(e[1])} Z `
                  }
                } else if (o === 'm') d += `M ${P(1)} `
                else if (o === 'l') d += `L ${P(1)} `
                else if (o === 'c') d += `C ${P(1)} ${P(1)} ${P(1)} `
                else if (o === 'v' || o === 'y') { const a = P(1), b = P(1); d += `Q ${a} ${b} ` }
                else if (o === 'h') d += 'Z '
              }
              emit('path', box, span, ctm, aa, {
                kind: 'path',
                subpaths: ops.filter((o) => o === 'm' || o === 're').length || 1,
                painted: fills && strokes ? 'both' : strokes ? 'stroke' : 'fill',
                d: d.trim() || undefined,
                ...(fills && fill ? { fill } : {}),
                ...(strokes && stroke ? { stroke, strokeWidth: lw * Math.hypot(ctm[0], ctm[1]) } : {}),
                evenOdd: /\*$/.test(op),
              }, standIn)
            }
          }
          resetPath(); break
        }

        case 'Do': {
          const name = String(args[0] ?? '')
          const xo = xobjRes?.lookup(PDFName.of(name.slice(1)))
          const xdict = xo instanceof PDFRawStream ? xo.dict : (xo instanceof PDFDict ? xo : undefined)
          const sub = (xdict?.lookup(PDFName.of('Subtype')) as PDFName | undefined)?.asString()
          const nums = (a: PDFArray | undefined, fallback: number[]): number[] =>
            a ? a.asArray().map((v) => (doc.context.lookup(v) as PDFNumber)?.asNumber?.() ?? 0) : fallback
          let corners: [number, number][]
          if (sub === '/Form') {
            const bb = nums(xdict?.lookup(PDFName.of('BBox')) as PDFArray | undefined, [0, 0, 1, 1])
            const fm = nums(xdict?.lookup(PDFName.of('Matrix')) as PDFArray | undefined, [1, 0, 0, 1, 0, 0]) as M
            const full = mul(fm, ctm)
            corners = ([[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]]] as [number, number][]).map(([x, y]) => apply(full, x, y))
          } else {
            corners = ([[0, 0], [1, 0], [1, 1], [0, 1]] as [number, number][]).map(([x, y]) => apply(ctm, x, y))
          }
          const box = clampBox(corners.map((c) => c[0]), corners.map((c) => c[1]))
          if (sub === '/Image') emit('image', box, [t, t + 1], ctm, isAA(ctm), { kind: 'image', name, subtype: '/Image' })
          else if (sub === '/Form') {
            // emit the form as one element, then descend into it: its content is
            // painted with the form matrix composed onto the current CTM, and its
            // own /Resources (parent's as a fallback). A hit inside a form yields
            // the whole form first; picking again steps deeper.
            emit('form', box, [t, t + 1], ctm, isAA(ctm), { kind: 'form', name })
            if (depth < maxDepth && xo instanceof PDFRawStream) {
              const fm = nums(xdict?.lookup(PDFName.of('Matrix')) as PDFArray | undefined, [1, 0, 0, 1, 0, 0]) as M
              const formRes = (xdict?.lookup(PDFName.of('Resources')) as PDFDict | undefined) ?? resources
              run(tokensOf(xo), formRes, mul(fm, ctm), depth + 1, [...formPath, name])
            }
          }
          break
        }
        case 'BI': {
          const corners = ([[0, 0], [1, 0], [1, 1], [0, 1]] as [number, number][]).map(([x, y]) => apply(ctm, x, y))
          emit('inline-image', clampBox(corners.map((c) => c[0]), corners.map((c) => c[1])), [t, t + 1], ctm, isAA(ctm), { kind: 'image', name: '', subtype: '/Image' })
          break
        }
        default: break
      }
    }
  }

  // the page's own content streams, concatenated, walked at depth 0
  const allToks: Tok[] = []
  for (const ref of refs) for (const tk of tokensOf(doc.context.lookup(ref))) allToks.push(tk)
  run(allToks, page.node.Resources(), [1, 0, 0, 1, 0, 0], 0, [])

  return { elements, incomplete }
}

/**
 * The elements under a view-space point, topmost first. Re-picking the same
 * point steps down the stack, which is how a click reaches an element sitting
 * beneath a larger one (a late full-page rectangle paints over a glyph).
 */
export function layersAt(
  elements: PageElement[], geom: PageGeom, viewX: number, viewY: number, slack = 2,
): PageElement[] {
  const [ux, uy] = viewToUser(geom, viewX, viewY)
  // intersects is strict, so a bare point never registers — give it a little area
  const pt: Rect = { x: ux - slack, y: uy - slack, w: 2 * slack, h: 2 * slack }
  // shallower first (the whole form before what's inside it), then topmost within
  // a level — so a click grabs the form, and picking again descends into it
  return elements.filter((el) => intersects(el.userBox, pt)).sort((a, b) => a.depth - b.depth || b.z - a.z)
}

export interface RemovalEdit {
  span: [number, number]
  /** a text run leaves its advance stand-in behind so its line keeps its place */
  replacement?: string
  /** empty/absent = the page's own content; a chain of form names = inside those forms */
  formPath?: string[]
}

/**
 * The show operators drawing the printed text that a patch laid over `band`
 * (view space) is covering — what an edit has to remove from the page's own
 * program, not merely paint over.
 *
 * Retype and peel both cover a row of print with a rebuilt background and set
 * new words on top. On the page that is the whole job; in the FILE the original
 * glyphs stay in the content stream under the patch, so pdftotext, copy-paste,
 * search and every indexer still read the words the user thinks they replaced.
 * A patch is a picture and can't fix that. These are the operators that have to
 * go with it.
 *
 * A run only counts when the patch really is standing in for it:
 *
 *  - it does not stick out SIDEWAYS. The pad is a fraction of the line height —
 *    enough for the sidebearings that make a run's box a shade wider than its
 *    ink, nowhere near enough to swallow the next word along.
 *  - it sits INSIDE the band down the page, give or take a third of its own
 *    height — the slack a band measured off the INK needs, since a run's
 *    typographic box reaches about that much higher than the ink does. Tying the
 *    slack to the run rather than to the band is what keeps a big hand-drawn
 *    rubber from reaching the line below it.
 *  - it is not much TALLER than the band, so a headline crossing a small band
 *    is left alone rather than deleted from under the reader.
 *
 * Anything else stays. Leaving a run behind costs what we already had — words
 * hidden under a patch — while taking the wrong one punches a visible hole in
 * someone's document.
 */
export function textSpansUnder(
  doc: PDFDocument, page: PDFPage, geom: PageGeom, band: Rect,
  /** a walk already done — a peel asks about a dozen bands on one page */
  elements?: PageElement[],
): RemovalEdit[] {
  const out: RemovalEdit[] = []
  for (const el of elements ?? walkPageContent(doc, page).elements) {
    if (el.kind !== 'text' || el.detail.kind !== 'text') continue
    // compare in VIEW space: the band is a row as displayed, and a run drawn
    // turned on the page has a tall narrow box there, which the tests below
    // then reject — as they should, since a horizontal band says nothing about it
    const b = userRectToView(geom, [el.userBox.x, el.userBox.y, el.userBox.x + el.userBox.w, el.userBox.y + el.userBox.h])
    const hpad = 0.3 * Math.min(band.h, b.h)
    // Where the run ENDS may be a guess. A base-14 font that declares no /Widths
    // is measured at a flat half-em a glyph, which overshoots real type by a
    // fifth or more — so a run that fits its band perfectly on the page looks
    // like it overhangs, and a strict edge test would refuse to remove any of it.
    // The run's START comes from the text matrix and is exact either way, so hold
    // that edge strictly and let an unmeasurable run overrun its band by up to a
    // third of its own estimated length.
    const tailSlack = el.detail.measurable === false ? Math.max(hpad, 0.35 * b.w) : hpad
    if (b.x < band.x - hpad || b.x + b.w > band.x + band.w + tailSlack) continue
    const vslack = 0.35 * b.h
    if (b.y < band.y - vslack || b.y + b.h > band.y + band.h + vslack) continue
    if (b.h > band.h * 2.2) continue
    // A form drawn twice on the page shares ONE stream, so removing this
    // occurrence's operators would erase the other copy too. Leave it: the patch
    // still covers the print, which is where we started.
    if (el.formPath.length && formStreamShared(doc, page, el.formPath)) continue
    out.push({ span: el.span, replacement: el.detail.synth ?? el.standIn, formPath: el.formPath })
  }
  return out
}

/**
 * Replace a stream's bytes, KEEPING ITS DICTIONARY.
 *
 * context.flateStream() builds a stream whose dict is only what you hand it, and
 * assign() swaps the whole object — so writing edited bytes back with a bare
 * flateStream silently threw away everything else the dictionary said. On a page
 * that costs little; on a FORM XObject it is fatal, because /Subtype /Form,
 * /BBox, /Matrix, /Resources and /Group all live there. The form became an
 * unnamed blob, its Do drew nothing, and every mark it carried left the page —
 * a whole letterhead gone because one line inside it was lifted.
 */
export function replaceStreamBytes(doc: PDFDocument, ref: PDFRef, bytes: Uint8Array): void {
  const orig = doc.context.lookup(ref)
  const keep: Record<string, PDFObject> = {}
  if (orig instanceof PDFRawStream) {
    for (const [k, v] of orig.dict.entries()) {
      const name = k.asString()
      // the three the new encoding decides for itself; everything else is the
      // object's own identity and must survive
      if (name === '/Length' || name === '/Filter' || name === '/DecodeParms') continue
      keep[name.slice(1)] = v
    }
  }
  doc.context.assign(ref, doc.context.flateStream(bytes, keep))
}

/** Rewrite one set of content-stream refs, dropping the given (local) spans. */
function rewriteStreams(doc: PDFDocument, refs: PDFRef[], edits: RemovalEdit[]): void {
  const perRef: { ref: PDFRef; start: number; len: number }[] = []
  const allToks: Tok[] = []
  for (const ref of refs) {
    const stream = doc.context.lookup(ref)
    if (!(stream instanceof PDFRawStream)) continue
    const raw = decodePDFRawStream(stream).decode()
    let src = ''
    for (let i = 0; i < raw.length; i += 0x8000) src += String.fromCharCode(...raw.subarray(i, i + 0x8000))
    const toks = tokenize(src)
    perRef.push({ ref, start: allToks.length, len: toks.length })
    for (const tk of toks) allToks.push(tk)
  }

  const drop = new Set<number>()
  const standIn = new Map<number, string>() // token index -> replacement text
  for (const { span, replacement } of edits) {
    for (let t = span[0]; t < span[1]; t++) drop.add(t)
    if (replacement) standIn.set(span[0], replacement)
  }

  for (const { ref, start, len } of perRef) {
    let touched = false
    for (let k = start; k < start + len; k++) if (drop.has(k)) { touched = true; break }
    if (!touched) continue
    const out: string[] = []
    for (let t = start; t < start + len; t++) {
      if (drop.has(t)) { const r = standIn.get(t); if (r) out.push(r); continue }
      const { op, args, raw } = allToks[t]
      if (raw !== undefined) { out.push(raw); continue } // an inline image, kept whole
      const parts = args.map((a) => {
        if (typeof a === 'number') return String(Math.round(a * 1e6) / 1e6)
        if (Array.isArray(a)) return `[${(a as unknown as (number | string)[]).map((v) => (typeof v === 'number' ? String(Math.round(v * 1e6) / 1e6) : v)).join(' ')}]`
        return a
      })
      out.push(parts.length ? `${parts.join(' ')} ${op}` : op)
    }
    const rewritten = out.join('\n')
    const bytes = new Uint8Array(rewritten.length)
    for (let i = 0; i < rewritten.length; i++) bytes[i] = rewritten.charCodeAt(i) & 0xff
    replaceStreamBytes(doc, ref, bytes)
  }
}

/**
 * Every form XObject stream reachable from a page, by object number.
 *
 * Used to answer a question `formStreamShared` cannot: that one asks whether a
 * form is drawn twice on THIS page, which is about one page's own ink. This one
 * is for the export path, where two DIFFERENT kept pages may draw the same form
 * object — and there, editing the shared stream for the page that covers it
 * would take the ink off the page that does not.
 */
export function formRefsOnPage(doc: PDFDocument, page: PDFPage): Set<number> {
  const out = new Set<number>()
  const seen = new Set<number>()
  const visit = (resources: PDFDict | undefined, depth: number): void => {
    if (!resources || depth > 8) return
    const xobj = resources.lookup(PDFName.of('XObject')) as PDFDict | undefined
    if (!xobj) return
    for (const [, value] of xobj.entries()) {
      if (!(value instanceof PDFRef)) continue
      if (seen.has(value.objectNumber)) continue
      seen.add(value.objectNumber)
      const form = doc.context.lookup(value)
      if (!(form instanceof PDFRawStream)) continue
      const sub = form.dict.lookup(PDFName.of('Subtype'))
      if (!(sub instanceof PDFName) || sub.asString() !== '/Form') continue
      out.add(value.objectNumber)
      const own = form.dict.lookup(PDFName.of('Resources')) as PDFDict | undefined
      visit(own ?? resources, depth + 1)
    }
  }
  visit(page.node.Resources(), 0)
  return out
}

/** The object number of the form reached by `formPath`, or null. */
export function formRefNumber(doc: PDFDocument, page: PDFPage, formPath: string[]): number | null {
  return resolveFormRef(doc, page, formPath)?.objectNumber ?? null
}

/**
 * May a span inside a form XObject be edited, given the set of pages the export
 * is keeping? Yes when exactly one of them can reach that form: its stream is
 * then this page's alone, and cutting the covered run out of it cannot take ink
 * off a page nobody marked.
 *
 * Lives here, next to the counting it depends on, so the export path and the
 * test that guards it are asking the same function rather than two restatements
 * of the same rule that can drift apart.
 */
export function formSpanGuard(
  doc: PDFDocument, pages: PDFPage[],
): (page: PDFPage, formPath: string[]) => boolean {
  const use = new Map<number, number>()
  for (const p of pages) for (const n of formRefsOnPage(doc, p)) use.set(n, (use.get(n) ?? 0) + 1)
  return (page, formPath) => {
    const n = formRefNumber(doc, page, formPath)
    // Unresolvable means we cannot prove it is ours alone, so leave it.
    return n !== null && (use.get(n) ?? 0) < 2
  }
}

/** The stream ref of the form reached by a chain of /XObject names from a page. */
function resolveFormRef(doc: PDFDocument, page: PDFPage, formPath: string[]): PDFRef | null {
  let resources = page.node.Resources()
  let ref: PDFRef | null = null
  for (const name of formPath) {
    const xobj = resources?.lookup(PDFName.of('XObject')) as PDFDict | undefined
    if (!xobj) return null
    const got = xobj.get(PDFName.of(name.slice(1)))
    if (!(got instanceof PDFRef)) return null
    ref = got
    const form = doc.context.lookup(ref)
    // a form may omit /Resources and inherit the parent's — mirror the walk's
    // fallback, or a deeper form reached through it resolves against nothing
    const own = form instanceof PDFRawStream ? (form.dict.lookup(PDFName.of('Resources')) as PDFDict | undefined) : undefined
    resources = own ?? resources
  }
  return ref
}

/**
 * Is the form reached by `formPath` drawn more than once on this page? Its
 * stream is a single shared object, so a destructive edit (removeSpans) meant
 * for one occurrence would erase the ink of every other occurrence too. The
 * lift path checks this and covers with a flat patch instead of editing the
 * shared stream. Counts every /Form Do across the page and its nested forms
 * that resolves to the same object, so aliasing under two names is caught too.
 */
export function formStreamShared(doc: PDFDocument, page: PDFPage, formPath: string[]): boolean {
  const target = resolveFormRef(doc, page, formPath)
  if (!target) return false
  const same = (r: PDFRef): boolean =>
    r === target || (r.objectNumber === target.objectNumber && r.generationNumber === target.generationNumber)
  // Decoding a stream to tokens is a static property of the object, so it is
  // cached. The target COUNT is deliberately NOT memoized: how many targets a
  // form contributes depends on the ancestor path (a cycle back-edge is skipped)
  // and on the resource context it is reached through (a /Resources-less form
  // binds its child names from the caller's resources), so a value computed in
  // one context is wrong in another. Re-counting per context is correct.
  const tokCache = new Map<number, Tok[]>()
  const toksOf = (ref: PDFRef): Tok[] => {
    let t = tokCache.get(ref.objectNumber)
    if (t) return t
    const stream = doc.context.lookup(ref)
    if (!(stream instanceof PDFRawStream)) { tokCache.set(ref.objectNumber, []); return [] }
    const raw = decodePDFRawStream(stream).decode()
    let src = ''
    for (let i = 0; i < raw.length; i += 0x8000) src += String.fromCharCode(...raw.subarray(i, i + 0x8000))
    t = tokenize(src)
    tokCache.set(ref.objectNumber, t)
    return t
  }
  // How many times the target's Do renders under these tokens, capped at 2 (all
  // we need is >1). `stack` is the ANCESTOR path: a diamond or a re-invoked
  // intermediate is counted once per path (correct), while a form already on the
  // path is a cycle and skipped. `budget` bounds total work against a crafted
  // deep DAG. Every uncertainty (too deep, out of budget) returns 2 — OVER-
  // reporting a shared form only costs a flat patch, whereas UNDER-reporting
  // would let removeSpans edit a shared stream and corrupt the other copies.
  let budget = 200000
  const count = (toks: Tok[], resources: PDFDict | undefined, stack: Set<number>, depth: number): number => {
    if (depth > 64) return 2
    let n = 0
    const xobjRes = resources?.lookup(PDFName.of('XObject')) as PDFDict | undefined
    for (const tk of toks) {
      if (tk.op !== 'Do') continue
      if (--budget <= 0) return 2
      const got = xobjRes?.get(PDFName.of(String(tk.args[0] ?? '').slice(1)))
      if (!(got instanceof PDFRef)) continue
      if (same(got)) { if ((n += 1) > 1) return 2; continue }
      const xo = doc.context.lookup(got)
      if (!(xo instanceof PDFRawStream)) continue
      if ((xo.dict.lookup(PDFName.of('Subtype')) as PDFName | undefined)?.asString() !== '/Form') continue
      const key = got.objectNumber
      if (stack.has(key)) continue // a form on the current path — cycle, skip
      stack.add(key)
      const own = (xo.dict.lookup(PDFName.of('Resources')) as PDFDict | undefined) ?? resources
      n += count(toksOf(got), own, stack, depth + 1)
      stack.delete(key)
      if (n > 1) return 2
    }
    return n
  }
  const contents = page.node.Contents()
  const refs: PDFRef[] = contents instanceof PDFArray
    ? (contents.asArray() as PDFRef[])
    : contents ? [page.node.get(PDFName.of('Contents')) as PDFRef] : []
  // The page's Contents may be an array split at ANY token boundary — even
  // between an operand and its operator — so concatenate the DECODED bytes (with
  // a separator, as a renderer does) and tokenize ONCE. Tokenizing each piece
  // alone would drop a `/Fm Do` that straddles the split and undercount the
  // target, which for this guard means a shared stream edited in place.
  let pageSrc = ''
  for (const ref of refs) {
    const stream = doc.context.lookup(ref)
    if (!(stream instanceof PDFRawStream)) continue
    const raw = decodePDFRawStream(stream).decode()
    for (let i = 0; i < raw.length; i += 0x8000) pageSrc += String.fromCharCode(...raw.subarray(i, i + 0x8000))
    pageSrc += '\n'
  }
  return count(tokenize(pageSrc), page.node.Resources(), new Set(), 0) > 1
}

/**
 * Remove token spans from a page — so a re-render shows it WITHOUT those
 * elements, the true background a destructive lift covers the hole with. Spans
 * inside a form (edit.formPath set) are removed from that form's own stream;
 * since this only ever runs on a throwaway copy of the page, the form copy is
 * isolated, so editing it is copy-on-write and never touches the source or a
 * shared form on another page.
 *
 * MUTATES the document — only ever call on a THROWAWAY copy of a page.
 */
export function removeSpans(doc: PDFDocument, page: PDFPage, edits: RemovalEdit[]): void {
  // group by which stream the span indices belong to (page content, or a form).
  // The key is structural (JSON) so an /XObject name with an odd character can't
  // corrupt the path the way a delimiter join/split would.
  const groups = new Map<string, { path: string[]; edits: RemovalEdit[] }>()
  for (const e of edits) {
    const path = e.formPath ?? []
    const key = JSON.stringify(path)
    const g = groups.get(key) ?? (groups.set(key, { path, edits: [] }).get(key)!)
    g.edits.push(e)
  }
  for (const { path, edits: groupEdits } of groups.values()) {
    if (path.length === 0) {
      const contents = page.node.Contents()
      if (!contents) continue
      const refs: PDFRef[] = contents instanceof PDFArray
        ? (contents.asArray() as PDFRef[])
        : [page.node.get(PDFName.of('Contents')) as PDFRef]
      rewriteStreams(doc, refs, groupEdits)
    } else {
      const formRef = resolveFormRef(doc, page, path)
      if (formRef) rewriteStreams(doc, [formRef], groupEdits)
    }
  }
}
