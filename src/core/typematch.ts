import { FONT_STACKS, FONT_IDS } from './types'
import type { FontId, Rect } from './types'

/* ----- type metric matching --------------------------------------------------
   "Same size" is a lie: two fonts at 24pt have different real letter heights,
   because point size measures the em box, not the ink. To make a replacement
   look like the original we match the thing the eye actually reads — the
   cap-height in pixels — not the nominal point size. This module measures the
   printed text's cap-height straight off the page and finds the font size that
   reproduces it, plus the letter-spacing that reproduces its width. */

let probe: CanvasRenderingContext2D | null = null
const probeCtx = (): CanvasRenderingContext2D => {
  if (!probe) probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
  return probe
}

interface FontMetric {
  capPerEm: number // cap-height / font-size
  xPerEm: number // x-height / font-size
}
const metricCache = new Map<string, FontMetric>()

/** Cap-height and x-height of a palette face, per em, measured from real pixels. */
export function fontMetric(font: FontId, bold: boolean): FontMetric {
  const key = `${font}-${bold ? 1 : 0}`
  let m = metricCache.get(key)
  if (m) return m
  const size = 100
  const c = probeCtx()
  const measure = (glyphs: string): number => {
    const cv = c.canvas
    cv.width = 260
    cv.height = 200
    c.clearRect(0, 0, cv.width, cv.height)
    c.font = `${bold ? '700' : '400'} ${size}px ${FONT_STACKS[font]}`
    c.fillStyle = '#000'
    c.textBaseline = 'alphabetic'
    const base = 150
    c.fillText(glyphs, 4, base)
    const d = c.getImageData(0, 0, cv.width, cv.height).data
    let top = -1
    for (let y = 0; y < cv.height && top < 0; y++)
      for (let x = 0; x < cv.width; x++)
        if (d[(y * cv.width + x) * 4 + 3] > 40) { top = y; break }
    return top < 0 ? 0 : base - top
  }
  m = { capPerEm: measure('HEBTM') / size, xPerEm: measure('xnoae') / size }
  metricCache.set(key, m)
  return m
}

export interface SourceType {
  capHeightPx: number // measured cap-height in view px
  baselineY: number // view y of the baseline
  ascent: number // baseline - top of ink
  descent: number // bottom of ink - baseline
}

/**
 * Measure the printed line's cap-height and baseline from its pixels via a
 * horizontal ink-row projection. Robust to a few descenders/accents.
 */
