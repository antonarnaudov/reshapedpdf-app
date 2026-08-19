import { FONT_STACKS } from './types'
import type { FontId, Rect } from './types'

/* ----- glyph cloning ---------------------------------------------------------
   The one way to make an edited word look EXACTLY like the original is to reuse
   the document's own letterforms.

   Two operations:
   - snapshotBand: copy a printed line's pixels verbatim (paper made
     transparent). Used when the text is UNCHANGED — trivially pixel-identical.
   - buildAtlas + composeFromAtlas: harvest per-letter bitmaps from one or more
     printed lines (labelled by their transcription) and recompose them into an
     edited string. Letters present come out identical; absent letters fall back
     to a metric-matched palette glyph.

   Everything works on rendered pixels, so it applies to scans and posters too. */

interface Sprite {
  canvas: HTMLCanvasElement
  w: number
  top: number // baseline-relative top (canvas px)
  advance: number // pen advance (canvas px)
}

export interface Atlas {
  glyphs: Map<string, Sprite>
  spaceAdvance: number
  ascent: number
  descent: number
  k: number // canvas px per view px
  inkHex: string
  inset: number // left inset of the source ink from band.x, in VIEW px
}

const measureCtx = (() => {
  let c: CanvasRenderingContext2D | null = null
  return () => (c ??= document.createElement('canvas').getContext('2d')!)
})()

interface BandInfo {
  d: Uint8ClampedArray
  lum: Float32Array
  W: number
  H: number
  paper: number
  thr: number
  col: Int32Array
  baseline: number
  capline: number
  bottom: number
  inkLeft: number
  inkRight: number
  /** the clicked line's own rows inside the padded window — the pad reaches into
   *  the lines above/below, and their ink must never be cropped into a glyph */
  bandTop: number
  bandBot: number
  /** letters-only mask, set when the line sits on a textured panel and the raw
   *  ink profile is useless (see analyzeBand); undefined on plain paper */
  textMask?: Uint8Array
  inkHex: string
}

