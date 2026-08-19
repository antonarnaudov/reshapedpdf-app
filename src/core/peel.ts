import { getSamplingCanvas, renderRegionToDataUrl } from '../pdf/render'
import { detectTextBlocks, readRegion } from '../ai/client'
import { makeBlendedPatch, sampleInkColor, detectInkBands, median } from '../pdf/patch'
import { baselineFromInk } from './typematch'
import { measureText, BASELINE_EM } from './measure'
import { getLibDoc, pageGeom, pageViewSize } from '../pdf/registry'
import { walkPageContent, textSpansUnder } from '../pdf/contentwalk'
import type { RemovalEdit } from '../pdf/contentwalk'
import { useStore } from './store'
import { uid } from './types'
import type { PageRef, AnyObj, Rect } from './types'

/* ----- raster layer peeling -----------------------------------------------

   A scan (or any flat page) is one picture: no text to select, no layers to
   move, nothing editable. But a page is really a stack — text over a
   background — and the stack is recoverable. Ask a vision model where the text
   blocks are; for each, find the ink row, read the words, measure where the
   line sits and how big it is from the pixels themselves, lay the words back as
   real editable text on that baseline in that ink colour, and rebuild the
   background where the ink was. Do that for every block and the picture comes
   apart into layers — editable text over a cleaned background. */

export interface PeelResult {
  layers: number
  blocks: number
  skipped: number
  /**
   * Why there are this many layers — and in particular WHICH of the four very
   * different zeros this is. The caller printed "No text found to peel" for all
   * of them, which is a claim about the page and was untrue in three.
   */
  outcome: 'ok' | 'empty' | 'stopped' | 'busy' | 'discarded' | 'allskipped'
}

// each peel gets its own cancel token, so two overlapping runs can't cancel or
// un-cancel each other
const running = new Set<{ aborted: boolean }>()
/** Ask any in-progress peel to stop after its current block. */
export function cancelPeel(): void { for (const t of running) t.aborted = true }

// sampleInkColor can't tell there is no visible ink and returns a near-black
// sentinel; when it does, trust the colour the model reported instead
function pickColor(canvas: HTMLCanvasElement, band: Rect, pageW: number, modelColor: string): string {
  const c = sampleInkColor(canvas, band, pageW)
  return c && c.toLowerCase() !== '#111111' ? c : modelColor
}

/**
 * Peel a page's text into editable layers over a cleaned background. Each block
 * becomes a text object placed on its measured baseline plus a background patch
 * that removes the original ink; the whole peel is ONE undoable step. A block
 * that can't be read or measured is skipped, not fatal. Needs a vision model.
 */