export function measureSourceType(canvas: HTMLCanvasElement, band: Rect, pageW: number): SourceType | null {
  try {
    const k = canvas.width / pageW
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    const padY = Math.round(band.h * 0.6)
    const x = Math.max(0, Math.round(band.x * k))
    const y = Math.max(0, Math.round((band.y - padY) * k))
    const w = Math.min(canvas.width - x, Math.round(band.w * k))
    const h = Math.min(canvas.height - y, Math.round((band.h + 2 * padY) * k))
    if (w < 4 || h < 4) return null
    const d = ctx.getImageData(x, y, w, h).data
    // per-row ink count against the row's own median tone
    const lum = new Float32Array(w * h)
    for (let i = 0; i < w * h; i++) lum[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]
    // paper tone = median of the border rows
    const border: number[] = []
    for (let xx = 0; xx < w; xx++) { border.push(lum[xx]); border.push(lum[(h - 1) * w + xx]) }
    border.sort((a, b) => a - b)
    const paper = border[border.length >> 1]
    const rows = new Float32Array(h)
    for (let yy = 0; yy < h; yy++) {
      let n = 0
      for (let xx = 0; xx < w; xx++) if (Math.abs(lum[yy * w + xx] - paper) > 26) n++
      // full-width rule rows (underlines, borders) are not glyph rows — zero them
      // so they can't hijack the baseline
      rows[yy] = n >= w * 0.82 ? 0 : n
    }
    let maxR = 0
    for (let yy = 0; yy < h; yy++) maxR = Math.max(maxR, rows[yy])
    if (maxR < 2) return null
    // smooth so single-row noise doesn't win the gradient search
    const sm = new Float32Array(h)
    for (let yy = 0; yy < h; yy++) {
      let a = 0, c = 0
      for (let dd = -1; dd <= 1; dd++) { const y2 = yy + dd; if (y2 >= 0 && y2 < h) { a += rows[y2]; c++ } }
      sm[yy] = a / c
    }
    // cap/ascender line = steepest sparse→dense transition in the upper band
    // (ignores accents sitting above a gap); baseline = steepest dense→sparse
    // transition in the lower band (ignores descenders below it)
    let capline = -1, bestRise = -0.5
    for (let yy = 1; yy < Math.floor(h * 0.62); yy++) {
      const rise = sm[yy] - sm[yy - 1]
      if (rise > bestRise) { bestRise = rise; capline = yy }
    }
    let baseline = -1, bestDrop = -0.5
    for (let yy = Math.floor(h * 0.38); yy < h - 1; yy++) {
      const drop = sm[yy] - sm[yy + 1]
      if (drop > bestDrop) { bestDrop = drop; baseline = yy }
    }
    let bottom = -1
    for (let yy = h - 1; yy >= 0; yy--) if (rows[yy] >= maxR * 0.15) { bottom = yy; break }
    if (capline < 0 || baseline < 0 || baseline <= capline) return null
    // Cap height is cap line to baseline, so it CANNOT exceed the height of the
    // ink band it was measured inside. The search window is padded by 0.6h on
    // each side to catch ascenders and descenders, which is right for type and
    // wrong for everything else: on a banner, a logo or a photograph the
    // gradient search locks onto the artwork's own edges and reports a cap
    // height several times the band's. Unclamped, a 39pt band on a dark banner
    // yielded a 98pt "cap height" and a 140.7pt reprint of small white type.
    // Clamping to the band cannot hurt a real line — its cap is ~0.7 of the ink
    // height — and it makes an impossible answer impossible.
    const cap = Math.min((baseline - capline) / k, band.h)
    return {
      capHeightPx: cap,
      baselineY: y / k + baseline / k,
      ascent: cap,
      descent: Math.max(0, (bottom - baseline)) / k,
    }
  } catch {
    return null
  }
}

/** The font size whose cap-height reproduces the measured source cap-height. */
export function sizeForCapHeight(capHeightPx: number, font: FontId, bold: boolean): number {
  const m = fontMetric(font, bold)
  const cap = m.capPerEm || 0.7
  return Math.max(4, Math.min(200, Math.round((capHeightPx / cap) * 10) / 10))
}

/**
 * Letter-spacing (px) that makes `text` in the given face fill `targetWidthPx`.
 * Positive = looser, negative = tighter. Clamped so glyphs never collide.
 */
