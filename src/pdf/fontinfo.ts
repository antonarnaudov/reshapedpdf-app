import { pdfjs } from './setup'
import { sampleInkColor } from './patch'
import { getSamplingCanvas } from './render'
import { getPageProxy, totalRotation } from './registry'
import type { FontId, PageRef, Rect } from '../core/types'

/* ----- reading the print's REAL font --------------------------------------------
   For a text-layer PDF, pdf.js knows the actual font each glyph run was set in —
   its name ("Helvetica", "Times-Bold"…), weight, style and exact point size.
   That's far more reliable than asking a vision model to guess "sans vs serif",
   and it removes the size-estimation error. For standard fonts we map the name
   to the closest palette face (Arimo, Tinos, … are metric twins). For truly
   embedded faces we can hand back the raw bytes so the edit uses the real font. */

export interface RunFont {
  fontId: FontId
  bold: boolean
  /** the print's slant — kept so an edited retype doesn't snap upright */
  italic: boolean
  size: number // point size = view px at scale 1
  name: string
  /** the run's exact view-space box — the precise thing under the cursor */
  rect: Rect
  /**
   * The run's actual baseline in view space — where the letters SIT, which is
   * not the bottom of the box around them. Descenders hang below it, so a
   * reprint aligned to the box bottom lands about a fifth of an em low: enough
   * to read as "this line has been meddled with" even when nothing else has.
   */
  baseline: number
  text: string
  /** canonical base-14 name (e.g. "Helvetica-Bold") when the run is a standard font */
  stdFont?: string
  /**
   * The family name pdf.js loaded this face under. pdf.js installs every
   * embedded font into document.fonts so it can draw the page, which means the
   * REAL typeface is already available to us — no "closest palette match"
   * needed. Rendering an edit in this family reproduces the print exactly.
   */
  loadedName?: string
  /**
   * The face's own space advance, in ems. Subset faces essentially never carry
   * a space GLYPH — PDFs put word gaps in as position offsets — but the width
   * is still declared, and it is the width the line was set with.
   */
  spaceEm?: number
  /**
   * The run is drawn more than once, a hair apart — how a file with no bold face
   * fakes one. pdf.js reports the regular face, so this is the only evidence
   * that the printed line is heavier than its font says.
   */
  overdrawn?: boolean
  /** raw font-program bytes when the face is embedded (not a standard font) */
  data?: Uint8Array
  mimetype?: string
}

/** The width of a space in this face, in ems (0.25 when the face doesn't say). */
function spaceAdvanceEm(font: Record<string, unknown>): number {
  const widths = font.widths as Record<number, number> | number[] | undefined
  const matrix = font.fontMatrix as number[] | undefined
  const w = widths ? (widths as Record<number, number>)[32] : undefined
  const unit = matrix?.[0] ?? 0.001
  const em = typeof w === 'number' && w > 0 ? w * unit : 0
  return em > 0.02 && em < 2 ? em : 0.25
}

/** The base-14 standard font a PDF font name resolves to, if any (pixel-identical on export). */
function standardFontOf(name: string, bold: boolean, italic: boolean): string | undefined {
  const n = name.toLowerCase()
  let base: 'Helvetica' | 'Times' | 'Courier' | null = null
  if (/courier/.test(n)) base = 'Courier'
  else if (/times/.test(n)) base = 'Times'
  else if (/helvetica|arial/.test(n)) base = 'Helvetica'
  if (!base) return undefined
  if (base === 'Times') {
    if (bold && italic) return 'Times-BoldItalic'
    if (bold) return 'Times-Bold'
    if (italic) return 'Times-Italic'
    return 'Times-Roman'
  }
  const suffix = bold && italic ? '-BoldOblique' : bold ? '-Bold' : italic ? '-Oblique' : ''
  return base + suffix
}

/** Map a PDF font name (+ descriptor flags) to the closest palette FontId. */
function mapFont(name: string): FontId {
  const n = name.toLowerCase()
  if (/courier|mono|consol|menlo|typewriter|inconsolat/.test(n)) return 'mono'
  if (/rockwell|slab|clarendon|memphis|serifa/.test(n)) return 'slab'
  if (/times|georgia|garamond|minion|serif|roman|book antiqua|palatino|cambria/.test(n)) return 'serif'
  if (/oswald|condensed|narrow|impact|din|compressed|tungsten/.test(n)) return 'condensed'
  if (/poppins|futura|century gothic|avenir|circular|gotham|montserrat|proxima|geometric/.test(n)) return 'geo'
  if (/nunito|rounded|comfortaa|quicksand|varela/.test(n)) return 'rounded'
  if (/franklin|archivo|grotesk|grotesque|acumin|trade gothic/.test(n)) return 'grotesk'
  if (/lato|segoe|frutiger|myriad|open sans|source sans|calibri|tahoma|verdana|humanist/.test(n)) return 'humanist'
  return 'sans' // Helvetica/Arial/Liberation and anything unrecognised
}