function analyzeBand(canvas: HTMLCanvasElement, band: Rect, k: number): BandInfo | null {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  const padY = Math.max(2, Math.round(band.h * 0.6))
  const X = Math.max(0, Math.round(band.x * k))
  const Y = Math.max(0, Math.round((band.y - padY) * k))
  const W = Math.min(canvas.width - X, Math.round(band.w * k))
  const H = Math.min(canvas.height - Y, Math.round((band.h + 2 * padY) * k))
  if (W < 6 || H < 6) return null
  const d = ctx.getImageData(X, Y, W, H).data
  const lum = new Float32Array(W * H)
  for (let i = 0; i < W * H; i++) lum[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]
  const border: number[] = []
  for (let x = 0; x < W; x++) { border.push(lum[x]); border.push(lum[(H - 1) * W + x]) }
  border.sort((a, b) => a - b)
  const paper = border[border.length >> 1]
  const thr = 30
  const rawInk = (i: number): boolean => Math.abs(lum[i] - paper) > thr

  // Does the BACKGROUND ink, or only the type? Measure the pad rows above and
  // below the line — the band itself is full of glyphs either way, so counting
  // the whole window just measures how much text is on the line. Between lines
  // plain paper is empty; a textured panel (a starfield, a photo) is not. Only
  // that case can't be read straight off the ink profile.
  const padRowsTop = Math.max(0, Math.min(H, Math.round(padY * k) - 1))
  const padRowsBot = Math.max(padRowsTop, Math.min(H, Math.round((padY + band.h) * k) + 1))
  // Count how many pad ROWS carry ink, not how many pixels do. A texture is thin
  // but continuous — it marks every row it covers, while never inking many
  // pixels in any one of them. A neighbouring line of type is the opposite: it
  // inks a couple of rows heavily and leaves the rest of the gap clean. Pixel
  // share can't separate those; row coverage can.
  let padRows = 0, padInked = 0
  for (let y = 0; y < H; y++) {
    if (y >= padRowsTop && y < padRowsBot) continue
    let n = 0
    for (let x = 0; x < W; x++) if (rawInk(y * W + x)) n++
    padRows++
    if (n > W * 0.02) padInked++
  }
  const onTexture = padRows > 0 && padInked > padRows * 0.7

  // On a textured panel, isolate the letters before measuring anything. Erode
  // the ink so the texture's crumbs vanish, then keep whole ink blobs that still
  // hold an eroded core — strokes keep their full width and soft edge, specks
  // are gone. Every profile below (rows, columns, baseline, glyph segmentation)
  // then describes the type instead of the panel it is printed on.
  let textMask: Uint8Array | undefined
  const lineH = Math.max(4, band.h * k)
  const minLetterTall = Math.max(3, Math.round(lineH * 0.35))
  const minLetterArea = Math.max(8, Math.round(lineH * 1.2))
  if (onTexture) {
    /* One pass of the letter hunt, over whatever counts as ink for it. */
    const findLetters = (gate: (i: number) => boolean, onBaseline: boolean) => {
      const eroded = new Uint8Array(W * H)
      for (let y = 1; y < H - 1; y++)
        for (let x = 1; x < W - 1; x++) {
          const o = y * W + x
          if (!gate(o)) continue
          if (gate(o - 1) && gate(o + 1) && gate(o - W) && gate(o + W) &&
              gate(o - W - 1) && gate(o - W + 1) && gate(o + W - 1) && gate(o + W + 1)) eroded[o] = 1
        }
      const seenC = new Uint8Array(W * H)
      const stackC = new Int32Array(W * H)
      const parts: { px: number[]; x0: number; x1: number; y1: number; tall: boolean; letter: boolean }[] = []
      for (let s0 = 0; s0 < W * H; s0++) {
        if (seenC[s0] || !gate(s0)) continue
        let top = 0, core = false
        let cy0 = (s0 / W) | 0, cy1 = cy0, cx0 = s0 % W, cx1 = cx0
        const comp: number[] = []
        stackC[top++] = s0; seenC[s0] = 1
        while (top > 0) {
          const o = stackC[--top]
          comp.push(o)
          if (eroded[o]) core = true
          const ox = o % W, oy = (o / W) | 0
          if (oy < cy0) cy0 = oy
          if (oy > cy1) cy1 = oy
          if (ox < cx0) cx0 = ox
          if (ox > cx1) cx1 = ox
          const push = (nx: number, ny: number): void => {
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) return
            const ni = ny * W + nx
            if (seenC[ni] || !gate(ni)) return
            seenC[ni] = 1; stackC[top++] = ni
          }
          push(ox - 1, oy); push(ox + 1, oy); push(ox, oy - 1); push(ox, oy + 1)
        }
        // A LETTER BODY is a solid blob that also stands most of the line's
        // height. A dense patch of texture can have an eroded core too, so the
        // core alone isn't enough — without the height test the starfield stays
        // in the mask and the segmentation reads the panel, not the words.
        const letter = core && comp.length >= minLetterArea && cy1 - cy0 + 1 >= minLetterTall
        parts.push({ px: comp, x0: cx0, x1: cx1, y1: cy1, tall: cy1 - cy0 + 1 >= minLetterTall, letter })
      }
      // Letters SIT ON A LINE. Texture does not — a dense patch can be big
      // enough and tall enough to pass for a letter, but it lands wherever it
      // happens to be, while every glyph's foot is on the same baseline
      // (descenders one step below). Take the baseline as the commonest foot
      // among the candidates and drop the ones standing somewhere else.
      //
      // Only worth doing while the ink colour is still unknown. It is a blunt
      // test — it can't tell a descender from a blob of texture, so it throws
      // away the odd real letter (the `g` of this heading went with it). Once
      // colour is doing the separating there is no texture left for it to
      // catch, and all it can do is cost us glyphs.
      const cand = onBaseline ? parts.filter((p) => p.letter) : []
      if (cand.length >= 3) {
        const tol = Math.max(2, Math.round(lineH * 0.12))
        let bestFoot = cand[0].y1, bestVotes = 0
        for (const a of cand) {
          let v = 0
          for (const b of cand) if (Math.abs(b.y1 - a.y1) <= tol) v++
          if (v > bestVotes) { bestVotes = v; bestFoot = a.y1 }
        }
        const lo = bestFoot - tol
        const hi = bestFoot + Math.max(tol, Math.round(lineH * 0.3)) // descenders
        for (const p of parts) if (p.letter && (p.y1 < lo || p.y1 > hi)) p.letter = false
      }
      return parts
    }

    /* Shape alone can only find the letters that stand clear of the texture.
       Where the panel's texture is dense the letters touch it, fuse into one
       blob and get thrown out with it — which is how the tail of this heading
       ("...ding", sitting on the thick of the starfield) went missing and the
       clone came out a fifth short of the print.

       But the letters and the texture are not the same COLOUR: cream type on a
       navy panel scattered with blue stars. Luminance can't tell them apart —
       both are simply "bright" — and that is all the mask was ever looking at.
       So learn the colour instead of assuming it: take the letters shape did
       find, read their ink colour off the page, and hunt again for everything
       wearing it. The letters buried in the texture come back, and the texture
       stays out, however densely it's packed. */
    let parts = findLetters(rawInk, true)
    const solid = parts.filter((p) => p.letter)
    if (solid.length >= 3) {
      const rs: number[] = [], gs: number[] = [], bs: number[] = []
      for (const p of solid) for (const o of p.px) { rs.push(d[o * 4]); gs.push(d[o * 4 + 1]); bs.push(d[o * 4 + 2]) }
      const mid = (a: number[]): number => { a.sort((x, y) => x - y); return a[a.length >> 1] }
      const ir = mid(rs), ig = mid(gs), ib = mid(bs)
      // How far off that colour the background's own marks sit. If the texture
      // wears the type's colour there is nothing to separate — the test below
      // then keeps everything and we are no worse off than shape alone.
      const near = (i: number): boolean => {
        const dr = d[i * 4] - ir, dg = d[i * 4 + 1] - ig, db = d[i * 4 + 2] - ib
        return dr * dr + dg * dg + db * db <= 70 * 70
      }
      const byColour = findLetters((i) => rawInk(i) && near(i), false)
      if (byColour.filter((p) => p.letter).length >= solid.length) parts = byColour
    }

    const m = new Uint8Array(W * H)
    for (const p of parts) if (p.letter) for (const o of p.px) m[o] = 1
    // Second pass: a letter is not always one blob. The dot of an i or j, an
    // accent, the bar of a punctuation mark are separate, small and short, so
    // the height test drops them — and the glyph comes out mutilated
    // ("buildı ıg"). Keep a small part when it sits over or under a kept letter
    // body, which a speck of background never does.
    for (const p of parts) {
      if (p.letter || p.tall) continue
      if (p.px.length < 2) continue
      for (const q of parts) {
        if (!q.letter) continue
        if (p.x0 <= q.x1 && p.x1 >= q.x0) { for (const o of p.px) m[o] = 1; break }
      }
    }
    // Colour-matching keeps the solid stroke but clips the antialiased fringe,
    // where the type fades into the panel behind it. Grow the mask a couple of
    // pixels back into the ink it came from so the harvested glyph keeps the
    // soft edge it was printed with and doesn't sit on the page looking cut out.
    for (let pass = 0; pass < 2; pass++) {
      const add: number[] = []
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const o = y * W + x
          if (m[o]) continue
          if (!rawInk(o)) continue
          if ((x > 0 && m[o - 1]) || (x < W - 1 && m[o + 1]) ||
              (y > 0 && m[o - W]) || (y < H - 1 && m[o + W])) add.push(o)
        }
      for (const o of add) m[o] = 1
    }
    let any = 0
    for (let i = 0; i < W * H; i++) if (m[i]) any++
    if (any > 8) textMask = m
  }
  const isInk = (i: number): boolean => (textMask ? textMask[i] === 1 : rawInk(i))

  const col = new Int32Array(W)
  const row = new Int32Array(H)
  let inkR = 0, inkG = 0, inkB = 0, inkN = 0
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (isInk(i)) {
        col[x]++; row[y]++
        inkR += d[i * 4]; inkG += d[i * 4 + 1]; inkB += d[i * 4 + 2]; inkN++
      }
    }
  if (inkN < 8) return null
  let maxRowAll = 0
  for (let y = 0; y < H; y++) maxRowAll = Math.max(maxRowAll, row[y])
  // Isolate the clicked line's own rows. The window is padded well past the
  // band, so it also sees the lines above and below; scanning all of it for the
  // baseline picks up a neighbour and seats the clone off its own line. Grow
  // from the band outward and stop at the blank gap between lines.
  const gTop = Math.max(0, Math.min(H - 1, Math.round(padY * k)))
  const gBot = Math.max(gTop, Math.min(H - 1, Math.round((padY + band.h) * k)))
  const inked = (y: number): boolean => row[y] > Math.max(1, maxRowAll * 0.02)
  let seed = -1
  for (let y = gTop; y <= gBot; y++) if (inked(y)) { seed = y; break }
  if (seed < 0) for (let y = 0; y < H; y++) if (inked(y)) { seed = y; break }
  if (seed < 0) return null
  let bandTop = seed, bandBot = seed
  while (bandTop - 1 >= 0 && inked(bandTop - 1)) bandTop--
  while (bandBot + 1 < H && inked(bandBot + 1)) bandBot++
  let maxRow = 0
  for (let y = bandTop; y <= bandBot; y++) maxRow = Math.max(maxRow, row[y])
  let capline = bandTop, baseline = bandBot, bottom = bandBot
  for (let y = bandTop; y <= bandBot; y++) if (row[y] >= maxRow * 0.2) { capline = y; break }
  for (let y = bandBot; y >= bandTop; y--) if (row[y] >= maxRow * 0.5) { baseline = y; break }
  for (let y = bandBot; y >= bandTop; y--) if (row[y] >= maxRow * 0.12) { bottom = y; break }
  let inkLeft = -1, inkRight = -1
  // Scale to the tallest COLUMN, not the widest row: a row spans the whole band,
  // so a row-derived cutoff grows with the band width and starts rejecting real
  // letters — which clipped the tail off long runs (a final "e" carries far less
  // column ink than a stem), so the clone came out shorter than the print.
  let maxCol = 0
  for (let x = 0; x < W; x++) maxCol = Math.max(maxCol, col[x])
  const colThr = Math.max(1, Math.round(maxCol * 0.12))
  for (let x = 0; x < W; x++) if (col[x] > colThr) { inkLeft = x; break }
  for (let x = W - 1; x >= 0; x--) if (col[x] > colThr) { inkRight = x; break }
  if (inkLeft < 0 || inkRight <= inkLeft) return null
  const hex = (n: number) => Math.round(n).toString(16).padStart(2, '0')
  const inkHex = `#${hex(inkR / inkN)}${hex(inkG / inkN)}${hex(inkB / inkN)}`
  return { d, lum, W, H, paper, thr, col, baseline, capline, bottom, inkLeft, inkRight, inkHex, bandTop, bandBot, textMask }
}

