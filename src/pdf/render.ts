import { PDFDocument, degrees } from 'pdf-lib'
import { pdfjs } from './setup'
import { getPageProxy, totalRotation, getLibDoc } from './registry'
import { removeSpans, formStreamShared } from './contentwalk'
import type { RemovalEdit } from './contentwalk'
import type { PageRef } from '../core/types'
import type { RenderTask } from 'pdfjs-dist'

const tasks = new Map<string, RenderTask>()

/** Scale the sampling/analysis canvases are rendered at. */
export const SAMPLE_SCALE = 1.5

/**
 * Render a page into a canvas at the given CSS scale (device pixel ratio handled here).
 * Re-entrant per key: a newer render cancels the older one.
 */
export async function renderPageToCanvas(
  key: string,
  ref: PageRef,
  cssScale: number,
  canvas: HTMLCanvasElement,
): Promise<boolean> {
  const page = await getPageProxy(ref)
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  let scale = cssScale * dpr
  const probe = page.getViewport({ scale: 1, rotation: totalRotation(ref) })
  // cap canvas edge at 8192px to stay within GPU texture limits
  const maxEdge = 8192
  scale = Math.min(scale, maxEdge / Math.max(probe.width, probe.height))
  const viewport = page.getViewport({ scale, rotation: totalRotation(ref) })

  tasks.get(key)?.cancel()

  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) return false

  const task = page.render({
    canvasContext: ctx,
    viewport,
    annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS,
  })
  tasks.set(key, task)
  try {
    await task.promise
    return true
  } catch (err) {
    if (err instanceof Error && err.name === 'RenderingCancelledException') return false
    console.warn('render failed', err)
    return false
  } finally {
    if (tasks.get(key) === task) tasks.delete(key)
  }
}

export function cancelRender(key: string): void {
  tasks.get(key)?.cancel()
  tasks.delete(key)
}

// Per-container render token + the live TextLayer, so a rapid re-render (rotating
// a page twice quickly) cancels the previous layer and supersedes a stale one —
// otherwise the first render keeps appending spans into the container the second
// already cleared, leaving a mix of two orientations' selectable text.
const textRenderTokens = new WeakMap<HTMLDivElement, object>()
const liveTextLayers = new WeakMap<HTMLDivElement, { cancel(): void }>()

/** Render the pdf.js text layer (built at scale 1; zoomed via the --scale-factor CSS variable). */
export async function renderTextLayer(ref: PageRef, container: HTMLDivElement): Promise<void> {
  const token = {}
  textRenderTokens.set(container, token)
  liveTextLayers.get(container)?.cancel()
  const page = await getPageProxy(ref)
  if (textRenderTokens.get(container) !== token) return // a newer render claimed this container
  const viewport = page.getViewport({ scale: 1, rotation: totalRotation(ref) })
  liveTextLayers.get(container)?.cancel()
  container.replaceChildren()
  // pdf.js sizes the layer from `rawDims` (viewBox x userUnit), which is
  // scale-INDEPENDENT — so on a /UserUnit page the container comes out userUnit
  // times the page shell and every span sits a page below its glyphs. Nothing is
  // selectable, and the oversized layer spills over the FOLLOWING page where it
  // swallows clicks. Until the layer can be built in the shell's space, leave it
  // empty rather than lay a broken one down; the page still renders and the app's
  // own search (textsearch.ts, which normalises userUnit) still works.
  if (((page as { userUnit?: number }).userUnit ?? 1) !== 1) return
  const layer = new pdfjs.TextLayer({
    textContentSource: page.streamTextContent(),
    container,
    viewport,
  })
  liveTextLayers.set(container, layer as unknown as { cancel(): void })
  try {
    await layer.render()
  } catch {
    // a superseding render cancelled this one — the abort rejects render(); it's
    // expected, so swallow it rather than surface an unhandled rejection
  }
}

/**
 * Deterministic offscreen render used for paper-color sampling. Unlike the display
 * canvas (which may be mid-render during zooms), this is awaited and cached.
 */
const sampleCanvases = new Map<string, Promise<HTMLCanvasElement>>()