/**
 * The font of the printed run under a view-space point. Returns null when the
 * page has no text layer (a scan/poster) — callers then fall back to the vision
 * model + pixel measurement.
 */
export async function runFontInfo(ref: PageRef, x: number, y: number): Promise<RunFont | null> {
  try {
    const page = await getPageProxy(ref)
    const rot = totalRotation(ref)
    const vp = page.getViewport({ scale: 1, rotation: rot })
    // process the operator list so commonObjs is populated with font objects
    await page.getOperatorList()
    const content = await page.getTextContent()

    interface Piece { item: (typeof content.items)[number]; rect: Rect; fontName: string; baseline: number }
    const pieces: Piece[] = []
    let best: Piece | null = null
    let bestDist = Infinity
    const sideways = rot % 180 === 90
    for (const item of content.items) {
      if (!('str' in item) || !item.str.trim()) continue
      const t = pdfjs.Util.transform(vp.transform, item.transform)
      const fontH = Math.hypot(t[2], t[3])
      const rect: Rect = sideways
        ? { x: t[4] - fontH, y: t[5], w: fontH, h: item.width * vp.scale }
        : { x: t[4], y: t[5] - fontH, w: item.width * vp.scale, h: fontH * 1.15 }
      const piece: Piece = { item, rect, fontName: String((item as { fontName?: string }).fontName ?? ''), baseline: t[5] }
      pieces.push(piece)
      const inside = x >= rect.x - 6 && x <= rect.x + rect.w + 6 && y >= rect.y - 3 && y <= rect.y + rect.h + 3
      const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2
      const dist = Math.hypot(cx - x, cy - y)
      if (inside && dist < bestDist) { bestDist = dist; best = piece }
    }
    if (!best) return null

    /* Grow the clicked run across pdf.js's arbitrary run splits. pdf.js breaks a
       printed line into items wherever it likes — often mid-word ("…6:01:44 P" +
       "M Eastern…") — so retyping the raw item leaves the tail of the line
       behind. Absorb neighbours that sit on the SAME baseline in the SAME font
       and are only a word-space away; a column gap is far wider than that, so
       table cells still stay isolated (which is the whole point of using the
       run box rather than the text-layer span). */
    const anchor = best
    /* WHICH WAY IS THE LINE?
       Every test below was written for an upright page, where a line runs along
       x and its neighbours share a baseline in y. On a 90/270 page the run
       advances down the page instead: `rect` is already built for that (w is the
       glyph height, h is the run's length) but the merge was still grouping by
       `baseline` (t[5], which now varies ALONG the line) and growing along x
       (now the cross axis). Both tests therefore matched every run in the
       column, and the "run" became the entire text block: one click on a rotated
       CV took 917 spans and reprinted them as a single 6490pt line, in reverse
       reading order, under a toast saying the look was matched.
       So name the axes once and let the rotation choose them. */
    const along = (r: Rect) => (sideways ? r.y : r.x)
    const alongEnd = (r: Rect) => (sideways ? r.y + r.h : r.x + r.w)
    const alongLen = (r: Rect) => (sideways ? r.h : r.w)
    /** the coordinate that says "same line": a baseline upright, a column sideways */
    const across = (p: Piece) => (sideways ? p.rect.x : p.baseline)
    /** the glyph's own height, whichever axis it is on */
    const glyphH = (r: Rect) => (sideways ? r.w : r.h)

    // ~0.35em — wide enough for a word space (~0.25em) and for a mid-word split
    // (no gap at all), tight enough that a label/value or column gap does not
    // qualify, so table cells stay isolated.
    const wordGap = Math.max(1.5, glyphH(anchor.rect) * 0.3)

    /* Same line, same font — and the SAME COLOUR.
       A run is only "the rest of this line" if it looks like the rest of this
       line. Body copy and a hyperlink inside it are usually set in one face at
       one size, differing in colour alone, so matching on font and baseline
       swallows the link into the sentence around it. The retype then samples one
       ink colour for the lot, the majority wins, and a green link comes back the
       blue of the text beside it — with its underline, which is a rule and never
       moved, still sitting there in green underneath. Nothing about that reads
       as anything but a botched edit. */
    let sampler: HTMLCanvasElement | null = null
    try { sampler = await getSamplingCanvas(ref) } catch { /* colour check is best-effort */ }
    const colourCache = new Map<Piece, string>()
    const colourOf = (p: Piece): string | null => {
      if (!sampler) return null
      let c = colourCache.get(p)
      if (c === undefined) {
        c = sampleInkColor(sampler, p.rect, vp.width)
        colourCache.set(p, c)
      }
      return c
    }
    const rgb = (hex: string): [number, number, number] => [
      parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16),
    ]
    const anchorColour = colourOf(anchor)
    const sameColour = (p: Piece): boolean => {
      const c = colourOf(p)
      if (!c || !anchorColour) return true // couldn't tell — don't block the merge
      const a = rgb(anchorColour), b = rgb(c)
      return Math.max(Math.abs(a[0]-b[0]), Math.abs(a[1]-b[1]), Math.abs(a[2]-b[2])) <= 48
    }

    const group: Piece[] = [anchor]
    // Runs drawn on top of runs we already have. A PDF with no bold face in it
    // fakes weight by drawing the same text two to four times a hair apart, and
    // pdf.js reports the FACE, which is regular — so a retype took weight from
    // the face alone, removed every draw, and put back one regular-weight copy.
    // The header came back visibly lighter than the ones around it. Overprinting
    // is not a curiosity to skip past; it is the document telling us the run is
    // bold.
    let overdrawn = 0
    for (let grew = true; grew;) {
      grew = false
      const minX = Math.min(...group.map((g) => along(g.rect)))
      const maxX = Math.max(...group.map((g) => alongEnd(g.rect)))
      for (const p of pieces) {
        if (group.includes(p)) continue
        if (p.fontName !== anchor.fontName) continue
        if (Math.abs(across(p) - across(anchor)) > Math.max(1, glyphH(anchor.rect) * 0.3)) continue
        // Some PDFs fake bold by drawing the same run two-to-four times a hair
        // apart. Those are overprints of text we already have, not neighbours —
        // taking them would repeat the words ("Attachments:Attachments:…").
        const dup = group.some((g) => {
          const ov = Math.min(alongEnd(p.rect), alongEnd(g.rect)) - Math.max(along(p.rect), along(g.rect))
          return ov > 0.5 * Math.min(alongLen(p.rect), alongLen(g.rect))
        })
        if (dup) { overdrawn++; continue }
        if (!sameColour(p)) continue
        const touchesRight = along(p.rect) - maxX <= wordGap && alongEnd(p.rect) > maxX
        const touchesLeft = minX - alongEnd(p.rect) <= wordGap && along(p.rect) < minX
        if (touchesRight || touchesLeft) { group.push(p); grew = true }
      }
    }
    group.sort((a, b) => along(a.rect) - along(b.rect))
    const gx = Math.min(...group.map((g) => g.rect.x))
    const gy = Math.min(...group.map((g) => g.rect.y))
    const gr = Math.max(...group.map((g) => g.rect.x + g.rect.w))
    const gb = Math.max(...group.map((g) => g.rect.y + g.rect.h))
    best = { ...anchor, rect: { x: gx, y: gy, w: gr - gx, h: gb - gy } }
    // Join in reading order, restoring the space the layout implies: pdf.js drops
    // the separator when it splits a line, so butt-joining would read
    // "Attachments:Email…". A visible gap between two pieces means a space.
    // How wide a gap has to be before it means a SPACE rather than a kerning
    // artefact — measured against the GROUP, not the anchor.
    //
    // Keying it to the clicked piece made the answer depend on where you
    // pointed: pieces of one line differ in box height (one with no ascender or
    // descender is shorter), so the same gap cleared the bar from one anchor and
    // not from another, and the same line came back "3:08:00 PM" or "3:08:00PM"
    // depending on which end of it you aimed at. The file says the space is
    // there. A line has one type size, so take the median across the pieces and
    // the reading stops moving.
    const heights = group.map((g) => glyphH(g.rect)).sort((a, b) => a - b)
    const spaceGap = (heights[heights.length >> 1] ?? glyphH(anchor.rect)) * 0.12
    const groupText = group
      .map((g, i) => {
        const str = String((g.item as { str?: string }).str ?? '')
        if (i === 0) return str
        const prev = group[i - 1]
        const gap = along(g.rect) - alongEnd(prev.rect)
        const needsSpace = gap > spaceGap && !/\s$/.test(String((prev.item as { str?: string }).str ?? '')) && !/^\s/.test(str)
        return (needsSpace ? ' ' : '') + str
      })
      .join('')

    const item = anchor.item as { fontName?: string; transform: number[]; str?: string }
    const fontName = item.fontName
    if (!fontName) return null
    let font: Record<string, unknown> | null = null
    try {
      font = page.commonObjs.get(fontName) as Record<string, unknown>
    } catch {
      return null
    }
    if (!font) return null

    const realName = String(font.name ?? fontName)
    const size = Math.hypot(item.transform[2], item.transform[3]) || Math.hypot(item.transform[0], item.transform[1])
    const bold = Boolean(font.bold) || Boolean(font.black) || /bold|black|heavy|semibold|demi/i.test(realName)
    const italic = Boolean(font.italic) || /italic|oblique/i.test(realName)
    const data = font.data instanceof Uint8Array && !font.missingFile ? (font.data as Uint8Array) : undefined
    return {
      fontId: mapFont(realName),
      bold,
      italic,
      size: Math.max(4, Math.round(size * 10) / 10),
      name: realName,
      rect: best.rect,
      baseline: best.baseline,
      text: groupText,
      stdFont: data ? undefined : standardFontOf(realName, bold, italic),
      loadedName: data ? fontName : undefined,
      spaceEm: spaceAdvanceEm(font),
      overdrawn: overdrawn > 0,
      data,
      mimetype: typeof font.mimetype === 'string' ? font.mimetype : undefined,
    }
  } catch {
    return null
  }
}
