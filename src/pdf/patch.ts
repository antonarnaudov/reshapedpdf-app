import type { Rect } from '../core/types'

/* ---------------- whiteout patch synthesis ---------------- */

export const median = (a: number[]): number => {
  const s = a.slice().sort((p, q) => p - q)
  return s[Math.floor(s.length / 2)] ?? 255
}

/* ----- background reconstruction (inpainting) ----------------------------------
   The patch under an erased region must look like the page was printed without
   the ink. Edge interpolation can't guarantee that (any glyph crossing the
   border smears through the patch), so this is a real inpaint: every pixel in a
   ring around the region is classified as paper or ink, the paper diffuses
   inward through a pull-push pyramid, and the ring's grain is re-applied so the
   fill doesn't look airbrushed. Works on gradients, multicolour splits, dark
   pages, scans, and rings that contain other printed text. */

/**
 * Exact 2D sliding-window median of an 8-bit plane (Huang histogram sweep,
 * edge-replicated). The median is the page-tone estimator that survives dense
 * text: glyph strokes are thin, so paper stays the window majority — a box
 * blur would average the ink in and start calling half-tone glyph pixels
 * "paper". Follows gradients and colour bands; is polarity-agnostic.
 */
export function slidingMedian(src: Uint8ClampedArray, W: number, H: number, r: number): Float32Array {
  const out = new Float32Array(W * H)
  const hist = new Uint32Array(256)
  const half = (((2 * r + 1) * (2 * r + 1)) + 1) >> 1
  const cx = (x: number) => Math.min(W - 1, Math.max(0, x))
  const cy = (y: number) => Math.min(H - 1, Math.max(0, y))
  for (let y = 0; y < H; y++) {
    hist.fill(0)
    for (let wy = -r; wy <= r; wy++) {
      const row = cy(y + wy) * W
      for (let wx = -r; wx <= r; wx++) hist[src[row + cx(wx)]]++
    }
    for (let x = 0; x < W; x++) {
      if (x > 0)
        for (let wy = -r; wy <= r; wy++) {
          const row = cy(y + wy) * W
          hist[src[row + cx(x - r - 1)]]--
          hist[src[row + cx(x + r)]]++
        }
      let acc = 0
      let m = 0
      for (; m < 255; m++) {
        acc += hist[m]
        if (acc >= half) break
      }
      out[y * W + x] = m
    }
  }
  return out
}

/**
 * How grainy the page is: the median absolute residual after removing the
 * low-frequency tone. Robust to sparse ink (a minority), so it measures the
 * paper's own noise. Ink detection scales its threshold off this, so a scan's
 * grain isn't mistaken for ink (which used to collapse the trusted-paper ring
 * and force a flat, seam-showing patch).
 */
function grainLevel(lum: ArrayLike<number>, low: ArrayLike<number>, N: number): number {
  if (N < 4) return 0
  const r = new Float32Array(N)
  for (let i = 0; i < N; i++) r[i] = Math.abs(lum[i] - low[i])
  r.sort()
  // the 25th percentile is the PAPER's own noise floor; the median would drift
  // upward (and blow the threshold past 255, disabling ink detection) once ink
  // covers ~half the region — e.g. erasing a word inside dense text
  return r[Math.floor(N * 0.25)]
}

/** Ink threshold that adapts to grain: a departure far above the paper's noise floor. */
function inkThreshold(grain: number, floor: number): number {
  return Math.max(floor, grain * 4.5)
}

/** Grow a binary mask by `passes` px (catches anti-aliased glyph fringes). */
function dilateMask(m: Uint8Array, W: number, H: number, passes: number): void {
  for (let p = 0; p < passes; p++) {
    const src = m.slice()
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if (src[y * W + x]) continue
        if (
          (x > 0 && src[y * W + x - 1]) ||
          (x < W - 1 && src[y * W + x + 1]) ||
          (y > 0 && src[(y - 1) * W + x]) ||
          (y < H - 1 && src[(y + 1) * W + x])
        )
          m[y * W + x] = 1
      }
  }
}


/**
 * Drop small isolated ink blobs from the mask — a page's own texture (speckles,
 * halftone dots, film grain, a photographic background) reads as "ink" against
 * the smooth tone, but it's BACKGROUND to keep, not foreground to remove. Text
 * strokes are large connected components; texture is tiny specks. Keeping only
 * the big components as ink stops texture from collapsing the trusted ring
 * (which forced a flat, background-destroying patch on complex art).
 */
export function removeSmallInk(ink: Uint8Array, W: number, H: number, minArea: number): void {
  const seen = new Uint8Array(ink.length)
  const stack = new Int32Array(ink.length)
  for (let start = 0; start < ink.length; start++) {
    if (!ink[start] || seen[start]) continue
    let top = 0
    stack[top++] = start
    seen[start] = 1
    const comp: number[] = []
    while (top > 0) {
      const o = stack[--top]
      comp.push(o)
      const x = o % W
      if (x > 0 && ink[o - 1] && !seen[o - 1]) { seen[o - 1] = 1; stack[top++] = o - 1 }
      if (x < W - 1 && ink[o + 1] && !seen[o + 1]) { seen[o + 1] = 1; stack[top++] = o + 1 }
      if (o >= W && ink[o - W] && !seen[o - W]) { seen[o - W] = 1; stack[top++] = o - W }
      if (o < ink.length - W && ink[o + W] && !seen[o + W]) { seen[o + W] = 1; stack[top++] = o + W }
    }
    if (comp.length < minArea) for (const o of comp) ink[o] = 0
  }
}

/** The texture's own luminance band (robust 1st..99th pct of the whole surround,
 *  incl. its specks, padded) — sources outside it are foreign content (a white
 *  margin, neighbouring text, a graphic) the mirror should not pull in. */
function lumRange(lums: number[]): [number, number] {
  if (!lums.length) return [-Infinity, Infinity] // no reference → accept every source
  const l = lums.slice().sort((a, b) => a - b)
  const lo = l[Math.floor(l.length * 0.01)]
  const hi = l[Math.floor(l.length * 0.99)]
  const pad = (hi - lo) * 0.15 + 4
  return [lo - pad, hi + pad]
}

interface ColourAxis { br: number; bg: number; bb: number; tr: number; tg: number; tb: number }

/** Distance from a colour to the base→mark segment that describes this background. */
function offAxis(r: number, g: number, b: number, a: ColourAxis): number {
  const dr = a.tr - a.br, dg = a.tg - a.bg, db = a.tb - a.bb
  const len = dr * dr + dg * dg + db * db
  const pr = r - a.br, pg = g - a.bg, pb = b - a.bb
  // clamped below (nothing is darker than the base) but allowed to run past the
  // mark: the brightest specks in a field sit beyond the colour taken for its
  // far end, and they are still the same background, not something foreign
  const t = len > 0 ? Math.max(0, Math.min(2, (pr * dr + pg * dg + pb * db) / len)) : 0
  const qr = pr - t * dr, qg = pg - t * dg, qb = pb - t * db
  return Math.sqrt(qr * qr + qg * qg + qb * qb)
}

/**
 * Rebuild a textured hole by MIRRORING the surrounding pixels across the nearest
 * hole edge. A statistical fill (diffuse a tone, scatter noise) gets the average
 * right but turns discrete texture — a starfield, grain, a photo's dots — into
 * flat static that reads as a patch. Reflecting real pixels instead copies real
 * dots at the local density and continues them seamlessly across the seam, and
 * the mean comes out right for free because the samples are the real thing.
 * Only pixels with wgt==0 (the hole) are written; valid pixels stay untouched.
 * `holeRect` is the reflection frame (the erase rect, or a stroke's bounding box).
 */
