import { getSamplingCanvas, renderRegionToDataUrl, renderPageWithoutSpans } from '../pdf/render'
import { detectObject } from '../ai/client'
import { cropCanvasToPatch, makeBlendedPatch, samplePaperColor } from '../pdf/patch'
import { getLibDoc, pageGeom, pageViewSize } from '../pdf/registry'
import { walkPageContent, textSpansUnder, formStreamShared } from '../pdf/contentwalk'
import type { PageElement, RemovalEdit } from '../pdf/contentwalk'
import { userRectToView } from './geometry'
import { useStore } from './store'
import { uid } from './types'
import type { PageRef, Rect, WhiteoutObj } from './types'

/* ----- cleaning something off the page -------------------------------------

   "Take that out" is the one edit every phone can do now: circle a thing, it is
   gone, the background closes over it. The way they do it is to invent the
   pixels underneath — which is the only option when all you have is a
   photograph, and it shows: a smear where a pattern should continue, a ghost of
   the removed shape, an edge that doesn't line up.

   A PDF is not a photograph. It is the instructions that drew the page, and the
   thing to remove is some of those instructions. Delete them and what is
   revealed is not a guess at the background — it IS the background, exactly as
   the document's author drew it, down to the rule that ran under the logo and
   the gradient that carried on behind it. Nothing is invented, so nothing can be
   wrong.

   So the model is not asked to paint. It is asked the one question a program
   cannot answer — which marks on this page are "the object" — and everything
   after that is deterministic: find those elements, take their operators out,
   re-render, keep the difference. A scan (where the words and pictures really
   are only pixels) still falls back to the texture-rebuilding fill, because
   there the phone's answer is the only answer there is.                       */

export interface CleanResult {
  /** how many drawing elements were taken out (0 = fell back to rebuilding pixels) */
  removed: number
  /**
   * What actually happened, which is not the same question as "how many
   * elements went". 'inpaint' used to cover four unrelated outcomes, including
   * three where the clean was ABANDONED because the document changed under it —
   * and the caller announced all of them as "this page is a picture", stated as
   * fact about the user's wholly-vector document.
   */
  mode: 'elements' | 'inpaint' | 'aborted'
}

const grow = (r: Rect, by: number): Rect => ({ x: r.x - by, y: r.y - by, w: r.w + 2 * by, h: r.h + 2 * by })
const inside = (outer: Rect, inner: Rect): boolean =>
  inner.x >= outer.x && inner.y >= outer.y
  && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h

/** Every span this page's existing patches already stand in for. */
function spansRemovedSoFar(pageId: string): RemovalEdit[] {
  const s = useStore.getState()
  const d = s.docs[s.active ?? '']
  return (d ? d.objOrder.map((id) => d.objects[id]) : [])
    .filter((o): o is WhiteoutObj => !!o && o.kind === 'whiteout' && o.page === pageId && !!o.removedSpans?.length)
    .flatMap((o) => o.removedSpans!)
}

/**
 * Remove the object inside `box` (view space) from the page.
 *
 * The box is what the user drew; the model tightens it to the object's own
 * extent, and the result is clamped back to what they drew plus its margin, so a
 * model that answers "the whole crop" can never take more of the page than was
 * pointed at. Everything the tightened box CONTAINS goes — containment, not
 * overlap, so a neighbour clipped by the edge is never half-deleted.
 */