export function trackingForWidth(
  text: string,
  font: FontId,
  size: number,
  bold: boolean,
  targetWidthPx: number,
  /**
   * The document's own face, when the reprint is being set in it.
   *
   * The correction still has to be measured, even then. "Same face, same size,
   * same words, therefore the same width" assumes the page was set with no
   * letter-spacing of its own — and designed type very often is not. A name
   * across the top of a CV is usually tracked in tight, and a reprint at the
   * face's natural spacing comes out several points long: the letterforms match
   * perfectly and the line still looks wrong, which is the most maddening kind
   * of wrong. What must not happen is measuring against the palette twin and
   * applying the result to the real face — a fit computed for a font that isn't
   * the one being drawn.
   */
  face?: string,
): number {
  const c = probeCtx()
  // `face` may be one family (a pdf.js embedded name) or a whole CSS stack (the
  // base-14 mapping). Quoting a stack would make it a single, nonexistent family
  // name and silently measure in the fallback — which is the very mistake this
  // correction exists to avoid.
  const faceCss = face ? (/[,'"]/.test(face) ? face : `"${face}"`) : null
  c.font = `${bold ? '700' : '400'} ${size}px ${faceCss ? `${faceCss}, ${FONT_STACKS[font]}` : FONT_STACKS[font]}`
  // sum PER-CHARACTER advances (no kerning) so the width matches the exporter,
  // which advances glyph-by-glyph when tracking is applied
  let natural = 0
  for (const ch of text) natural += c.measureText(ch).width
  const gaps = Math.max(1, [...text].length - 1)
  // A very short run has nowhere to put the correction. "ff" has ONE gap, so the
  // entire width difference — measurement noise, a ligature the face cannot set,
  // a side bearing — lands between the two letters and visibly splits them: the
  // ligature run inside "different" came back with 1.99pt driven into its single
  // gap. Across a sentence the same total is invisible. Below four characters
  // the correction cannot be distributed, so it is not worth making.
  if ([...text].length < 4) return 0
  const track = (targetWidthPx - natural) / gaps
  // Cap the stretch at a typographic amount. Letting it run to 0.4em to force a
  // width match turns the words into s p a c e d   o u t letters, which reads far
  // worse than simply being a little narrower than the print — the substitute
  // face is chosen for its metrics (see bestWidthFont), so this only has to
  // absorb the remainder.
  const cap = face ? 0.3 : 0.12
  const capHi = face ? 0.3 : 0.15
  return Math.max(-size * cap, Math.min(size * capHi, Math.round(track * 100) / 100))
}

/**
 * Pick the palette face whose natural width best reproduces the printed run.
 *
 * With no text layer there is no font name to map — the face comes from the
 * vision model's guess, and a guess of "sans" for a wide geometric display face
 * lands ~35% short. Letter-spacing then has to stretch the words to fill the
 * line, which is what turns a heading into s p a c e d   o u t letters. The
 * printed width is a measurement we actually have, so use it: at the size the
 * cap-height already fixed, the face needing the least stretch is the closest
 * metric match, and the tracking left over is small enough to be invisible.
 */
export function bestWidthFont(
  text: string,
  size: number,
  bold: boolean,
  targetWidthPx: number,
  fallback: FontId,
): FontId {
  if (!text.trim() || !(targetWidthPx > 0)) return fallback
  const c = probeCtx()
  let best: FontId = fallback
  let bestErr = Infinity
  for (const id of FONT_IDS) {
    c.font = `${bold ? '700' : '400'} ${size}px ${FONT_STACKS[id]}`
    let natural = 0
    for (const ch of text) natural += c.measureText(ch).width
    if (!(natural > 0)) continue
    const err = Math.abs(natural - targetWidthPx) / targetWidthPx
    if (err < bestErr) { bestErr = err; best = id }
  }
  return best
}

/* ----- identifying the face a picture of words was set in -------------------

   For type baked into an image there is no font to ask about, only pixels. The
   app's answer so far has been to clone: lift the glyphs off the page and paste
   them back. That is exact, and it is exact only for letters that were already
   there — change "Summer" to "Winter" and there is no W to lift, so the line
   falls back to a stand-in face and the edit announces itself.

   The way out is to work out WHICH face it was, and then simply set the words
   in it. And that is a question pixels can answer, because we know what the
   words say: render them in each candidate and see which one lands on top of
   what is already there. Nothing has to be recognised or guessed — it is a
   comparison, and it either matches or it doesn't.

   Cloning stays for the cases where nothing matches well. */

export interface FaceGuess {
  font: FontId
  /** the numeric weight that matched (400/500/600/700) */
  weight?: number
  /** set when the winner is a match-only face rather than a palette one */
  matchFace?: string
  bold: boolean
  size: number
  tracking: number
  baselineY: number
  x: number
  /** share of the two inked areas that coincide, 0..1 */
  score: number
  /**
   * How far the winner stands clear of the field (best / median).
   *
   * The absolute score cannot be compared across cases: overlap is harsher on
   * small type, where a stroke is a couple of pixels wide and being one pixel
   * out costs half of it, so a 12pt subtitle matched as well as a 22pt headline
   * still scores lower. A fixed bar therefore rejects good matches on small text
   * and would accept poor ones on large. Whether the best candidate beats the
   * rest of the field is a question that means the same thing at any size.
   */
  margin: number
}

function maskOf(data: Uint8ClampedArray, n: number, bg: [number, number, number]): Uint8Array {
  const m = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const o = i * 4
    if (Math.max(Math.abs(data[o] - bg[0]), Math.abs(data[o + 1] - bg[1]), Math.abs(data[o + 2] - bg[2])) > 40) m[i] = 1
  }
  return m
}

/**
 * Faces carried purely to be recognised, not to be chosen from a menu.
 *
 * The palette is nine families picked to span the common shapes of type. That is
 * the right size for a picker and far too small a net for identification: the
 * banner in the test corpus matched its nearest palette face at 0.45, which is
 * the score of "roughly the same sort of font", and setting a headline in
 * roughly the same sort of font is exactly the tell we are trying to remove.
 * These are the families that actually turn up in templates and decks.
 */
export const MATCH_FACES: { css: string; file: string }[] = [
  { css: 'Montserrat', file: 'montserrat' },
  { css: 'Raleway', file: 'raleway' },
  { css: 'Work Sans', file: 'worksans' },
  { css: 'DM Sans', file: 'dmsans' },
  { css: 'Inter', file: 'inter' },
  { css: 'Manrope', file: 'manrope' },
  { css: 'Rubik', file: 'rubik' },
  { css: 'Figtree', file: 'figtree' },
  { css: 'Outfit', file: 'outfit' },
  { css: 'Plus Jakarta Sans', file: 'plusjakartasans' },
  { css: 'Quicksand', file: 'quicksand' },
  { css: 'Urbanist', file: 'urbanist' },
]

/** Ink extent of a mask: the box the marks actually occupy. */
function extent(m: Uint8Array, w: number, h: number): { x0: number; y0: number; x1: number; y1: number; n: number } | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1, n = 0
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!m[y * w + x]) continue
      n++
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  return x1 < 0 ? null : { x0, y0, x1, y1, n }
}