function mirrorFill(
  rgb: Float32Array, wgt: Float32Array, d: Uint8ClampedArray, W: number, H: number,
  ix: number, iy: number, iw: number, ih: number, loLum: number, hiLum: number,
  solidInk?: Uint8Array,
  axis?: ColourAxis | null,
): void {
  const x1 = ix + iw - 1, y1 = iy + ih - 1
  const topB = iy, botB = H - (iy + ih), leftB = ix, rightB = W - (ix + iw)
  // fold a distance into a band of `band` valid pixels (triangle wave): a deep
  // hole then TILES the surrounding texture instead of reflecting off the frame
  // and falling back to a smooth (visibly smeared) fill in its centre. Uses
  // reflect-101 (…2,1,0,1,2…) so the turn doesn't duplicate the edge row, which
  // would print a doubled line every period.
  const fold = (dist: number, band: number): number => {
    if (band <= 0) return -1
    if (band === 1) return 0
    const p = 2 * (band - 1)
    const m = dist % p
    return m < band ? m : p - m
  }
  /** Where a hole pixel reflects to. */
  const srcFor = (x: number, y: number): number[] | null => {
    const dL = x - ix, dR = x1 - x, dT = y - iy, dB = y1 - y
    // Sample across the hole's SHORT axis — for an erased text line, from the
    // strips directly above and below it.
    //
    // Two reasons, and the first is arithmetic. The surround is a frame: a
    // line-shaped hole is far wider than the band beside it, so folding a
    // left/right distance tiles one narrow column of pixels across the whole
    // width. Where that column happens to be quiet, the entire hole comes out
    // quiet — a flat slab with the erase box's corners showing, which is what
    // this heading did across the thick of its starfield. Above and below, the
    // band is as wide as the hole itself and only a fold or two deep.
    //
    // The second is that sampling vertically keeps x, so each column is filled
    // from the background at ITS OWN horizontal position: bare panel stays bare,
    // and where the star field thickens the fill thickens with it. A horizontal
    // fold cannot do that — it carries the wrong part of the page sideways by
    // construction.
    //
    // What made the horizontal choice tempting is that the neighbouring TEXT
    // lines live above and below, and reflecting them tiles ghost letters into
    // the patch. That is handled where it belongs: printed strokes are marked
    // (solidInk) and never copied, and anything off the background's own colour
    // axis is refused.
    const wide = iw >= ih
    const prim = wide ? [{ d: dT, e: 0 }, { d: dB, e: 1 }] : [{ d: dL, e: 2 }, { d: dR, e: 3 }]
    const sec = wide ? [{ d: dL, e: 2 }, { d: dR, e: 3 }] : [{ d: dT, e: 0 }, { d: dB, e: 1 }]
    const order = [...prim.sort((a, b) => a.d - b.d), ...sec.sort((a, b) => a.d - b.d)]
    for (const { e } of order) {
      if (e === 0) { const m = fold(dT, topB); if (m >= 0) return [x, iy - 1 - m] }
      else if (e === 1) { const m = fold(dB, botB); if (m >= 0) return [x, iy + ih + m] }
      else if (e === 2) { const m = fold(dL, leftB); if (m >= 0) return [ix - 1 - m, y] }
      else { const m = fold(dR, rightB); if (m >= 0) return [ix + iw + m, y] }
    }
    return null
  }
  /** Is this a pixel we are allowed to copy? */
  // Everything off the background's colour axis, plus a margin around it. The
  // margin is the point: a glyph's edge fades into the panel behind it, and
  // those in-between pixels sit close enough to the base colour to pass the test
  // on their own. Copy them and the erase comes back stippled with the ghost of
  // whatever they came from — faint green dashes, in the case of the subheading
  // under this banner.
  let foreign: Uint8Array | null = null
  if (axis) {
    const f = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++) if (offAxis(d[i * 4], d[i * 4 + 1], d[i * 4 + 2], axis) > 60) f[i] = 1
    foreign = new Uint8Array(f)
    for (let pass = 0; pass < 2; pass++) {
      const src = new Uint8Array(foreign)
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const o = y * W + x
          if (src[o]) continue
          if ((x > 0 && src[o - 1]) || (x < W - 1 && src[o + 1]) ||
              (y > 0 && src[o - W]) || (y < H - 1 && src[o + W])) foreign[o] = 1
        }
    }
  }
  const usable = (sx: number, sy: number): boolean => {
    if (sx < 0 || sy < 0 || sx >= W || sy >= H) return false
    const o = sy * W + sx
    if (wgt[o] <= 0) return false // inside the hole: nothing known there yet
    const s = o * 4
    // reject foreign content the reflection may reach (neighbouring text, a
    // graphic): outside the texture's own tonal range it is not texture
    const sl = 0.2126 * d[s] + 0.7152 * d[s + 1] + 0.0722 * d[s + 2]
    if (sl < loLum || sl > hiLum) return false
    // never copy a printed stroke — that tiles ghost letters into the erase
    if (solidInk && solidInk[o]) return false
    // nor anything off the background's own colour axis: same reason, but it
    // also catches the small type an erosion is too coarse to find
    if (foreign && foreign[o]) return false
    return true
  }

  // Copy in BLOCKS, each free to slide a little off where it reflects to.
  //
  // Reflecting pixel by pixel is exactly periodic: a hole several times deeper
  // than the frame beside it repeats the same strip over and over, and the eye
  // reads the repeat instantly — the erase came out ruled in stripes. Jittering
  // per pixel is no good either, since that shreds the texture's own marks into
  // static. A block is the middle: big enough to carry a star or a grain intact,
  // small enough that shifting each one independently leaves no visible period.
  // Locality is what keeps a density gradient honest, so the jitter is a nudge
  // (a block or two) rather than a free choice of anywhere in the frame.
  const B = Math.max(3, Math.min(14, Math.round(Math.min(iw, ih) / 4)))
  // deterministic: the same erase twice must give the same pixels
  let seed = (ix * 73856093) ^ (iy * 19349663) ^ (iw * 83492791) ^ ih
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) | 0
    return ((seed >>> 8) & 0xffff) / 0x10000
  }
  for (let by = iy; by <= y1; by += B)
    for (let bx = ix; bx <= x1; bx += B) {
      const bw = Math.min(B, x1 - bx + 1)
      const bh = Math.min(B, y1 - by + 1)
      const base = srcFor(bx + (bw >> 1), by + (bh >> 1))
      if (!base) continue // no valid band anywhere: keep the flat median fallback
      const odx = base[0] - (bx + (bw >> 1))
      const ody = base[1] - (by + (bh >> 1))
      // Accept the FIRST offset that is wholly usable rather than the one with the
      // most usable pixels. Scoring by count quietly prefers wherever the fewest
      // samples are refused — the emptiest part of the surround — so an erase in
      // a speckled field kept reaching for its bare patches and came back thinner
      // than the background around it. A yes/no gate has no such gradient, and
      // the offsets are tried in random order, so density carries across.
      // Try the SHIFTED offsets first and keep the plain reflection only as a
      // fallback. Offering the unshifted position first looked harmless, but it
      // is almost always usable, so it was almost always taken — the jitter never
      // happened and the fill went back to repeating one strip in a visible grid.
      //
      // Accept the first offset that is wholly usable rather than the one with
      // the most usable pixels. Scoring by count quietly prefers wherever the
      // fewest samples are refused — the emptiest part of the surround — so an
      // erase in a speckled field kept reaching for its bare patches and came
      // back thinner than the background around it.
      let bestDx = odx, bestDy = ody
      const reach = Math.max(2, B * 2)
      for (let t = 0; t < 10; t++) {
        const jx = Math.round((rnd() * 2 - 1) * reach)
        const jy = Math.round((rnd() * 2 - 1) * reach)
        let whole = true
        for (let yy = 0; yy < bh && whole; yy++)
          for (let xx = 0; xx < bw; xx++) if (!usable(bx + xx + odx + jx, by + yy + ody + jy)) { whole = false; break }
        if (whole) { bestDx = odx + jx; bestDy = ody + jy; break }
      }
      for (let yy = 0; yy < bh; yy++)
        for (let xx = 0; xx < bw; xx++) {
          const o = (by + yy) * W + (bx + xx)
          if (wgt[o] > 0) continue
          const sx = bx + xx + bestDx, sy = by + yy + bestDy
          if (!usable(sx, sy)) continue
          const s = (sy * W + sx) * 4
          rgb[o * 3] = d[s]; rgb[o * 3 + 1] = d[s + 1]; rgb[o * 3 + 2] = d[s + 2]
        }
    }
}


/* ----- backgrounds that repeat -------------------------------------------

   A printed pattern is a motif stamped on a grid. If we can find the grid, the
   fill isn't a reconstruction at all: whatever belongs at a covered pixel is
   already on the page, one period away, and copying it is exact.

   This matters because the classifier above cannot help here. It only sends a
   hole to the texture fill when the marks are BRIGHTER than the ground — a rule
   that exists to stop dark type on light paper being tiled into the erase, and
   which as a side effect disqualifies almost every printed pattern there is,
   since those are dark ink on light stock. They all fall through to the
   diffusion fill, which smooths a tone across the hole. That is the "huge single
   coloured block" over a patterned background.

   The danger in the idea is obvious: a LINE OF TEXT also repeats, at letter
   pitch, and tiling that into a hole would stamp ghost letters everywhere. So
   the offset has to earn it. It must predict the pixels we can already see, to
   within the noise, and it must do so independently in several places across
   the hole — which a real lattice does and a line of type does not, because
   type only looks periodic locally and never agrees on one global offset. If
   nothing passes, nothing changes: the existing fills run exactly as before. */

interface Lattice { dx: number; dy: number }

/**
 * Find the offset at which this background repeats, or null.
 *
 * Scored on RAW luminance, not on the local high-frequency residue. Subtracting
 * a sliding median is the right way to see fine grain, but it erases coarse
 * structure completely — inside a six-pixel stripe the median IS the stripe, the
 * residue is zero, and the most obviously repeating background there is looks
 * like flat paper. Normalised correlation already cancels means and contrast, so
 * the raw signal costs nothing and keeps the stripes.
 */
function findLattices(
  lum: Float32Array, low: Float32Array, wgt: Float32Array,
  W: number, H: number, ix: number, iy: number, iw: number, ih: number,
  grain: number,
): Lattice[] {
  const known = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < W && y < H && wgt[y * W + x] > 0

  const MAXD = Math.min(72, Math.max(W, H) >> 1)
  const MIND = 4
  let cand: { dx: number; dy: number; ncc: number }[] = []
  for (let dy = -MAXD; dy <= MAXD; dy += 2)
    for (let dx = 0; dx <= MAXD; dx += 2) {
      if (dx * dx + dy * dy < MIND * MIND) continue
      let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0
      for (let y = 0; y < H; y += 2)
        for (let x = 0; x < W; x += 2) {
          if (!known(x, y) || !known(x + dx, y + dy)) continue
          const a = lum[y * W + x], b = lum[(y + dy) * W + (x + dx)]
          n++; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b
        }
      if (n < 400) continue
      const va = saa - (sa * sa) / n, vb = sbb - (sb * sb) / n
      if (va <= 1 || vb <= 1) continue // no structure to match at all
      const ncc = (sab - (sa * sb) / n) / Math.sqrt(va * vb)
      if (ncc > 0.8) cand.push({ dx, dy, ncc })
    }
  if (!cand.length) return []
  // Keep every offset that matches as well as the best one, shortest first, and
  // hand them all back. Which of them is USABLE depends on the hole, not on the
  // pattern: a wide shallow erase can be served in one step by a vertical
  // period but needs to march half its width to reach the edge on a diagonal
  // one, and may run out of image on the way. Rather than guess, the caller
  // tries them and keeps the first that covers the hole completely.
  const best = cand.reduce((m, c) => Math.max(m, c.ncc), 0)
  cand = cand.filter((c) => c.ncc >= best - 0.005)
  cand.sort((a, b) => (a.dx * a.dx + a.dy * a.dy) - (b.dx * b.dx + b.dy * b.dy))

  /** RMS of the prediction error at an offset, over the pixels we can see. */
  const rmsAt = (dx: number, dy: number, sx0: number, sx1: number): number | null => {
    let n = 0, se = 0
    for (let y = 0; y < H; y++)
      for (let x = sx0; x < sx1; x++) {
        if (!known(x, y) || !known(x + dx, y + dy)) continue
        const e = lum[y * W + x] - lum[(y + dy) * W + (x + dx)]
        se += e * e; n++
      }
    return n < 60 ? null : Math.sqrt(se / n)
  }

  const strips = 4
  const good: Lattice[] = []
  for (const c of cand.slice(0, 24)) {
    // A wrong offset can still predict a SPARSE pattern well, because most of a
    // dot grid is bare stock and bare stock matches bare stock wherever you put
    // it. So don't just ask whether this offset predicts well — ask whether it
    // predicts much better than a deliberately wrong one, half a period along.
    // A real lattice is far better there; background agreement is not.
    const ref = rmsAt(Math.round(c.dx / 2), Math.round(c.dy / 2), 0, W)
    let agree = 0
    for (let i = 0; i < strips; i++) {
      const sx0 = Math.round((W * i) / strips)
      const sx1 = Math.round((W * (i + 1)) / strips)
      const r = rmsAt(c.dx, c.dy, sx0, sx1)
      if (r === null) continue
      const sharp = ref === null || ref < 1 ? true : r < ref * 0.35
      if (sharp && r < Math.max(3, grain * 2)) agree++
    }
    // and it has to hold across the whole span, not in one lucky place: a line
    // of type correlates with itself at letter pitch locally and never agrees on
    // one offset from end to end
    if (agree >= 3) good.push({ dx: c.dx, dy: c.dy })
    if (good.length >= 6) break
  }
  return good
}