export function getSamplingCanvas(ref: PageRef): Promise<HTMLCanvasElement> {
  const key = `${ref.srcId}:${ref.srcIndex}:${totalRotation(ref)}`
  let p = sampleCanvases.get(key)
  if (!p) {
    p = (async () => {
      const page = await getPageProxy(ref)
      const viewport = page.getViewport({ scale: SAMPLE_SCALE, rotation: totalRotation(ref) })
      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true })!
      // 'print' intent renders without requestAnimationFrame chunking — display-intent
      // renders stall indefinitely in background tabs, which would hang sampling
      await page.render({ canvasContext: ctx, viewport, intent: 'print', annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS }).promise
      return canvas
    })()
    if (sampleCanvases.size > 8) sampleCanvases.clear()
    sampleCanvases.set(key, p)
  }
  return p
}

/**
 * Crop a page region to a high-res PNG (for the AI to read print). View-space rect.
 * Vertical margin stays near zero so neighboring lines don't leak into the crop —
 * a sliver of a line is enough for a good model to "helpfully" transcribe all of it.
 */
export async function renderRegionToDataUrl(
  ref: PageRef,
  rect: { x: number; y: number; w: number; h: number },
  scale = 3,
  marginX = 5,
  marginY = 1,
): Promise<string> {
  const page = await getPageProxy(ref)
  const viewport = page.getViewport({ scale, rotation: totalRotation(ref) })
  // pdf.js bakes /UserUnit into the viewport, so page content lands at
  // view x (scale x userUnit) device px while `rect` is unscaled view space. Using
  // `scale` alone read the wrong region entirely on such a page — every AI crop,
  // peel and lift sampled somewhere else. Same correction as the redaction burn.
  const k = scale * ((page as { userUnit?: number }).userUnit ?? 1)
  const full = document.createElement('canvas')
  full.width = Math.floor(viewport.width)
  full.height = Math.floor(viewport.height)
  const ctx = full.getContext('2d', { alpha: false })!
  await page.render({ canvasContext: ctx, viewport, intent: 'print', annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS }).promise
  // Clamp the source read to the canvas, and SHRINK the span by whatever was
  // clamped off the left/top — otherwise a region hugging the left/top edge starts
  // the read at 0 but keeps the full margin-inclusive width, capturing content that
  // extends past the requested region on the right/bottom (a peel/blend crop then
  // feeds a neighbour's words to the OCR/vision read). Mirrors the caller-side fix
  // in ObjectsLayer's buildRasterObject.
  const rawX = (rect.x - marginX) * k
  const rawY = (rect.y - marginY) * k
  const sx = Math.max(0, rawX)
  const sy = Math.max(0, rawY)
  const sw = Math.min(full.width - sx, (rect.w + marginX * 2) * k - (sx - rawX))
  const sh = Math.min(full.height - sy, (rect.h + marginY * 2) * k - (sy - rawY))
  const crop = document.createElement('canvas')
  crop.width = Math.max(2, Math.floor(sw))
  crop.height = Math.max(2, Math.floor(sh))
  crop.getContext('2d')!.drawImage(full, sx, sy, sw, sh, 0, 0, crop.width, crop.height)
  return crop.toDataURL('image/png')
}

/** Offscreen high-res render of a page (used for true redaction + thumbnails-to-file). */
export async function renderPageToDataUrl(ref: PageRef, targetWidth: number, draw?: (ctx: CanvasRenderingContext2D, scale: number) => void): Promise<{ dataUrl: string; w: number; h: number }> {
  const page = await getPageProxy(ref)
  const probe = page.getViewport({ scale: 1, rotation: totalRotation(ref) })
  const scale = targetWidth / probe.width
  const viewport = page.getViewport({ scale, rotation: totalRotation(ref) })
  const canvas = document.createElement('canvas')
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  const ctx = canvas.getContext('2d', { alpha: false })!
  // 'print' intent: deterministic, no rAF chunking — a true-redact export must not
  // hang because the user switched to another tab mid-export
  await page.render({ canvasContext: ctx, viewport, intent: 'print', annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS }).promise
  // The draw callback (redaction burns its black boxes here) works in UNSCALED view
  // space, but pdf.js bakes /UserUnit into the viewport, so page content lands at
  // view×(userUnit×scale) device px. Hand the callback that full factor, or on a
  // UserUnit≠1 page the boxes land at 1/userUnit of the content and cover nothing.
  const userUnit = (page as { userUnit?: number }).userUnit ?? 1
  draw?.(ctx, scale * userUnit)
  return { dataUrl: canvas.toDataURL('image/jpeg', 0.92), w: probe.width, h: probe.height }
}