/** Crop a column range into a sprite (RGB from the page, alpha from ink strength). */
function cropRange(info: BandInfo, x0: number, x1: number, advance: number): Sprite | null {
  const { d, lum, W, H, paper, thr, baseline, bandTop, bandBot, textMask } = info
  // On a textured panel only the letters may enter the sprite — otherwise every
  // cloned glyph carries a halo of starfield with it.
  const isInkAt = (i: number): boolean =>
    textMask ? textMask[i] === 1 : Math.abs(lum[i] - paper) > thr
  x0 = Math.max(0, Math.min(W - 1, x0))
  x1 = Math.max(0, Math.min(W - 1, x1))
  if (x1 < x0) return null
  // Rows carrying ink in this column range. The analysis window is padded well
  // past the band, so it also sees the lines above and below — taking the outer
  // extent of ALL ink would bake a slice of a neighbouring line into the glyph
  // (a clipped strip of letter-tops riding under the retyped words). Grow out
  // from the clicked line's own rows and stop at the blank gap that separates
  // it from its neighbours, so ascenders and descenders are kept and nothing
  // beyond the line is.
  const rowInk = new Int32Array(H)
  for (let y = 0; y < H; y++)
    for (let x = x0; x <= x1; x++) if (isInkAt(y * W + x)) { rowInk[y]++; break }
  let seed = -1
  for (let y = bandTop; y <= bandBot; y++) if (rowInk[y]) { seed = y; break }
  if (seed < 0) for (let y = 0; y < H; y++) if (rowInk[y]) { seed = y; break }
  if (seed < 0) return null
  // Grow across the small breaks INSIDE a glyph — the space under the dot of an
  // i or j, under an accent — but never across the big one that separates this
  // line from the next. Stopping at the first blank row instead kept only
  // whichever half of the letter the seed happened to land in, and the heading
  // came out reading "bu\u02d9ld\u02d9ng": two dots and no stems. Anything this
  // hops over stays inside the line's own span, which is what bounds it.
  const spanH = Math.max(4, bandBot - bandTop + 1)
  const maxGap = Math.max(2, Math.round(spanH * 0.3))
  // Stay inside the line's own span, give or take a pixel for the soft edge.
  // The gaps worth hopping are all internal — the dot of an i, an accent — and
  // the span already reaches from the tallest ascender to the lowest descender,
  // so there is nothing to gain outside it and a neighbouring line to lose:
  // allowing a quarter of the line height of headroom was enough, in tight
  // leading, to pick up the descenders of the line above and carry them into
  // the harvested glyphs, which is exactly the debris that shows up floating
  // over retyped text.
  const ceil = Math.max(0, bandTop - 1)
  const floor = Math.min(H - 1, bandBot + 1)
  let top = seed, bot = seed
  for (;;) {
    let y = top - 1, gap = 0
    while (y >= ceil && !rowInk[y] && gap < maxGap) { y--; gap++ }
    if (y < ceil || !rowInk[y]) break
    top = y
  }
  for (;;) {
    let y = bot + 1, gap = 0
    while (y <= floor && !rowInk[y] && gap < maxGap) { y++; gap++ }
    if (y > floor || !rowInk[y]) break
    bot = y
  }
  if (bot < top) return null
  const gw = x1 - x0 + 1
  const gh = bot - top + 1

  // Keep only the ink that belongs to THIS letter.
  //
  // A cut between two letters is rarely a clean empty column — in a serifed face
  // at text size they very nearly touch — so the box takes a slice of its
  // neighbour with it. That slice then drags the sprite's rows up to whatever
  // the neighbour reaches, and the harvested `e` comes back wearing the top of
  // the `k` beside it: the retyped line reads "we'ek'end", stray marks hanging
  // over the words.
  //
  // A slice is recognisable by how little it puts IN the box: follow it and most
  // of the shape lies elsewhere, and what it does leave here is a sliver beside
  // the letter's own body. Judge it that way rather than by where the shape's
  // bulk is — in a serifed face at text size whole runs of letters join up, so
  // "most of this shape is outside the box" is true of the letter itself, and
  // going by that alone emptied the line instead of cleaning it.
  const reach = Math.max(2, gw)
  const wx0 = Math.max(0, x0 - reach)
  const wx1 = Math.min(W - 1, x1 + reach)
  const ww = wx1 - wx0 + 1
  const own = new Uint8Array(ww * gh)
  {
    const seen = new Uint8Array(ww * gh)
    const stack = new Int32Array(ww * gh)
    const comp = new Int32Array(ww * gh)
    const parts: { px: number[]; n: number; inside: number }[] = []
    const at = (lx: number, ly: number): number => (top + ly) * W + (wx0 + lx)
    for (let s0 = 0; s0 < ww * gh; s0++) {
      if (seen[s0] || !isInkAt(at(s0 % ww, (s0 / ww) | 0))) continue
      let sp = 0, n = 0, inside = 0
      stack[sp++] = s0; seen[s0] = 1
      while (sp > 0) {
        const o = stack[--sp]
        comp[n++] = o
        const lx = o % ww, ly = (o / ww) | 0
        const gx = wx0 + lx
        if (gx >= x0 && gx <= x1) inside++
        const push = (nx: number, ny: number): void => {
          if (nx < 0 || ny < 0 || nx >= ww || ny >= gh) return
          const ni = ny * ww + nx
          if (seen[ni] || !isInkAt(at(nx, ny))) return
          seen[ni] = 1; stack[sp++] = ni
        }
        push(lx - 1, ly); push(lx + 1, ly); push(lx, ly - 1); push(lx, ly + 1)
      }
      parts.push({ px: Array.from(comp.slice(0, n)), n, inside })
    }
    let insideTotal = 0
    for (const q of parts) insideTotal += q.inside
    for (const q of parts) {
      const keep = q.inside >= q.n * 0.4 || q.inside >= insideTotal * 0.3
      if (keep) for (const o of q.px) own[o] = 1
    }
  }
  const mine = (gx: number, gy: number): boolean => {
    const lx = gx - wx0, ly = gy - top
    if (lx < 0 || ly < 0 || lx >= ww || ly >= gh) return false
    return own[ly * ww + lx] === 1
  }

  const sc = document.createElement('canvas')
  sc.width = gw
  sc.height = gh
  const sctx = sc.getContext('2d')!
  const out = sctx.createImageData(gw, gh)
  for (let y = 0; y < gh; y++)
    for (let x = 0; x < gw; x++) {
      const si = ((top + y) * W + (x0 + x)) * 4
      const oi = (y * gw + x) * 4
      out.data[oi] = d[si]
      out.data[oi + 1] = d[si + 1]
      out.data[oi + 2] = d[si + 2]
      const si2 = (top + y) * W + (x0 + x)
      const l = lum[si2]
      const a = (textMask && !textMask[si2]) || !mine(x0 + x, top + y)
        ? 0
        : Math.max(0, Math.min(1, (Math.abs(l - paper) - thr * 0.4) / (thr * 1.2)))
      out.data[oi + 3] = Math.round(a * 255)
    }
  sctx.putImageData(out, 0, 0)
  return { canvas: sc, w: gw, top: top - baseline, advance }
}