/**
 * Make sure every candidate face is actually loaded before anything is compared.
 *
 * Declaring @font-face is not loading: a face nothing has drawn with yet stays
 * unfetched, and canvas silently substitutes the default for it. The comparison
 * then runs a dozen "different" candidates that are all the same fallback, and
 * they come back scoring identically to three decimals — which is what happened,
 * and is the only reason it was noticed at all. `document.fonts.ready` does not
 * help; it waits for fonts in USE, and these are used by nothing on the page.
 */
export async function ensureMatchFaces(): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) return
  const wanted: string[] = []
  for (const m of MATCH_FACES) for (const w of [400, 500, 600, 700]) wanted.push(`${w} 20px "${m.css}"`)
  for (const f of FONT_IDS) for (const w of [400, 500, 600, 700]) wanted.push(`${w} 20px ${FONT_STACKS[f]}`)
  await Promise.all(wanted.map((w) => document.fonts.load(w).catch(() => undefined)))
}

export function identifyFace(
  canvas: HTMLCanvasElement,
  band: Rect,
  text: string,
  pageW: number,
  hintSize: number,
  inkHex?: string,
): FaceGuess | null {
  try {
    if (!text.trim()) return null
    const k = canvas.width / pageW
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null

    const padY = Math.max(4, Math.round(band.h * 0.8 * k))
    const padX = Math.max(4, Math.round(band.h * 0.6 * k))
    const X = Math.max(0, Math.round(band.x * k) - padX)
    const Y = Math.max(0, Math.round(band.y * k) - padY)
    const W = Math.min(canvas.width - X, Math.round(band.w * k) + padX * 2)
    const H = Math.min(canvas.height - Y, Math.round(band.h * k) + padY * 2)
    if (W < 10 || H < 10) return null
    const src = ctx.getImageData(X, Y, W, H)

    const bs: number[][] = [[], [], []]
    for (let xx = 0; xx < W; xx++)
      for (const yy of [0, H - 1]) {
        const o = (yy * W + xx) * 4
        bs[0].push(src.data[o]); bs[1].push(src.data[o + 1]); bs[2].push(src.data[o + 2])
      }
    const mid = (a: number[]) => a.sort((p, q) => p - q)[a.length >> 1]
    const bg: [number, number, number] = [mid(bs[0]), mid(bs[1]), mid(bs[2])]

    // The target is the LETTERS, nothing else. Masking by "unlike the
    // background" is right on paper and wrong on the artwork this exists for: a
    // banner strewn with pale specks puts every one of them in, and no rendering
    // of any typeface covers confetti. The score then saturates for every
    // candidate alike and the ranking becomes noise.
    const ink = inkHex && /^#[0-9a-f]{6}$/i.test(inkHex)
      ? [parseInt(inkHex.slice(1, 3), 16), parseInt(inkHex.slice(3, 5), 16), parseInt(inkHex.slice(5, 7), 16)]
      : null
    // COVERAGE, not a yes/no mask.
    //
    // These words live inside a raster image, so rendering the page larger does
    // not sharpen them — it interpolates, and the letters arrive soft-edged
    // however much resolution is thrown at them. A freshly rendered candidate is
    // crisp. Comparing the two as binary masks therefore caps the score around
    // one half for EVERY face, correct or not, because the disagreement being
    // measured is mostly blur rather than shape.
    //
    // So measure how inky each pixel is, on a scale, by projecting its colour on
    // to the line running from the surface to the ink. A half-covered edge pixel
    // then counts as a half, on both sides, and the comparison is about letter
    // shapes again.
    const F = ink ?? [255 - bg[0], 255 - bg[1], 255 - bg[2]]
    const dF = [F[0] - bg[0], F[1] - bg[1], F[2] - bg[2]]
    const denom = dF[0] * dF[0] + dF[1] * dF[1] + dF[2] * dF[2] || 1
    const cover = new Float32Array(W * H)
    for (let i = 0; i < W * H; i++) {
      const o = i * 4
      const a = ((src.data[o] - bg[0]) * dF[0] + (src.data[o + 1] - bg[1]) * dF[1] + (src.data[o + 2] - bg[2]) * dF[2]) / denom
      cover[i] = a < 0.12 ? 0 : a > 1 ? 1 : a
    }
    // The room around the band exists so the CANDIDATE can be slid, not so that
    // whatever else is nearby joins the comparison. On the banner it reached a
    // line and a half down and took in the subtitle, so every face was scored on
    // how well one line of text covers two — which none of them does, and the
    // ranking stopped meaning anything. Keep the slack for the candidate;
    // confine the target to its own band.
    const bandTop = padY
    const bandBot = padY + Math.round(band.h * k)
    for (let y = 0; y < H; y++) {
      if (y >= bandTop && y <= bandBot) continue
      for (let x = 0; x < W; x++) cover[y * W + x] = 0
    }
    const target = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++) if (cover[i] > 0.5) target[i] = 1

    // Drop specks before measuring how big the type is.
    //
    // The extent of the inked area is what size is solved from, so a single
    // stray dot above the caps or below the baseline stretches it and every
    // candidate is then rendered too large — 13.8pt for type that is 12. On a
    // banner sown with particles there are always a few inside the band, and the
    // ink-colour filter does not remove the ones that happen to be near the
    // letters in colour. A letter is a connected mass of pixels; a speck is not.
    const minBlob = Math.max(4, Math.round((band.h * k) * (band.h * k) * 0.015))
    {
      const seen = new Uint8Array(W * H)
      const stack: number[] = []
      for (let i0 = 0; i0 < W * H; i0++) {
        if (!target[i0] || seen[i0]) continue
        stack.length = 0
        stack.push(i0)
        seen[i0] = 1
        const blob: number[] = []
        while (stack.length) {
          const i = stack.pop()!
          blob.push(i)
          const x = i % W, y = (i / W) | 0
          if (x > 0 && target[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1) }
          if (x < W - 1 && target[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1) }
          if (y > 0 && target[i - W] && !seen[i - W]) { seen[i - W] = 1; stack.push(i - W) }
          if (y < H - 1 && target[i + W] && !seen[i + W]) { seen[i + W] = 1; stack.push(i + W) }
        }
        if (blob.length < minBlob) for (const i of blob) { target[i] = 0; cover[i] = 0 }
      }
    }
    const tE = extent(target, W, H)
    if (!tE || tE.n < 30) return null
    let tSum = 0
    for (let i = 0; i < W * H; i++) tSum += cover[i]

    const off = document.createElement('canvas')
    off.width = W
    off.height = H
    const octx = off.getContext('2d', { willReadFrequently: true })
    if (!octx) return null

    const faces: { id: FontId | null; css: string; label: string }[] = [
      ...FONT_IDS.map((f) => ({ id: f as FontId | null, css: FONT_STACKS[f], label: f as string })),
      ...MATCH_FACES.map((m) => ({ id: null, css: `"${m.css}", sans-serif`, label: m.file })),
    ]

    /** Draw the words at a size and spacing, and return the mask + its extent. */
    const draw = (css: string, weight: number, sizePx: number, trackPx: number) => {
      octx.fillStyle = '#fff'
      octx.fillRect(0, 0, W, H)
      octx.fillStyle = '#000'
      octx.textBaseline = 'alphabetic'
      octx.font = `${weight} ${sizePx}px ${css}`
      let cx = padX
      const ay = padY + Math.round(band.h * k * 0.82)
      for (const ch of text) {
        octx.fillText(ch, cx, ay)
        cx += octx.measureText(ch).width + trackPx
      }
      const d = octx.getImageData(0, 0, W, H).data
      const m = new Uint8Array(W * H)
      const cv = new Float32Array(W * H)
      for (let i = 0; i < W * H; i++) {
        cv[i] = 1 - d[i * 4] / 255
        if (cv[i] > 0.5) m[i] = 1
      }
      return { mask: m, cover: cv, ext: extent(m, W, H), ay }
    }

    let best: FaceGuess | null = null
    let bestCover: Float32Array | null = null
    const rank = new Map<string, number>()

    for (const face of faces) {
      // Display type is very often Medium or SemiBold. Offering only regular and
      // bold forces the comparison to pick one that is plainly too light or too
      // heavy, which caps how well the RIGHT face can score and lets the ranking
      // between faces turn on noise instead of shape.
      for (const weight of [400, 500, 600, 700]) {
        const bold = weight >= 600
        // Size is not searched — it is solved. Render once, compare the height of
        // the ink to the height of the target's ink, and scale by the ratio. One
        // step of Newton, and it lands within a per cent.
        const probe = draw(face.css, weight, hintSize * k, 0)
        if (!probe.ext) continue
        const tH = tE.y1 - tE.y0 + 1
        const pH = probe.ext.y1 - probe.ext.y0 + 1
        if (pH < 2) continue
        const sizePx = Math.max(4, (hintSize * k) * (tH / pH))

        // and spacing likewise: the width it must span is known, so the tracking
        // that spans it is arithmetic. Capped, or a wrong face is simply stretched
        // until it fits and scores as though it belonged.
        octx.font = `${weight} ${sizePx}px ${face.css}`
        let natural = 0
        for (const ch of text) natural += octx.measureText(ch).width
        const gaps = Math.max(1, [...text].length - 1)
        const trackPx = ((tE.x1 - tE.x0 + 1) - natural) / gaps
        if (Math.abs(trackPx) > sizePx * 0.3) continue

        const cand = draw(face.css, weight, sizePx, trackPx)
        if (!cand.ext || cand.ext.n < 30) continue

        // ALIGNMENT IS NOT SEARCHED EITHER.
        //
        // Sliding one image over another to find the best fit costs the square of
        // the offsets tried, and the offsets that must be tried grow with
        // resolution — so the brute force that was affordable at 1.5x simply
        // never returns at 5x, which is the resolution where faces actually
        // become distinguishable. But both images are a line of text: put their
        // ink boxes on top of each other and they are already aligned to within a
        // pixel or two. Only that pixel or two is worth searching.
        const dx0 = tE.x0 - cand.ext.x0
        const dy0 = tE.y0 - cand.ext.y0

        for (let dy = dy0 - 2; dy <= dy0 + 2; dy++) {
          for (let dx = dx0 - 2; dx <= dx0 + 2; dx++) {
            // Compare the shapes at their HALF-COVERAGE outline, not by how much
            // ink each lays down.
            //
            // The target is a photograph of type and its edges are soft; a fresh
            // rendering's are not. Scored by coverage, the extra grey skirt around
            // every blurred stroke is mass the candidate can only match by being
            // heavier — so the ranking rewards weight over shape, and a humanist
            // face at bold beat the geometric ones the banner is visibly set in.
            // A blurred edge crosses half coverage at the position of the true
            // edge, so thresholding both there compares outlines and is
            // indifferent to how soft either one is.
            let inter = 0, cN = 0
            for (let yy = 0; yy < H; yy++) {
              const ty = yy + dy
              if (ty < 0 || ty >= H) continue
              const rc = yy * W, rt = ty * W
              for (let xx = 0; xx < W; xx++) {
                if (!cand.mask[rc + xx]) continue
                cN++
                const tx = xx + dx
                if (tx >= 0 && tx < W) inter += target[rt + tx]
              }
            }
            // Prefer the fit that needs least forcing: a face can be made to
            // cover a line by shrinking it and spacing the letters out, and the
            // overlap barely notices — but the moment anyone types a different
            // word into it, the spacing gives it away.
            const strain = Math.min(0.4, (Math.abs(trackPx) / sizePx) * 1.6)
            // Charge for laying down the wrong AMOUNT of ink, which is weight.
            //
            // Overlap alone is too forgiving about it: a face a couple of steps
            // too heavy still covers everything the right one would, and loses
            // only the surplus in the union. The result reads as the correct
            // shapes set too bold — which is precisely the kind of thing a reader
            // notices without being able to say why. Comparing the inked areas
            // says it directly, and symmetrically, so too light is charged the
            // same as too heavy.
            const areaRatio = cN > 0 ? cN / tE.n : 1
            const weightOff = Math.min(0.4, Math.abs(Math.log(areaRatio)) * 2.2)
            const score = (inter / (tE.n + cN - inter)) * (1 - strain) * (1 - weightOff)
            const key = `${face.label}-${weight}`
            if (score > (rank.get(key) ?? 0)) rank.set(key, score)
            if (!best || score > best.score) {
              bestCover = cand.cover
              best = {
                font: face.id ?? 'sans',
                matchFace: face.id ? undefined : face.label,
                bold,
                weight,
                size: sizePx / k,
                tracking: trackPx / k,
                baselineY: (Y + cand.ay + dy) / k,
                x: (X + padX + dx) / k,
                score,
                margin: 1,
              }
            }
          }
        }
      }
    }
    if (best && rank.size >= 4) {
      const vals = [...rank.values()].sort((a, b) => a - b)
      const median = vals[vals.length >> 1] || 0.0001
      best.margin = best.score / median
    }
    if (typeof window !== 'undefined') {
      // dump what is actually being compared, for eyeballing
      const dbg = document.createElement('canvas')
      dbg.width = W; dbg.height = H * 2 + 4
      const dc = dbg.getContext('2d')!
      const im = dc.createImageData(W, H)
      for (let i = 0; i < W * H; i++) {
        const v = 255 - Math.round(cover[i] * 255)
        im.data[i*4] = v; im.data[i*4+1] = v; im.data[i*4+2] = v; im.data[i*4+3] = 255
      }
      dc.putImageData(im, 0, 0)
      if (bestCover) {
        const im2 = dc.createImageData(W, H)
        for (let i = 0; i < W * H; i++) {
          const v = 255 - Math.round(bestCover[i] * 255)
          im2.data[i*4] = v; im2.data[i*4+1] = v; im2.data[i*4+2] = v; im2.data[i*4+3] = 255
        }
        dc.putImageData(im2, 0, H + 4)
      }
      ;(window as unknown as { __dbgImg?: string }).__dbgImg = dbg.toDataURL('image/png')
      ;(window as unknown as { __rank?: unknown }).__rank =
        [...rank.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n, v]) => [n, +v.toFixed(3)])
    }
    return best
  } catch {
    return null
  }
}