/**
 * A single run of text on the page, positioned in the SAME view space the page is
 * rendered and the redaction marks live in (scale 1, page rotation applied,
 * top-left origin, y down). `vx`/`vy` is the baseline origin, `fs` the on-screen
 * font height, `w` the run's advance width, `angle` its baseline angle (radians).
 *
 * Used to lay an invisible, still-selectable text layer back over a page that had
 * to be rasterised for redaction — so the words the marks did NOT cover stay
 * searchable and copyable instead of turning into flat pixels. The caller is
 * responsible for dropping any run that touches a mark (a leak otherwise).
 */
export interface TextRun { str: string; vx: number; vy: number; fs: number; w: number; angle: number }

export async function getPageTextRuns(ref: PageRef): Promise<TextRun[]> {
  const page = await getPageProxy(ref)
  // pdf.js multiplies the viewport (and thus every run's coords) by /UserUnit, but
  // the redaction marks are placed in UNSCALED view space. On a UserUnit≠1 page the
  // two spaces differ by that factor, so the mark-exclusion test would never match
  // and every run would be re-added — a systematic leak. Fail closed: no invisible
  // layer for such pages (they still redact safely, just without a searchable layer).
  if (((page as { userUnit?: number }).userUnit ?? 1) !== 1) return []
  const viewport = page.getViewport({ scale: 1, rotation: totalRotation(ref) })
  let tc
  try { tc = await page.getTextContent() } catch { return [] }
  const styles = (tc as { styles?: Record<string, { vertical?: boolean }> }).styles ?? {}
  const runs: TextRun[] = []
  for (const item of tc.items) {
    if (!('str' in item) || !item.str) continue
    // Vertical writing mode (Identity-V etc.): pdf.js reports the run's width as a
    // single glyph (~font size) while the column descends via `height`, and the
    // baseline angle stays ~0. A horizontal re-add would both misplace it AND, worse,
    // its box would bracket only the top glyph — a mark over the lower column would
    // miss, re-adding the covered text as extractable. These pages already rasterise
    // (unsafe font); the safe move is to leave vertical/stacked runs OUT entirely.
    const it = item as { fontName?: string; height?: number; transform: number[]; str: string; width: number }
    if (styles[it.fontName ?? '']?.vertical) continue
    const tfs = Math.hypot(it.transform[2], it.transform[3])          // text-space font size
    if (it.height && it.height > tfs * 1.5 && it.str.length > 1) continue // anomalously tall run — stacked/vertical, drop
    // item.transform maps the run to unrotated user space; composing with the
    // viewport transform puts the baseline origin into view space, exactly where
    // the rendered raster (same viewport) drew it.
    const m = pdfjs.Util.transform(viewport.transform, item.transform)
    const fs = Math.hypot(m[2], m[3])
    if (!(fs > 0.01)) continue
    runs.push({ str: item.str, vx: m[4], vy: m[5], fs, w: item.width, angle: Math.atan2(m[1], m[0]) })
  }
  return runs
}

/* ----- the background that was always there -------------------------------

   Erasing printed text by painting over it is guesswork: you decide which
   pixels were ink, take them out, and invent something to put back. Every
   artefact we have chased — the flat block over a pattern, the faint traces of
   the letters that were "removed" — comes from that guess.

   For most PDFs the guess is unnecessary. The page is a stack of drawing
   instructions and the text is drawn ON TOP of the background; the background
   is still in the file, whole and exact, underneath. So don't reconstruct it —
   re-render the page with those glyphs simply not drawn, and read the true
   pixels off the result. Nothing is invented, so nothing can be wrong: the
   pattern continues because it IS the pattern, and no trace of the type is left
   because the type was never painted.

   pdf.js draws glyphs through ctx.fillText/strokeText, and every other mark on
   the page (vector fills, strokes, images) through other calls. A canvas
   context that drops those two calls — and only for glyphs whose baseline lands
   in the region we're erasing — leaves the rest of the page untouched. */