/**
 * Harvest per-letter sprites from a line by slicing the ink extent at the
 * character boundaries predicted by the transcription's metrics, snapping each
 * cut to the nearest low-ink column so it never bisects a stroke. Every
 * character gets a sprite (no dropped letters).
 */


export function buildAtlas(canvas: HTMLCanvasElement, band: Rect, transcription: string, pageW: number): Atlas | null {
  return buildAtlasMulti(canvas, [{ band, text: transcription }], pageW)
}


/**
 * Cut a printed line into one span per character.
 *
 * Splitting on whitespace fails on a textured panel: neighbouring letters touch,
 * and the gaps that do survive aren't the ones between words. What we do know is
 * the transcription — how many letters there are, and roughly how wide each one
 * should be relative to the others. So place every cut at once with a DP that
 * trades two costs against each other: cutting through ink is expensive, and a
 * span that doesn't match its letter's expected width is expensive.
 *
 * This is what the greedy "split the widest shape until the counts agree" rule
 * got wrong. On "Summer Teambuilding" the widest shape is an `m` — so when `bu`
 * fused into one shape, the splitter went and cut an `m` in half instead, and
 * every label after it slid one letter out of step. Widths only mean something
 * measured against what the letter is supposed to be.
 */
function segmentByAdvances(
  info: BandInfo,
  chars: string[],
  advs: number[],
): { x0: number; x1: number }[] | null {
  const n = chars.length
  if (n === 0) return null
  const lx = info.inkLeft
  const rx = info.inkRight
  const W = rx - lx + 1
  if (W < n) return null
  const tot = advs.reduce((a, b) => a + b, 0)
  if (!(tot > 0)) return null
  const scale = W / tot
  if (n === 1) return [{ x0: lx, x1: rx }]

  let maxCol = 0
  for (let x = lx; x <= rx; x++) maxCol = Math.max(maxCol, info.col[x])
  if (maxCol <= 0) return null
  const inkAt = (x: number): number => (x < lx || x > rx ? 0 : info.col[x] / maxCol)
  const pre = new Float64Array(W + 1)
  for (let i = 0; i < W; i++) pre[i + 1] = pre[i] + inkAt(lx + i)
  const meanInk = (a: number, b: number): number =>
    b < a ? 0 : (pre[b - lx + 1] - pre[a - lx]) / (b - a + 1)

  // where each cut would land if the line were set at exactly these advances,
  // plus enough slack to absorb the difference between the substitute face's
  // proportions and the printed one's
  const avg = W / n
  const slack = Math.max(2, Math.round(avg * 0.8))
  const winLo: number[] = []
  const winHi: number[] = []
  let acc = 0
  for (let i = 0; i < n - 1; i++) {
    acc += advs[i]
    const want = lx + acc * scale - 1
    const lo = Math.max(lx + i, Math.round(want - slack))
    const hi = Math.min(rx - (n - 1 - i), Math.round(want + slack))
    if (hi < lo) return null
    winLo.push(lo)
    winHi.push(hi)
  }

  const spanCost = (i: number, a: number, b: number): number => {
    const w = b - a + 1
    if (w <= 0) return 1e6
    const want = Math.max(1, advs[i] * scale)
    const rel = (w - want) / want
    let cost = 1.4 * rel * rel
    const ink = meanInk(a, b)
    // a space has to be empty, and a letter has to not be — this is what keeps
    // the word break on the real gap instead of a letter's inner counter
    if (chars[i] === ' ') cost += 6 * ink
    else if (ink < 0.02) cost += 3
    return cost
  }
  const CUT = 2.2

  let prev: Float64Array | null = null
  const back: Int32Array[] = []
  for (let i = 0; i < n - 1; i++) {
    const lo = winLo[i]
    const hi = winHi[i]
    const cur = new Float64Array(hi - lo + 1).fill(Infinity)
    const bk = new Int32Array(hi - lo + 1).fill(-1)
    for (let c = lo; c <= hi; c++) {
      const cut = CUT * inkAt(c) + CUT * 0.5 * inkAt(c + 1)
      if (i === 0) {
        cur[c - lo] = spanCost(0, lx, c) + cut
        continue
      }
      const plo = winLo[i - 1]
      const phi = Math.min(winHi[i - 1], c - 1)
      let best = Infinity
      let bi = -1
      for (let p = plo; p <= phi; p++) {
        const v = prev![p - plo] + spanCost(i, p + 1, c)
        if (v < best) { best = v; bi = p }
      }
      cur[c - lo] = best + cut
      bk[c - lo] = bi
    }
    back.push(bk)
    prev = cur
  }
  if (!prev) return null

  const lo = winLo[n - 2]
  const hi = winHi[n - 2]
  let best = Infinity
  let bc = -1
  for (let c = lo; c <= hi; c++) {
    const v = prev[c - lo] + spanCost(n - 1, c + 1, rx)
    if (v < best) { best = v; bc = c }
  }
  if (bc < 0 || !Number.isFinite(best)) return null

  const cuts = new Array<number>(n - 1)
  let c = bc
  for (let i = n - 2; i >= 0; i--) {
    cuts[i] = c
    if (i > 0) {
      c = back[i][c - winLo[i]]
      if (c < 0) return null
    }
  }
  const spans: { x0: number; x1: number }[] = []
  let s = lx
  for (let i = 0; i < n; i++) {
    const e = i === n - 1 ? rx : cuts[i]
    spans.push({ x0: s, x1: e })
    s = e + 1
  }
  return spans
}

