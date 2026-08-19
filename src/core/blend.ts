import type { PageRef, Rect, TextObj } from './types'
import { useStore, activeDoc } from './store'
import { getPageSpanRects } from '../pdf/textsearch'
import { getSamplingCanvas, renderRegionToDataUrl } from '../pdf/render'
import { detectInkBands, makeBlendedPatch, median, sampleInkColor, samplePaperColor } from '../pdf/patch'
import { measureText } from './measure'
import { readRegion } from '../ai/client'

/* ----- blending user edits into the print ---------------------------------------
   The reshape tool reads the page; this module works the other way around: it
   takes objects the USER added and re-seats them in the document's own grid —
   baseline on a printed line (or the page's leading), left edge on a column or
   right after a printed label, glyph size from the neighbouring line height,
   ink colour from the neighbouring pixels, typeface via the connected model.
   White-out patches are re-reconstructed with the inpainter. */

interface Line {
  x: number
  right: number
  y: number
  bottom: number
  h: number // median span height — glyph size, not the ascender/descender union
  spans: Rect[]
}

/** Group text-layer span rects into visual lines (columns sharing a baseline merge). */
export function clusterLines(spans: Rect[]): Line[] {
  const usable = spans.filter((r) => r.h > 3 && r.h < 120 && r.w > 1.5)
  const sorted = usable.slice().sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2))
  const lines: Line[] = []
  for (const r of sorted) {
    const yc = r.y + r.h / 2
    const last = lines[lines.length - 1]
    if (last && Math.abs(yc - (last.y + last.bottom) / 2) < Math.max(3, last.h * 0.5)) {
      last.x = Math.min(last.x, r.x)
      last.right = Math.max(last.right, r.x + r.w)
      last.y = Math.min(last.y, r.y)
      last.bottom = Math.max(last.bottom, r.y + r.h)
      last.spans.push(r)
      last.h = median(last.spans.map((sp) => sp.h))
    } else {
      lines.push({ x: r.x, right: r.x + r.w, y: r.y, bottom: r.y + r.h, h: r.h, spans: [r] })
    }
  }
  return lines
}

/** Where visual runs of text start on a line — column/tab-stop candidates. */
function runStarts(l: Line): number[] {
  const s = l.spans.slice().sort((a, b) => a.x - b.x)
  const out: number[] = []
  let prevEnd = -Infinity
  for (const r of s) {
    if (r.x - prevEnd > Math.max(6, l.h)) out.push(r.x)
    prevEnd = Math.max(prevEnd, r.x + r.w)
  }
  return out
}

/**
 * The page's printed lines around a rect: text-layer spans when the page has
 * them, otherwise ink bands detected straight from the pixels (posters, scans,
 * outlined vector text).
 */
async function pageLines(pageRef: PageRef, canvas: HTMLCanvasElement | null, around: Rect): Promise<Line[]> {
  const spans = await getPageSpanRects(pageRef).catch(() => [] as Rect[])
  const lines = clusterLines(spans)
  const oc = around.y + around.h / 2
  if (lines.some((l) => Math.abs((l.y + l.bottom) / 2 - oc) < 160)) return lines
  if (!canvas) return lines
  return detectInkBands(canvas, around, canvas.width / 1.5).map((b) => ({
    x: b.x,
    right: b.right,
    y: b.y,
    bottom: b.y + b.h,
    h: b.h,
    spans: [],
  }))
}

interface TextBlend {
  size: number
  x: number
  y: number
  color?: string
  lineRect: Rect // the printed line the style was read from (AI refine crop)
}