/** A canvas context that refuses to draw glyphs landing inside `hide`. */
function textSuppressingCtx(
  ctx: CanvasRenderingContext2D,
  hide: (deviceX: number, deviceY: number) => boolean,
): CanvasRenderingContext2D {
  const skip = (x: number, y: number): boolean => {
    const m = ctx.getTransform()
    return hide(m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f)
  }
  return new Proxy(ctx, {
    get(target, prop, recv) {
      if (prop === 'fillText' || prop === 'strokeText') {
        const real = prop === 'fillText' ? target.fillText : target.strokeText
        return function (text: string, x: number, y: number, maxWidth?: number): void {
          if (skip(x, y)) return
          if (maxWidth === undefined) real.call(target, text, x, y)
          else real.call(target, text, x, y, maxWidth)
        }
      }
      const v = Reflect.get(target, prop, target)
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
    },
    set(target, prop, value) {
      ;(target as unknown as Record<string | symbol, unknown>)[prop] = value
      return true
    },
    has(target, prop) { return Reflect.has(target, prop) },
  }) as CanvasRenderingContext2D
}

export interface HideRect { x: number; y: number; w: number; h: number }

/**
 * Render a page at sampling scale with the glyphs inside `hide` left undrawn —
 * i.e. the page exactly as it would look if that text had never been typed.
 * Rects are in page points (top-down), matching the rest of the app.
 */
/**
 * Render the page with the given token spans taken OUT of its own drawing
 * program — the true background under a lifted element, whatever it is (a run of
 * text, an image, a vector shape). Unlike renderPageWithoutText, which suppresses
 * glyphs at the canvas, this edits the content stream on a throwaway copy of the
 * page and renders that, so it removes anything the walker can point at. A text
 * span may carry a `replacement` (its advance stand-in) so the rest of its line
 * keeps its place. Returns null if the page can't be copied/rendered.
 */
export async function renderPageWithoutSpans(
  ref: PageRef,
  edits: RemovalEdit[],
  scale = SAMPLE_SCALE,
): Promise<HTMLCanvasElement | null> {
  try {
    const src = await getLibDoc(ref.srcId)
    const tmp = await PDFDocument.create()
    const [copied] = await tmp.copyPages(src, [ref.srcIndex])
    const p = tmp.addPage(copied)
    p.setRotation(degrees(totalRotation(ref)))
    // A form drawn more than once on the page shares one content stream; editing
    // it to remove one occurrence's ink would erase the others too. Bail so the
    // caller falls back to a flat paper-colour patch instead of corrupting them.
    for (const e of edits)
      if (e.formPath?.length && formStreamShared(tmp, p, e.formPath)) return null
    removeSpans(tmp, p, edits)
    const bytes = await tmp.save()
    const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise
    try {
      const page = await doc.getPage(1)
      const viewport = page.getViewport({ scale }) // the copied page carries its own rotation
      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true })!
      await page.render({ canvasContext: ctx, viewport, intent: 'print' }).promise
      return canvas
    } finally {
      doc.destroy()
    }
  } catch {
    return null
  }
}

export async function renderPageWithoutText(
  ref: PageRef,
  hide: HideRect[],
  scale = SAMPLE_SCALE,
): Promise<HTMLCanvasElement> {
  const page = await getPageProxy(ref)
  const viewport = page.getViewport({ scale, rotation: totalRotation(ref) })
  const canvas = document.createElement('canvas')
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true })!
  // A glyph is placed by its BASELINE, which sits inside the band we mean to
  // clear, so testing that one point against the rect is enough — and it is
  // exact, unlike deciding pixel by pixel what was ink.
  const inside = (dx: number, dy: number): boolean => {
    const px = dx / scale
    const py = dy / scale
    for (const r of hide) {
      // half-open on the right: a glyph whose origin sits exactly on the far
      // edge is the FIRST glyph of the next run, not the last of this one —
      // include it and an adjacent "!" disappears along with the words
      if (px >= r.x - 0.5 && px < r.x + r.w - 0.25 && py >= r.y - 0.5 && py <= r.y + r.h + 0.5) return true
    }
    return false
  }
  await page.render({
    canvasContext: textSuppressingCtx(ctx, inside),
    viewport,
    intent: 'print',
    annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS,
  }).promise
  return canvas
}
