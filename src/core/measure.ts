import { FONT_STACKS } from './types'
import type { FontId } from './types'

let ctx: CanvasRenderingContext2D | null = null
const getCtx = (): CanvasRenderingContext2D => {
  if (!ctx) ctx = document.createElement('canvas').getContext('2d')!
  return ctx
}

export const LINE_HEIGHT = 1.3

/**
 * Top of a text box to the baseline of its first line, in ems.
 *
 * Shared, because two renderers draw these objects — the canvas raster path and
 * the PDF exporter — and a retype is placed by working backwards from where the
 * original baseline sat. If the two disagreed by even a hundredth, every edit
 * would sit off the line in one of them.
 */
export const BASELINE_EM = 1.02

/**
 * The family list to set text in: the document's own embedded face first when we
 * have it, the palette face behind it. The browser falls back per CHARACTER, so
 * a subset face that can't set some new letter degrades to the palette twin for
 * that letter alone instead of failing outright.
 */
export const faceStack = (font: FontId, pdfFont?: string, matchFace?: string): string =>
  pdfFont
    ? `"${pdfFont}", ${FONT_STACKS[font]}`
    : matchFace
      ? `"${MATCH_CSS[matchFace] ?? matchFace}", ${FONT_STACKS[font]}`
      : FONT_STACKS[font]

/** file basename in public/fonts -> the CSS family it is registered under */
export const MATCH_CSS: Record<string, string> = {
  montserrat: 'Montserrat', raleway: 'Raleway', worksans: 'Work Sans', dmsans: 'DM Sans',
  inter: 'Inter', manrope: 'Manrope', rubik: 'Rubik', figtree: 'Figtree', outfit: 'Outfit',
  plusjakartasans: 'Plus Jakarta Sans', quicksand: 'Quicksand', urbanist: 'Urbanist',
}

/**
 * CSS font shorthand. When the face has no true italic the browser synthesises
 * the oblique — and because the exporter's raster path uses this same spec on a
 * canvas, the exported slant matches the screen exactly.
 *
 * An embedded face is asked for at normal weight and upright: it already IS the
 * bold or the italic the print used (Times-Bold is its own font program), and
 * asking the browser for 700 on top would have it synthesise a second helping of
 * weight over the real thing.
 */
const fontSpec = (font: FontId, size: number, bold: boolean, italic = false, pdfFont?: string): string =>
  pdfFont
    ? `400 ${size}px ${faceStack(font, pdfFont)}`
    : `${italic ? 'italic ' : ''}${bold ? '700' : '400'} ${size}px ${FONT_STACKS[font]}`

/** Greedy word-wrap using real canvas metrics — the same breaks the editor shows. */
export function wrapLines(text: string, font: FontId, size: number, bold: boolean, maxW: number, italic = false, pdfFont?: string, tracking = 0): string[] {
  const c = getCtx()
  c.font = fontSpec(font, size, bold, italic, pdfFont)
  // Honour letter-spacing: a run set with negative tracking (a display name
  // tightened to fit) is NARROWER than its bare glyph widths, so measuring
  // without it wrapped text that actually fits on one line — "MERIDIAN" broke to
  // two. Add (n-1)·tracking, exactly as the renderer and exporter draw it.
  const fits = (s: string) => c.measureText(s).width + Math.max(0, [...s].length - 1) * tracking <= maxW
  // A word wider than the box (a long URL, a hex hash, a run-together token) is
  // broken at the character level — mirroring the CSS `word-break: break-word`
  // the editor DIV uses, so line count, height, textarea, selection box and the
  // exporter all agree instead of overflowing the box only on export.
  const breakLong = (word: string): string[] => {
    if (fits(word)) return [word]
    const chunks: string[] = []
    let cur = ''
    for (const ch of word) {
      if (cur && !fits(cur + ch)) { chunks.push(cur); cur = ch }
      else cur += ch
    }
    if (cur) chunks.push(cur)
    return chunks
  }
  const out: string[] = []
  for (const hard of text.split('\n')) {
    let line = ''
    for (const word of hard.split(' ')) {
      const candidate = line ? `${line} ${word}` : word
      if (fits(candidate)) { line = candidate; continue }
      if (line) { out.push(line); line = '' }
      const parts = breakLong(word) // word alone: keep whole if it fits, else split
      for (let i = 0; i < parts.length - 1; i++) out.push(parts[i])
      line = parts[parts.length - 1]
    }
    out.push(line)
  }
  return out.length ? out : ['']
}