/**
 * Fill the hole by stepping whole periods to the nearest pixel we can trust.
 *
 * "Outside the hole" is not enough to trust a pixel. The erase rect is measured
 * from the ink, and ink has a way of reaching past whatever measured it — a
 * final letter's tail, the soft edge of an accent — so the margin just beyond
 * the rect can still hold a piece of the very text being removed. Copy from
 * there and the pattern fill stamps that piece across the hole again and again:
 * a line erased and replaced with a row of its own last letters.
 *
 * A pixel earns trust by agreeing with the pattern: step one period from it and
 * it should land on something that looks the same. Background does. Text does
 * not, because one period along from a letter is bare stock.
 */
function periodicFill(
  rgb: Float32Array, wgt: Float32Array, d: Uint8ClampedArray,
  W: number, H: number, ix: number, iy: number, iw: number, ih: number,
  lat: Lattice, lum: Float32Array, tol: number,
): number {
  const outside = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < W && y < H && wgt[y * W + x] > 0
  const conforms = (x: number, y: number): boolean => {
    const here = lum[y * W + x]
    // Any whole number of periods will do. The margin around the hole is often
    // narrower than the period itself — a dot grid on a 15px pitch beside a 20px
    // margin — so insisting on the immediate neighbour leaves every pixel in
    // that margin unable to prove anything, and the fill starves on exactly the
    // patterns it was built for.
    for (let n = 1; n <= 20; n++) {
      for (const sgn of [1, -1]) {
        const px = x + sgn * n * lat.dx
        const py = y + sgn * n * lat.dy
        if (!outside(px, py)) continue
        return Math.abs(here - lum[py * W + px]) <= tol
      }
    }
    return false
  }
  // cache, because every hole pixel probes the same handful of source columns
  const trust = new Int8Array(W * H)
  const trusted = (x: number, y: number): boolean => {
    if (!outside(x, y)) return false
    const o = y * W + x
    if (trust[o] === 0) trust[o] = conforms(x, y) ? 1 : -1
    return trust[o] === 1
  }

  let filled = 0
  for (let y = iy; y < iy + ih; y++)
    for (let x = ix; x < ix + iw; x++) {
      const o = y * W + x
      if (wgt[o] > 0) continue
      for (let n = 1; n <= 40; n++) {
        let done = false
        for (const sgn of [1, -1]) {
          const sx = x + sgn * n * lat.dx
          const sy = y + sgn * n * lat.dy
          if (!trusted(sx, sy)) continue
          const s = (sy * W + sx) * 4
          rgb[o * 3] = d[s]; rgb[o * 3 + 1] = d[s + 1]; rgb[o * 3 + 2] = d[s + 2]
          filled++; done = true
          break
        }
        if (done) break
      }
    }
  return filled
}

/**
 * Trusted paper must be reachable from the working-region border: interiors of
 * thick display-glyph strokes can fool any fixed median window into reading
 * them as "paper", but they are always ISLANDS enclosed by their own edges.
 * Demotes unreachable valid pixels in place.
 */
function keepBorderConnected(valid: Uint8Array, W: number, H: number): void {
  const seen = new Uint8Array(valid.length)
  const queue = new Int32Array(valid.length)
  let head = 0
  let tail = 0
  const push = (o: number) => {
    if (!seen[o] && valid[o]) {
      seen[o] = 1
      queue[tail++] = o
    }
  }
  for (let x = 0; x < W; x++) {
    push(x)
    push((H - 1) * W + x)
  }
  for (let y = 0; y < H; y++) {
    push(y * W)
    push(y * W + W - 1)
  }
  while (head < tail) {
    const o = queue[head++]
    const x = o % W
    if (x > 0) push(o - 1)
    if (x < W - 1) push(o + 1)
    if (o >= W) push(o - W)
    if (o < (H - 1) * W) push(o + W)
  }
  for (let i = 0; i < valid.length; i++) if (valid[i] && !seen[i]) valid[i] = 0
}

/**
 * Fill weight-0 pixels by shooting rays to the nearest trusted pixels in 16
 * directions, weighted hard toward the closest hits (1/d³). Nearest-dominated
 * gathering continues bands and follows gradient iso-lines instead of
 * averaging the whole surroundings into mud; the Jacobi passes afterwards
 * iron out the residual ray structure.
 */
function shootFill(rgb: Float32Array, wgt: Float32Array, W: number, H: number, fallback: number[]): void {
  const DIRS = 16
  const dirs: [number, number][] = []
  for (let a = 0; a < DIRS; a++) dirs.push([Math.cos((a * 2 * Math.PI) / DIRS), Math.sin((a * 2 * Math.PI) / DIRS)])
  const maxSteps = Math.min(W + H, 320) // bound ray length so a long-thin erase cannot hang
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const o = y * W + x
      if (wgt[o] > 0) continue
      let sw = 0
      let r = 0, g = 0, b = 0
      let nearS = Infinity, nr = fallback[0], ng = fallback[1], nb = fallback[2]
      for (const [dx, dy] of dirs) {
        let fx = x, fy = y
        for (let s = 1; s <= maxSteps; s++) {
          fx += dx
          fy += dy
          const xi = Math.round(fx), yi = Math.round(fy)
          if (xi < 0 || yi < 0 || xi >= W || yi >= H) break
          const q = yi * W + xi
          if (wgt[q] > 0) {
            const w = 1 / (s * s * s)
            sw += w
            r += rgb[q * 3] * w
            g += rgb[q * 3 + 1] * w
            b += rgb[q * 3 + 2] * w
            if (s < nearS) { nearS = s; nr = rgb[q * 3]; ng = rgb[q * 3 + 1]; nb = rgb[q * 3 + 2] }
            break
          }
        }
      }
      if (sw > 0) {
        const mr = r / sw, mg = g / sw, mb = b / sw
        // when the surrounding colours disagree (a sharp boundary), lean toward
        // the nearest one so the edge stays crisp; when they agree (a gradient),
        // the smooth weighted mean wins
        const disagree = Math.max(Math.abs(nr - mr), Math.abs(ng - mg), Math.abs(nb - mb))
        const a = Math.max(0, Math.min(0.7, (disagree - 6) / 34))
        rgb[o * 3] = nr * a + mr * (1 - a)
        rgb[o * 3 + 1] = ng * a + mg * (1 - a)
        rgb[o * 3 + 2] = nb * a + mb * (1 - a)
      } else {
        rgb[o * 3] = fallback[0]
        rgb[o * 3 + 1] = fallback[1]
        rgb[o * 3 + 2] = fallback[2]
      }
    }
}

/**
 * A few edge-preserving (bilateral) Jacobi passes — irons out ray/pyramid
 * blockiness in smooth regions without blurring across a sharp colour boundary
 * that shootFill deliberately kept crisp.
 */
function relaxFill(rgb: Float32Array, wgt: Float32Array, W: number, H: number, iters: number): void {
  for (let it = 0; it < iters; it++) {
    const src = rgb.slice()
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const o = y * W + x
        if (wgt[o] > 0) continue
        const cr = src[o * 3], cg = src[o * 3 + 1], cb = src[o * 3 + 2]
        let wsum = 0, r = 0, g = 0, b = 0
        const add = (p: number) => {
          const d = Math.abs(src[p] - cr) + Math.abs(src[p + 1] - cg) + Math.abs(src[p + 2] - cb)
          const w = d > 60 ? 0.05 : 1 // don't average across a strong edge
          wsum += w; r += src[p] * w; g += src[p + 1] * w; b += src[p + 2] * w
        }
        if (x > 0) add(o * 3 - 3)
        if (x < W - 1) add(o * 3 + 3)
        if (y > 0) add((o - W) * 3)
        if (y < H - 1) add((o + W) * 3)
        if (wsum > 0) {
          rgb[o * 3] = r / wsum
          rgb[o * 3 + 1] = g / wsum
          rgb[o * 3 + 2] = b / wsum
        }
      }
  }
}

/**
 * Build a patch that disappears into the surroundings, whatever they are.
 * Flat grain-free paper gets a single sampled color; everything else gets an
 * inpainted image reconstructed from the ink-free pixels around the region.
 */