async function computeTextBlend(
  obj: TextObj,
  pageRef: PageRef,
  canvas: HTMLCanvasElement | null,
  refRect?: Rect, // the user's gesture: "match the print inside THIS box"
): Promise<TextBlend | null> {
  const objArea = { x: obj.x, y: obj.y, w: Math.max(obj.w, 60), h: Math.max(obj.h, obj.size * 1.3) }
  const around = refRect
    ? {
        x: Math.min(refRect.x, objArea.x),
        y: Math.min(refRect.y, objArea.y),
        w: Math.max(refRect.x + refRect.w, objArea.x + objArea.w) - Math.min(refRect.x, objArea.x),
        h: Math.max(refRect.y + refRect.h, objArea.y + objArea.h) - Math.min(refRect.y, objArea.y),
      }
    : objArea
  const lines = await pageLines(pageRef, canvas, around)
  const oc = obj.y + obj.size * 0.65
  // How far a printed line may be to still count as "the line this text belongs
  // to". With an explicit gesture box the user pointed AT some print, so reach
  // generously (160). Without one — freshly typed text auto-matching — only snap
  // to a line the text is essentially sitting ON (about one-and-a-half of its own
  // line heights), or a click into whitespace jumps to a heading two lines away
  // and silently resizes what the user just typed.
  const maxDy = refRect ? 160 : Math.max(20, obj.size * 1.6)
  const near = lines
    .map((l) => ({ l, dy: Math.abs((l.y + l.bottom) / 2 - oc) }))
    .filter((e) => e.dy < maxDy)
    .sort((a, b) => a.dy - b.dy)
  if (!near.length) return null

  // The style reference: printed lines INSIDE the gesture box beat everything;
  // otherwise the single closest line — never an average of unrelated sizes.
  const refLines = refRect
    ? near.filter((e) => {
        const padY = 28 // the line grazing the box edge is part of the gesture
        return (
          e.l.y < refRect.y + refRect.h + padY &&
          e.l.bottom > refRect.y - padY &&
          e.l.x < refRect.x + refRect.w + 10 &&
          e.l.right > refRect.x - 10
        )
      })
    : []
  const ref = (refLines.length ? refLines : near)[0].l
  const size = Math.max(5, Math.min(96, Math.round((ref.h / 1.15) * 10) / 10))

  // baseline: sit ON an overlapping printed line, else on the page's leading grid
  let y = obj.y
  const overlapping = near.find((e) => e.l.y < obj.y + size * 1.2 && e.l.bottom > obj.y)
  if (overlapping) {
    y = overlapping.l.y - 1
  } else {
    const ys = lines.map((l) => l.y).sort((a, b) => a - b)
    const diffs: number[] = []
    for (let i = 1; i < ys.length; i++) {
      const dy = ys[i] - ys[i - 1]
      if (dy > 4 && dy < 60) diffs.push(dy)
    }
    const leading = diffs.length >= 2 ? median(diffs) : null
    if (leading) {
      const base = near[0].l.y
      const cand = base + Math.round((obj.y - base) / leading) * leading - 1
      if (Math.abs(cand - obj.y) <= leading * 0.45) y = cand
    }
  }

  // left edge: if the box sits INSIDE a printed span it's a mid-line replacement
  // (typed over an erasure) and x is intentional. Otherwise continue a label
  // that ends just left of it, or snap to a column start.
  let x = obj.x
  const spaceW = size * 0.3
  const covered = overlapping ? overlapping.l.spans.some((r) => r.x < obj.x - 4 && r.x + r.w > obj.x + 4) : false
  if (overlapping && !covered) {
    let labelEnd: number | null = null
    for (const r of overlapping.l.spans) {
      const right = r.x + r.w
      if (right <= obj.x + 6 && obj.x - right <= spaceW * 3) labelEnd = Math.max(labelEnd ?? -Infinity, right)
    }
    if (labelEnd !== null) x = labelEnd + spaceW
  }
  if (x === obj.x && !covered) {
    let best: number | null = null
    for (const e of near)
      for (const rs of runStarts(e.l)) if (best === null || Math.abs(rs - obj.x) < Math.abs(best - obj.x)) best = rs
    if (best !== null && Math.abs(best - obj.x) <= 14) x = best
  }
  if (x === obj.x && !covered && overlapping && !overlapping.l.spans.length && Math.abs(overlapping.l.x - obj.x) <= 14) {
    x = overlapping.l.x // pixel-detected line: its ink's left edge is the column
  }

  const l0 = ref
  const lineRect = { x: l0.x, y: l0.y, w: Math.min(l0.right - l0.x, 420), h: l0.bottom - l0.y }
  let color: string | undefined
  if (canvas) {
    try {
      color = sampleInkColor(canvas, lineRect, canvas.width / 1.5)
    } catch {
      /* keep the object's colour */
    }
  }
  return { size, x, y, color, lineRect }
}