/**
 * The baseline of a line of type, measured from the pixels and owing nothing to
 * any typeface.
 *
 * Letters sit ON the baseline. Nearly all of them stop there — only descenders
 * carry on below, and there are always far fewer of those. So take each mark in
 * the line, note where it ends, and use the middle of those endings: the g's and
 * y's are outvoted, and the answer is the line the type was set on.
 *
 * Deriving it from a matched face instead makes it hostage to the match, because
 * a fit lands by aligning ink boxes and the top of an ink box is the cap line —
 * so any error in the face's cap height moves the baseline by that much. That
 * showed up as the two failing the other's test: one face seated the line
 * correctly but set it too heavy, another had the weight right and sat a point
 * low. Weight is a property of the face and has to be identified; where the line
 * sits is not, and should not be made to depend on it.
 */
export function baselineFromInk(
  canvas: HTMLCanvasElement,
  band: Rect,
  pageW: number,
  inkHex?: string,
): number | null {
  try {
    const k = canvas.width / pageW
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    const X = Math.max(0, Math.round(band.x * k))
    const Y = Math.max(0, Math.round(band.y * k))
    const W = Math.min(canvas.width - X, Math.round(band.w * k))
    const H = Math.min(canvas.height - Y, Math.round(band.h * k))
    if (W < 4 || H < 4) return null
    const d = ctx.getImageData(X, Y, W, H).data

    const ink = inkHex && /^#[0-9a-f]{6}$/i.test(inkHex)
      ? [parseInt(inkHex.slice(1, 3), 16), parseInt(inkHex.slice(3, 5), 16), parseInt(inkHex.slice(5, 7), 16)]
      : null
    const m = new Uint8Array(W * H)
    if (ink) {
      for (let i = 0; i < W * H; i++) {
        const o = i * 4
        if (Math.max(Math.abs(d[o] - ink[0]), Math.abs(d[o + 1] - ink[1]), Math.abs(d[o + 2] - ink[2])) <= 70) m[i] = 1
      }
    } else {
      const lums: number[] = []
      for (let i = 0; i < W * H; i++) lums.push(0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2])
      const sorted = [...lums].sort((a, b) => a - b)
      const paper = sorted[Math.floor(sorted.length * 0.75)]
      for (let i = 0; i < W * H; i++) if (Math.abs(lums[i] - paper) > 45) m[i] = 1
    }

    // each connected mark, and where it ends
    const seen = new Uint8Array(W * H)
    const bottoms: number[] = []
    const stack: number[] = []
    const minBlob = Math.max(3, Math.round(H * H * 0.02))
    for (let i0 = 0; i0 < W * H; i0++) {
      if (!m[i0] || seen[i0]) continue
      stack.length = 0
      stack.push(i0)
      seen[i0] = 1
      let n = 0, bot = -1
      while (stack.length) {
        const i = stack.pop()!
        n++
        const x = i % W, y = (i / W) | 0
        if (y > bot) bot = y
        if (x > 0 && m[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1) }
        if (x < W - 1 && m[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1) }
        if (y > 0 && m[i - W] && !seen[i - W]) { seen[i - W] = 1; stack.push(i - W) }
        if (y < H - 1 && m[i + W] && !seen[i + W]) { seen[i + W] = 1; stack.push(i + W) }
      }
      if (n >= minBlob) bottoms.push(bot)
    }
    if (bottoms.length < 3) return null
    bottoms.sort((a, b) => a - b)
    // the middle ending: descenders sit past it, and are outnumbered
    const med = bottoms[bottoms.length >> 1]
    return (Y + med + 1) / k
  } catch {
    return null
  }
}