export function makeBlendedPatch(
  canvas: HTMLCanvasElement,
  rect: Rect,
  pageW: number,
  /** how far above and below the rect is free of other content, in points */
  clearAbove?: number,
  clearBelow?: number,
): { color: string; src?: string; w?: number; h?: number } {
  const flat = { color: samplePaperColor(canvas, rect, pageW) }
  try {
    const k = canvas.width / pageW
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return flat
    const rx = Math.max(0, Math.round(rect.x * k))
    const ry = Math.max(0, Math.round(rect.y * k))
    const rw = Math.min(canvas.width - rx, Math.max(2, Math.round(rect.w * k)))
    const rh = Math.min(canvas.height - ry, Math.max(2, Math.round(rect.h * k)))
    if (rw < 2 || rh < 2) return flat

    // The frame around the hole is the ONLY material a textured fill has to work
    // from, so it has to be a real sample of the background, not a hairline. A
    // fixed 10pt margin left a 15px frame around a hole ten times that wide,
    // and the fill could do nothing but repeat those few pixels. Scale it with
    // the hole, capped so a full-page erase doesn't read the whole page.
    const pad = Math.round(Math.min(60 * k, Math.max(10 * k, Math.min(rw, rh) * 0.9)))
    // Vertically, only look as far as the caller says is safe.
    //
    // The fill takes its material from around the hole, and on a textured
    // background it trusts everything there — which is right for grain and
    // disastrous next to another line of type. Erasing a subtitle on a banner
    // reaches up into the headline and down into the date, and mirrors pieces of
    // both into the gap: pale fragments scattered where the words were, looking
    // for all the world like debris the erase failed to remove, when in fact the
    // fill imported them.
    //
    // Telling letters from speckles by size does not work here — on a dense
    // field the specks touch and form masses as large as any letter, and
    // excluding those starves the fill until it returns blank paper. Not looking
    // at the neighbours in the first place does work, and needs no classifier.
    const padUp = Math.min(pad, Math.round((clearAbove ?? Infinity) * k))
    const padDown = Math.min(pad, Math.round((clearBelow ?? Infinity) * k))
    // Take back sideways what was given up vertically. A line of type is a
    // horizontal slot: the background on its OWN rows, to the left and to the
    // right, is the same background and holds no other line — so when the
    // neighbours force the window shut from above and below, open it wider
    // instead and the fill has plenty to work from.
    const squeezed = padUp < pad || padDown < pad
    const padX = squeezed ? Math.max(pad, Math.round(rh * 3)) : pad
    const x0 = Math.max(0, rx - padX)
    const y0 = Math.max(0, ry - padUp)
    // huge erases reconstruct at reduced resolution — the patch is stretched
    // over the rect anyway, and ray marching is O(hole px × distance)
    const f = Math.max(1, Math.ceil(Math.sqrt((rw * rh) / 45000)))
    let W = Math.min(canvas.width, rx + rw + padX) - x0
    let H = Math.min(canvas.height, ry + rh + padDown) - y0
    let d: Uint8ClampedArray
    if (f > 1) {
      const wc = document.createElement('canvas')
      wc.width = Math.max(8, Math.round(W / f))
      wc.height = Math.max(8, Math.round(H / f))
      const wcx = wc.getContext('2d', { willReadFrequently: true })!
      wcx.drawImage(canvas, x0, y0, W, H, 0, 0, wc.width, wc.height)
      d = wcx.getImageData(0, 0, wc.width, wc.height).data
      W = wc.width
      H = wc.height
    } else {
      d = ctx.getImageData(x0, y0, W, H).data
    }
    const N = W * H
    if (N < 64) return flat

    const lum = new Float32Array(N)
    const lum8 = new Uint8ClampedArray(N)
    for (let i = 0; i < N; i++) {
      lum[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]
      lum8[i] = lum[i]
    }
    // ink departs from the local page tone; the sliding median IS the page
    // tone. Two scales: display-size glyph strokes are WIDER than a small
    // median window, so their interiors read as "paper" at r=5 — the wide
    // window catches them. Paper must be consistent at both.
    const low = slidingMedian(lum8, W, H, 5)
    const low2 = slidingMedian(lum8, W, H, 11)
    const thr = inkThreshold(grainLevel(lum, low, N), 13)
    const ink = new Uint8Array(N)
    for (let i = 0; i < N; i++) if (Math.abs(lum[i] - low[i]) > thr || Math.abs(lum[i] - low2[i]) > thr) ink[i] = 1
    // tiny isolated blobs are the background's own texture (speckles/grain/photo),
    // not text — keep them so the ring survives and the texture can be rebuilt
    removeSmallInk(ink, W, H, Math.max(6, Math.round((W * H) / 1400)))
    dilateMask(ink, W, H, 2)

    const ix = Math.round((rx - x0) / f)
    const iy = Math.round((ry - y0) / f)
    const iw = Math.min(W - ix, Math.max(1, Math.round(rw / f)))
    const ih = Math.min(H - iy, Math.max(1, Math.round(rh / f)))
    // Decide "reproduce the texture" (mirror) vs "diffuse the tone" (the safe fill
    // that excludes ink). Two signals over the surround (the frame around the hole):
    //  hf = mean |lum − median5| — high for discrete texture (a starfield, grain),
    //       ~0 for a smooth gradient / colour split / stripe even when its edges
    //       make a large ink fraction; density rides along (dense field ≫ sparse).
    //  energy direction — the texture worth reproducing here is the page's own
    //       BRIGHT speck field on a darker base (the banner), whose above-median
    //       energy dominates; DARK marks on a light page are TEXT (a neighbouring
    //       line caught in the frame) — reproducing those would tile glyphs in, so
    //       they go to the diffusion fill, which drops ink instead.
    //  Measured in vertical STRIPS, and the verdict is the strongest strip, not
    //  the average. A line of text is long: this hole runs from bare panel at one
    //  end into the thick of the starfield at the other. Averaged over the whole
    //  frame the bare end outvotes the dense one, the fill goes to diffusion, and
    //  the dense end comes out as a flat slab with the erase box's corners
    //  showing. Texture anywhere in the surround means the hole needs mirroring —
    //  and mirroring a smooth stretch just reproduces the smoothness, so the
    //  quiet strips lose nothing by it. Direction stays global: it is the guard
    //  against tiling a neighbouring line of type into the hole, and that risk
    //  isn't local to a strip.
    const strip = Math.max(8, Math.min(W, ih))
    const nStrip = Math.max(1, Math.ceil(W / strip))
    const sE = new Float64Array(nStrip), sN = new Float64Array(nStrip)
    let brightE = 0, darkE = 0
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const inHole = x >= ix && x < ix + iw && y >= iy && y < iy + ih
        if (inHole) continue
        const dv = lum[y * W + x] - low[y * W + x]
        const si = Math.min(nStrip - 1, (x / strip) | 0)
        sE[si] += Math.abs(dv); sN[si]++
        if (dv > 0) brightE += dv; else darkE -= dv
      }
    let hfPeak = 0
    for (let i = 0; i < nStrip; i++) if (sN[i] >= 24) hfPeak = Math.max(hfPeak, sE[i] / sN[i])
    const textured = hfPeak >= 2.5 && brightE > darkE
    // Solid strokes = LETTERS. Texture is porous and vanishes under a 3x3
    // erosion; a printed stroke survives. Only used where the colour axis below
    // can't describe the background — where it can, it is the better test.
    const solidInk = new Uint8Array(N)
    if (textured) {
      for (let y = 1; y < H - 1; y++)
        for (let x = 1; x < W - 1; x++) {
          const o = y * W + x
          if (!ink[o]) continue
          if (ink[o - 1] && ink[o + 1] && ink[o - W] && ink[o + W] &&
              ink[o - W - 1] && ink[o - W + 1] && ink[o + W - 1] && ink[o + W + 1]) solidInk[o] = 1
        }
    }

    // A patterned panel is a TWO-COLOUR system: one base tone with one mark
    // scattered over it — navy with pale blue stars, paper with grey grain — and
    // every pixel of it, antialiased edges included, lies on the line between
    // those two colours. Foreign content does not. The green subheading below
    // this heading sits inside the starfield's brightness range, so no tonal
    // test can refuse it, but it is nowhere near the navy-to-star axis, and
    // neither is the cream of the heading's own letters.
    //
    // Read both ends off the surround and let the mirror copy only what lies
    // along that axis. Then check the model actually describes this background
    // before trusting it: on a photo, or anything else with real colour variety,
    // most of the surround will sit off the axis, and the test is dropped rather
    // than rejecting everything and leaving a flat slab behind.
    let axis: { br: number; bg: number; bb: number; tr: number; tg: number; tb: number } | null = null
    if (textured) {
      const sl: number[] = []
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const inHole = x >= ix && x < ix + iw && y >= iy && y < iy + ih
          if (!inHole) sl.push(lum[y * W + x])
        }
      if (sl.length > 64) {
        const sorted = sl.slice().sort((a, b) => a - b)
        const midL = sorted[sorted.length >> 1]
        const hiL = sorted[Math.floor(sorted.length * 0.92)]
        const acc = (test: (l: number) => boolean) => {
          const rr: number[] = [], gg: number[] = [], bb: number[] = []
          for (let y = 0; y < H; y++)
            for (let x = 0; x < W; x++) {
              const inHole = x >= ix && x < ix + iw && y >= iy && y < iy + ih
              if (inHole) continue
              const o = y * W + x
              if (!test(lum[o])) continue
              rr.push(d[o * 4]); gg.push(d[o * 4 + 1]); bb.push(d[o * 4 + 2])
            }
          if (rr.length < 8) return null
          const m = (a: number[]) => { a.sort((x, y) => x - y); return a[a.length >> 1] }
          return [m(rr), m(gg), m(bb)] as [number, number, number]
        }
        const base = acc((l) => l <= midL)
        const mark = acc((l) => l >= hiL)
        if (base && mark) {
          const cand = { br: base[0], bg: base[1], bb: base[2], tr: mark[0], tg: mark[1], tb: mark[2] }
          let on = 0, tot = 0
          for (let y = 0; y < H; y++)
            for (let x = 0; x < W; x++) {
              const inHole = x >= ix && x < ix + iw && y >= iy && y < iy + ih
              if (inHole) continue
              const o = y * W + x
              tot++
              if (offAxis(d[o * 4], d[o * 4 + 1], d[o * 4 + 2], cand) <= 60) on++
            }
          if (tot > 0 && on / tot >= 0.85) axis = cand
        }
      }
    }
    const valid = new Uint8Array(N)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const o = y * W + x
        const inHole = x >= ix && x < ix + iw && y >= iy && y < iy + ih
        if (!inHole && (textured || !ink[o])) valid[o] = 1
      }
    keepBorderConnected(valid, W, H)
    const rgb = new Float32Array(N * 3)
    // Does this background simply REPEAT?
    //
    // Ask before deciding what counts as ink, because on a patterned background
    // that decision is the thing that goes wrong: the pattern's own marks get
    // taken for ink and excluded, the trusted ring is left holding nothing but
    // bare stock, and the fill concludes the background is a flat colour and
    // paints one. That is the block over the pattern. Here there is nothing to
    // classify — if the page repeats at some offset, whatever belongs under the
    // words is already on it, one period away, and copying it is exact.
    {
      const known = new Float32Array(N)
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const inHole = x >= ix && x < ix + iw && y >= iy && y < iy + ih
          known[y * W + x] = inHole ? 0 : 1
        }
      for (const lat of findLattices(lum, low, known, W, H, ix, iy, iw, ih, grainLevel(lum, low, N))) {
        const rgbP = new Float32Array(N * 3)
        for (let i = 0; i < N; i++) { rgbP[i * 3] = d[i * 4]; rgbP[i * 3 + 1] = d[i * 4 + 1]; rgbP[i * 3 + 2] = d[i * 4 + 2] }
        // All of it, or none of it. A partial periodic fill leaves the pixels it
        // couldn't reach holding their ORIGINAL contents — which is the text we
        // are erasing — so "mostly filled" means "mostly erased", with fragments
        // of the old words still standing.
        if (periodicFill(rgbP, known, d, W, H, ix, iy, iw, ih, lat, lum, Math.max(6, grainLevel(lum, low, N) * 3)) >= iw * ih) {
          return emitPatch(rgbP, flat, W, ix, iy, iw, ih, f, k, rect)
        }
      }
    }

    const wgt = new Float32Array(N)
    const ring: number[] = [] // trusted paper pixels around the hole
    for (let o = 0; o < N; o++) {
      rgb[o * 3] = d[o * 4]
      rgb[o * 3 + 1] = d[o * 4 + 1]
      rgb[o * 3 + 2] = d[o * 4 + 2]
      if (valid[o]) {
        wgt[o] = 1
        ring.push(o)
      }
    }
    if (ring.length < 30) return flat

    /* Don't copy from the NEXT LINE OF TYPE.
       The window around a hole is padded by a good fraction of the hole's own
       height, which on tightly-set artwork reaches the line above or below — a
       subtitle sits six points under its headline and the window opens thirteen.
       Ink detection does not save us there: on a dark banner strewn with pale
       specks, a line of white lettering looks like more of the same texture, so
       it is taken for background and mirrored into the hole. What comes back is
       a scatter of bright fragments where the words used to be, which is exactly
       what an erase is supposed not to leave.
       A line of type gives itself away by density: it is far more marked than
       the background it sits on, and it says so row by row. */
    {
      const outside: number[] = []
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          if (x >= ix && x < ix + iw && y >= iy && y < iy + ih) continue
          if (wgt[y * W + x] > 0) outside.push(Math.abs(lum[y * W + x] - low[y * W + x]))
        }
      if (outside.length >= 60) {
        const sorted = [...outside].sort((a, b) => a - b)
        const hi = sorted[Math.floor(sorted.length * 0.9)]
        const cut = Math.max(6, hi * 1.6)
        const rowScore: number[] = []
        for (let y = 0; y < H; y++) {
          let n = 0, m = 0
          for (let x = 0; x < W; x++) {
            if (x >= ix && x < ix + iw && y >= iy && y < iy + ih) continue
            if (wgt[y * W + x] <= 0) continue
            m++
            if (Math.abs(lum[y * W + x] - low[y * W + x]) > cut) n++
          }
          rowScore.push(m >= 8 ? n / m : 0)
        }
        const typical = median(rowScore.filter((v) => v > 0)) || 0
        for (let y = 0; y < H; y++) {
          // three times as marked as a typical row, and marked enough to matter
          if (rowScore[y] > Math.max(0.12, typical * 3)) {
            for (let x = 0; x < W; x++) wgt[y * W + x] = 0
          }
        }
      }
    }

    // flat AND grain-free paper? the sampled color is pixel-identical and tiny
    const med = [0, 1, 2].map((c) => median(ring.map((o) => rgb[o * 3 + c])))
    const dev = ring
      .map((o) => Math.max(Math.abs(rgb[o * 3] - med[0]), Math.abs(rgb[o * 3 + 1] - med[1]), Math.abs(rgb[o * 3 + 2] - med[2])))
      .sort((a, b) => a - b)
    const spread = dev[Math.floor(dev.length * 0.98)]
    let g = 0
    for (const o of ring) g += Math.abs(lum[o] - low[o])
    const grain = g / ring.length
    if (spread < 8 && grain < 1.2) return flat

    // textured background: floor the hole with the ring's MEDIAN tone (robust —
    // never a stray white margin or neighbour, unlike a diffused per-pixel mean),
    // then mirror the real surrounding texture across the hole edges so discrete
    // dots come back with their true structure and local density. Only genuine
    // bright-speck texture takes this path; grain / gradients / smooth paper use
    // the diffusion fill, which excludes ink (so an overflowing erased glyph in
    // the surround can't be tiled back in).
    if (textured) {
      for (let o = 0; o < N; o++) { if (wgt[o] > 0) continue; rgb[o * 3] = med[0]; rgb[o * 3 + 1] = med[1]; rgb[o * 3 + 2] = med[2] }
      const surLum: number[] = []
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const inHole = x >= ix && x < ix + iw && y >= iy && y < iy + ih
          if (!inHole) surLum.push(lum[y * W + x])
        }
      const [lo, hi] = lumRange(surLum)
      // The colour axis is the better test for "not this background" wherever it
      // applies: it refuses foreign content however fine its strokes are, and
      // accepts the texture however densely it is packed. The erosion can do
      // neither — in the thick of a speckled field its clumps read as strokes,
      // and the fill starves. Keep it only for backgrounds the axis can't
      // describe, where a solid stroke is the one signal left.
      mirrorFill(rgb, wgt, d, W, H, ix, iy, iw, ih, lo, hi, axis ? undefined : solidInk, axis)
    } else {
      shootFill(rgb, wgt, W, H, med)
      relaxFill(rgb, wgt, W, H, 2)
    }

    return emitPatch(rgb, flat, W, ix, iy, iw, ih, f, k, rect)
  } catch {
    return flat
  }
}