/**
 * Blend the given objects into the print. Text objects get re-seated and
 * restyled (size/position/ink now, typeface async when a model is connected);
 * white-out patches get re-reconstructed by the inpainter.
 */
export async function blendObjects(ids: string[], opts?: { refRect?: Rect }): Promise<void> {
  const s = useStore.getState
  const d = activeDoc()
  if (!d) return
  const targets = ids.map((id) => d.objects[id]).filter(Boolean)
  const texts = targets.filter((o): o is TextObj => o.kind === 'text')
  const whiteouts = targets.filter((o) => o.kind === 'whiteout')
  if (!texts.length && !whiteouts.length) {
    s().toast('Select added text or white-out patches to blend', 'info')
    return
  }
  s().commitNow()
  let blended = 0
  const refine: { id: string; lineRect: Rect; pageRef: PageRef }[] = []

  for (const obj of texts) {
    const pageRef = d.pages.find((p) => p.id === obj.page)
    if (!pageRef) continue
    const canvas = await getSamplingCanvas(pageRef).catch(() => null)
    const res = await computeTextBlend(obj, pageRef, canvas, opts?.refRect)
    if (!res) continue
    const m = measureText(obj.text, obj.font, res.size, obj.bold, obj.boxW)
    s().updateObject(obj.id, {
      size: res.size,
      x: res.x,
      y: res.y,
      w: obj.boxW ?? m.w,
      h: m.h,
      ...(res.color ? { color: res.color } : {}),
    })
    refine.push({ id: obj.id, lineRect: res.lineRect, pageRef })
    blended++
  }

  for (const obj of whiteouts) {
    const pageRef = d.pages.find((p) => p.id === obj.page)
    if (!pageRef) continue
    try {
      const canvas = await getSamplingCanvas(pageRef)
      const patch = makeBlendedPatch(canvas, { x: obj.x, y: obj.y, w: obj.w, h: obj.h }, canvas.width / 1.5)
      s().updateObject(obj.id, { color: patch.color, src: patch.src })
      blended++
    } catch {
      /* leave the patch as it is */
    }
  }

  if (!blended) {
    s().toast('No printed text near the selection to blend with', 'warn')
    return
  }

  const cfg = s().aiConfig
  if (cfg && refine.length) {
    s().toast(`Blended — matching the typeface with ${cfg.model}…`, 'info')
    void (async () => {
      let matched = 0
      for (const r of refine) {
        try {
          const crop = await renderRegionToDataUrl(r.pageRef, r.lineRect, 3)
          const reading = await readRegion(cfg, crop)
          const cur = activeDoc()?.objects[r.id] as TextObj | undefined
          if (!cur) continue
          const m = measureText(cur.text, reading.font, cur.size, reading.bold, cur.boxW)
          s().updateObject(r.id, { font: reading.font, bold: reading.bold, w: cur.boxW ?? m.w, h: m.h }, { keepRedo: true })
          matched++
        } catch {
          /* size/baseline/ink already blended */
        }
      }
      if (matched) s().toast('Typeface matched to the print', 'ok')
    })()
  } else {
    s().toast(
      refine.length
        ? `Blended into the print — size, baseline and ink matched${cfg ? '' : ' (connect a model to match the typeface too)'}`
        : 'Patch re-blended into the background',
      'ok',
    )
  }
}

/**
 * Quiet magnetism for a freshly committed text box: snap onto an overlapping
 * printed baseline / nearby column edge, touch nothing else. No toasts.
 */