export function buildAtlasMulti(
  canvas: HTMLCanvasElement,
  sources: { band: Rect; text: string }[],
  pageW: number,
): Atlas | null {
  try {
    const k = canvas.width / pageW
    const glyphs = new Map<string, Sprite>()
    let ascent = 0, descent = 0, spaceAdvSum = 0, spaceAdvN = 0
    let inkHex = '#111111'
    let inset = 0
    let insetSet = false
    for (const { band, text: raw } of sources) {
      const text = raw.replace(/\s+/g, ' ').trim()
      if (!text) continue
      const info = analyzeBand(canvas, band, k)
      if (!info) continue
      inkHex = info.inkHex
      if (!insetSet) { inset = info.inkLeft / k; insetSet = true }
      ascent = Math.max(ascent, info.baseline - info.capline + 1)
      descent = Math.max(descent, Math.max(0, info.bottom - info.baseline))
      const inkW = info.inkRight - info.inkLeft
      const c = measureCtx()
      c.font = `100px ${FONT_STACKS.sans}`
      const xHeightPx = info.baseline - info.capline
      const avgAdv = inkW / Math.max(1, [...text].filter((ch) => ch !== ' ').length)
      const win = Math.max(1, Math.round(avgAdv * 0.22))
      const snap = (x: number): number => {
        let best = Math.round(x), bestV = Infinity
        for (let dx = -win; dx <= win; dx++) {
          const xx = Math.round(x) + dx
          if (xx < info.inkLeft || xx > info.inkRight + 1) continue
          const v = info.col[Math.max(0, Math.min(info.W - 1, xx))]
          if (v < bestV) { bestV = v; best = xx }
        }
        return best
      }

      // catalogue every whitespace gap in the ink profile
      const colThr = 1
      const gapRuns: { at: number; len: number }[] = []
      let gs = -1
      for (let x = info.inkLeft; x <= info.inkRight; x++) {
        if (info.col[x] <= colThr) { if (gs < 0) gs = x } else if (gs >= 0) { gapRuns.push({ at: gs, len: x - gs }); gs = -1 }
      }
      const words = text.split(' ').filter(Boolean)
      // pick a threshold that yields exactly (words-1) word breaks, using the
      // transcription's known word count — the word gaps are the largest, and
      // must stand clearly above the letter gaps to be trusted
      const lensDesc = gapRuns.map((g) => g.len).sort((a, b) => b - a)
      let gapMin = Infinity
      if (words.length > 1 && lensDesc.length >= words.length - 1) {
        const wordGap = lensDesc[words.length - 2]
        const letterGap = lensDesc[words.length - 1] ?? 0
        if (wordGap >= 2 && wordGap >= letterGap + 1.5) gapMin = (wordGap + letterGap) / 2
      }
      const segs: { x0: number; x1: number }[] = []
      let segStart = info.inkLeft
      for (const gap of gapRuns) {
        if (gap.len >= gapMin) { segs.push({ x0: segStart, x1: gap.at - 1 }); segStart = gap.at + gap.len }
      }
      segs.push({ x0: segStart, x1: info.inkRight })

      const sliceWord = (word: string, x0: number, x1: number) => {
        const chars = [...word]
        const advs = chars.map((ch) => c.measureText(ch).width)
        const tot = advs.reduce((s, a) => s + a, 0) || 1
        const scale = (x1 - x0) / tot
        let pen = x0
        for (let i = 0; i < chars.length; i++) {
          const ch = chars[i]
          const start = pen
          pen += advs[i] * scale
          if (glyphs.has(ch)) continue
          const sx0 = i === 0 ? x0 : snap(start)
          // guard against the two cuts collapsing onto the same valley (narrow
          // glyphs like i/l/punctuation) which would invert the range and drop
          // a letter that is actually present
          const sx1 = i === chars.length - 1 ? x1 : Math.max(sx0, snap(pen) - 1)
          const sprite = cropRange(info, sx0, sx1, advs[i] * scale)
          if (sprite) glyphs.set(ch, sprite)
        }
      }

      // Textured panel: segment from the letters-only mask's connected
      // components. Each box IS one glyph, so the labels are certain — no gap
      // threshold to get wrong, which is what scrambled the words before. Only
      // taken when the shape count matches the transcription exactly; anything
      // else means the read and the print disagree, and guessing there is how
      // mislabelled sprites get emitted.
      // Cut the line by aligning the whole transcription against the ink profile
      // at once. Returns false if it can't produce one span per letter.
      const harvestByAlignment = (): boolean => {
        const all = [...text]
        const spans = segmentByAdvances(info, all, all.map((ch) => c.measureText(ch).width))
        if (!spans) return false
        const boxes = spans.filter((_, i) => all[i] !== ' ')
        const letters = all.filter((ch) => ch !== ' ')
        if (boxes.length !== letters.length) return false
        for (let i = 0; i < letters.length; i++) {
          const ch = letters[i]
          if (glyphs.has(ch)) continue
          const b = boxes[i]
          const nextGap = i + 1 < boxes.length ? boxes[i + 1].x0 - b.x1 : 0
          const sprite = cropRange(info, b.x0, b.x1, (b.x1 - b.x0 + 1) + Math.max(0, nextGap) * 0.5)
          if (sprite) glyphs.set(ch, sprite)
        }
        // word space = the widest inter-shape gap actually present
        let wide = 0
        for (let i = 1; i < boxes.length; i++) wide = Math.max(wide, boxes[i].x0 - boxes[i - 1].x1)
        spaceAdvSum += wide > 0 ? wide : avgAdv * 0.9
        spaceAdvN += 1
        return true
      }

      // On a textured panel there are no whitespace gaps to trust — the panel
      // inks everywhere — so alignment is the only way in.
      if (info.textMask) {
        if (harvestByAlignment()) continue
        continue // shapes and transcription disagree — don't mislabel
      }

      if (segs.length === words.length) {
        // clean 1:1 word alignment — slice each word within its own ink extent
        words.forEach((w, i) => sliceWord(w, segs[i].x0, segs[i].x1))
        spaceAdvSum += avgAdv * 0.9 * Math.max(0, words.length - 1)
        spaceAdvN += Math.max(0, words.length - 1)
      } else if (words.length === 1) {
        // single word, no space to resync on — bounded drift, slice directly
        sliceWord(words[0], info.inkLeft, info.inkRight)
      } else if (!harvestByAlignment()) {
        // The gaps don't match the transcription's word structure. That is not
        // always a misread: in tight bold text at small sizes the word spaces
        // simply aren't wider than the letter spaces by enough to tell apart,
        // and a line like "Teambuilding weekend in Rivergate" lands here every
        // time — the harvest used to be abandoned outright, so every edit to it
        // silently fell back to a substitute font. Cutting by expected width
        // instead has no such cliff. Only if THAT can't produce one span per
        // letter do we give up, rather than emit mislabelled sprites.
        continue
      }
    }
    if (!glyphs.size) return null
    const spaceAdvance = spaceAdvN ? spaceAdvSum / spaceAdvN : ascent * 0.4
    return { glyphs, spaceAdvance, ascent, descent, k, inkHex, inset }
  } catch {
    return null
  }
}