/** Crop the reconstructed working buffer to the hole and hand it back as a patch. */
function emitPatch(
  rgb: Float32Array, flat: { color: string }, W: number,
  ix: number, iy: number, iw: number, ih: number,
  f: number, k: number, rect: Rect,
): { color: string; src: string; w?: number; h?: number } {
  {
    const out = document.createElement('canvas')
    out.width = iw
    out.height = ih
    const octx = out.getContext('2d')!
    const img = octx.createImageData(iw, ih)
    for (let y = 0; y < ih; y++)
      for (let x = 0; x < iw; x++) {
        const src = ((y + iy) * W + (x + ix)) * 3
        const dst = (y * iw + x) * 4
        img.data[dst] = Math.max(0, Math.min(255, Math.round(rgb[src])))
        img.data[dst + 1] = Math.max(0, Math.min(255, Math.round(rgb[src + 1])))
        img.data[dst + 2] = Math.max(0, Math.min(255, Math.round(rgb[src + 2])))
        img.data[dst + 3] = 255
      }
    octx.putImageData(img, 0, 0)
    // the src covers only the on-canvas part of the rect — hand back its real
    // view-space size so the caller doesn't stretch a clamped PNG over the
    // full (page-edge-overflowing) rect
    const coverW = (iw * f) / k
    const coverH = (ih * f) / k
    const clamped = coverW < rect.w - 0.5 || coverH < rect.h - 0.5
    return { ...flat, src: out.toDataURL('image/png'), ...(clamped ? { w: coverW, h: coverH } : {}) }
  }
}

/**
 * Trim a detected ink band down to the run that was actually clicked, by colour.
 *
 * Row detection asks "is this pixel background?", which is the right question on
 * paper and the wrong one on decorated artwork. A banner scattered with pale
 * specks answers yes across its whole width, so the band holding a subtitle runs
 * from the subtitle out through several hundred points of drifting particles,
 * and the erase dutifully covers the lot: a couple of words removed and a large
 * rectangle of scenery removed along with them.
 *
 * The letters have a colour, though, and the scenery does not share it — green
 * type on a blue field strewn with white dots. So keep the columns that hold ink
 * of the CLICKED run's colour, and take the stretch of them that the click sits
 * in, bridging the gaps between words but not the gap out into the decoration.
 */
export function narrowBandToRun(
  canvas: HTMLCanvasElement,
  band: Rect,
  pageW: number,
  clickX: number,
  inkHex: string,
): Rect {
  try {
    const k = canvas.width / pageW
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return band
    const x = Math.max(0, Math.round(band.x * k))
    const y = Math.max(0, Math.round(band.y * k))
    const w = Math.min(canvas.width - x, Math.round(band.w * k))
    const h = Math.min(canvas.height - y, Math.round(band.h * k))
    if (w < 4 || h < 2) return band
    const d = ctx.getImageData(x, y, w, h).data
    const ink = [
      parseInt(inkHex.slice(1, 3), 16),
      parseInt(inkHex.slice(3, 5), 16),
      parseInt(inkHex.slice(5, 7), 16),
    ]
    // generous on brightness, strict on hue: antialiasing changes how light a
    // letter's edge is, never what colour it is
    const holds = new Uint8Array(w)
    for (let px = 0; px < w; px++) {
      let n = 0
      for (let py = 0; py < h; py++) {
        const i = (py * w + px) * 4
        const dr = d[i] - ink[0], dg = d[i + 1] - ink[1], db = d[i + 2] - ink[2]
        if (Math.abs(dr) <= 60 && Math.abs(dg) <= 60 && Math.abs(db) <= 60) n++
      }
      if (n >= Math.max(1, Math.round(h * 0.06))) holds[px] = 1
    }
    const cx = Math.round(clickX * k) - x
    if (cx < 0 || cx >= w) return band
    // a word space is about a quarter of the line's height; anything wider is
    // the run ending
    const bridge = Math.max(2, Math.round(h * 0.55))
    let lo = cx, hi = cx
    if (!holds[cx]) {
      let found = -1
      for (let r = 1; r <= bridge * 2 && found < 0; r++) {
        if (cx - r >= 0 && holds[cx - r]) found = cx - r
        else if (cx + r < w && holds[cx + r]) found = cx + r
      }
      if (found < 0) return band
      lo = hi = found
    }
    for (;;) {
      let n = lo - 1
      while (n >= 0 && lo - n <= bridge && !holds[n]) n--
      if (n >= 0 && holds[n]) { lo = n; continue }
      break
    }
    for (;;) {
      let n = hi + 1
      while (n < w && n - hi <= bridge && !holds[n]) n++
      if (n < w && holds[n]) { hi = n; continue }
      break
    }
    if (hi - lo < 2) return band

    // Follow the letter out to its faint edge.
    //
    // A column counts as part of the run when a few per cent of its height
    // matches the ink colour — a fair test for a stroke, too strict for the
    // antialiased column beside it, which is half background and passes nothing.
    // Stopping there leaves the outermost sliver of the first and last letters
    // standing: on this banner, one column of green exactly where the L was,
    // half a point outside the erase and perfectly visible.
    //
    // So having found the run by its solid columns, walk outwards while there is
    // still any trace of that colour, judged loosely. A couple of columns is all
    // a glyph edge ever needs, which is also short enough not to wander into
    // whatever sits alongside.
    // The edge column is not judged by colour, because it hasn't much of the
    // ink's colour left in it. Half background by area, an antialiased column
    // beside a green stroke on a blue field is nearer the blue than the green —
    // no tolerance picks it up without also picking up the field itself.
    // What IS true of it is that it is not background. So take the background's
    // own colour, here, between the letters, and step outwards while the column
    // still departs from it.
    const bg = (() => {
      const rs: number[] = [], gs: number[] = [], bs: number[] = []
      for (let py = 0; py < h; py += 2)
        for (let pxx = 0; pxx < w; pxx += 2) {
          const i = (py * w + pxx) * 4
          rs.push(d[i]); gs.push(d[i + 1]); bs.push(d[i + 2])
        }
      const mid = (a: number[]) => a.sort((p, q) => p - q)[a.length >> 1]
      return [mid(rs), mid(gs), mid(bs)]
    })()
    const trace = (col: number): boolean => {
      if (col < 0 || col >= w) return false
      for (let py = 0; py < h; py++) {
        const i = (py * w + col) * 4
        const dev = Math.max(Math.abs(d[i] - bg[0]), Math.abs(d[i + 1] - bg[1]), Math.abs(d[i + 2] - bg[2]))
        if (dev > 26) return true
      }
      return false
    }
    let lo2 = lo, hi2 = hi
    for (let n = 0; n < 3 && trace(lo2 - 1); n++) lo2--
    for (let n = 0; n < 3 && trace(hi2 + 1); n++) hi2++
    return { x: (x + lo2) / k, y: band.y, w: (hi2 - lo2 + 1) / k, h: band.h }
  } catch {
    return band
  }
}