export async function cleanRegion(ref: PageRef, box: Rect): Promise<CleanResult> {
  const s = useStore.getState
  const cfg = s().aiConfig
  if (!cfg) throw new Error('Connect a vision model first')
  const pv = pageViewSize(ref)
  const startDoc = s().active // the many awaits below mustn't drop a patch into another doc

  s().setBusy('Looking at what you circled…')
  try {
    // 1. the crop the model sees: the drawn box plus a margin of context. Mirror
    //    renderRegionToDataUrl's own clamping so a box against the page edge maps
    //    back to exactly the region that was rendered.
    const padX = Math.max(8, box.w * 0.25)
    const padY = Math.max(8, box.h * 0.25)
    const cx = Math.max(0, box.x - padX)
    const cy = Math.max(0, box.y - padY)
    const cw = Math.min(pv.w - cx, box.w + 2 * padX - (cx - (box.x - padX)))
    const ch = Math.min(pv.h - cy, box.h + 2 * padY - (cy - (box.y - padY)))
    const cropRect: Rect = { x: cx, y: cy, w: cw, h: ch }

    let target: Rect = { ...box }
    try {
      const crop = await renderRegionToDataUrl(ref, box, 3, padX, padY)
      s().setBusy('Working out where it ends…')
      const found = await detectObject(cfg, crop, cw * 3, ch * 3)
      if (found.length) {
        const f = found[0]
        const t: Rect = { x: cx + f.x * cw, y: cy + f.y * ch, w: f.w * cw, h: f.h * ch }
        // Clamp to the crop: the user's box and its margin is the most that may
        // ever go, whatever the model says. Then take the union with the drawn
        // box — the user pointed at that, and a tightening must not leave a
        // corner of what they circled behind.
        const x0 = Math.max(cropRect.x, Math.min(t.x, box.x))
        const y0 = Math.max(cropRect.y, Math.min(t.y, box.y))
        const x1 = Math.min(cropRect.x + cropRect.w, Math.max(t.x + t.w, box.x + box.w))
        const y1 = Math.min(cropRect.y + cropRect.h, Math.max(t.y + t.h, box.y + box.h))
        if (x1 - x0 > 1 && y1 - y0 > 1) target = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
      }
    } catch {
      // the model didn't answer usefully — then the box the user drew IS the
      // answer, and the rest of this runs exactly the same
    }
    if (s().active !== startDoc) return { removed: 0, mode: 'aborted' }

    // 2. which of the page's own drawing elements that box contains
    s().setBusy('Taking it off the page…')
    let edits: RemovalEdit[] = []
    try {
      const lib = await getLibDoc(ref.srcId)
      const lp = lib.getPage(ref.srcIndex)
      const geom = pageGeom(ref)
      const els = walkPageContent(lib, lp).elements
      const viewBox = (el: PageElement): Rect =>
        userRectToView(geom, [el.userBox.x, el.userBox.y, el.userBox.x + el.userBox.w, el.userBox.y + el.userBox.h])
      // Text is matched by the shared band rule (a run's measured width can be a
      // guess); everything else has an exact geometric box, so plain containment
      // is right — with a little slack for the anti-aliased fringe and the half
      // stroke-width that reaches past a path's own geometry.
      const roomy = grow(target, Math.max(2, 0.06 * Math.min(target.w, target.h)))
      const others = els.filter((el) => el.kind !== 'text' && inside(roomy, viewBox(el)))
        .filter((el) => !(el.formPath.length && formStreamShared(lib, lp, el.formPath)))
        .map((el) => ({ span: el.span, formPath: el.formPath }))
      edits = [...textSpansUnder(lib, lp, geom, target, els), ...others]
    } catch { /* an unreadable page can still be patched over below */ }

    // 3. remove them, and take the true background from a render without them
    if (edits.length) {
      const clean = await renderPageWithoutSpans(ref, [...spansRemovedSoFar(ref.id), ...edits], 3)
      if (clean) {
        // the crop repaints the real background, so a generous box costs nothing
        const pad = Math.max(3, 0.08 * Math.min(target.w, target.h))
        const patch = cropCanvasToPatch(clean, grow(target, pad), pv.w)
        if (s().active !== startDoc) return { removed: 0, mode: 'aborted' }
        s().addObject({
          id: uid(), page: ref.id, kind: 'whiteout', opacity: 1, ...patch, removedSpans: edits,
        })
        return { removed: edits.length, mode: 'elements' }
      }
    }

    // 4. nothing the walker can point at (a scan), or the clean render failed:
    //    rebuild the pixels, which is all a photograph ever allows
    const canvas = await getSamplingCanvas(ref)
    let patch: { color: string; src?: string; w?: number; h?: number }
    try {
      patch = makeBlendedPatch(canvas, target, pv.w)
    } catch {
      patch = { color: samplePaperColor(canvas, grow(target, 8), pv.w) }
    }
    if (s().active !== startDoc) return { removed: 0, mode: 'aborted' }
    s().addObject({ id: uid(), page: ref.id, kind: 'whiteout', opacity: 1, ...target, ...patch })
    return { removed: 0, mode: 'inpaint' }
  } finally {
    s().setBusy(null)
  }
}
