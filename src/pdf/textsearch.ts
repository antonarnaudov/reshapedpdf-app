import { pdfjs } from './setup'
import { getPageProxy, totalRotation } from './registry'
import type { DocState, PageRef, Rect, RedactObj, SearchMatch, WhiteoutObj } from '../core/types'

/** Device-space geometry of a text run: baseline origin, advance-unit, ascender-
 *  unit, run length and font height — enough to bound the run OR any substring of
 *  it at any rotation/skew. */
interface RunGeo { ox: number; oy: number; ax: number; ay: number; ux: number; uy: number; len: number; fh: number }

interface PageText {
  full: string
  spans: { start: number; end: number; rect: Rect; geo: RunGeo }[]
}

/**
 * Axis-aligned bounding box of a run (or sub-run) drawn in device space: the
 * baseline runs from (ox,oy) along the advance unit (ax,ay) for `len`, and the
 * glyphs extend `asc` toward the ascender unit (ux,uy) and `desc` the other way.
 * General over rotation and skew, so search rects and highlights are correct for
 * 0/90/180/270 — the earlier per-rotation special-casing kept getting a case wrong
 * (thickness on the wrong side at 90°, the whole run misplaced at 180°).
 */
function runAABB(ox: number, oy: number, ax: number, ay: number, ux: number, uy: number, len: number, asc: number, desc: number): Rect {
  const xs = [ox + ux * asc, ox + ax * len + ux * asc, ox - ux * desc, ox + ax * len - ux * desc]
  const ys = [oy + uy * asc, oy + ay * len + uy * asc, oy - uy * desc, oy + ay * len - uy * desc]
  const minX = Math.min(...xs), maxX = Math.max(...xs)
  const minY = Math.min(...ys), maxY = Math.max(...ys)
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) }
}

const cache = new Map<string, PageText>() // key: pageRef id

export function invalidateSearchCache(): void {
  cache.clear()
}

/** Per-line text geometry for a page — powers line-snapping markup. */
export async function getPageSpanRects(ref: PageRef): Promise<Rect[]> {
  const pt = await pageText(ref.id, null, ref)
  return pt ? pt.spans.map((s) => s.rect) : []
}

async function pageText(refId: string, doc: DocState | null, refDirect?: PageRef): Promise<PageText | null> {
  const hit = cache.get(refId)
  if (hit) return hit
  const ref = refDirect ?? doc?.pages.find((p) => p.id === refId)
  if (!ref) return null
  const page = await getPageProxy(ref)
  const rot = totalRotation(ref)
  const vp = page.getViewport({ scale: 1, rotation: rot })
  const content = await page.getTextContent()
  let full = ''
  const spans: PageText['spans'] = []
  for (const item of content.items) {
    if (!('str' in item)) continue
    const t = pdfjs.Util.transform(vp.transform, item.transform)
    const len = item.width * vp.scale
    // Advance (text +x) and ascender (text +y) directions in device space, from
    // the run's own transform — so the box is right at any rotation, not just the
    // axis-aligned ones. fh (font height) doubles as the ascent; a small descent
    // matches the old 1.15x box height.
    const al = Math.hypot(t[0], t[1]) || 1
    const ul = Math.hypot(t[2], t[3]) || 1
    // pdf.js bakes /UserUnit into the VIEWPORT but not into vp.scale, so on such a
    // page the composed origin and font height come out ×userUnit while `len`
    // (item.width × vp.scale) is already in unscaled units. View space here — the
    // space marks, covers and highlights live in — is the unscaled one, so divide
    // the transform-derived parts and leave len alone. Getting this wrong is not
    // cosmetic: a run rect in the wrong space never intersects a redaction cover,
    // so `coveredMajority` reports false and Find prints text hidden under a mark.
    const uu = (page as { userUnit?: number }).userUnit ?? 1
    const geo: RunGeo = {
      ox: t[4] / uu, oy: t[5] / uu, ax: t[0] / al, ay: t[1] / al, ux: t[2] / ul, uy: t[3] / ul, len, fh: ul / uu,
    }
    const rect = runAABB(geo.ox, geo.oy, geo.ax, geo.ay, geo.ux, geo.uy, geo.len, geo.fh, geo.fh * 0.15)
    const start = full.length
    full += item.str
    spans.push({ start, end: full.length, rect, geo })
    if (item.hasEOL) full += ' '
  }
  const result = { full, spans }
  cache.set(refId, result)
  return result
}