/** The ink color inside a text region: median of the darkest pixel cluster. */
export function sampleInkColor(canvas: HTMLCanvasElement, rect: Rect, pageW: number): string {
  try {
    const k = canvas.width / pageW
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return '#111111'
    const x = Math.max(0, Math.round(rect.x * k))
    const y = Math.max(0, Math.round(rect.y * k))
    const w = Math.min(canvas.width - x, Math.max(2, Math.round(rect.w * k)))
    const h = Math.min(canvas.height - y, Math.max(2, Math.round(rect.h * k)))
    const d = ctx.getImageData(x, y, w, h).data
    const lum = (i: number) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
    let minL = 255, maxL = 0
    for (let i = 0; i < d.length; i += 4) {
      const l = lum(i)
      if (l < minL) minL = l
      if (l > maxL) maxL = l
    }
    if (maxL - minL < 20) return '#111111' // no visible ink here

    // Which of the two tones is the INK, and which is the surface it sits on?
    //
    // Counting them and calling the smaller one the ink is nearly always right
    // and spectacularly wrong when it isn't. A line of body copy inks a few per
    // cent of its box, so the count settles it. But the box here is trimmed to
    // the letters, and a name set in 50pt bold caps fills more than half of that
    // — so the vote inverts, the paper is taken for the ink, and the words are
    // reprinted in the colour of the page. They do not look wrong. They are not
    // there at all.
    //
    // Ask the surround instead. Whatever borders the run is the surface, by
    // definition, whether that is white stock or a dark blue banner; the ink is
    // then whichever extreme lies further from it. No counting, and no
    // assumption about how much of its line a letter is entitled to cover.
    const frame = Math.max(2, Math.round(Math.min(w, h) * 0.35))
    const fx0 = Math.max(0, x - frame), fy0 = Math.max(0, y - frame)
    const fw = Math.min(canvas.width - fx0, w + frame * 2)
    const fh = Math.min(canvas.height - fy0, h + frame * 2)
    const fd = ctx.getImageData(fx0, fy0, fw, fh).data
    const surround: number[] = []
    for (let py = 0; py < fh; py++)
      for (let px = 0; px < fw; px++) {
        const insideRun = px + fx0 >= x && px + fx0 < x + w && py + fy0 >= y && py + fy0 < y + h
        if (insideRun) continue
        const i = (py * fw + px) * 4
        surround.push(0.2126 * fd[i] + 0.7152 * fd[i + 1] + 0.0722 * fd[i + 2])
      }
    let inkIsDark: boolean
    if (surround.length >= 24) {
      const paperL = median(surround)
      inkIsDark = Math.abs(minL - paperL) > Math.abs(maxL - paperL)
    } else {
      // hemmed in on every side (page edge, or a run that fills its frame):
      // fall back to the count, which is right whenever it can be checked
      const mid = (minL + maxL) / 2
      let darkCount = 0, total = 0
      for (let i = 0; i < d.length; i += 4) { total++; if (lum(i) <= mid) darkCount++ }
      inkIsDark = darkCount / total <= 0.5
    }
    const cut = inkIsDark ? minL + (maxL - minL) * 0.3 : maxL - (maxL - minL) * 0.3
    const isInk = new Uint8Array(w * h)
    for (let j = 0; j < w * h; j++) {
      const l = lum(j * 4)
      if (inkIsDark ? l <= cut : l >= cut) isInk[j] = 1
    }
    // Sample the CORE of the strokes, not their edges.
    //
    // Every glyph is surrounded by a ring of antialiasing — pixels that are part
    // ink, part paper. Averaging those in with the rest drags the sampled colour
    // toward the background, and the reprint comes out visibly weaker than the
    // print beside it: right hue, wrong strength, which reads as faded rather
    // than as a different colour. Keep only pixels whose neighbours are also
    // ink, so the blend at the boundary is excluded.
    const core: number[] = []
    for (let py = 1; py < h - 1; py++)
      for (let px = 1; px < w - 1; px++) {
        const j = py * w + px
        if (!isInk[j] || !isInk[j - 1] || !isInk[j + 1] || !isInk[j - w] || !isInk[j + w]) continue
        core.push(j)
      }
    // hairline type may have no interior at all — then the edges are all there is
    const picked = core.length >= 12 ? core : (() => {
      const all: number[] = []
      for (let j = 0; j < w * h; j++) if (isInk[j]) all.push(j)
      return all
    })()
    const rs: number[] = [], gs: number[] = [], bs: number[] = []
    for (const j of picked) { rs.push(d[j * 4]); gs.push(d[j * 4 + 1]); bs.push(d[j * 4 + 2]) }
    if (!rs.length) return '#111111'
    const hex = (n: number) => n.toString(16).padStart(2, '0')

    // LAST GUARD: never hand back the colour of the paper.
    //
    // Everything above is a judgement about which of two tones is the ink, and
    // it can be wrong. On a coloured panel with darker lines above and below,
    // the surround frame reaches into those neighbours, the median comes out
    // dark, and the lighter tone — the panel itself — wins the comparison. The
    // reprint is then set in the background colour: the words are erased, drawn
    // again in the colour of the thing behind them, and vanish. The app called
    // that a match.
    //
    // Whatever the sampler decided, a colour indistinguishable from the surface
    // is not an answer, so take the other extreme instead. It cannot make a
    // correct sample worse — a correct one is nowhere near the paper.
    const inkR = median(rs), inkG = median(gs), inkB = median(bs)
    if (surround.length >= 24) {
      const paperL = median(surround)
      const inkL = 0.2126 * inkR + 0.7152 * inkG + 0.0722 * inkB
      if (Math.abs(inkL - paperL) < 18) {
        const flipped: number[] = []
        for (let j = 0; j < w * h; j++) {
          const l = lum(j * 4)
          if (inkIsDark ? l >= maxL - (maxL - minL) * 0.3 : l <= minL + (maxL - minL) * 0.3) flipped.push(j)
        }
        if (flipped.length >= 12) {
          const fr: number[] = [], fg: number[] = [], fb: number[] = []
          for (const j of flipped) { fr.push(d[j * 4]); fg.push(d[j * 4 + 1]); fb.push(d[j * 4 + 2]) }
          const fl = 0.2126 * median(fr) + 0.7152 * median(fg) + 0.0722 * median(fb)
          if (Math.abs(fl - paperL) > Math.abs(inkL - paperL)) {
            return `#${hex(median(fr))}${hex(median(fg))}${hex(median(fb))}`
          }
        }
      }
    }
    return `#${hex(inkR)}${hex(inkG)}${hex(inkB)}`
  } catch {
    return '#111111'
  }
}

export function samplePaperColor(canvas: HTMLCanvasElement, rect: Rect, pageW: number): string {
  try {
    if (canvas.width === 0) return '#FFFFFF'
    const k = canvas.width / pageW
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return '#FFFFFF'
    const pad = 3 * k
    const x = Math.max(0, rect.x * k - pad)
    const y = Math.max(0, rect.y * k - pad)
    const w = Math.min(canvas.width - x, rect.w * k + pad * 2)
    const h = Math.min(canvas.height - y, rect.h * k + pad * 2)
    if (w < 2 || h < 2) return '#FFFFFF'
    const strips = [
      ctx.getImageData(x, y, w, 1).data,
      ctx.getImageData(x, Math.min(canvas.height - 1, y + h - 1), w, 1).data,
      ctx.getImageData(x, y, 1, h).data,
      ctx.getImageData(Math.min(canvas.width - 1, x + w - 1), y, 1, h).data,
    ]
    const rs: number[] = [], gs: number[] = [], bs: number[] = []
    for (const d of strips) {
      for (let i = 0; i < d.length; i += 4) {
        rs.push(d[i]); gs.push(d[i + 1]); bs.push(d[i + 2])
      }
    }
    const med = (a: number[]) => {
      a.sort((p, q) => p - q)
      return a[Math.floor(a.length / 2)] ?? 255
    }
    const hex = (n: number) => n.toString(16).padStart(2, '0')
    return `#${hex(med(rs))}${hex(med(gs))}${hex(med(bs))}`
  } catch {
    return '#FFFFFF'
  }
}


/* ----- pixel text detection (pages with no text layer) --------------------------
   Posters, scans, and outlined-vector PDFs have no spans to align with, but the
   print is still right there in the pixels. Ink = departure from the sliding-
   median page tone (same classifier the inpainter trusts); its row projection
   yields the text bands — position, height, left edge — everything blending
   needs. */

export interface InkBand {
  x: number
  right: number
  y: number
  h: number
}