export interface Composition {
  dataUrl: string
  w: number
  h: number
  baselineFromTop: number
  coverage: number
  inset: number // left inset from band.x, view px — add to band.x when seating
}

/** Copy a printed line's pixels verbatim (paper→transparent) — pixel-identical. */
/**
 * The true box of the printed line: where its LETTERS actually start, end, top
 * out and drop to — texture excluded.
 *
 * The band that comes back from ink detection is a good enough place to look,
 * but it is not the box to erase. It measures rows of "something darker/lighter
 * than the background", so on a plain page it can stop above a descender (the
 * tail of a `g` carries too few pixels in its row to register), and on a
 * textured one it can run on past the last letter into the pattern. Erase that
 * box and you either leave a piece of the old word behind or wipe background
 * the reprint has no business touching — both were happening on this heading.
 *
 * The clone already works this out properly, since it has to isolate the
 * letters before it can harvest them. Use the same measurement for the erase so
 * the two can't disagree.
 */
export function measureLineBox(canvas: HTMLCanvasElement, band: Rect, pageW: number): Rect | null {
  const k = canvas.width / pageW
  const info = analyzeBand(canvas, band, k)
  if (!info) return null
  const padY = Math.max(2, Math.round(band.h * 0.6))
  const X = Math.max(0, Math.round(band.x * k))
  const Y = Math.max(0, Math.round((band.y - padY) * k))
  const w = (info.inkRight - info.inkLeft + 1) / k
  const h = (info.bandBot - info.bandTop + 1) / k
  if (!(w > 1) || !(h > 1)) return null
  return { x: (X + info.inkLeft) / k, y: (Y + info.bandTop) / k, w, h }
}