/** Measure a text block in view units. `maxW` turns on word wrapping. `tracking` adds per-letter spacing. */
export function measureText(
  text: string,
  font: FontId,
  size: number,
  bold: boolean,
  maxW?: number,
  tracking = 0,
  italic = false,
  pdfFont?: string,
): { w: number; h: number; lines: string[] } {
  const c = getCtx()
  c.font = fontSpec(font, size, bold, italic, pdfFont)
  const lines = maxW ? wrapLines(text, font, size, bold, maxW, italic, pdfFont, tracking) : text.split('\n')
  let w = 0
  for (const line of lines) w = Math.max(w, c.measureText(line || ' ').width + Math.max(0, (line?.length ?? 1) - 1) * tracking)
  if (maxW) w = maxW
  return { w: Math.max(w, 4), h: Math.max(lines.length, 1) * size * LINE_HEIGHT, lines }
}

/** Rasterize a text block to a trimmed transparent PNG (unicode-safe export fallback). */
export function rasterizeText(
  text: string,
  font: FontId,
  size: number,
  bold: boolean,
  color: string,
  scale = 3,
  maxW?: number,
  tracking = 0,
  italic = false,
  pdfFont?: string,
  align: 'left' | 'center' | 'right' = 'left',
): { dataUrl: string; w: number; h: number } {
  const m = measureText(text, font, size, bold, maxW, tracking, italic, pdfFont)
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil((m.w + 2) * scale)
  canvas.height = Math.ceil(m.h * scale)
  const c = canvas.getContext('2d')!
  c.scale(scale, scale)
  c.font = fontSpec(font, size, bold, italic, pdfFont)
  c.fillStyle = color
  c.textBaseline = 'alphabetic'
  // Per-line horizontal offset inside a fixed box, so a right/centre-aligned run
  // that has to raster (CJK, synthetic italic) matches the screen and the vector
  // export instead of sitting flush-left. Only meaningful with a box wider than
  // the line (m.w is pinned to maxW when maxW is set).
  const lineWidth = (line: string) => {
    if (!tracking) return c.measureText(line).width
    let w = 0
    for (const ch of line) w += c.measureText(ch).width + tracking
    return Math.max(0, w - tracking)
  }
  const offset = (line: string) => {
    if (align === 'left' || !maxW) return 1
    const extra = m.w - lineWidth(line)
    return extra <= 0 ? 1 : 1 + (align === 'right' ? extra : extra / 2)
  }
  m.lines.forEach((line, i) => {
    const y = size * LINE_HEIGHT * i + size * BASELINE_EM
    if (tracking) {
      let x = offset(line)
      for (const ch of line) {
        c.fillText(ch, x, y)
        x += c.measureText(ch).width + tracking
      }
    } else {
      c.fillText(line, offset(line), y)
    }
  })
  return { dataUrl: canvas.toDataURL('image/png'), w: m.w + 2, h: m.h }
}

/** WinAnsi-encodable check: if false, the exporter falls back to rasterized text. */
export function isWinAnsi(text: string): boolean {
  //  -~ and  -ÿ only — NOT DEL () or the C1 controls
  // (-), which sit inside a naive " -ÿ" range but which pdf-lib's
  // WinAnsi encoder rejects; accepting them here re-triggered the export
  // double-print. The WinAnsi "high" glyphs (€ ' " … etc.) are listed by their
  // real code points below.
  //
  // Also excluded, each for its own reason:
  //   TAB and CR — pdf-lib's WinAnsi encoder throws on these exactly as it does on
  //     the C1 controls ("WinAnsi cannot encode 0x0009"), and this predicate is what
  //     picks the vector path, so answering yes re-triggers the double-print.
  //   SOFT HYPHEN (U+00AD) — it encodes happily, but WinAnsi paints it as a REAL
  //     hyphen while the editor shows nothing, so a discretionary break the user
  //     cannot see becomes ink in the file.
  // Text carrying any of them takes the raster path, which reproduces what the user
  // is actually looking at instead of what pdf-lib happens to tolerate.
  // eslint-disable-next-line no-control-regex
  return /^[\u0020-\u007E\u00A0-\u00AC\u00AE-\u00FFŒœŠšŸŽžƒˆ˜–—‘’‚“”„†‡•…‰‹›€™\n]*$/.test(text)
}