/** Detect printed text-row bands around a view-space rect. Coordinates in view space. */
export function detectInkBands(canvas: HTMLCanvasElement, around: Rect, pageW: number): InkBand[] {
  try {
    const k = canvas.width / pageW
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return []
    const x0 = Math.max(0, Math.round((around.x - 150) * k))
    const y0 = Math.max(0, Math.round((around.y - 110) * k))
    const x1 = Math.min(canvas.width, Math.round((around.x + around.w + 150) * k))
    const y1 = Math.min(canvas.height, Math.round((around.y + around.h + 110) * k))
    const W = x1 - x0
    const H = y1 - y0
    if (W < 16 || H < 16) return []
    const d = ctx.getImageData(x0, y0, W, H).data
    const N = W * H
    const lum8 = new Uint8ClampedArray(N)
    for (let i = 0; i < N; i++) lum8[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]
    const med = slidingMedian(lum8, W, H, 5)
    const bandThr = inkThreshold(grainLevel(lum8, med, N), 16)

    const counts = new Int32Array(H)
    const lefts = new Int32Array(H).fill(-1)
    const rights = new Int32Array(H).fill(-1)
    const ink = new Uint8Array(N)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const o = y * W + x
        if (Math.abs(lum8[o] - med[o]) > bandThr) {
          ink[o] = 1
          counts[y]++
          if (lefts[y] < 0) lefts[y] = x
          rights[y] = x
        }
      }
    // Eroded ink: a pixel kept only when its whole 3x3 neighbourhood is ink.
    // A printed stroke is SOLID and survives; a texture is porous — speckles,
    // halftone dots, grain are a couple of pixels across and disappear, however
    // densely they are packed. This is what tells a heading from the starfield
    // it is printed on, which counting or continuity alone cannot.
    const solid = new Uint8Array(N)
    for (let y = 1; y < H - 1; y++)
      for (let x = 1; x < W - 1; x++) {
        const o = y * W + x
        if (!ink[o]) continue
        if (ink[o - 1] && ink[o + 1] && ink[o - W] && ink[o + W] &&
            ink[o - W - 1] && ink[o - W + 1] && ink[o + W - 1] && ink[o + W + 1]) solid[o] = 1
      }

    // On a textured background (speckles, grain, a photo) every row carries a
    // baseline of "ink" from the texture, so text is what rises ABOVE that
    // baseline — measured against the QUIET rows (a low percentile: the gaps
    // between words, the sky between speckles).
    //
    // That level has to be LOCAL. A page mixes plain paper with textured panels
    // — a photo, a dark banner — and one level for the whole window fails both
    // ways: taken from the paper it is ~0, so every row of the panel's texture
    // passes and the entire panel fuses into one over-tall band that the height
    // filter then discards (the banner's heading was invisible to the editor);
    // taken from the panel it is high, and the paper's text can't clear it.
    // Judging each row against the quiet rows AROUND it keeps both: paper text
    // clears a ~0 local level, and a heading printed over a starfield clears the
    // starfield's own level.
    const R = Math.max(8, Math.round(30 * k))
    const localBase = new Float32Array(H)
    const win: number[] = []
    for (let y = 0; y < H; y++) {
      const a = Math.max(0, y - R), b = Math.min(H - 1, y + R)
      win.length = 0
      for (let i = a; i <= b; i++) win.push(counts[i])
      win.sort((p, q) => p - q)
      localBase[y] = win[Math.floor(win.length * 0.25)]
    }
    const minDelta = Math.max(3, W * 0.015)
    const raw: InkBand[] = []
    let start = -1
    for (let y = 0; y <= H; y++) {
      const on = y < H && counts[y] >= localBase[y] + minDelta
      if (on && start < 0) start = y
      if (!on && start >= 0) {
        let l = Infinity
        let r = -Infinity
        for (let yy = start; yy < y; yy++) {
          if (lefts[yy] >= 0) l = Math.min(l, lefts[yy])
          r = Math.max(r, rights[yy])
        }
        // On a textured panel the first/last inked column is the PANEL's edge,
        // not the text's — a starfield puts specks in every column, so the band
        // would span the whole banner. Judge columns against the band's OWN
        // quiet columns (the gaps between letters on paper; the bare texture on
        // a panel) exactly as rows are judged, and keep those that rise above.
        // Only needed where the background itself inks: on plain paper the first
        // and last inked column ALREADY are the text, and blob-filtering there
        // would trim thin small print. `localBase` is the background's own ink
        // level, so it tells the two apart.
        const bh = y - start
        const onTexture = localBase[start] > W * 0.05
        // Letters are LARGE solid blobs that span most of the line's height; a
        // texture — however densely packed — only leaves short crumbs once
        // eroded. Keep the letter-shaped blobs so the band ends where the words
        // end rather than where the panel does.
        const minBlob = Math.max(8, Math.round(bh * 1.2))
        const minTall = Math.max(2, Math.round(bh * 0.35))
        const seen = new Uint8Array(W * bh)
        const stack = new Int32Array(W * bh)
        let tl = -1, tr = -1
        const blobs: { x0: number; x1: number; y1: number }[] = []
        for (let sy = 0; sy < bh; sy++)
          for (let sx = 0; sx < W; sx++) {
            const si = sy * W + sx
            if (seen[si] || !solid[(start + sy) * W + sx]) continue
            let top = 0, area = 0, bx0 = sx, bx1 = sx, by0 = sy, by1 = sy
            stack[top++] = si; seen[si] = 1
            while (top > 0) {
              const c = stack[--top]
              const cx = c % W, cy = (c / W) | 0
              area++
              if (cx < bx0) bx0 = cx
              if (cx > bx1) bx1 = cx
              if (cy < by0) by0 = cy
              if (cy > by1) by1 = cy
              const push = (nx: number, ny: number): void => {
                if (nx < 0 || ny < 0 || nx >= W || ny >= bh) return
                const ni = ny * W + nx
                if (seen[ni] || !solid[(start + ny) * W + nx]) return
                seen[ni] = 1; stack[top++] = ni
              }
              push(cx - 1, cy); push(cx + 1, cy); push(cx, cy - 1); push(cx, cy + 1)
            }
            if (area >= minBlob && by1 - by0 + 1 >= minTall) blobs.push({ x0: bx0, x1: bx1, y1: by1 })
          }
        // Letters sit on a shared baseline; a clump of texture lands wherever it
        // happens to. A dense patch can be big enough and tall enough to read as
        // a letter, so size alone let a star cluster past the end of the words
        // extend the band — and the erase then wiped background the reprint had
        // no business touching. Take the baseline as the commonest blob foot and
        // keep only the blobs standing on it.
        if (blobs.length >= 3) {
          const tol = Math.max(2, Math.round(bh * 0.18))
          let foot = blobs[0].y1, votes = 0
          for (const a of blobs) {
            let v = 0
            for (const b of blobs) if (Math.abs(b.y1 - a.y1) <= tol) v++
            if (v > votes) { votes = v; foot = a.y1 }
          }
          const hi = foot + Math.max(tol, Math.round(bh * 0.3)) // descenders
          for (let i = blobs.length - 1; i >= 0; i--) {
            if (blobs[i].y1 < foot - tol || blobs[i].y1 > hi) blobs.splice(i, 1)
          }
        }
        for (const b of blobs) {
          if (tl < 0 || b.x0 < tl) tl = b.x0
          if (b.x1 > tr) tr = b.x1
        }
        if (onTexture && tl >= 0 && tr > tl) { l = tl; r = tr }
        raw.push({ x: (x0 + l) / k, right: (x0 + r) / k, y: (y0 + start) / k, h: (y - start) / k })
        start = -1
      }
    }
    // re-join bands split by the x-height/diacritic gap inside one text line
    const merged: InkBand[] = []
    for (const b of raw) {
      const prev = merged[merged.length - 1]
      if (prev && b.y - (prev.y + prev.h) < 3) {
        prev.h = b.y + b.h - prev.y
        prev.x = Math.min(prev.x, b.x)
        prev.right = Math.max(prev.right, b.right)
      } else merged.push({ ...b })
    }
    // keep bands from a body line up to a large display heading; the quiet-row
    // baseline above already stops a whole textured region collapsing into one
    // over-tall band, so the ceiling can be generous without readmitting that.
    return merged.filter((b) => b.h >= 4 && b.h <= 120)
  } catch {
    return []
  }
}

/**
 * Narrow a rect to the columns that actually carry ink.
 * A pdf.js run box is an ADVANCE box: it includes the run's trailing spaces, so
 * it can be far wider than the glyphs it prints. Erasing the raw box wipes blank
 * paper past the end of the words, and the replacement text (which is only as
 * wide as the glyphs) then can't cover it — leaving a cleared gap. Trimming to
 * the ink keeps the erase and the reprint the same width.
 */
export function trimRectToInk(canvas: HTMLCanvasElement, rect: Rect, pageW: number): Rect {
  try {
    const k = canvas.width / pageW
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return rect
    const padY = Math.max(2, Math.round(rect.h * 0.5))
    const X = Math.max(0, Math.round(rect.x * k))
    const Y = Math.max(0, Math.round((rect.y - padY) * k))
    const W = Math.min(canvas.width - X, Math.round(rect.w * k))
    const H = Math.min(canvas.height - Y, Math.round((rect.h + 2 * padY) * k))
    if (W < 6 || H < 6) return rect
    const d = ctx.getImageData(X, Y, W, H).data
    const lum = new Float32Array(W * H)
    for (let i = 0; i < W * H; i++) lum[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]
    // paper = the median of the top/bottom rows (works on dark stock too)
    const border: number[] = []
    for (let x = 0; x < W; x++) { border.push(lum[x]); border.push(lum[(H - 1) * W + x]) }
    border.sort((a, b) => a - b)
    const paper = border[border.length >> 1]
    const col = new Int32Array(W)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) if (Math.abs(lum[y * W + x] - paper) > 30) col[x]++
    // Scale the cutoff to the tallest COLUMN (how many rows of ink a stem has),
    // never to the widest row — a row spans the whole band, so a row-derived
    // cutoff grows with the band's width and starts rejecting real letters. That
    // silently clipped the end of long runs, since a final round letter ("e")
    // carries far less column ink than a stem.
    let maxCol = 0
    for (let x = 0; x < W; x++) maxCol = Math.max(maxCol, col[x])
    if (maxCol < 1) return rect
    const thr = Math.max(1, Math.round(maxCol * 0.12))
    let l = -1, r = -1
    for (let x = 0; x < W; x++) if (col[x] > thr) { l = x; break }
    for (let x = W - 1; x >= 0; x--) if (col[x] > thr) { r = x; break }
    if (l < 0 || r <= l) return rect
    // one device pixel of slack so the glyphs' faintest antialiased fringe is
    // inside the erase — far below a glyph's width, so it can't reach a neighbour
    l = Math.max(0, l - 1); r = Math.min(W - 1, r + 1)
    return { x: rect.x + l / k, y: rect.y, w: (r - l + 1) / k, h: rect.h }
  } catch {
    return rect
  }
}

/** Fraction of a rect that is printed ink — how the reshape tool tells "add here" from "replace this". */
export function inkFraction(canvas: HTMLCanvasElement, rect: Rect, pageW: number): number {
  try {
    const k = canvas.width / pageW
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return 0
    const pad = Math.round(8 * k)
    const rx = Math.round(rect.x * k)
    const ry = Math.round(rect.y * k)
    const rw = Math.round(rect.w * k)
    const rh = Math.round(rect.h * k)
    const x0 = Math.max(0, rx - pad)
    const y0 = Math.max(0, ry - pad)
    const W = Math.min(canvas.width, rx + rw + pad) - x0
    const H = Math.min(canvas.height, ry + rh + pad) - y0
    if (W < 8 || H < 8 || rw < 2 || rh < 2) return 0
    const d = ctx.getImageData(x0, y0, W, H).data
    const N = W * H
    const lum8 = new Uint8ClampedArray(N)
    for (let i = 0; i < N; i++) lum8[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]
    const med = slidingMedian(lum8, W, H, 5)
    const fracThr = inkThreshold(grainLevel(lum8, med, N), 14)
    let ink = 0
    let total = 0
    const ix = rx - x0
    const iy = ry - y0
    for (let y = iy; y < iy + rh && y < H; y++)
      for (let x = ix; x < ix + rw && x < W; x++) {
        const o = y * W + x
        total++
        if (Math.abs(lum8[o] - med[o]) > fracThr) ink++
      }
    return total ? ink / total : 0
  } catch {
    return 0
  }
}

/**
 * Inpaint under a freehand brush stroke — the "magic eraser". Same engine as
 * the rect patch (median-classified ring, nearest-dominated ray fill, grain),
 * but the hole is the brushed area and the output PNG is alpha-masked to it,
 * so untouched pixels stay the page's own.
 */