export function snapshotBand(canvas: HTMLCanvasElement, band: Rect, pageW: number): Composition | null {
  try {
    const k = canvas.width / pageW
    const info = analyzeBand(canvas, band, k)
    if (!info) return null
    const sprite = cropRange(info, info.inkLeft, info.inkRight, 0)
    if (!sprite) return null
    return {
      dataUrl: sprite.canvas.toDataURL('image/png'),
      w: sprite.canvas.width / k,
      h: sprite.canvas.height / k,
      baselineFromTop: -sprite.top / k,
      coverage: 1,
      inset: info.inkLeft / k,
    }
  } catch {
    return null
  }
}

/** Compose `text` from the atlas; missing letters fall back to the palette face. */
export function composeFromAtlas(atlas: Atlas, text: string, fallbackFont: FontId, bold: boolean): Composition | null {
  try {
    const chars = [...text]
    const { k, ascent, descent } = atlas
    const emPx = ascent / 0.7
    const c = measureCtx()
    c.font = `${bold ? '700' : '400'} ${emPx}px ${FONT_STACKS[fallbackFont]}`
    let penX = 0
    let cloned = 0, total = 0
    let maxTop = ascent, maxBot = descent
    const plan: { sprite?: Sprite; ch: string; x: number }[] = []
    for (const ch of chars) {
      if (ch === ' ') { plan.push({ ch, x: penX }); penX += atlas.spaceAdvance; continue }
      total++
      const sprite = atlas.glyphs.get(ch)
      if (sprite) {
        cloned++
        plan.push({ sprite, ch, x: penX })
        penX += sprite.advance
        maxTop = Math.max(maxTop, -sprite.top)
        maxBot = Math.max(maxBot, sprite.top + sprite.canvas.height)
      } else {
        plan.push({ ch, x: penX })
        penX += c.measureText(ch).width
      }
    }
    const totalW = Math.max(1, Math.ceil(penX))
    const baseline = Math.ceil(maxTop)
    const H = Math.ceil(maxTop + maxBot + 2)
    const out = document.createElement('canvas')
    out.width = totalW
    out.height = H
    const octx = out.getContext('2d')!
    octx.font = c.font
    octx.fillStyle = atlas.inkHex
    octx.textBaseline = 'alphabetic'
    for (const p of plan) {
      if (p.sprite) octx.drawImage(p.sprite.canvas, Math.round(p.x), Math.round(baseline + p.sprite.top))
      else if (p.ch !== ' ') octx.fillText(p.ch, p.x, baseline)
    }
    return {
      dataUrl: out.toDataURL('image/png'),
      w: totalW / k,
      h: H / k,
      baselineFromTop: baseline / k,
      coverage: total ? cloned / total : 0,
      inset: atlas.inset,
    }
  } catch {
    return null
  }
}
