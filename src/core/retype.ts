import type { FontId, PageRef, Rect, TextObj } from './types'
import { useStore, activeDoc } from './store'
import { getSamplingCanvas } from '../pdf/render'
import { buildAtlas, composeFromAtlas, snapshotBand } from './glyphclone'
import { measureText } from './measure'

/* ----- retype-in-place -------------------------------------------------------
   Turn a printed word into an editable one that looks identical. The lift path
   (in ObjectsLayer) produces a metric-matched editable text object; this module
   adds the pixel-identical layer: it remembers where the original ink is and
   what it said, so it can recompose the current text from the document's own
   glyphs on demand ("Match exactly"), and clear back to live font on edit. */

interface CloneSource {
  page: string
  band: Rect
  sourceText: string
  baselineY: number
}

// session cache: object id → where its original ink lives (kept out of the doc
// schema / undo history; a reload just means re-lifting)
const cloneSources = new Map<string, CloneSource>()

export function registerCloneSource(id: string, src: CloneSource): void {
  cloneSources.set(id, src)
}

export function hasCloneSource(id: string): boolean {
  return cloneSources.has(id)
}

/**
 * Compose the object's CURRENT text from the original printed glyphs and, if
 * enough letters are present to look right, store it as the object's
 * pixel-identical rendering. Returns the clone coverage (0..1) or null.
 */
export async function cloneTextLook(id: string, opts?: { minCoverage?: number; silent?: boolean }): Promise<number | null> {
  const s = useStore.getState
  const d = activeDoc()
  const obj = d?.objects[id] as TextObj | undefined
  const src = cloneSources.get(id)
  if (!d || !obj || obj.kind !== 'text' || !src) return null
  const pageRef = d.pages.find((p) => p.id === src.page)
  if (!pageRef) return null
  const wantText = obj.text // capture: an edit/undo mid-await must not be clobbered
  try {
    const canvas = await getSamplingCanvas(pageRef)
    const unchanged = wantText.replace(/\s+/g, ' ').trim() === src.sourceText.replace(/\s+/g, ' ').trim()
    // unchanged text → copy the original pixels verbatim (trivially identical);
    // otherwise recompose from the harvested letters
    const comp = unchanged
      ? snapshotBand(canvas, src.band, canvas.width / 1.5)
      : (() => {
          const atlas = buildAtlas(canvas, src.band, src.sourceText, canvas.width / 1.5)
          return atlas ? composeFromAtlas(atlas, wantText, obj.font, obj.bold) : null
        })()
    if (!comp) return null
    const min = opts?.minCoverage ?? 0.6
    if (comp.coverage < min) {
      if (!opts?.silent) s().toast(`Only ${Math.round(comp.coverage * 100)}% of these letters are on the page — keeping the matched font`, 'info')
      return comp.coverage
    }
    // the object may have been edited, undone, or deleted while we awaited the
    // canvas — only write if it still exists with the text we cloned
    const now = activeDoc()?.objects[id] as TextObj | undefined
    if (!now || now.kind !== 'text' || now.text !== wantText) return comp.coverage
    // seat the composed bitmap so its baseline lands on the original baseline
    // and its first ink lands where the original text's first ink did
    s().updateObject(id, {
      x: src.band.x + comp.inset,
      y: src.baselineY - comp.baselineFromTop,
      glyphSrc: comp.dataUrl,
      glyphW: comp.w,
      glyphH: comp.h,
      w: comp.w,
      h: comp.h,
    })
    if (!opts?.silent) {
      s().toast(comp.coverage >= 0.999 ? 'Cloned the original letters — pixel-identical' : `Cloned ${Math.round(comp.coverage * 100)}% from the page`, 'ok')
    }
    return comp.coverage
  } catch {
    return null
  }
}

/** The original baseline y for a lifted object, so vector text can sit on it too. */
export function cloneBaselineY(id: string): number | null {
  return cloneSources.get(id)?.baselineY ?? null
}

/** Drop the cloned bitmap, returning to the live (still metric-matched) font. */
export function uncloneTextLook(id: string): void {
  const s = useStore.getState
  const obj = activeDoc()?.objects[id] as TextObj | undefined
  if (!obj || obj.kind !== 'text' || !obj.glyphSrc) return
  const m = measureText(obj.text || ' ', obj.font, obj.size, obj.bold, obj.boxW, obj.tracking ?? 0)
  // the clone was seated at top-of-ink; vector text puts the baseline at
  // y + size*1.02, so shift y up to keep the baseline on the original line
  const baselineY = cloneSources.get(id)?.baselineY
  const y = baselineY != null ? baselineY - obj.size * 1.02 : obj.y
  s().commitNow()
  s().updateObject(id, { glyphSrc: undefined, glyphW: undefined, glyphH: undefined, w: obj.boxW ?? m.w, h: m.h, y })
}

export interface RetypeStyle {
  size: number
  tracking: number
  font: FontId
  bold: boolean
  color: string
  x: number
  y: number
  baselineY: number
}
export type { PageRef }