export async function peelPage(ref: PageRef, opts?: { maxBlocks?: number }): Promise<PeelResult> {
  const s = useStore.getState
  const cfg = s().aiConfig
  if (!cfg) throw new Error('Connect a vision model first')
  // Re-entrancy guard: a second peel launched while one is in flight (a double
  // click, or the button not yet disabled) would run the whole detect→place
  // pipeline again and stack a duplicate copy of every lifted layer + patch.
  if (running.size > 0) { s().toast('A peel is already running on this document', 'warn'); return { layers: 0, blocks: 0, skipped: 0, outcome: 'busy' } }
  const pv = pageViewSize(ref)
  const startDoc = s().active // peel's many awaits mustn't dump layers into a doc the user switched to
  const token = { aborted: false }
  running.add(token)

  s().setBusy('Finding the text blocks…')
  try {
    // 1. render the page and ask the model where its text sits
    const detectScale = 2
    const pageImg = await renderRegionToDataUrl(ref, { x: 0, y: 0, w: pv.w, h: pv.h }, detectScale, 0, 0)
    let blocks = await detectTextBlocks(cfg, pageImg, pv.w * detectScale, pv.h * detectScale)
    if (opts?.maxBlocks) blocks = blocks.slice(0, opts.maxBlocks)
    if (!blocks.length) { s().toast('No text blocks found on this page', 'warn'); return { layers: 0, blocks: 0, skipped: 0, outcome: 'empty' } }

    const canvas = await getSamplingCanvas(ref)
    const patches: AnyObj[] = [] // backgrounds, kept UNDER the text
    const texts: AnyObj[] = []
    let skipped = 0

    // A peel that only paints over the print leaves the words themselves in the
    // page's drawing program: the picture comes apart into layers while the file
    // still hands the originals back to pdftotext, to copy-paste, and to every
    // indexer — beside the peeled copy, so the document now says everything
    // twice. Record which operators each patch stands in for and the export
    // takes them out with it. A scan has none (its words are pixels, which is
    // why it needed peeling), so this costs those pages one walk and nothing else.
    // undefined = the page hasn't been walked yet; null = it can't be
    let spansFor: ((band: Rect) => RemovalEdit[]) | null | undefined
    const spansUnder = async (band: Rect): Promise<RemovalEdit[]> => {
      if (spansFor === undefined) {
        spansFor = null
        try {
          const lib = await getLibDoc(ref.srcId)
          const lp = lib.getPage(ref.srcIndex)
          const geom = pageGeom(ref)
          const els = walkPageContent(lib, lp).elements // once for the whole page
          spansFor = (b: Rect) => textSpansUnder(lib, lp, geom, b, els)
        } catch { /* unreadable page: covered but not removed, as before */ }
      }
      return spansFor ? spansFor(band) : []
    }

    let i = 0
    for (const b of blocks) {
      if (token.aborted) break
      i++
      s().setBusy(`Peeling block ${i} of ${blocks.length}…`)
      const block: Rect = {
        x: Math.max(0, b.x * pv.w), y: Math.max(0, b.y * pv.h),
        w: Math.min(pv.w, b.w * pv.w), h: Math.min(pv.h, b.h * pv.h),
      }
      if (block.w < 6 || block.h < 4) { skipped++; continue }

      // 2. tighten the model's loose box to the actual ink rows, and measure the
      //    line size from them (ink height is about 1.15x the point size)
      const bands = detectInkBands(canvas, block, pv.w)
        .map((bd) => ({ x: Math.max(bd.x, block.x), y: bd.y, w: Math.min(bd.right, block.x + block.w) - Math.max(bd.x, block.x), h: bd.h }))
        .filter((bd) => bd.w > 4 && bd.y + bd.h > block.y - 2 && bd.y < block.y + block.h + 2)
      const anchor = bands.length ? bands[0] : block
      const size = bands.length
        ? Math.max(5, Math.min(120, Math.round((median(bands.map((bd) => bd.h)) / 1.15) * 10) / 10))
        : Math.max(6, Math.min(120, block.h * 0.72))

      // 3. read the words in the block. Detected boxes hug the ink, and the OCR
      //    misreads glyphs that touch a crop edge ("RONWORKS" for "IRONWORKS"),
      //    so pad the READ crop — generously across (few horizontal neighbours;
      //    catches the first/last letter) and modestly down (enough for
      //    ascenders/descenders without pulling in the line above or below).
      //    Placement doesn't use this crop — it re-tightens to ink bands — so a
      //    roomy read crop is free accuracy.
      let reading
      try {
        const padX = Math.max(6, block.h * 0.8)
        const padY = Math.max(3, block.h * 0.18)
        const crop = await renderRegionToDataUrl(ref, block, 3, padX, padY)
        reading = await readRegion(cfg, crop)
      } catch { skipped++; continue }
      const text = reading.text.trim()
      if (!text) { skipped++; continue }

      // 4. lay the words back. When the OCR splits into as many lines as there
      //    are ink rows, place one line per row on its OWN measured baseline —
      //    a fixed leading would drift a multi-line block off its cleaned rows.
      //    Otherwise place one (wrapping) object anchored to the first row.
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
      const inpaint: Rect[] = []
      if (bands.length >= 2 && lines.length === bands.length) {
        for (let li = 0; li < bands.length; li++) {
          const bd = bands[li]
          // Size each row from its OWN ink height, not the block median. A heading
          // and its subheading detected as one block have very different sizes, and
          // one median size made the heading too small and the subheading too big.
          const lineSize = Math.max(5, Math.min(120, Math.round((bd.h / 1.15) * 10) / 10))
          const color = pickColor(canvas, bd, pv.w, reading.color)
          const bl = baselineFromInk(canvas, bd, pv.w, color) ?? (bd.y + bd.h)
          const m = measureText(lines[li], reading.font, lineSize, reading.bold)
          texts.push({
            id: uid(), page: ref.id, kind: 'text', opacity: 1,
            x: bd.x, y: bl - lineSize * BASELINE_EM, w: m.w, h: m.h,
            text: lines[li], color, size: lineSize, font: reading.font, bold: reading.bold,
          })
          inpaint.push(bd)
        }
      } else {
        const color = pickColor(canvas, anchor, pv.w, reading.color)
        const baseline = baselineFromInk(canvas, anchor, pv.w, color) ?? (anchor.y + anchor.h)
        const boxW = block.w > anchor.w * 1.05 ? Math.round(block.w) : undefined
        const m = measureText(text, reading.font, size, reading.bold, boxW)
        // Recover the multi-line case: OCR sometimes returns the rows joined by a
        // space rather than a newline, so `lines` was 1 while there are N bands.
        // If re-wrapping the text to the block width breaks it back into exactly
        // as many visual rows as there are ink bands, treat it like the matched
        // path — one wrapped line per band, each on its own measured baseline and
        // each band erased. This peels the "two coloured lines" case cleanly.
        if (bands.length >= 2 && m.lines.length === bands.length) {
          for (let li = 0; li < bands.length; li++) {
            const bd = bands[li]
            const bcol = pickColor(canvas, bd, pv.w, reading.color)
            const bl = baselineFromInk(canvas, bd, pv.w, bcol) ?? (bd.y + bd.h)
            const lm = measureText(m.lines[li], reading.font, size, reading.bold)
            texts.push({
              id: uid(), page: ref.id, kind: 'text', opacity: 1,
              x: bd.x, y: bl - size * BASELINE_EM, w: lm.w, h: lm.h,
              text: m.lines[li], color: bcol, size, font: reading.font, bold: reading.bold,
            })
            inpaint.push(bd)
          }
        } else {
          texts.push({
            id: uid(), page: ref.id, kind: 'text', opacity: 1,
            x: anchor.x, y: baseline - size * BASELINE_EM, w: m.w, h: m.h,
            text, color, size, font: reading.font, bold: reading.bold, ...(boxW ? { boxW } : {}),
          })
          // Erase only the rows this reprint actually covers. Erasing an ink band
          // the reprint does not reach would blank content we cannot reproduce —
          // a worse failure than leaving that row as the original. The object runs
          // from its baseline down by its measured height; bands whose centre sits
          // below that stay as the original raster rather than being lost.
          const objBottom = baseline - size * BASELINE_EM + m.h
          const rows = bands.length
            ? bands.filter((bd) => bd.y + bd.h / 2 <= objBottom + 2)
            : [block]
          inpaint.push(...(rows.length ? rows : [anchor]))
        }
      }

      // 5. rebuild the background under the ink we replaced, one patch per row.
      //    Tell makeBlendedPatch how far the nearest line of type is above and
      //    below each row (same as the interactive erase), so its textured fill
      //    can't mirror an adjacent line's ink into the cleared row as bright
      //    fragments — the "ghosted outline" a banner peel appeared to leave.
      for (const bd of inpaint) {
        const gone = await spansUnder(bd)
        let above: number | undefined, below: number | undefined
        try {
          for (const nb of detectInkBands(canvas, { x: bd.x, y: bd.y - 60, w: bd.w, h: bd.h + 120 }, pv.w)) {
            if (nb.y + nb.h <= bd.y + 0.5) above = Math.min(above ?? Infinity, Math.max(1, bd.y - (nb.y + nb.h)))
            if (nb.y >= bd.y + bd.h - 0.5) below = Math.min(below ?? Infinity, Math.max(1, nb.y - (bd.y + bd.h)))
          }
        } catch { /* no bands: default padding is fine */ }
        const paper = makeBlendedPatch(canvas, bd, pv.w, above, below)
        patches.push({
          id: uid(), page: ref.id, kind: 'whiteout', opacity: 1, ...bd, ...paper,
          ...(gone.length ? { removedSpans: gone } : {}),
        })
      }
    }

    // addObjects writes to whatever doc is active NOW; if the user switched docs
    // mid-peel these layers (tagged with ref.id) would land orphaned in the wrong
    // one. Discard rather than corrupt — the source page is unchanged.
    if (s().active !== startDoc) {
      s().toast('Peel discarded — the document changed', 'warn')
      return { layers: 0, blocks: blocks.length, skipped, outcome: 'discarded' }
    }
    const objs = [...patches, ...texts] // every background first, then every text
    if (objs.length) s().addObjects(objs)
    if (token.aborted) s().toast(`Stopped — peeled ${texts.length} of ${blocks.length}`, 'warn')
    // Zero layers has four quite different causes and the caller could not tell
    // them apart: an empty page, Stop, a document switch, or every block failing
    // its read. All four printed "No text found to peel", which is a statement
    // about the PAGE and was false in three of them.
    return {
      layers: texts.length, blocks: blocks.length, skipped,
      outcome: texts.length ? 'ok' : (token.aborted ? 'stopped' : 'allskipped'),
    }
  } finally {
    // only clear the busy indicator when the LAST concurrent peel finishes, so a
    // fast run doesn't null the spinner out from under a slower one still going
    running.delete(token)
    if (running.size === 0) s().setBusy(null)
  }
}