export function makeBrushPatch(
  canvas: HTMLCanvasElement,
  strokes: [number, number][][],
  radius: number,
  pageW: number,
): { rect: Rect; color: string; src: string } | null {
  try {
    const k = canvas.width / pageW
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const st of strokes)
      for (const [x, y] of st) {
        minX = Math.min(minX, x); minY = Math.min(minY, y)
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y)
      }
    if (!isFinite(minX)) return null
    const rect: Rect = {
      x: Math.max(0, minX - radius - 2),
      y: Math.max(0, minY - radius - 2),
      w: Math.min(canvas.width / k, maxX + radius + 2) - Math.max(0, minX - radius - 2),
      h: Math.min(canvas.height / k, maxY + radius + 2) - Math.max(0, minY - radius - 2),
    }
    const color = samplePaperColor(canvas, rect, pageW)

    const rx = Math.round(rect.x * k)
    const ry = Math.round(rect.y * k)
    const rw = Math.max(2, Math.round(rect.w * k))
    const rh = Math.max(2, Math.round(rect.h * k))
    // Scale the reconstruction margin with the brush (as makeBlendedPatch does):
    // a big brush over a fixed 10px frame starves the fill ("could not read
    // enough background" / smears). Grow the surround with the stroke, capped.
    const pad = Math.round(Math.min(60 * k, Math.max(10 * k, radius * k * 0.9)))
    const x0 = Math.max(0, rx - pad)
    const y0 = Math.max(0, ry - pad)
    const f = Math.max(1, Math.ceil(Math.sqrt((rw * rh) / 45000)))
    let W = Math.min(canvas.width, rx + rw + pad) - x0
    let H = Math.min(canvas.height, ry + rh + pad) - y0
    let d: Uint8ClampedArray
    if (f > 1) {
      const wc = document.createElement('canvas')
      wc.width = Math.max(8, Math.round(W / f))
      wc.height = Math.max(8, Math.round(H / f))
      const wcx = wc.getContext('2d', { willReadFrequently: true })!
      wcx.drawImage(canvas, x0, y0, W, H, 0, 0, wc.width, wc.height)
      d = wcx.getImageData(0, 0, wc.width, wc.height).data
      W = wc.width
      H = wc.height
    } else {
      d = ctx.getImageData(x0, y0, W, H).data
    }
    const N = W * H
    if (N < 64) return null

    // the brushed hole, drawn at working resolution (antialiased edge = feather)
    const mc = document.createElement('canvas')
    mc.width = W
    mc.height = H
    const mctx = mc.getContext('2d')!
    mctx.lineCap = 'round'
    mctx.lineJoin = 'round'
    mctx.strokeStyle = '#fff'
    mctx.fillStyle = '#fff'
    mctx.lineWidth = (2 * radius * k) / f
    for (const st of strokes) {
      if (st.length === 1) {
        mctx.beginPath()
        mctx.arc(((st[0][0] * k) - x0) / f, ((st[0][1] * k) - y0) / f, (radius * k) / f, 0, Math.PI * 2)
        mctx.fill()
        continue
      }
      mctx.beginPath()
      st.forEach(([x, y], i) => {
        const px = ((x * k) - x0) / f
        const py = ((y * k) - y0) / f
        if (i === 0) mctx.moveTo(px, py)
        else mctx.lineTo(px, py)
      })
      mctx.stroke()
    }
    const mask = mctx.getImageData(0, 0, W, H).data

    const lum = new Float32Array(N)
    const lum8 = new Uint8ClampedArray(N)
    for (let i = 0; i < N; i++) {
      lum[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]
      lum8[i] = lum[i]
    }
    const low = slidingMedian(lum8, W, H, 5)
    const low2 = slidingMedian(lum8, W, H, 11)
    const thr = inkThreshold(grainLevel(lum, low, N), 13)
    const ink = new Uint8Array(N)
    for (let i = 0; i < N; i++) if (Math.abs(lum[i] - low[i]) > thr || Math.abs(lum[i] - low2[i]) > thr) ink[i] = 1
    removeSmallInk(ink, W, H, Math.max(6, Math.round((W * H) / 1400)))
    dilateMask(ink, W, H, 2)

    // texture vs text (see makeBlendedPatch): reproduce a bright discrete texture,
    // diffuse smooth tone or dark text. hf = mean |lum − median5| over the
    // un-brushed surround; bright energy must dominate to count as texture.
    // Strongest strip, not the average — see makeBlendedPatch: a stroke that
    // crosses from bare background into texture must still be filled as texture.
    const strip = Math.max(8, Math.min(W, Math.round(H / 2)))
    const nStrip = Math.max(1, Math.ceil(W / strip))
    const sE = new Float64Array(nStrip), sN = new Float64Array(nStrip)
    let brightE = 0, darkE = 0
    for (let i = 0; i < N; i++) {
      // Measure the surround's texture on the BACKGROUND only — skip brushed AND
      // ink pixels. Otherwise white lettering on a flat dark banner registers as
      // "bright texture", `textured` fires, and the mirror-fill reflects the
      // letters back into the hole as the pale fragments the erase looked to leave.
      if (mask[i * 4 + 3] !== 0 || ink[i]) continue
      const dv = lum[i] - low[i]
      const si = Math.min(nStrip - 1, ((i % W) / strip) | 0)
      sE[si] += Math.abs(dv); sN[si]++
      if (dv > 0) brightE += dv; else darkE -= dv
    }
    let hfPeak = 0
    for (let i = 0; i < nStrip; i++) if (sN[i] >= 24) hfPeak = Math.max(hfPeak, sE[i] / sN[i])
    const textured = hfPeak >= 2.5 && brightE > darkE
    const valid = new Uint8Array(N)
    for (let i = 0; i < N; i++) if (mask[i * 4 + 3] === 0 && (textured || !ink[i])) valid[i] = 1
    keepBorderConnected(valid, W, H)
    const rgb = new Float32Array(N * 3)
    const wgt = new Float32Array(N)
    const ring: number[] = []
    for (let i = 0; i < N; i++) {
      rgb[i * 3] = d[i * 4]
      rgb[i * 3 + 1] = d[i * 4 + 1]
      rgb[i * 3 + 2] = d[i * 4 + 2]
      if (valid[i]) {
        wgt[i] = 1
        ring.push(i)
      }
    }
    if (ring.length < 30) return null
    const med = [0, 1, 2].map((c) => median(ring.map((o) => rgb[o * 3 + c])))

    // output only the brushed pixels (alpha from the stroke mask)
    const ix = Math.round((rx - x0) / f)
    const iy = Math.round((ry - y0) / f)
    const iw = Math.min(W - ix, Math.max(1, Math.round(rw / f)))
    const ih = Math.min(H - iy, Math.max(1, Math.round(rh / f)))

    if (textured) {
      // floor the stroke with the ring median, then mirror real texture in (see
      // makeBlendedPatch), reflecting across the stroke's bounding box
      for (let o = 0; o < N; o++) { if (wgt[o] > 0) continue; rgb[o * 3] = med[0]; rgb[o * 3 + 1] = med[1]; rgb[o * 3 + 2] = med[2] }
      // Keep the mirror from copying LETTERS into the hole (the reported ghost
      // "garbage" on a textured/decorated/photo background): a letter is a SOLID
      // stroke that survives a 3x3 erosion, real texture is porous and vanishes.
      // The box path (makeBlendedPatch) already excludes solidInk this way.
      const solidInk = new Uint8Array(N)
      for (let y = 1; y < H - 1; y++)
        for (let x = 1; x < W - 1; x++) {
          const o = y * W + x
          if (!ink[o]) continue
          if (ink[o - 1] && ink[o + 1] && ink[o - W] && ink[o + W] &&
              ink[o - W - 1] && ink[o - W + 1] && ink[o + W - 1] && ink[o + W + 1]) solidInk[o] = 1
        }
      const surLum: number[] = []
      for (let i = 0; i < N; i++) if (mask[i * 4 + 3] === 0) surLum.push(lum[i])
      const [lo, hi] = lumRange(surLum)
      mirrorFill(rgb, wgt, d, W, H, ix, iy, iw, ih, lo, hi, solidInk)
    } else {
      shootFill(rgb, wgt, W, H, med)
      relaxFill(rgb, wgt, W, H, 2)
    }
    const out = document.createElement('canvas')
    out.width = iw
    out.height = ih
    const octx = out.getContext('2d')!
    const img = octx.createImageData(iw, ih)
    for (let y = 0; y < ih; y++)
      for (let x = 0; x < iw; x++) {
        const src = (y + iy) * W + (x + ix)
        const dst = (y * iw + x) * 4
        img.data[dst] = Math.max(0, Math.min(255, Math.round(rgb[src * 3])))
        img.data[dst + 1] = Math.max(0, Math.min(255, Math.round(rgb[src * 3 + 1])))
        img.data[dst + 2] = Math.max(0, Math.min(255, Math.round(rgb[src * 3 + 2])))
        img.data[dst + 3] = mask[src * 4 + 3]
      }
    octx.putImageData(img, 0, 0)
    return { rect, color, src: out.toDataURL('image/png') }
  } catch {
    return null
  }
}


/**
 * Lift a rect straight out of an already-correct canvas as a patch.
 *
 * Used with a page re-rendered minus the words being replaced: there is nothing
 * to reconstruct, so there is no reconstruction — just the real background,
 * cropped. The companion to makeBlendedPatch, for the (common) case where the
 * document still contains the answer.
 */
export function cropCanvasToPatch(
  canvas: HTMLCanvasElement,
  rect: Rect,
  pageW: number,
): { x: number; y: number; color: string; src: string; w: number; h: number } {
  const k = canvas.width / pageW
  // Clamp the crop to the canvas AND return the clamped page-space rect, so the
  // caller lays the patch down exactly over the pixels it captured. Returning the
  // unclamped rect while the source was pinned to the page edge shifted and
  // stretched the true-background image across the hole — the visible lift seam
  // on anything near a margin. Clamp the far edge too (round x2, then subtract),
  // not the width, or a 1px rounding split re-introduces the stretch.
  const x = Math.max(0, Math.round(rect.x * k))
  const y = Math.max(0, Math.round(rect.y * k))
  const w = Math.max(1, Math.min(canvas.width - x, Math.round((rect.x + rect.w) * k) - x))
  const h = Math.max(1, Math.min(canvas.height - y, Math.round((rect.y + rect.h) * k) - y))
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const ctx = out.getContext('2d', { alpha: false })!
  ctx.drawImage(canvas, x, y, w, h, 0, 0, w, h)
  // a flat colour for anything that can only take one (exporter fallback)
  const mid = ctx.getImageData(Math.floor(w / 2), Math.floor(h / 2), 1, 1).data
  const hex = `#${[mid[0], mid[1], mid[2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`
  return { x: x / k, y: y / k, color: hex, src: out.toDataURL('image/png'), w: w / k, h: h / k }
}