export async function searchDoc(doc: DocState, query: string, limit = 400): Promise<SearchMatch[]> {
  const q = query.toLowerCase()
  if (q.trim().length < 2) return []
  const matches: SearchMatch[] = []
  for (let pi = 0; pi < doc.pages.length; pi++) {
    const ref = doc.pages[pi]
    const pt = await pageText(ref.id, doc)
    if (!pt) continue
    // Text sitting under a redaction or an erase (whiteout) has been HIDDEN on the
    // page — Find must not surface it verbatim (a redacted SSN turning up in the
    // search panel defeats the redaction). The original text is still in the
    // pdf.js layer until export, so filter matches that sit under a cover.
    //
    // pdf.js emits a whole line/run as ONE span, so testing the run's centre is
    // both too weak (a redaction over the START of a run leaves the run centre
    // uncovered → leak) and too strong (a small cover over the MIDDLE hides the
    // whole line → visible text unfindable). Instead compute the MATCH's own slice
    // of each run — interpolated by character offset — and hide it only when a
    // cover overlaps a majority of that slice's area.
    const covers = Object.values(doc.objects)
      .filter((o): o is RedactObj | WhiteoutObj => o.page === ref.id && (o.kind === 'redact' || o.kind === 'whiteout'))
      .map((o) => ({ x: o.x, y: o.y, w: o.w, h: o.h }))
    const coveredMajority = (r: Rect): boolean => {
      const area = Math.max(1, r.w * r.h)
      for (const c of covers) {
        const ox = Math.max(0, Math.min(r.x + r.w, c.x + c.w) - Math.max(r.x, c.x))
        const oy = Math.max(0, Math.min(r.y + r.h, c.y + c.h) - Math.max(r.y, c.y))
        if ((ox * oy) / area >= 0.5) return true
      }
      return false
    }
    // The match's rects, each narrowed to just the searched substring within its
    // run (uniform-advance approximation) — used for BOTH the cover test and the
    // highlight, so a hit no longer paints the whole line. The sub-run starts f0
    // of the way along the run's advance and spans (f1-f0); runAABB bounds it in
    // the run's actual orientation, so this is correct at every rotation.
    const matchRects = (a: number, b: number): Rect[] =>
      pt.spans
        .filter((s) => s.end > a && s.start < b)
        .map((s) => {
          const span = s.end - s.start
          if (span <= 0) return s.rect
          const f0 = Math.max(0, (a - s.start) / span)
          const f1 = Math.min(1, (b - s.start) / span)
          const g = s.geo
          const subOx = g.ox + g.ax * g.len * f0
          const subOy = g.oy + g.ay * g.len * f0
          return runAABB(subOx, subOy, g.ax, g.ay, g.ux, g.uy, g.len * (f1 - f0), g.fh, g.fh * 0.15)
        })
    const lower = pt.full.toLowerCase()
    let idx = lower.indexOf(q)
    while (idx !== -1 && matches.length < limit) {
      const end = idx + q.length
      const rects = matchRects(idx, end)
      const hidden = covers.length > 0 && rects.length > 0 && rects.every(coveredMajority)
      if (rects.length && !hidden) {
        const from = Math.max(0, idx - 32)
        const to = Math.min(pt.full.length, end + 32)
        // The snippet is raw page text, so redacted text sitting NEXT TO an
        // unredacted match would otherwise print verbatim in the Find panel — the
        // match itself is filtered, but a search for an adjacent visible word would
        // surface the hidden run in its context, an asymmetric bypass of the same
        // redaction. Mask context characters that sit under a cover. Only paid on
        // pages that actually carry a cover.
        let ctx: string
        if (covers.length === 0) {
          ctx = pt.full.slice(from, to)
        } else {
          let body = ''
          for (let j = from; j < to; j++) {
            const cr = matchRects(j, j + 1)
            body += cr.length > 0 && cr.every(coveredMajority) ? '█' : pt.full[j]
          }
          ctx = body
        }
        const snippet = (from > 0 ? '…' : '') + ctx.replace(/\s+/g, ' ') + (to < pt.full.length ? '…' : '')
        matches.push({ page: ref.id, pageIndex: pi, rects, snippet })
      }
      idx = lower.indexOf(q, idx + 1)
    }
    if (matches.length >= limit) break
  }
  return matches
}
