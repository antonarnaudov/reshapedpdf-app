import { getSamplingCanvas, renderPageWithoutText, SAMPLE_SCALE } from './render'
import { removeSmallInk } from './patch'
import type { PageRef, Rect } from '../core/types'

/* ----- reading the background instead of reconstructing it ------------------

   Render the page twice: once as it is, once with one run's glyphs simply not
   painted. The two rasters differ in exactly the pixels those glyphs touched —
   every one of them, down to the faintest edge of the antialiasing — and
   nowhere else. That difference is not an estimate of where the ink was. It IS
   where the ink was.

   Which turns three separate problems into one measurement:

     · the background under the words          — the second render, verbatim
     · the ink's true extent, for the erase    — the difference
     · whether any of this worked at all       — also the difference

   The last one matters more than it sounds. Glyphs only reach our suppression
   when pdf.js draws them with fillText, and it doesn't always: Type 3 fonts run
   little content streams of their own, pattern-filled and clipped text go
   through path filling instead. All of those would sail past the hook and land
   on the page as usual. Rather than try to predict which PDFs do that — a list
   that would rot with the next pdf.js release — render it and look: if the
   words are still there in the "clean" copy, this route doesn't work for this
   page, and the caller falls back to reconstruction. */

/**
 * How finely to render the background that gets pasted back.
 *
 * Kept at the sampling scale ON PURPOSE, though it is tempting to raise it: the
 * patch is a bitmap in a page of vector art, so a rule caught inside it picks up
 * a soft halo that the identical rule an inch away does not have.
 *
 * Rendering the patch finer than the page makes that worse, not better, and the
 * suite says so plainly — residue reappears on lines that were clean, and the
 * ink of a reprint drifts several per cent. The patch has to agree with the
 * raster it is composited into, and pdf.js does not hint a rule at 3x the way it
 * hints the same rule at 1.5x, so a finer patch is a patch that no longer
 * matches its surroundings. Out-resolving the mismatch is the wrong instinct;
 * not overlapping crisp artwork in the first place is the right one, which is
 * what sizing the erase to the measured glyph footprint already does.
 */
export const PATCH_SCALE = SAMPLE_SCALE

export interface TrueBackground {
  /** the page minus that run, rendered finely enough to paste back */
  clean: HTMLCanvasElement
  /** view-space box actually touched by the removed glyphs, antialiasing included */
  inkBox: Rect | null
  /** how many device pixels changed — near zero means the suppression missed */
  changed: number
  /** pixels per point at which `changed` was counted (not the patch's own scale) */
  diffK: number
}

/**
 * Lift the true background from behind a run of text.
 *
 * `hide` should be the run's ADVANCE box (what pdf.js reports for the run), not
 * a box measured from the pixels. Suppression tests each glyph's pen origin,
 * which sits to the left of its ink by the left sidebearing — a box trimmed to
 * the ink starts inside the first glyph's origin and lets that glyph through.
 * The effect scales with type size: invisible in body copy, a whole letter left
 * standing in a headline.
 */
export async function liftTrueBackground(
  ref: PageRef,
  hide: Rect,
  pageW: number,
): Promise<TrueBackground | null> {
  const orig = await getSamplingCanvas(ref)
  const clean = await renderPageWithoutText(ref, [hide], PATCH_SCALE)

  // The DIFF only needs to find which pixels the glyphs touched, and it has to
  // compare like with like, so do it against a copy reduced to the sampling
  // canvas's own scale. The fine render is kept for the patch itself.
  const small = document.createElement('canvas')
  small.width = orig.width
  small.height = orig.height
  const sctx = small.getContext('2d', { alpha: false, willReadFrequently: true })
  if (!sctx) return null
  sctx.imageSmoothingEnabled = true
  sctx.imageSmoothingQuality = 'high'
  sctx.drawImage(clean, 0, 0, small.width, small.height)

  const k = small.width / pageW
  // look a little wider than the run: descenders, accents and the soft edge of
  // the outermost glyphs all sit outside the advance box
  const pad = Math.max(4, Math.round(hide.h * k * 0.6))
  const x0 = Math.max(0, Math.round(hide.x * k) - pad)
  const y0 = Math.max(0, Math.round(hide.y * k) - pad)
  const x1 = Math.min(small.width, Math.round((hide.x + hide.w) * k) + pad)
  const y1 = Math.min(small.height, Math.round((hide.y + hide.h) * k) + pad)
  const w = x1 - x0
  const h = y1 - y0
  if (w < 2 || h < 2) return null

  const a = orig.getContext('2d', { willReadFrequently: true })!.getImageData(x0, y0, w, h).data
  const b = sctx.getImageData(x0, y0, w, h).data

  // 2/255 sits just above rasteriser jitter and two orders of magnitude below
  // any ink threshold — which is the point: a threshold can only find ink it is
  // dark enough to notice, and the traces left behind after an erase are
  // precisely the pixels that sat under it
  const support = new Uint8Array(w * h)
  let changed = 0
  for (let i = 0; i < w * h; i++) {
    const o = i * 4
    const dev = Math.max(Math.abs(a[o] - b[o]), Math.abs(a[o + 1] - b[o + 1]), Math.abs(a[o + 2] - b[o + 2]))
    if (dev > 2) { support[i] = 1; changed++ }
  }
  // a re-render is not bit-exact on adjacent vector art; isolated specks are that,
  // not glyph edges
  removeSmallInk(support, w, h, 2)

  let ix0 = w, iy0 = h, ix1 = -1, iy1 = -1
  let n = 0
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!support[y * w + x]) continue
      n++
      if (x < ix0) ix0 = x
      if (x > ix1) ix1 = x
      if (y < iy0) iy0 = y
      if (y > iy1) iy1 = y
    }
  // Exactly the pixels that changed — no safety margin.
  //
  // A margin is the instinct here, and the suite says it is wrong in both
  // directions. The diff finds the glyphs' footprint down to a coverage of
  // 1/255, antialiasing included, so there is nothing left over for padding to
  // catch. What padding does instead is reach into whatever the line was sitting
  // next to: on an underlined heading a full pixel lands a point and a half past
  // the baseline, which is where the rule is, and the patch pastes a resampled
  // copy of the rule's top edge over the crisp original and doubles it. Half a
  // pixel is no better — it still touches the rule, and it drags the reprint's
  // weight up several per cent. Exact wins.
  const inkBox = ix1 < 0 ? null : {
    x: (x0 + ix0) / k,
    y: (y0 + iy0) / k,
    w: (ix1 - ix0 + 1) / k,
    h: (iy1 - iy0 + 1) / k,
  }

  return { clean, inkBox, changed: n, diffK: k }
}

/**
 * Did the suppression actually take the words out?
 *
 * A run that was never drawn through fillText leaves the "clean" render
 * identical to the original, and cropping that as a patch would paste the old
 * words straight back over themselves. Cheap, total, and it fails safe.
 */
export function suppressionWorked(tb: TrueBackground | null, band: Rect, pageW: number): boolean {
  if (!tb || !tb.inkBox) return false
  // measured against the scale the count was taken at, which is NOT the scale
  // the patch is rendered at — they were separated so patches could be finer
  const k = tb.diffK
  const area = Math.max(1, band.w * k * band.h * k)
  return tb.changed > area * 0.01
}

export { SAMPLE_SCALE }