export async function snapTextPosition(id: string): Promise<void> {
  const s = useStore.getState
  const d = activeDoc()
  const obj = d?.objects[id]
  if (!d || !obj || obj.kind !== 'text' || !obj.text.trim()) return
  const pageRef = d.pages.find((p) => p.id === obj.page)
  if (!pageRef) return
  const canvas = await getSamplingCanvas(pageRef).catch(() => null)
  const lines = await pageLines(pageRef, canvas, {
    x: obj.x, y: obj.y, w: Math.max(obj.w, 60), h: Math.max(obj.h, obj.size * 1.3),
  })
  let x = obj.x
  let y = obj.y
  const overlapping = lines.find((l) => l.y < obj.y + obj.size * 1.2 && l.bottom > obj.y)
  if (overlapping && Math.abs(overlapping.y - 1 - obj.y) <= obj.size * 0.7) y = overlapping.y - 1
  const covered = overlapping ? overlapping.spans.some((r) => r.x < obj.x - 4 && r.x + r.w > obj.x + 4) : false
  if (overlapping && !covered) {
    let labelEnd: number | null = null
    for (const r of overlapping.spans) {
      const right = r.x + r.w
      if (right <= obj.x + 6 && obj.x - right <= obj.size * 0.9) labelEnd = Math.max(labelEnd ?? -Infinity, right)
    }
    if (labelEnd !== null) x = labelEnd + obj.size * 0.3
  }
  if (x === obj.x && !covered) {
    let best: number | null = null
    for (const l of lines)
      if (Math.abs((l.y + l.bottom) / 2 - (obj.y + obj.size * 0.65)) < 120)
        for (const rs of runStarts(l)) if (best === null || Math.abs(rs - obj.x) < Math.abs(best - obj.x)) best = rs
    if (best !== null && Math.abs(best - obj.x) <= 10) x = best
  }
  if (x === obj.x && !covered && overlapping && !overlapping.spans.length && Math.abs(overlapping.x - obj.x) <= 10) {
    x = overlapping.x
  }
  if (x !== obj.x || y !== obj.y) s().updateObject(id, { x, y }, { keepRedo: true })
}

const hexLum = (hex: string): number => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return 128
  const v = parseInt(m[1], 16)
  return 0.2126 * (v >> 16) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255)
}

/**
 * Objects whose style the USER deliberately set (toolbar, grips, options bar).
 * Auto-matching keeps its hands off these; the explicit Blend button ignores it.
 */
export const userStyled = new Set<string>()

/**
 * Match a text object to the surrounding print — size, ink and seating now,
 * typeface async. Runs at creation AND again at commit, so a fast typist can't
 * race it away. Skips objects the user has hand-styled. On blank areas it
 * contrast-guards the ink against the paper so text can never be invisible.
 */
export async function applyPrintMatch(id: string): Promise<void> {
  const s = useStore.getState
  const d = activeDoc()
  const obj = d?.objects[id]
  if (!d || !obj || obj.kind !== 'text' || userStyled.has(id)) return
  const pageRef = d.pages.find((p) => p.id === obj.page)
  if (!pageRef) return
  const canvas = await getSamplingCanvas(pageRef).catch(() => null)
  const res = await computeTextBlend(obj, pageRef, canvas)
  const cur = activeDoc()?.objects[id] as TextObj | undefined
  if (!cur || cur.kind !== 'text' || userStyled.has(id)) return
  if (res) {
    const m = measureText(cur.text || ' ', cur.font, res.size, cur.bold, cur.boxW)
    s().updateObject(id, {
      size: res.size,
      x: res.x,
      y: res.y,
      w: cur.boxW ?? m.w,
      h: m.h,
      ...(res.color ? { color: res.color } : {}),
    }, { keepRedo: true })
    const cfg = s().aiConfig
    if (cfg) {
      void (async () => {
        try {
          const crop = await renderRegionToDataUrl(pageRef, res.lineRect, 3)
          const reading = await readRegion(cfg, crop)
          const c2 = activeDoc()?.objects[id] as TextObj | undefined
          if (!c2 || userStyled.has(id)) return
          const m2 = measureText(c2.text || ' ', reading.font, c2.size, reading.bold, c2.boxW)
          s().updateObject(id, { font: reading.font, bold: reading.bold, w: c2.boxW ?? m2.w, h: m2.h }, { keepRedo: true })
        } catch {
          /* pixel match already applied */
        }
      })()
    }
  } else if (canvas) {
    // blank surroundings: never let the ink vanish into the paper
    const paper = samplePaperColor(canvas, { x: cur.x, y: cur.y, w: Math.max(cur.w, 40), h: Math.max(cur.h, 16) }, canvas.width / 1.5)
    if (Math.abs(hexLum(paper) - hexLum(cur.color)) < 50) {
      s().updateObject(id, { color: hexLum(paper) < 128 ? '#FFFFFF' : '#17171B' }, { keepRedo: true })
    }
  }
}

/** @deprecated superseded by applyPrintMatch (kept for callers mid-migration). */
export const matchNewText = applyPrintMatch
