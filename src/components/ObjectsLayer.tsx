import { memo, useEffect, useRef, useState } from 'react'
import { AlignCenter, AlignLeft, AlignRight, ArrowDownToLine, ArrowUpToLine, Bold, Copy, Pencil, Pipette, StickyNote, Trash2, Type, Wand2 } from 'lucide-react'
import { useStore, useActiveDoc } from '../core/store'
import { inkPath, arrowHead, objBounds, translateObj, normRect, userRectToView, userToView } from '../core/geometry'
import { walkPageContent, layersAt, rgbToHex, textSpansUnder, formStreamShared } from '../pdf/contentwalk'
import type { PageElement, RemovalEdit } from '../pdf/contentwalk'
import { getLibDoc, pageGeom } from '../pdf/registry'
import { faceStack, measureText, BASELINE_EM, LINE_HEIGHT } from '../core/measure'
import { FONTS, FONT_IDS, FONT_STACKS, NOTE_SIZE, stdFontStack, uid } from '../core/types'
import type { AnyObj, FontId, PageRef, Rect, Rotation, TextObj, NoteObj, ShapeObj, VectorObj, ImageObj, WhiteoutObj } from '../core/types'
import { pickFiles } from '../native'
import { bytesToDataUrl, placeImageOnPage } from '../core/actions'
import { getSamplingCanvas, renderRegionToDataUrl, renderPageWithoutSpans } from '../pdf/render'
import { getPageSpanRects } from '../pdf/textsearch'
import { runFontInfo } from '../pdf/fontinfo'
import { capturePointer } from '../core/pointer'
import { readRegion } from '../ai/client'
import { cropCanvasToPatch, detectInkBands, inkFraction, makeBlendedPatch, makeBrushPatch, median, narrowBandToRun, sampleInkColor, samplePaperColor, trimRectToInk } from '../pdf/patch'
import { measureLineBox } from '../core/glyphclone'
import { liftTrueBackground, suppressionWorked } from '../pdf/truebg'
import { cleanRegion } from '../core/clean'
import { renderPageWithoutText } from '../pdf/render'

/** Page scale used only for recognising a face; see identifyFace. */
const IDENTIFY_SCALE = 4
import { faceCovers, rememberEmbeddedFont, spaceEmOfFace, spaceEmFromRun } from '../pdf/embeddedfonts'
import { applyPrintMatch, blendObjects, snapTextPosition, userStyled } from '../core/blend'
import { baselineFromInk, ensureMatchFaces, identifyFace, measureSourceType, sizeForCapHeight, trackingForWidth, bestWidthFont } from '../core/typematch'
import { cloneBaselineY, cloneTextLook, hasCloneSource, registerCloneSource, uncloneTextLook } from '../core/retype'

/** Text objects created this session that haven't been committed once yet. */
const freshTextIds = new Set<string>()
/** page id -> "take this page apart", registered by the mounted page */
export const peelers = new Map<string, () => Promise<{ peeled: number; skipped: number }>>()

const isDarkHex = (hex: string): boolean => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return false
  const v = parseInt(m[1], 16)
  return 0.2126 * (v >> 16) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255) < 128
}

const activeDocForEditor = () => {
  const st = useStore.getState()
  return st.active ? st.docs[st.active] : undefined
}

/* ---------------- drafts (in-progress drawings) ---------------- */

type Draft =
  | { kind: 'ink'; points: [number, number][] }
  | { kind: 'erase'; points: [number, number][] }
  | { kind: 'retouch'; points: [number, number][]; color: string }
  | { kind: 'shape'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'box'; tool: 'whiteout' | 'redact' | 'reshape' | 'clean' | 'markup' | 'text'; x1: number; y1: number; x2: number; y2: number }

/**
 * Acrobat-style line snapping: intersect a dragged box with the page's text
 * geometry and return per-line bands clipped to the drag. Browser text
 * selection is useless here — PDF content order rarely matches visual order.
 */
function snapRectToLines(r: Rect, spans: Rect[]): Rect[] {
  const hits: Rect[] = []
  for (const s of spans) {
    const overlapY = Math.min(s.y + s.h, r.y + r.h) - Math.max(s.y, r.y)
    if (overlapY < s.h * 0.45) continue
    const x1 = Math.max(s.x, r.x)
    const x2 = Math.min(s.x + s.w, r.x + r.w)
    if (x2 - x1 < 2) continue
    hits.push({ x: x1, y: s.y, w: x2 - x1, h: s.h })
  }
  // merge fragments that sit on the same visual line
  hits.sort((a, b) => a.y - b.y || a.x - b.x)
  const lines: Rect[] = []
  for (const h of hits) {
    const last = lines[lines.length - 1]
    if (last && Math.abs(last.y - h.y) < Math.max(last.h, h.h) * 0.6) {
      const x2 = Math.max(last.x + last.w, h.x + h.w)
      last.x = Math.min(last.x, h.x)
      last.w = x2 - last.x
      last.y = Math.min(last.y, h.y)
      last.h = Math.max(last.h, h.h)
    } else {
      lines.push({ ...h })
    }
  }
  return lines
}

/* ---------------- resize ---------------- */

const isLineLike = (o: AnyObj): boolean => o.kind === 'shape' && (o.mode === 'line' || o.mode === 'arrow')

/**
 * CSS placement for a text/image whose content is turned inside its axis-aligned
 * box (obj.rot, set when the page is rotated). rot 0 → the plain box; 90/270 →
 * the natural (un-swapped) size, centred on the box centre and CSS-rotated so it
 * fills the box. The transform-origin is the element's own centre (the default).
 */
function contentRotStyle(o: { x: number; y: number; w: number; h: number; rot?: Rotation }): {
  left: number; top: number; width: number; height: number; transform?: string
} {
  const rot = o.rot ?? 0
  if (!rot) return { left: o.x, top: o.y, width: o.w, height: o.h }
  const natW = rot % 180 === 0 ? o.w : o.h
  const natH = rot % 180 === 0 ? o.h : o.w
  return {
    left: o.x + o.w / 2 - natW / 2,
    top: o.y + o.h / 2 - natH / 2,
    width: natW, height: natH,
    transform: `rotate(${rot}deg)`,
  }
}

// The box dims to STORE for a text run given its UPRIGHT measurement `m`. A turned
// run (rot 90/270) stores them swapped — box width = content height and vice
// versa — the same invariant scaleObjTo keeps and contentRotStyle relies on. The
// editor commit must use these, or editing (even open+close) a rotated run writes
// the un-swapped dims and squashes/displaces it.
const TE_BW = (o: TextObj, m: { w: number; h: number }): number =>
  (o.rot ?? 0) % 180 !== 0 ? m.h : (o.boxW ?? m.w)
const TE_BH = (o: TextObj, m: { w: number; h: number }): number =>
  (o.rot ?? 0) % 180 !== 0 ? (o.boxW ?? m.w) : m.h

/**
 * Which edge a run is aligned on, inferred from the column it sits in.
 *
 * A retype is placed by its LEFT edge — correct for body text, wrong for a
 * right-aligned figure or a centred heading, where editing the value then grows
 * it off the left anchor and breaks the column. One run can't say; a column of
 * runs can — the others stacked in the same column share the aligned edge. Count
 * the nearby runs that share this run's left edge, right edge and centre; return
 * 'right'/'center' only when that edge clearly dominates AND has real support, so
 * ordinary left-aligned text (the overwhelming default) is never touched.
 */
export function detectAlign(spans: Rect[], rect: Rect): 'center' | 'right' | undefined {
  if (spans.length < 3) return undefined
  const left = rect.x, right = rect.x + rect.w, cx = rect.x + rect.w / 2
  // Scale the slop to the COLUMN, not to this run's own height. A 58pt name got
  // a 20pt window, wide enough for every genuinely centred item in a sidebar to
  // agree with its centre by accident: C beat L on a name whose left edge was
  // flush with the line under it, the object was created align:'center', and the
  // first edit shoved it 54pt off the margin. Body copy sets the column's scale.
  const neighbours = spans.filter((s) => {
    if (Math.abs(s.y - rect.y) < rect.h * 0.6) return false            // same line, not a column
    if (Math.abs((s.y + s.h / 2) - (rect.y + rect.h / 2)) > rect.h * 40) return false
    return !(s.x + s.w < left - rect.w || s.x > right + rect.w)
  })
  if (neighbours.length < 2) return undefined
  const heights = neighbours.map((s) => s.h).sort((a, b) => a - b)
  const columnH = heights[heights.length >> 1]
  const tol = Math.max(2, Math.min(rect.h, columnH) * 0.35)
  let L = 0, R = 0, C = 0
  for (const s of neighbours) {
    if (Math.abs(s.x - left) <= tol) L++
    if (Math.abs(s.x + s.w - right) <= tol) R++
    if (Math.abs(s.x + s.w / 2 - cx) <= tol) C++
  }
  // A left edge shared EXACTLY is the strongest signal on a page and beats any
  // amount of centre agreement: a run flush with the margin is left-aligned,
  // whatever else happens to line up with its middle.
  const flushLeft = neighbours.some((s) => Math.abs(s.x - left) <= 1)
  if (flushLeft) return undefined
  if (R >= 2 && R > L && R >= C) return 'right'
  if (C >= 2 && C > L && C > R) return 'center'
  return undefined
}

type Corner = 'nw' | 'ne' | 'sw' | 'se'

function scaleObjTo(obj: AnyObj, ob: Rect, nb: Rect): AnyObj {
  const sx = ob.w > 0.01 ? nb.w / ob.w : 1
  const sy = ob.h > 0.01 ? nb.h / ob.h : 1
  switch (obj.kind) {
    case 'ink':
      return {
        ...obj,
        points: obj.points.map(([x, y]) => [nb.x + (x - ob.x) * sx, nb.y + (y - ob.y) * sy] as [number, number]),
      }
    case 'markup':
      return obj // anchored to text lines — moving is fine, stretching is nonsense
    case 'text': {
      // A turned run (rot 90/270, set when the page was rotated) has its visual
      // axes SWAPPED: the box's width maps to the content's height and vice versa.
      // Scale the point size by the axis that drives content height, and store the
      // box swapped so contentRotStyle re-derives the right natural size — without
      // this the box was set to the UPRIGHT measured dims while still rotated, and
      // the text came out squashed.
      const turned = ((obj as TextObj).rot ?? 0) % 180 !== 0
      // A cloned (glyphSrc) run renders as an <img> sized by glyphW/glyphH, so
      // resizing must scale THOSE — otherwise the handle moves the box while the
      // bitmap stays put and nothing visible changes.
      if (obj.glyphSrc) {
        const gw = (obj.glyphW ?? obj.w) * (turned ? sy : sx)
        const gh = (obj.glyphH ?? obj.h) * (turned ? sx : sy)
        return { ...obj, x: nb.x, y: nb.y, glyphW: gw, glyphH: gh, w: turned ? gh : gw, h: turned ? gw : gh, size: Math.max(5, obj.size * (turned ? sx : sy)) }
      }
      const size = Math.max(5, obj.size * (turned ? sx : sy))
      const boxW = obj.boxW ? Math.max(48, obj.boxW * (turned ? sy : sx)) : undefined
      const m = measureText(obj.text || ' ', obj.font, size, obj.bold, boxW, obj.tracking ?? 0, obj.italic, obj.pdfFont)
      const cw = boxW ?? m.w
      return { ...obj, x: nb.x, y: nb.y, size, boxW, w: turned ? m.h : cw, h: turned ? cw : m.h }
    }
    case 'note':
      return obj
    case 'shape':
      if (obj.mode === 'line' || obj.mode === 'arrow') return obj
      return { ...obj, x: nb.x, y: nb.y, w: nb.w, h: nb.h }
    default:
      return { ...obj, x: nb.x, y: nb.y, w: nb.w, h: nb.h }
  }
}

/* ---------------- inline text editor + its floating toolbar ---------------- */

const EDIT_TEXT_COLORS = ['#17171B', '#2456D6', '#D6382E', '#0B7A4B', '#FFFFFF']

function TextEditToolbar({
  obj, zoom, matching, onMatch,
}: {
  obj: TextObj
  zoom: number
  matching: boolean
  onMatch: () => void
}): JSX.Element {
  const s = useStore.getState
  const edit = (patch: Partial<TextObj>) => {
    userStyled.add(obj.id)
    s().commitNow()
    s().updateObject(obj.id, patch)
  }
  return (
    <div
      className="text-toolbar"
      style={{
        left: obj.x - 3,
        top: obj.y - 12 / zoom,
        transform: `scale(${1 / zoom}) translateY(-100%)`,
        transformOrigin: 'bottom left',
      }}
      onPointerDown={(e) => {
        // keep the textarea focused for buttons; the select needs real focus to open
        if (!(e.target as HTMLElement).closest('select')) e.preventDefault()
        e.stopPropagation()
      }}
    >
      <select
        className="select"
        style={{ height: 24, fontSize: 12, paddingRight: 18 }}
        value={obj.font}
        onChange={(e) => edit({ font: e.target.value as TextObj['font'] })}
      >
        {FONT_IDS.map((id) => (
          <option key={id} value={id}>{FONTS[id].label}</option>
        ))}
      </select>
      <div className="stepper" style={{ height: 24 }}>
        <button onClick={() => edit({ size: Math.max(5, Math.round((obj.size - 1) * 10) / 10) })}>−</button>
        <span className="val" style={{ minWidth: 26, fontSize: 11.5 }}>{Math.round(obj.size)}</span>
        <button onClick={() => edit({ size: Math.min(120, Math.round((obj.size + 1) * 10) / 10) })}>+</button>
      </div>
      <button
        className={`btn-icon ${obj.bold ? 'on' : ''}`}
        style={{ width: 24, height: 24 }}
        title="Bold"
        onClick={() => edit({ bold: !obj.bold })}
      >
        <Bold size={13} />
      </button>
      <span className="tt-swatches">
        {EDIT_TEXT_COLORS.map((c) => (
          <button
            key={c}
            className={`swatch ${obj.color.toLowerCase() === c.toLowerCase() ? 'active' : ''}`}
            style={{ width: 14, height: 14, background: c }}
            onClick={() => edit({ color: c })}
          />
        ))}
      </span>
      <span className="divider-v" style={{ margin: '3px 2px' }} />
      {([['left', AlignLeft], ['center', AlignCenter], ['right', AlignRight]] as const).map(([a, Icon]) => (
        <button
          key={a}
          className={`btn-icon ${(obj.align ?? 'left') === a ? 'on' : ''}`}
          style={{ width: 24, height: 24 }}
          title={`Align ${a}`}
          onClick={() => edit({ align: a === 'left' ? undefined : a })}
        >
          <Icon size={13} />
        </button>
      ))}
      <span className="divider-v" style={{ margin: '3px 2px' }} />
      <button
        className={`btn-icon ${matching ? 'on' : ''}`}
        style={{ width: 24, height: 24 }}
        title="Match the print — click any text on the page to copy its size & color (font too, with AI connected)"
        onClick={onMatch}
      >
        <Pipette size={13} />
      </button>
    </div>
  )
}

/* ---------------- inline text editor ---------------- */

function TextEditor({ obj, zoom }: { obj: TextObj; zoom: number }): JSX.Element {
  const s = useStore.getState
  const [val, setVal] = useState(obj.text)
  const [paper, setPaper] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  const committed = useRef(false)
  // The editor commits on blur and on Escape, and until now those were the only
  // two ways out. Every other exit — a tool change, a document switch, the page
  // being deleted, anything that clears editingText from elsewhere — unmounts
  // the textarea WITHOUT blurring it, and the typed words were simply gone. So
  // commit on unmount as well, which means commit() has to read the live value
  // rather than the one its closure captured on the render that created it.
  const valRef = useRef(val)
  valRef.current = val
  const objRef = useRef(obj)
  objRef.current = obj
  const grip = useRef<{ startY: number; startSize: number } | null>(null)
  const wgrip = useRef<{ startX: number; startW: number } | null>(null)

  useEffect(() => {
    const ta = ref.current
    if (ta) {
      ta.focus()
      ta.setSelectionRange(ta.value.length, ta.value.length)
    }
  }, [])

  // the field wears the page's own paper — a white card over a dark poster
  // would swallow light-coloured text while you type
  useEffect(() => {
    let on = true
    const d = activeDocForEditor()
    const pageRef = d?.pages.find((p) => p.id === obj.page)
    if (!pageRef) return
    getSamplingCanvas(pageRef)
      .then((c) => {
        if (!on) return
        const col = samplePaperColor(c, { x: obj.x, y: obj.y, w: Math.max(obj.w, 40), h: Math.max(obj.h, 16) }, c.width / 1.5)
        setPaper(col)
      })
      .catch(() => {})
    return () => {
      on = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [obj.page])

  // include tracking so the width matches how the object was stored — otherwise a
  // tracked lifted-text object looks "changed" on every open/close and spuriously commits
  const m = measureText(val || ' ', obj.font, obj.size, obj.bold, obj.boxW, obj.tracking ?? 0, obj.italic, obj.pdfFont)
  const fieldW = obj.boxW ?? Math.max(m.w + 10, 90)

  const commit = () => {
    if (committed.current) return
    committed.current = true
    // deliberately shadowing: on the unmount path the enclosing `val`/`obj` are
    // whatever the first render saw, and the refs are what the user last typed.
    const val = valRef.current
    const obj = objRef.current
    s().setEditingText(null)
    if (!val.trim()) {
      // A freshly-dropped box abandoned without typing rewinds its own creation
      // (no phantom undo entry, no false "Edited"); an EXISTING run emptied out is
      // a real deletion and goes through the normal history.
      if (freshTextIds.delete(obj.id)) s().discardFreshObject(obj.id)
      else s().removeObjects([obj.id])
      // a glyph-cloned object sizes to its bitmap, not the font metrics — don't
      // let that mismatch masquerade as an edit (it added a spurious history
      // entry so Undo appeared to do nothing after a retype)
    } else if (val !== obj.text || (!obj.glyphSrc && (obj.w !== TE_BW(obj, m) || obj.h !== TE_BH(obj, m)))) {
      s().commitNow()
      // editing the words invalidates a cloned-glyph bitmap: fall back to the
      // (still metric-matched) live font, then try to recompose the NEW words
      // from the page's own letters so the change stays looking identical
      const textChanged = val !== obj.text
      let clearClone: Partial<TextObj> = {}
      if (textChanged && obj.glyphSrc) {
        clearClone = { glyphSrc: undefined, glyphW: undefined, glyphH: undefined }
        // the clone sat at top-of-ink; vector text baselines at y+size*1.02 —
        // move y up so the line doesn't jump if the reclone can't fire
        const by = cloneBaselineY(obj.id)
        if (by != null) clearClone.y = by - obj.size * 1.02
      }
      // Keep the aligned edge fixed. An auto-grow (no boxW) right/centre run is
      // anchored by its right edge or centre, not its left — so as the width
      // changes, shift x to hold that edge. A boxW run has a fixed frame; the
      // alignment there is per-line inside the box (renderer + exporter), so x
      // stays put.
      let nx = obj.x
      if (!obj.boxW && obj.align && obj.align !== 'left' && (obj.rot ?? 0) % 180 === 0) {
        const nw = m.w
        nx = obj.align === 'right' ? obj.x + obj.w - nw : obj.x + obj.w / 2 - nw / 2
      }
      s().updateObject(obj.id, { text: val, x: nx, w: TE_BW(obj, m), h: TE_BH(obj, m), ...clearClone })
      // Editing the words switches a cloned (bitmap) run back to crisp vector text
      // and KEEPS it there. Re-cloning here re-rasterised the run on every edit — a
      // fixed-resolution picture of text that softens on zoom/export and can't
      // render letters that were never on the page. "Match exactly (clone letters)"
      // in the context menu stays available for anyone who wants the bitmap.
      // Grown past the line it replaced? Say so; do not quietly shove the rest
      // of the page down to make room.
      //
      // Re-flowing everything below is the clever-looking option and it is how a
      // one-word change silently reshuffles a layout — the guess about which
      // lines belong to this paragraph is the part that goes wrong, and it goes
      // wrong invisibly. A collision the author can see is a problem they can
      // decide about: shorten it, widen the box by its handle, or move what is
      // underneath.
      if (m.h > obj.h + obj.size * 0.4) {
        const lines = Math.round(m.h / (obj.size * LINE_HEIGHT))
        s().toast(
          `This now runs to ${lines} lines and may overlap what follows — drag the width handle, or shorten it`,
          'warn',
        )
      }
      // fresh boxes are guaranteed a print match at commit — the creation-time
      // pass is only the fast path and a quick typist can outrun it
      if (freshTextIds.delete(obj.id)) {
        const auto = useStore.getState().prefs.autoMatchText
        if (auto && !userStyled.has(obj.id)) void applyPrintMatch(obj.id)
        else void snapTextPosition(obj.id)
      }
    }
  }

  const paperDark = paper ? isDarkHex(paper) : false
  // Any unmount is an exit from the editor. `committed` makes this a no-op when
  // blur or Escape already ran, so the only case it catches is the one that used
  // to lose the words.
  //
  // With one exception, which cost a green suite to find: an empty textarea over
  // an object that HAS text means the words were put there by something other
  // than this editor — a programmatic update, the toolbar, anything holding the
  // object id — and the abandonment branch would delete them as though the user
  // had emptied the box by hand. Only the user's own typing gets committed on
  // the way out.
  useEffect(() => () => {
    // Ask the STORE, not the prop. setEditingText(null) lands in the same tick
    // as whatever set the words, so this component has not re-rendered and
    // objRef still holds the text from before — which is exactly the empty
    // string that triggers the delete.
    const live = s().docs[s().active ?? '']?.objects[objRef.current.id] as TextObj | undefined
    if (!valRef.current.trim() && (live?.text ?? '').trim()) return
    commit()
  }, [])

  return (
    <div
      className="text-editor"
      style={{
        left: obj.x - 7,
        top: obj.y - 5,
        background: paper ?? undefined,
        borderColor: paperDark ? 'rgba(255, 255, 255, 0.4)' : undefined,
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <textarea
        ref={ref}
        style={{
          width: fieldW,
          height: m.h + 2,
          fontSize: obj.size,
          fontFamily: obj.pdfFont || obj.matchFace ? faceStack(obj.font, obj.pdfFont, obj.matchFace) : (obj.stdFont && stdFontStack(obj.stdFont)) ?? FONT_STACKS[obj.font],
          // An embedded face IS already the bold it was printed in — asking the
          // browser for 700 on top synthesises a second helping of weight, so the
          // heading shows over-bold in the editor and then lightens on commit
          // (the renderer already does this). Match it: pdfFont draws at 400.
          fontWeight: obj.matchWeight ?? (obj.pdfFont ? 400 : obj.bold ? 700 : 400),
          fontStyle: obj.italic ? 'italic' : undefined,
          letterSpacing: obj.tracking ? `${obj.tracking}px` : undefined,
          color: obj.color,
          caretColor: obj.color,
          ['--te-ph' as never]: paperDark ? 'rgba(255, 255, 255, 0.45)' : undefined,
          whiteSpace: obj.boxW ? 'pre-wrap' : 'pre',
          wordBreak: obj.boxW ? 'break-word' : undefined,
          // Only align WITHIN a fixed box. An auto-grow field is min-90px wide, so
          // aligning a short run right/centre inside it made the text jump away
          // from where it renders while typing; the committed x-anchor handles the
          // real alignment, so the editor stays left for auto-grow runs.
          textAlign: obj.boxW ? (obj.align ?? undefined) : undefined,
        }}
        value={val}
        placeholder="Type…"
        spellCheck={false}
        onChange={(e) => setVal(e.target.value)}
        onBlur={(e) => {
          // focus moving into the toolbar or the resize grip isn't "done editing"
          const t = e.relatedTarget as HTMLElement | null
          if (t?.closest?.('.text-toolbar') || t?.closest?.('.text-editor')) return
          commit()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            commit()
          }
          e.stopPropagation()
        }}
      />
      <div
        className="te-grip"
        title="Drag to resize the text"
        onPointerDown={(e) => {
          e.preventDefault()
          e.stopPropagation()
          capturePointer(e)
          grip.current = { startY: e.clientY, startSize: obj.size }
          userStyled.add(obj.id)
          s().commitNow()
        }}
        onPointerMove={(e) => {
          const g = grip.current
          if (!g) return
          const dy = (e.clientY - g.startY) / zoom
          s().updateObject(obj.id, {
            size: Math.max(5, Math.min(120, Math.round((g.startSize + dy * 0.45) * 10) / 10)),
          })
        }}
        onPointerUp={() => {
          grip.current = null
          ref.current?.focus()
        }}
      />
      <div
        className="te-wgrip"
        title="Drag to set the box width — text wraps to it"
        onPointerDown={(e) => {
          e.preventDefault()
          e.stopPropagation()
          capturePointer(e)
          wgrip.current = { startX: e.clientX, startW: obj.boxW ?? fieldW }
          s().commitNow()
        }}
        onPointerMove={(e) => {
          const g = wgrip.current
          if (!g) return
          const dx = (e.clientX - g.startX) / zoom
          s().updateObject(obj.id, { boxW: Math.max(48, Math.round(g.startW + dx)) })
        }}
        onPointerUp={() => {
          wgrip.current = null
          ref.current?.focus()
        }}
      />
    </div>
  )
}


/**
 * Where the lines around this one end.
 *
 * A retyped run needs somewhere to wrap, and the honest answer is not "work out
 * the paragraph" — that is the inference Acrobat makes, and it is what mangles a
 * layout when the guess is wrong on a table or a second column. It is simply
 * where the neighbouring lines already stop. That is a fact on the page rather
 * than a theory about it, and if the reprint wraps there it wraps where every
 * other line does.
 *
 * Returns null when there is nothing to learn from — an isolated caption, a
 * banner, a line on its own — and the caller then leaves the run unwrapped,
 * exactly as before.
 */
function neighbourRightEdge(spans: Rect[], band: Rect): number | null {
  const mid = band.y + band.h / 2
  const reach = Math.max(band.h * 4, 40)

  // Group the spans into LINES before measuring anything.
  //
  // They arrive word by word, so asking each one whether it reaches across to
  // this run rejects every word at the left of the line below — which is most
  // of them, and the answer comes back "no neighbours" on a perfectly ordinary
  // paragraph. A line's right edge is a property of the line, not of any word
  // in it.
  const lines = new Map<number, { x: number; right: number; h: number; y: number }>()
  for (const sp of spans) {
    if (sp.w <= 0 || sp.h <= 0) continue
    const c = sp.y + sp.h / 2
    if (Math.abs(c - mid) > reach) continue
    if (Math.abs(c - mid) < band.h * 0.45) continue   // the run's own line
    if (sp.h < band.h * 0.5 || sp.h > band.h * 2.2) continue  // a different size is a different block
    const key = Math.round(c / Math.max(2, band.h * 0.5))
    const cur = lines.get(key)
    if (cur) {
      cur.x = Math.min(cur.x, sp.x)
      cur.right = Math.max(cur.right, sp.x + sp.w)
    } else {
      lines.set(key, { x: sp.x, right: sp.x + sp.w, h: sp.h, y: sp.y })
    }
  }
  // Only lines that actually share this column, judged once per line.
  //
  // "Starts within eight line-heights to the right" was far too generous: on a
  // two-column page the lines level with the run are the OTHER column's, they
  // qualified, and the widest of them handed back that column's right margin —
  // so the wrap width became most of the page and a slightly longer replacement
  // ran straight into the neighbouring column instead of wrapping.
  //
  // A line shares a column when its horizontal range OVERLAPS the run's. That
  // is what being in the same column means, it keeps a paragraph's short last
  // line and an indented one, and it excludes a column that begins past the
  // run's right edge — which no amount of slack can distinguish otherwise.
  const sharing = [...lines.values()].filter((l) => l.right > band.x && l.x < band.x + band.w)
  if (!sharing.length) return null

  // the widest of them, not the average: a paragraph's last line is short and
  // would pull the edge in, wrapping text far earlier than the page does
  const edge = Math.max(...sharing.map((l) => l.right))
  return edge > band.x + band.h * 2 ? edge : null
}

/* ---------------- note editor popover ---------------- */

function NoteEditor({ obj, zoom, onClose }: { obj: NoteObj; zoom: number; onClose: () => void }): JSX.Element {
  const s = useStore.getState
  const [val, setVal] = useState(obj.text)
  const ref = useRef<HTMLTextAreaElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const valRef = useRef(val)
  valRef.current = val

  useEffect(() => {
    ref.current?.focus()
  }, [])

  const commit = () => {
    if (valRef.current !== obj.text) {
      s().commitNow()
      s().updateObject(obj.id, { text: valRef.current })
    }
    onClose()
  }

  // clicking anywhere outside the popover commits the note
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) commit()
    }
    document.addEventListener('pointerdown', onDown, { capture: true })
    return () => document.removeEventListener('pointerdown', onDown, { capture: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      ref={boxRef}
      className="note-editor"
      style={{
        left: obj.x + NOTE_SIZE + 10 / zoom,
        top: obj.y - 6 / zoom,
        // the html layer is scaled by zoom — counter-scale so the editor is always 1:1
        transform: `scale(${1 / zoom})`,
        transformOrigin: 'top left',
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span className="note-tail" style={{ background: obj.color }} />
      <div className="note-head">
        <span className="note-dot" style={{ background: obj.color }} />
        <span className="note-title">Note</span>
        <button
          className="btn-icon"
          style={{ width: 24, height: 24, marginLeft: 'auto' }}
          title="Delete note"
          onClick={() => {
            onClose()
            s().removeObjects([obj.id])
          }}
        >
          <Trash2 size={13} />
        </button>
      </div>
      <textarea
        ref={ref}
        placeholder="Type your note — click anywhere else when done. Exports as a real PDF comment."
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) commit()
          e.stopPropagation()
        }}
      />
    </div>
  )
}

/* ---------------- the layer ---------------- */

// The lift tool's descend cursor: re-clicking the same spot steps down the
// stack of elements under it. Session-only, keyed by page, like the retype
// tool's clone sources — it must survive re-renders but not the document.
const liftCursor = new Map<string, { x: number; y: number; i: number }>()

// what the ghost preview says the element is. In Stage 2 everything rasters, so
// Tell the user what Enter will actually give them, matching the tier realiseLift
// will pick: real editable text, a real vector shape, or — when the element
// can't be reproduced that faithfully — a picture of it. The distinction is the
// whole point of the tiers, so the ghost should not hide it.
function labelForElement(el: PageElement): string {
  const d = el.detail
  switch (el.kind) {
    // axis-aligned text lifts as editable text (runFontInfo reads even base-14);
    // rotated/skewed text can't, so it rasters
    case 'text': return el.axisAligned ? 'text' : 'text · as image'
    // a rect stays vector only axis-aligned and in a device colour; a line stays
    // vector at any angle as long as it has a stroke colour
    case 'fill-rect': return el.axisAligned && d.kind === 'shape' && (d.fill || d.stroke) ? 'shape' : 'shape · as image'
    case 'stroke-line': return d.kind === 'shape' && d.stroke ? 'line' : 'line · as image'
    case 'image': case 'inline-image': return 'image'
    case 'form': return 'group'
    // A path with geometry now comes off as real vectors, so say so — the ghost
    // read "as image" over a curve it was about to hand back editable, which is
    // the label promising LESS than the tool delivers.
    case 'path': return d.kind === 'path' && d.d ? 'vector' : 'artwork · as image'
    default: return 'as image'
  }
}

export const ObjectsLayer = memo(function ObjectsLayer({
  page, pv, zoom,
}: {
  page: PageRef
  pv: { w: number; h: number }
  zoom: number
}): JSX.Element | null {
  const doc = useActiveDoc()
  const tool = useStore((s) => s.tool)
  const shapeMode = useStore((s) => s.shapeMode)
  const prefs = useStore((s) => s.prefs)
  const editingText = useStore((s) => s.editingText)
  const s = useStore.getState

  const svgRef = useRef<SVGSVGElement>(null)
  const spanRectsRef = useRef<Rect[] | null>(null) // text geometry for line-snap markup
  // Rotating the page moves every span, but this ref short-circuits the module
  // cache that rotatePages DOES invalidate, and PageView is keyed on page.id so
  // nothing remounts to clear it. A highlight drawn after a rotate was snapped —
  // and exported — at pre-rotation coordinates, and stayed wrong for the rest of
  // the session. Drop the cached geometry whenever the page turns.
  useEffect(() => { spanRectsRef.current = null }, [page.extraRot])
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  const [matchPick, setMatchPick] = useState(false)

  // Escape cancels match-the-print mode before anything else
  useEffect(() => {
    if (!matchPick) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setMatchPick(false)
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [matchPick])

  useEffect(() => {
    if (!ctxMenu) return
    const close = () => setCtxMenu(null)
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', close)
    window.addEventListener('wheel', close, { passive: true })
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', close)
      window.removeEventListener('wheel', close)
    }
  }, [ctxMenu])
  const [draft, _setDraft] = useState<Draft | null>(null)
  // gestures update faster than React renders; the ref is the source of truth mid-gesture
  const draftRef = useRef<Draft | null>(null)
  const setDraft = (d: Draft | null) => {
    draftRef.current = d
    _setDraft(d)
  }
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [noteEdit, setNoteEdit] = useState<string | null>(null)
  // lift tool: the element the next Enter will pull out, previewed as a ghost.
  // Single source of truth in the store, tagged with its page, so with every
  // page's ObjectsLayer mounted only ONE preview is ever live and one Enter
  // commits exactly one element.
  const liftPreview = useStore((st) => st.liftPreview)
  const myLift = liftPreview && liftPreview.pageId === page.id ? liftPreview : null

  const gesture = useRef<{
    mode: 'move' | 'resize' | 'endpoint'
    start: [number, number]
    origs: Map<string, AnyObj>
    corner?: Corner
    endpoint?: 1 | 2
    origBounds?: Rect
    committed: boolean
  } | null>(null)

  useEffect(() => {
    // Close a note editor when the user picks a DRAWING tool, not when we switch
    // to 'select' — placing a note flips the tool to select and opens the editor
    // in the same gesture, and clearing on every tool change nulled it right back.
    if (tool !== 'select') setNoteEdit(null)
  }, [tool])

  /* ----- lift: click an element, pull it out as an editable object ----- */

  // Tiered by fidelity: printed text comes back as real editable text; a plain
  // rectangle or line as a real vector shape; anything else (a scan, a rotated
  // run, an odd colour) as a faithful raster of its own region. The lifted
  // object lands together with a patch of the TRUE BACKGROUND — the page
  // re-rendered with this element's own operators taken out — so the original
  // comes away with the lift and the hole shows what was behind it, not a copy
  // of the thing you lifted. Both land as ONE undoable step.
  const realiseLift = async (el: PageElement, viewRect: Rect) => {
    const startDoc = s().active
    s().setBusy('Lifting…')
    try {
      let obj: AnyObj | null = null
      // The ghost labelled an axis-aligned run "text", promising an editable lift.
      // buildTextObject can still fail at the probe (a run pdf.js won't read), and
      // then we fall through to a picture — so say so, rather than silently handing
      // back an image the user was told would be text.
      let textFellBack = false
      if (el.kind === 'text' && el.axisAligned) {
        obj = await buildTextObject(el)
        if (!obj) textFellBack = true
      }
      if (!obj && el.detail.kind === 'shape') {
        const cv = await getSamplingCanvas(page).catch(() => null)
        obj = buildShapeObject(el, cv)
      }
      // Vectors before pixels: a path the shape tier cannot name is still a
      // path, and handing back a picture of it loses everything that made it
      // worth lifting.
      if (!obj && el.detail.kind === 'path') obj = buildVectorObject(el)
      if (!obj) obj = await buildRasterObject(el, viewRect)
      if (!obj) return
      // PATCH WHAT WAS ACTUALLY LIFTED.
      //
      // buildTextObject does not take the walked element as-is: it re-reads the
      // spot with runFontInfo, which grows the run across pdf.js's arbitrary
      // splits so a lift takes the whole word or line rather than the fragment
      // pdf.js happened to emit. The patch was still built from the single
      // walked element, and the two disagree by an order of magnitude — on the
      // benchmark CV, clicking inside "Adaptability" lifted the whole word and
      // erased ONE 16pt glyph of it, leaving 50pt of the printed word on the
      // page. Move the lifted copy and the mutilated original is revealed;
      // export it and the file carries "Ada tability" plus a duplicate.
      //
      // So when the object is wider than the element it came from, remove what
      // the object covers instead.
      let patch: WhiteoutObj | null = null
      if (obj.kind === 'text') {
        const geomL = pageGeom(page)
        const elBox = userRectToView(geomL, [el.userBox.x, el.userBox.y,
          el.userBox.x + el.userBox.w, el.userBox.y + el.userBox.h])
        const runBox = { x: obj.x, y: obj.y, w: obj.w, h: obj.h }
        // "materially wider" = beyond one glyph of slack, so an ordinary
        // single-run lift keeps the element-precise patch it already had.
        const slack = Math.max(2, Math.min(elBox.w, elBox.h) * 0.5)
        if (runBox.w > elBox.w + slack || runBox.x < elBox.x - slack) {
          patch = await removalPatchForRect(runBox)
        }
      }
      if (!patch) patch = await removalPatch(el)
      if (s().active !== startDoc) return // switched documents mid-render
      if (patch) s().addObjects([patch, obj], { selectId: obj.id })
      else s().addObject(obj)
      s().setTool('select')
      if (textFellBack) s().toast('These words could not be read as editable text — lifted as an image instead', 'info')
    } finally {
      s().setBusy(null)
    }
  }

  // The true background under an element: the page rendered with just this
  // element's token span removed, cropped to where it sat, as a whiteout patch.
  /** Every content span already removed from THIS page by an edit, newest last. */
  const spansLiftedSoFar = (): RemovalEdit[] => {
    const d = s().docs[s().active ?? '']
    return (d ? d.objOrder.map((id) => d.objects[id]) : [])
      .filter((o): o is WhiteoutObj => !!o && o.kind === 'whiteout' && o.page === page.id && !!o.removedSpans?.length)
      .flatMap((o) => o.removedSpans!)
  }

  /**
   * The show operators that draw the printed run a retype is replacing — see
   * textSpansUnder. `rect` is the run's own box, the same rect the
   * true-background pass suppressed to build the patch, so the ink those
   * operators draw is exactly the ink the patch is holding.
   */
  const spansUnderRun = async (rect: Rect): Promise<RemovalEdit[]> => {
    try {
      const libDoc = await getLibDoc(page.srcId)
      return textSpansUnder(libDoc, libDoc.getPage(page.srcIndex), pageGeom(page), rect)
    } catch {
      return [] // an unreadable page keeps the old behaviour: covered, not removed
    }
  }


  /**
   * The same true-background patch as removalPatch, over an arbitrary view-space
   * rect rather than one walked element — for a lift whose object came back
   * bigger than the element that started it (see realiseLift).
   *
   * Falls back to null rather than to a flat fill: the caller then uses the
   * element-precise patch, which covers less but is never wrong.
   */
  const removalPatchForRect = async (rect: Rect): Promise<WhiteoutObj | null> => {
    try {
      const edits = await spansUnderRun(rect)
      if (!edits.length) return null
      const clean = await renderPageWithoutSpans(page, [...spansLiftedSoFar(), ...edits], 3)
      if (!clean) return null
      const pad = Math.max(2, 0.35 * Math.min(rect.w, rect.h))
      const box = { x: rect.x - pad, y: rect.y - pad, w: rect.w + 2 * pad, h: rect.h + 2 * pad }
      return {
        id: uid(), page: page.id, kind: 'whiteout', opacity: 1,
        removedSpans: edits,
        ...cropCanvasToPatch(clean, box, pv.w),
      }
    } catch {
      return null
    }
  }

  const removalPatch = async (el: PageElement): Promise<WhiteoutObj | null> => {
    const geom = pageGeom(page)
    const vb = userRectToView(geom, [el.userBox.x, el.userBox.y, el.userBox.x + el.userBox.w, el.userBox.y + el.userBox.h])
    // A text run's box is the baseline-to-cap band: its descenders sit below the
    // box, and a base-14 run estimated with no /Widths can under-reach across.
    // Pad from the ON-PAGE glyph size (vb, already scaled by the text matrix) —
    // NOT the raw Tf operand, which is 1 for a run drawn under a 100x matrix and
    // would leave descenders and edges exposed.
    const isText = el.kind === 'text'
    const axisText = isText && el.axisAligned
    const unmeasured = el.detail.kind === 'text' && el.detail.measurable === false
    // A NON-text element's userBox is the geometry of its path/box — it excludes
    // what actually inks the page beyond it: a stroke reaches ±strokeWidth/2 past
    // the line, and an image/fill has an anti-alias fringe. Padding those by 1pt
    // (the old default) left that hairline behind as debris once the lift moved.
    // Cover the stroke half-width (converted to view units) plus a fringe margin.
    const viewPerUser = Math.max(vb.w, vb.h) / Math.max(1e-3, Math.max(el.userBox.w, el.userBox.h))
    const strokeHalf = el.detail.kind === 'shape' && el.detail.strokeWidth ? (el.detail.strokeWidth * viewPerUser) / 2 : 0
    const nonTextCrop = Math.max(6, strokeHalf + 4) // crop repaints true bg → free to over-cover
    const nonTextFlat = Math.max(2, strokeHalf + 1) // flat fill → tight, but still clears the stroke
    // The CROP box repaints the TRUE background, so every margin is free — a
    // wider crop just re-shows more of the same page — so pad generously all
    // round (extra across for an unmeasured run whose width is under-estimated).
    const cropPadY = isText ? Math.max(2, 0.4 * vb.h) : nonTextCrop
    const cropPadX = isText ? (unmeasured ? Math.max(2, 0.45 * vb.w) : Math.max(2, 0.2 * vb.h)) : nonTextCrop
    const cropBox = { x: vb.x - cropPadX, y: vb.y - cropPadY, w: vb.w + 2 * cropPadX, h: vb.h + 2 * cropPadY }
    // The FLAT-FALLBACK box paints SOLID paper, so EVERY margin must stay tight
    // or it obliterates a neighbour — across (a second column, a table cell) AND
    // down/up (the lines above and below in tight leading). Scale the pads off
    // the GLYPH-HEIGHT dimension — min(vb.w, vb.h) — not vb.h, because for a
    // rotated run the axis-aligned vb.h is the run's LENGTH and would balloon the
    // box. For upright text vb is the baseline-to-cap band so descenders sit
    // ~0.35 below it (asymmetric); for a rotated run the descender direction
    // isn't the box's +y, so pad symmetrically.
    const gh = Math.min(vb.w, vb.h)
    const flatPadX = isText ? Math.max(2, 0.2 * gh) : nonTextFlat
    const flatUp = axisText ? Math.max(2, 0.12 * vb.h) : (isText ? Math.max(2, 0.35 * gh) : nonTextFlat)
    const flatDown = axisText ? Math.max(2, 0.35 * vb.h) : (isText ? Math.max(2, 0.35 * gh) : nonTextFlat)
    const flatBox = { x: vb.x - flatPadX, y: vb.y - flatUp, w: vb.w + 2 * flatPadX, h: vb.h + flatUp + flatDown }

    const replacement = el.detail.kind === 'text' ? el.detail.synth : undefined
    // Render the true background at 3x, not the 1.5x sampling scale. The patch is
    // a bitmap laid into an otherwise-vector page: at 1.5x it visibly softens
    // against the crisp rules and type around the hole on export and at zoom. 3x
    // matches the raster tier and export DPI, so the patched region stays sharp.
    // Re-render the background with EVERY span lifted from this page so far, not
    // just this one. Rendering pristine-minus-only-the-current-span meant a second
    // lift's patch still contained the first element's glyphs and, appended last in
    // objOrder, painted them back over the object the first lift produced — editing
    // or deleting that object then changed nothing on the page.
    // (Compositing the earlier PATCHES onto this render instead — the tempting
    // shortcut — is wrong: those patches hold the OLD background, e.g. banner
    // pixels, and would stamp a banner-coloured rectangle onto paper the current
    // lift has just cleared.)
    const priorEdits = spansLiftedSoFar()
    const thisEdit = { span: el.span, replacement, formPath: el.formPath }
    const clean = await renderPageWithoutSpans(page, [...priorEdits, thisEdit], 3)
    if (clean) {
      // x/y/w/h come from cropCanvasToPatch — the CLAMPED region it actually
      // captured — so the patch lands exactly over the pixels it holds.
      return {
        id: uid(), page: page.id, kind: 'whiteout', opacity: 1,
        removedSpans: [thisEdit], // so the NEXT lift renders without it — and the export drops it
        ...cropCanvasToPatch(clean, cropBox, pv.w),
      }
    }
    // The true-background render failed (an encrypted page, an unsupported
    // filter). Rather than leave the original showing through the lifted copy,
    // still cover it — flat, in the paper colour sampled around it, over the
    // tight box so a solid fill never spills onto neighbouring content. Not the
    // exact background, but the lift stays destructive instead of a ghost.
    const box = flatBox
    try {
      const canvas = await getSamplingCanvas(page)
      // Sample the paper from a ring well OUTSIDE the element, not the tight box's
      // own edge — that edge hugs the element's ink and would tint the fill with
      // the very thing we are covering (a dark heading giving a grey patch).
      // Clear the element's OWN outline before sampling. A pill or a card is a
      // body plus a stroke, and a ring 0.6 glyph-heights out is still standing on
      // that stroke — which is how a cream pill's flat fallback came back solid
      // black. Sample twice and prefer the outer reading when they disagree
      // sharply: the near ring is the thing being covered, the far one is the
      // page it sits on.
      const near = Math.max(4, gh * 0.6)
      const far = Math.max(10, gh * 2.2)
      const ringAt = (m: number) => ({ x: box.x - m, y: box.y - m, w: box.w + 2 * m, h: box.h + 2 * m })
      const cNear = samplePaperColor(canvas, ringAt(near), pv.w)
      const cFar = samplePaperColor(canvas, ringAt(far), pv.w)
      const lum = (c: string) => 0.2126 * parseInt(c.slice(1, 3), 16)
        + 0.7152 * parseInt(c.slice(3, 5), 16) + 0.0722 * parseInt(c.slice(5, 7), 16)
      const color = Math.abs(lum(cNear) - lum(cFar)) > 40 ? cFar : cNear
      return { id: uid(), page: page.id, kind: 'whiteout', opacity: 1, x: box.x, y: box.y, w: box.w, h: box.h, color }
    } catch {
      return { id: uid(), page: page.id, kind: 'whiteout', opacity: 1, x: box.x, y: box.y, w: box.w, h: box.h, color: '#FFFFFF' }
    }
  }

  // Highest fidelity: printed text as real, editable text set in its own font,
  // via the retype construction (pen origin, baseline, embedded/twin face,
  // sampled ink colour). Null when pdf.js can't read it as text.
  const buildTextObject = async (el: PageElement): Promise<TextObj | null> => {
    const geom = pageGeom(page)
    const d = el.detail
    // Probe the run's START, not its centre: an over-estimated base-14 box would
    // otherwise land past a run of narrow glyphs. The pen origin is always on it.
    const dx = d.kind === 'text' && d.measurable === false ? Math.min(el.userBox.w / 2, d.fs * 0.5) : el.userBox.w / 2
    const [vx, vy] = userToView(geom, el.userBox.x + dx, el.userBox.y + el.userBox.h / 2)
    const fi = await runFontInfo(page, vx, vy).catch(() => null)
    if (!fi || fi.rect.w <= 2 || fi.rect.h <= 2 || !fi.text.trim()) return null
    const printed = fi.text, font = fi.fontId, bold = fi.bold, size = fi.size
    let usableFace: string | undefined
    if (fi.loadedName && fi.data) {
      rememberEmbeddedFont(fi.loadedName, fi.data, fi.mimetype)
      if (faceCovers(fi.loadedName, printed)) usableFace = fi.loadedName
    }
    let color = '#000000'
    try {
      const canvas = await getSamplingCanvas(page)
      color = sampleInkColor(canvas, { x: fi.rect.x, y: fi.rect.y, w: Math.min(fi.rect.w, 420), h: fi.rect.h }, pv.w) ?? '#000000'
    } catch { /* black is a fine fallback */ }
    const tracking = usableFace ? 0 : trackingForWidth(printed, font, size, bold, fi.rect.w, usableFace)
    const m = measureText(printed || ' ', font, size, bold, undefined, tracking, false, usableFace)
    return {
      id: uid(), page: page.id, kind: 'text', opacity: 1,
      x: fi.rect.x, y: fi.baseline - size * BASELINE_EM, w: m.w, h: m.h,
      text: printed, color, size, font, bold,
      ...(usableFace ? { pdfFont: usableFace, pdfSpace: spaceEmFromRun(usableFace, printed, fi.rect.w, size) ?? spaceEmOfFace(usableFace) ?? fi.spaceEm ?? 0.25 } : {}),
      ...(fi.italic && !usableFace ? { italic: true } : {}),
      ...(tracking ? { tracking } : {}),
      ...(fi.stdFont ? { stdFont: fi.stdFont } : {}),
    }
  }


  /**
   * A path lifted as REAL VECTORS: a logo, a curve, an icon, a rule with a
   * radius — anything the shape tier cannot call a rectangle or a line, which
   * until now became a picture of itself.
   *
   * The walker hands back the path in USER space, so this maps every coordinate
   * through the page's own user→view transform (which is what makes it correct
   * on a rotated or cropped page, where a naive y-flip is not) and then makes it
   * relative to the object's own top-left. After that the geometry never moves
   * again: dragging and resizing are a transform on the box, and the path stays
   * exactly as the document drew it — crisp at any zoom, and exported as
   * instructions rather than pixels.
   */

  /**
   * PEEL THE PAGE INTO ITS ELEMENTS.
   *
   * Lift takes one thing at a time, which is right when you know what you want.
   * This takes everything: every run, every path, every picture the page draws,
   * handed back as editable objects over the background they sat on. A finished
   * PDF becomes a document again — drag the logo, recolour the rule, retype the
   * heading — without a model, because none of it is a guess. It is the page's
   * own drawing program, read and re-laid.
   *
   * The background is rendered ONCE with every peeled span suppressed, and each
   * element's patch is a crop of that single image. Doing it per element would
   * mean one full-page render each — twenty renders for twenty elements — and
   * each would show the elements not yet peeled, so the patches would disagree
   * with each other.
   *
   * One undo step: peeling a page and being unable to take it back in one press
   * would be worse than not offering it.
   */
  const peelElements = async (): Promise<{ peeled: number; skipped: number }> => {
    const startDoc = s().active
    s().setBusy('Taking the page apart…')
    try {
      const libDoc = await getLibDoc(page.srcId)
      const geom = pageGeom(page)
      const all = walkPageContent(libDoc, libDoc.getPage(page.srcIndex)).elements
      const pageArea = Math.max(1, pv.w * pv.h)
      const viewOf = (el: PageElement): Rect => userRectToView(geom,
        [el.userBox.x, el.userBox.y, el.userBox.x + el.userBox.w, el.userBox.y + el.userBox.h])

      // What NOT to take: the sheet's own background (every point sits on it, and
      // lifting it hands back a page-sized rectangle), anything inside a form
      // shared with another page, clip stand-ins, and slivers.
      const wanted = all.filter((el) => {
        if (el.standIn) return false
        if (el.formPath.length && formStreamShared(libDoc, libDoc.getPage(page.srcIndex), el.formPath)) return false
        const b = viewOf(el)
        if (b.w < 1.5 || b.h < 1.5) return false
        if (b.w * b.h > pageArea * 0.9) return false
        return true
      })
      if (!wanted.length) return { peeled: 0, skipped: 0 }

      const edits: RemovalEdit[] = wanted.map((el) => ({
        span: el.span,
        replacement: el.detail.kind === 'text' ? el.detail.synth : el.standIn,
        formPath: el.formPath,
      }))
      const clean = await renderPageWithoutSpans(page, [...spansLiftedSoFar(), ...edits], 3)
      if (s().active !== startDoc) return { peeled: 0, skipped: 0 }

      const canvas = clean ? null : await getSamplingCanvas(page).catch(() => null)
      const made: AnyObj[] = []
      let skipped = 0
      for (const el of wanted) {
        const vb = viewOf(el)
        let obj: AnyObj | null = null
        if (el.kind === 'text' && el.axisAligned) obj = await buildTextObject(el)
        if (!obj && el.detail.kind === 'shape') obj = buildShapeObject(el, canvas)
        if (!obj && el.detail.kind === 'path') obj = buildVectorObject(el)
        if (!obj) obj = await buildRasterObject(el, vb)
        if (!obj) { skipped++; continue }
        made.push(obj)
      }
      if (!made.length) return { peeled: 0, skipped }
      if (s().active !== startDoc) return { peeled: 0, skipped }

      // ONE patch for the whole page: the background with everything taken off.
      const patch: WhiteoutObj = clean
        ? {
            id: uid(), page: page.id, kind: 'whiteout', opacity: 1,
            removedSpans: edits,
            ...cropCanvasToPatch(clean, { x: 0, y: 0, w: pv.w, h: pv.h }, pv.w),
          }
        : { id: uid(), page: page.id, kind: 'whiteout', opacity: 1, x: 0, y: 0, w: pv.w, h: pv.h, color: '#FFFFFF' }
      s().addObjects([patch, ...made], { selectId: made[made.length - 1].id })
      return { peeled: made.length, skipped }
    } finally {
      s().setBusy(null)
    }
  }

  const buildVectorObject = (el: PageElement): VectorObj | null => {
    const d = el.detail
    if (d.kind !== 'path' || !d.d) return null
    const geom = pageGeom(page)
    const vb = userRectToView(geom, [el.userBox.x, el.userBox.y,
      el.userBox.x + el.userBox.w, el.userBox.y + el.userBox.h])
    if (vb.w < 0.4 || vb.h < 0.4) return null
    // Rewrite the coordinate pairs in place. The walker emits only absolute
    // M/L/C/Q and Z, so every number is half of a point and the order is the
    // order they appear.
    let bad = false
    const local = d.d.replace(/(-?\d*\.?\d+)\s+(-?\d*\.?\d+)/g, (_m, a: string, b: string) => {
      const [vx, vy] = userToView(geom, parseFloat(a), parseFloat(b))
      if (!Number.isFinite(vx) || !Number.isFinite(vy)) { bad = true; return '0 0' }
      return `${Math.round((vx - vb.x) * 1e3) / 1e3} ${Math.round((vy - vb.y) * 1e3) / 1e3}`
    })
    if (bad || !local.trim()) return null
    return {
      id: uid(), page: page.id, kind: 'vector', opacity: 1,
      x: vb.x, y: vb.y, w: vb.w, h: vb.h,
      d: local.trim(), srcW: vb.w, srcH: vb.h,
      fill: d.fill ? rgbToHex(...d.fill) : null,
      stroke: d.stroke ? rgbToHex(...d.stroke) : null,
      strokeWidth: d.strokeWidth ?? 1,
      ...(d.evenOdd ? { evenOdd: true } : {}),
    }
  }

  const buildShapeObject = (el: PageElement, canvas?: HTMLCanvasElement | null): ShapeObj | null => {
    const d = el.detail
    if (d.kind !== 'shape') return null
    const geom = pageGeom(page)
    if (d.shape === 'rect') {
      if (!el.axisAligned) return null        // a rotated rect isn't a rect object
      if (!d.fill && !d.stroke) return null   // non-device colour -> raster
      const vb = userRectToView(geom, [el.userBox.x, el.userBox.y, el.userBox.x + el.userBox.w, el.userBox.y + el.userBox.h])
      let fill = d.fill ? rgbToHex(...d.fill) : null
      // CHECK THE DECLARED FILL AGAINST THE PIXELS INSIDE IT.
      //
      // A pill or a card is drawn as more than one path — a body and an outline
      // — and the element the walker hands back may be either. On the benchmark
      // CV it is the black outline of a cream pill, so the lifted "shape" came
      // out a solid black bar the size of the heading it sat behind, with no
      // message at all. The declared fill is a fact about ONE path; what the
      // reader sees inside the box is a fact about the shape.
      if (fill && canvas) {
        try {
          const inset = Math.max(2, Math.min(vb.w, vb.h) * 0.25)
          const inner = { x: vb.x + inset, y: vb.y + inset,
            w: Math.max(2, vb.w - 2 * inset), h: Math.max(2, vb.h - 2 * inset) }
          const seen = samplePaperColor(canvas, inner, pv.w)
          const hx = (c: string): [number, number, number] => [
            parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]
          const a = hx(fill), b = hx(seen)
          const far = Math.max(Math.abs(a[0]-b[0]), Math.abs(a[1]-b[1]), Math.abs(a[2]-b[2])) > 60
          if (far) fill = seen
        } catch { /* keep the declared fill */ }
      }
      return {
        id: uid(), page: page.id, kind: 'shape', opacity: 1, mode: 'rect',
        x: vb.x, y: vb.y, w: vb.w, h: vb.h,
        fill,
        stroke: d.stroke ? rgbToHex(...d.stroke) : null,
        strokeWidth: d.strokeWidth ?? 1,
      }
    }
    if (!d.stroke || !d.p1 || !d.p2) return null
    const [ax, ay] = userToView(geom, d.p1[0], d.p1[1])
    const [bx, by] = userToView(geom, d.p2[0], d.p2[1])
    return {
      id: uid(), page: page.id, kind: 'shape', opacity: 1, mode: 'line',
      x: ax, y: ay, w: bx - ax, h: by - ay, // line convention: p2 = (x+w, y+h)
      stroke: rgbToHex(...d.stroke), strokeWidth: d.strokeWidth ?? 1, fill: null,
    }
  }

  const buildRasterObject = async (el: PageElement, viewRect: Rect): Promise<ImageObj | null> => {
    // Text runs box the baseline-to-cap band and exclude descenders (a rotated
    // run's tails can exit any edge), so grow the crop for text and place the
    // image at the grown rect. A base-14 run with no /Widths has its width
    // UNDER-estimated at 0.5em/glyph, and removalPatch already widens its whiteout
    // by 0.45·w to cover the real tail — so the raster must widen to MATCH, or the
    // page loses the tail (whited out) while the lift omits it.
    const isText = el.kind === 'text'
    const unmeasured = isText && el.detail.kind === 'text' && el.detail.measurable === false
    const padY = isText ? Math.max(2, 0.3 * viewRect.h) : 0
    const padX = isText ? (unmeasured ? Math.max(2, 0.45 * viewRect.w) : Math.max(2, 0.3 * viewRect.h)) : 0
    const raw = { x: viewRect.x - padX, y: viewRect.y - padY, w: viewRect.w + 2 * padX, h: viewRect.h + 2 * padY }
    // Clamp to the page BEFORE rendering: renderRegionToDataUrl clamps the source
    // read to [0..], so a crop that reaches past the top/left edge would be placed
    // at the unclamped (negative) origin and land shifted off the element. Clamp
    // the placement to match the pixels actually captured.
    const x = Math.max(0, raw.x), y = Math.max(0, raw.y)
    const r = { x, y, w: Math.min(pv.w - x, raw.w - (x - raw.x)), h: Math.min(pv.h - y, raw.h - (y - raw.y)) }
    // The bitmap is cut from the page, so on a page that has ALREADY been lifted
    // from it would carry the earlier element's ink — and an image paints above the
    // whiteouts, so lifting a banner out from under a lifted heading pasted the
    // heading straight back. Cut from a render with those spans gone (the element
    // being lifted is of course still there).
    const prior = spansLiftedSoFar()
    if (prior.length) {
      const base = await renderPageWithoutSpans(page, prior, 3)
      if (base) {
        const p = cropCanvasToPatch(base, r, pv.w)
        return { id: uid(), page: page.id, kind: 'image', opacity: 1, x: p.x, y: p.y, w: p.w, h: p.h, src: p.src }
      }
    }
    const src = await renderRegionToDataUrl(page, r, 3, 0, 0)
    return { id: uid(), page: page.id, kind: 'image', opacity: 1, x: r.x, y: r.y, w: r.w, h: r.h, src }
  }

  // The sampling canvas holds the PRISTINE page. Erasing over an area already
  // erased then samples the ORIGINAL through the earlier patch, so the fill can
  // mirror back the very ink the first stroke covered — a second pass "undoes"
  // the first. Composite the whiteout patches already on this page (those that
  // overlap the region being sampled) over the original, so each erase builds
  // on the visible result rather than the untouched page.
  const sampledWithPatches = async (region: Rect): Promise<HTMLCanvasElement> => {
    const base = await getSamplingCanvas(page)
    const d = s().docs[s().active ?? '']
    if (!d) return base
    const hit = (o: WhiteoutObj) =>
      o.x < region.x + region.w && o.x + o.w > region.x && o.y < region.y + region.h && o.y + o.h > region.y
    const patches = d.objOrder
      .map((id) => d.objects[id])
      .filter((o): o is WhiteoutObj => !!o && o.page === page.id && o.kind === 'whiteout' && hit(o))
    if (!patches.length) return base
    const out = document.createElement('canvas')
    out.width = base.width; out.height = base.height
    const ctx = out.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(base, 0, 0)
    const k = base.width / pv.w
    for (const p of patches) {
      try {
        if (p.src) {
          const im = await new Promise<HTMLImageElement>((res, rej) => {
            const el = new Image(); el.onload = () => res(el); el.onerror = rej; el.src = p.src!
          })
          ctx.drawImage(im, p.x * k, p.y * k, p.w * k, p.h * k)
        } else {
          ctx.fillStyle = p.color
          ctx.fillRect(p.x * k, p.y * k, p.w * k, p.h * k)
        }
      } catch { /* a patch that won't load just isn't composited */ }
    }
    return out
  }

  /**
   * Is the ink here actually a RASTER — pixels, where words could only be read
   * by looking at them?
   *
   * This decides whether "I can't read this" means "connect a model" or "there
   * is nothing here to read". Retype used to skip the question: any ink it could
   * not read as text got "this text is part of an image — connect a model". On a
   * page with a coloured sidebar, a rule under a heading, a logo drawn as vector
   * paths — none of which contain a single glyph — that is not merely unhelpful,
   * it is false, and no model can turn a filled rectangle into words. Measured on
   * a design-heavy CV: thirteen of twenty-four drag points demanded a model, and
   * the file's own text layer confirmed there was no text at any of them.
   */
  const rasterUnder = async (x: number, y: number): Promise<boolean> => {
    try {
      const libDoc = await getLibDoc(page.srcId)
      const els = walkPageContent(libDoc, libDoc.getPage(page.srcIndex)).elements
      return layersAt(els, pageGeom(page), x, y)
        .some((el) => el.kind === 'image' || el.kind === 'inline-image')
    } catch {
      // Can't tell. Offer the model rather than refuse to help: a wrong prompt
      // is recoverable, a tool that silently does nothing is not.
      return true
    }
  }

  const runLiftClick = async (x: number, y: number) => {
    const libDoc = await getLibDoc(page.srcId)
    const geom = pageGeom(page)
    const els = walkPageContent(libDoc, libDoc.getPage(page.srcIndex)).elements
    let hits = layersAt(els, geom, x, y)
    // A full-bleed background rectangle is under EVERY point on the page, so on
    // any document whose author painted one, clicking blank margin offered the
    // entire page as a liftable "shape" — and taking it covered the whole sheet
    // with a patch and handed back a page-sized object. Nothing about a click on
    // empty paper asks for that. Step past anything that is effectively the page
    // itself; the descend cursor still reaches it for anyone who wants it.
    const pageArea = Math.max(1, pv.w * pv.h)
    const coversPage = (el: PageElement): boolean => {
      const b = userRectToView(geom, [el.userBox.x, el.userBox.y,
        el.userBox.x + el.userBox.w, el.userBox.y + el.userBox.h])
      return b.w * b.h > pageArea * 0.9
    }
    if (hits.length && hits.every(coversPage)) {
      s().setLiftPreview(null); liftCursor.delete(page.id)
      s().toast('Nothing here to lift — click on something printed', 'info')
      return
    }
    hits = hits.filter((h) => !coversPage(h)).concat(hits.filter(coversPage))
    if (!hits.length) { s().setLiftPreview(null); liftCursor.delete(page.id); return }
    // re-clicking the same spot steps down to the element beneath the last one.
    // Clamp at the bottom rather than wrapping (% hits.length): a lift adds a copy
    // on top without removing the page's own ink, so the element stays detectable,
    // and wrapping cycled the cursor straight back to the top layer — re-lifting
    // it and stacking a duplicate copy + patch. Stop at the deepest layer instead.
    const prev = liftCursor.get(page.id)
    const same = prev && Math.hypot(prev.x - x, prev.y - y) < 4
    const i = same ? Math.min(prev.i + 1, hits.length - 1) : 0
    liftCursor.set(page.id, { x, y, i })
    const el = hits[i]
    const vb = userRectToView(geom, [el.userBox.x, el.userBox.y, el.userBox.x + el.userBox.w, el.userBox.y + el.userBox.h])
    s().setLiftPreview({ pageId: page.id, rect: vb, label: labelForElement(el), el })
  }

  // Expose this page's peeler so a page-level command (and the automation
  // harness) can reach it: the builders it needs close over this component's
  // page, geometry and sampling canvas, so it cannot live in a core module
  // without dragging all of that with it.
  useEffect(() => {
    peelers.set(page.id, peelElements)
    return () => { peelers.delete(page.id) }
  })

  // Enter lifts THIS page's previewed element; Escape cancels. The preview lives
  // in the store tagged with its page, so only the matching page registers a
  // listener and one Enter commits exactly one element.
  useEffect(() => {
    if (tool !== 'lift' || !myLift) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        const p = myLift
        s().setLiftPreview(null); liftCursor.delete(page.id)
        void realiseLift(p.el, p.rect)
      } else if (e.key === 'Escape') {
        s().setLiftPreview(null); liftCursor.delete(page.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // `page` belongs here even though nothing in the body reads it directly:
    // realiseLift closes over this PageRef, and a rotation changes the geometry
    // without changing `tool` or `myLift`. The store clears the preview on every
    // such change now, so this is the second lock on the same door.
  }, [tool, myLift, page])

  // leaving the tool clears this page's descend cursor (the store clears the
  // preview itself on tool change)
  useEffect(() => {
    if (tool !== 'lift') liftCursor.delete(page.id)
  }, [tool])

  // and clear the descend cursor when this page unmounts (the document closed),
  // so the module-level map doesn't accumulate dead entries
  useEffect(() => () => { liftCursor.delete(page.id) }, [page.id])

  if (!doc) return null

  const objs = doc.objOrder
    .map((id) => doc.objects[id])
    .filter((o): o is AnyObj => Boolean(o) && o.page === page.id)
  const selection = doc.selection.filter((id) => doc.objects[id]?.page === page.id)

  const toPage = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = svgRef.current!.getBoundingClientRect()
    return [(e.clientX - r.left) / zoom, (e.clientY - r.top) / zoom]
  }

  const ensureCommit = () => {
    const g = gesture.current
    if (g && !g.committed) {
      g.committed = true
      s().commitNow()
    }
  }

  /* ----- select-tool gestures on existing objects ----- */

  const startMove = (e: React.PointerEvent, obj: AnyObj) => {
    if (tool !== 'select' || e.button !== 0) return
    e.stopPropagation()
    let sel = doc.selection
    if (e.shiftKey) {
      sel = sel.includes(obj.id) ? sel.filter((i) => i !== obj.id) : [...sel, obj.id]
      s().setSelection(sel)
      return
    }
    if (!sel.includes(obj.id)) {
      sel = [obj.id]
      s().setSelection(sel)
    }
    const d = s().active ? s().docs[s().active!] : null
    const origs = new Map<string, AnyObj>()
    // Move EVERY selected object, not just this page's — a selection can span
    // pages (shift-click across a scroll), and the drag delta is in per-page view
    // units that mean the same shift on any page. Filtering to page.id silently
    // left the other pages' objects behind.
    for (const id of sel) {
      const o = d?.objects[id]
      if (o) origs.set(id, o)
    }
    gesture.current = { mode: 'move', start: toPage(e), origs, committed: false }
    capturePointer(e)
  }

  const startResize = (e: React.PointerEvent, obj: AnyObj, corner: Corner) => {
    e.stopPropagation()
    gesture.current = {
      mode: 'resize', start: toPage(e), origs: new Map([[obj.id, obj]]),
      corner, origBounds: objBounds(obj), committed: false,
    }
    capturePointer(e)
  }

  const startEndpoint = (e: React.PointerEvent, obj: AnyObj, which: 1 | 2) => {
    e.stopPropagation()
    gesture.current = { mode: 'endpoint', start: toPage(e), origs: new Map([[obj.id, obj]]), endpoint: which, committed: false }
    capturePointer(e)
  }

  const onGestureMove = (e: React.PointerEvent) => {
    const g = gesture.current
    if (!g) return
    const [px, py] = toPage(e)
    const dx = px - g.start[0]
    const dy = py - g.start[1]
    if (!g.committed && Math.hypot(dx, dy) < 1.5 / zoom) return
    ensureCommit()

    if (g.mode === 'move') {
      for (const [id, orig] of g.origs) s().replaceObject(translateObj(orig, dx, dy))
      void 0
    } else if (g.mode === 'resize' && g.origBounds && g.corner) {
      const ob = g.origBounds
      let x1 = ob.x, y1 = ob.y, x2 = ob.x + ob.w, y2 = ob.y + ob.h
      if (g.corner.includes('w')) x1 += dx
      if (g.corner.includes('e')) x2 += dx
      if (g.corner.includes('n')) y1 += dy
      if (g.corner.includes('s')) y2 += dy
      if (e.shiftKey) {
        const ar = ob.w / Math.max(ob.h, 0.01)
        const nw = Math.abs(x2 - x1)
        const nh = nw / ar
        if (g.corner.includes('n')) y1 = y2 - nh
        else y2 = y1 + nh
      }
      const nb = normRect(x1, y1, x2, y2)
      nb.w = Math.max(6, nb.w)
      nb.h = Math.max(6, nb.h)
      const orig = [...g.origs.values()][0]
      s().replaceObject(scaleObjTo(orig, ob, nb))
    } else if (g.mode === 'endpoint' && g.endpoint) {
      const orig = [...g.origs.values()][0]
      if (orig.kind === 'shape') {
        if (g.endpoint === 1) {
          s().replaceObject({ ...orig, x: orig.x + dx, y: orig.y + dy, w: orig.w - dx, h: orig.h - dy })
        } else {
          s().replaceObject({ ...orig, w: orig.w + dx, h: orig.h + dy })
        }
      }
    }
  }

  const endGesture = () => {
    gesture.current = null
  }

  /* ----- AI reshape: read the print, match its style, hand the user the pen ----- */

  /* ----- Retype: click a printed line, change its words, keep the look ----- */
  const runRetypeClick = async (x: number, y: number) => {
    const st = s()
    let band: Rect | null = null
    // The horizontal extent found by COLOUR on the raster path, kept so the
    // pixel re-measurement below cannot trim the faint edge of a glyph back off.
    let colourBand: Rect | null = null
    // BEST: pdf.js knows the exact run under the cursor (its own geometry) — this
    // isolates a single word/cell without merging neighbouring columns
    const fi = await runFontInfo(page, x, y).catch(() => null)
    if (fi && fi.rect.w > 2 && fi.rect.h > 2) {
      // a run box is an ADVANCE box — it includes the run's trailing spaces, so
      // it reaches past the last glyph. Trim it to the ink or we erase blank
      // paper the reprinted text can't cover.
      band = fi.rect
      try {
        const trimmed = trimRectToInk(await getSamplingCanvas(page), fi.rect, pv.w)
        // same floor as below: a trim that eats most of the line's height has
        // found a rule or a border, not the words
        if (trimmed && trimmed.h >= (fi.size ? fi.size * 0.35 : 0)) band = trimmed
      } catch { /* keep the run box */ }
    }
    // else (scan/poster, no text layer): detect the ink band from pixels
    if (!band) {
      try {
        const canvas = await getSamplingCanvas(page)
        const bands = detectInkBands(canvas, { x: x - 260, y: y - 40, w: 520, h: 80 }, pv.w)
          .filter((b) => y >= b.y - 4 && y <= b.y + b.h + 4)
          // ...and that the click is actually ON it. Matching by row alone picks
          // whatever else happens to share that row — on a banner, the drift of
          // particles off to the right is a wide, ink-rich band at almost every
          // height, so it wins on nearly every click and the erase lands a couple
          // of hundred points from the words the user pointed at.
          .filter((b) => x >= b.x - 8 && x <= b.right + 8)
          .sort((a, b) => Math.abs(a.y + a.h / 2 - y) - Math.abs(b.y + b.h / 2 - y))
        if (bands[0]) {
          band = { x: bands[0].x, y: bands[0].y, w: bands[0].right - bands[0].x, h: bands[0].h }
          // The band is "rows that aren't background", which on decorated artwork
          // reaches far past the words — a subtitle on a speckled banner comes
          // back joined to a few hundred points of drifting particles. Cut it
          // down to the run whose colour was actually clicked.
          const probe = {
            x: Math.max(band.x, x - band.h * 1.2), y: band.y,
            w: Math.min(band.w, band.h * 2.4), h: band.h,
          }
          // Scan a WIDE window, not the band that was handed over. Row detection
          // decides where a band starts by asking whether a column differs from
          // the background, and on a speckled field the first letters of a word
          // can lose that vote to the specks around them — the band then opens
          // part-way through the phrase and the erase begins mid-word. Colour
          // does not have that problem, so give it the whole neighbourhood and
          // let it find both ends of the run itself.
          const wide = { x: Math.max(0, x - 260), y: band.y, w: 520, h: band.h }
          band = narrowBandToRun(canvas, wide, pv.w, x, sampleInkColor(canvas, probe, pv.w))
          colourBand = band
        }
      } catch { /* fall through */ }
    }
    if (!band) {
      st.toast('No printed text there — click directly on a line of text', 'warn')
      return
    }
    // Both routes above give a box that is close but not exact — a run box is an
    // advance box, a detected band is rows of "not background". Re-measure it
    // against the letters themselves, the same way the clone does, so the erase
    // and the reprint are working from one box rather than two that disagree.
    //
    // But a pixel measurement is a REFINEMENT of what the file already said, and
    // a refinement that disagrees by a factor of ten is not a refinement. A rule
    // ruled across the page, a table border, the underline of the heading above
    // — anything thin, dark and full-width inside the run box can out-vote the
    // letters in a row profile, and the box then collapses onto the rule. The
    // symptom is not a slightly wrong erase: the sliver holds no ink, so the
    // whole thing is taken for blank paper and the click quietly turns into
    // "add an empty text box" over type that is still sitting there.
    //
    // When the document states the point size, trust it as a floor. Even
    // all-lowercase copy inks about half its em; caps a good deal more.
    try {
      const exact = measureLineBox(await getSamplingCanvas(page), band, pv.w)
      const floor = fi?.size ? fi.size * 0.35 : 0
      // A refinement also has to still cover the spot that was clicked. Re-measuring
      // against "the letters" assumes the box holds letters; where it holds a drift
      // of particles or a photograph, the densest part of that wins and the box
      // walks off the words entirely — the user clicks a subtitle and the erase
      // lands two hundred points away, on scenery.
      const holds = (b: Rect) => x >= b.x - 8 && x <= b.x + b.w + 8 && y >= b.y - 8 && y <= b.y + b.h + 8
      if (exact && exact.w > 2 && exact.h > 2 && exact.h >= floor && holds(exact)) {
        band = exact
      }
    } catch { /* keep the box we have */ }
    // A model is only needed to READ words we can't otherwise read. When the
    // page carries a text layer it has already told us the words, the family,
    // the weight and the size exactly — and the background comes from
    // re-rendering, not from a guess. Asking the user to go and connect a model
    // before they can edit text the file spells out in full is pure friction,
    // and the model's reading is strictly worse than the file's own.
    if (!st.aiConfig && !fi?.text?.trim()) {
      if (await rasterUnder(x, y)) {
        st.openModal({ type: 'ai' })
        st.toast('This text is part of an image — connect a model once (a local Ollama or LM Studio works) and it can be read and edited too', 'info')
      } else {
        // Ink, but not one glyph in it: a panel, a rule, a logo. There is
        // nothing here for a model to read, so do not send anyone to fetch one.
        st.toast('That is artwork, not type — there are no words here to edit. Lift (L) picks the shape up; Erase takes it out.', 'info')
      }
      return
    }
    // The box now spans the line's real ink, descenders included, so all that is
    // left to cover is the antialiased edge where the glyphs fade out. A hair all
    // round does it — text still lands on the original (unpadded) band.
    // No horizontal outset: the band is already trimmed to this run's ink, and
    // widening it reaches into the neighbouring words — which both clipped their
    // glyphs (visible damage either side of the edit) and put them in the crop
    // the model reads, so the lift came back with stray letters attached.
    const padX = 0
    const padTop = band.h * 0.06
    const padBot = band.h * 0.06

    // Two boxes, because two different jobs are being done with them.
    //
    // What has to be COVERED is every pixel the letters marked, the faint outer
    // column of the first glyph included — miss it and a sliver of the old word
    // is still on the page. What the new type is MEASURED from has to be the
    // solid letters only: cap height, baseline and weight all come from that
    // box, and letting it grow by a column of half-lit antialiasing at each end
    // drags the reading off. Widening the one box for the sake of the erase
    // moved the reprint's baseline by a point and a half.
    const eraseBand = colourBand
      ? (() => {
          const x0 = Math.min(band.x, colourBand.x)
          const x1 = Math.max(band.x + band.w, colourBand.x + colourBand.w)
          return { x: x0, y: band.y, w: x1 - x0, h: band.h }
        })()
      : band
    await runReshape(
      { x: eraseBand.x - padX, y: eraseBand.y - padTop, w: eraseBand.w + padX * 2, h: eraseBand.h + padTop + padBot },
      { fixedBand: band, fontInfo: fi },
    )
  }

  const runReshape = async (r: Rect, opts?: { fixedBand?: Rect; fontInfo?: Awaited<ReturnType<typeof runFontInfo>> }) => {
    const st = s()
    // The AI read can take seconds; if the user switches documents during it, the
    // patch+text must NOT be deposited into whichever doc is now active (with a page
    // id from the old one). Captured here, checked before the commit below.
    const startDoc = st.active

    // YOUR objects come first: dragging the AI box over something you added
    // means "blend THIS into the print" — the original page is not touched.
    const hit = doc.objOrder
      .map((id) => doc.objects[id])
      .filter((o) => o && o.page === page.id && (o.kind === 'text' || o.kind === 'whiteout'))
      .filter((o) => {
        const b = objBounds(o)
        return b.x < r.x + r.w && b.x + b.w > r.x && b.y < r.y + r.h && b.y + b.h > r.y
      })
    if (hit.length) {
      st.setTool('select')
      st.setSelection(hit.map((o) => o.id))
      // Dragging over your own text means "blend THIS into the print around it".
      // But a retype's own output has no print around it any more: it replaced
      // the print, and its patch covers where that print was. Re-blending it
      // measures the patch — so a second retype over a line you already retyped
      // added nothing, said nothing, and quietly moved and resized the first
      // replacement (measured: 9.7pt wider, 0.6pt up). Offer to edit the words
      // again instead, which is what a second gesture on the same line means.
      const texts = hit.filter((o) => o.kind === 'text')
      if (texts.length && texts.every((o) => (o as TextObj).fromPrint)) {
        st.setEditingText(texts[0].id)
        return
      }
      await blendObjects(hit.map((o) => o.id), { refRect: r })
      return
    }

    st.setBusy('Reading the region…')
    let canvas: HTMLCanvasElement | null = null
    try {
      canvas = await getSamplingCanvas(page)
    } catch { /* no canvas — treat the box as empty paper */ }

    // KNOW THE TASK: is there printed ink inside the box? (inset 3px so a
    // grazed glyph fringe doesn't count as "covering text")
    const inset = { x: r.x + 3, y: r.y + 3, w: Math.max(1, r.w - 6), h: Math.max(1, r.h - 6) }
    // Thin or faint print (a hairline face, grey small print) covers well under
    // 2% of the box, so coverage alone reads it as blank paper and the drag adds
    // an empty box instead of retyping. Row detection sees those lines, and it
    // finds nothing on truly empty paper, so either signal means "there's print".
    const overPrint = canvas
      ? inkFraction(canvas, inset, pv.w) >= 0.02 ||
        detectInkBands(canvas, inset, pv.w).some((b) => b.y + b.h > inset.y && b.y < inset.y + inset.h)
      : false

    // Leave a record of which way this went. A test that can only see the
    // finished objects has to infer the route from them and will infer wrong:
    // an "add empty text box" and a "retype that read nothing" look identical
    // from outside, and they are completely different bugs.
    ;(window as unknown as { __reshapedpdfTrace?: unknown }).__reshapedpdfTrace = {
      rect: { x: r.x, y: r.y, w: r.w, h: r.h },
      inset, overPrint,
      inkFraction: canvas ? inkFraction(canvas, inset, pv.w) : null,
      bands: canvas ? detectInkBands(canvas, inset, pv.w).length : null,
      fontInfo: opts?.fontInfo ? { text: opts.fontInfo.text, size: opts.fontInfo.size, name: opts.fontInfo.name } : null,
      route: overPrint ? 'replace' : 'add',
    }

    if (!overPrint) {
      // ADD: nothing printed here — no patch, nothing erased. The new text
      // takes the surrounding style (pixels alone are enough; no model needed).
      st.setBusy(null)
      const size = prefs.textSize
      const m = measureText(' ', prefs.font, size, prefs.bold)
      const id = uid()
      st.addObject({
        id, page: page.id, kind: 'text', opacity: 1,
        x: r.x + 1, y: r.y, w: Math.max(60, r.w), h: m.h,
        text: '', color: prefs.textColor, size, font: prefs.font, bold: prefs.bold,
        ...(r.w > 120 ? { boxW: r.w } : {}),
      })
      freshTextIds.add(id)
      st.setTool('select')
      st.setEditingText(id)
      void applyPrintMatch(id)
      st.toast('New text — it takes on the style of the print around it', 'ok')
      return
    }

    // REPLACE: the box covers printed text. Keep the content — transcribe it,
    // patch the original ink out, and hand it back pre-filled for editing.
    const cfg = st.aiConfig

    // Size comes from the TEXT'S geometry (the lines the box intersects), never
    // from the drag box itself — a generously drawn box must not inflate the type.
    // A click-to-retype passes its exact isolated run so we don't re-merge columns.
    const spans = spanRectsRef.current ?? (spanRectsRef.current = await getPageSpanRects(page).catch(() => []))
    let bands = opts?.fixedBand ? [opts.fixedBand] : snapRectToLines(r, spans ?? [])
    if (!bands.length && !opts?.fixedBand && spans?.length) {
      // The click landed just OFF a line on a text-layer page. Snap to the
      // nearest run rather than falling through to "these words are an image,
      // connect a model" — the text is right there in the file. Only when it is
      // genuinely close (within ~1.5 line heights); a click on blank paper stays
      // a blank click and adds a new text box as before.
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2
      let best: Rect | null = null, bestD = Infinity
      for (const sp of spans) {
        const dx = Math.max(sp.x - cx, 0, cx - (sp.x + sp.w))
        const dy = Math.max(sp.y - cy, 0, cy - (sp.y + sp.h))
        const dd = dx * dx + dy * dy
        if (dd < bestD) { bestD = dd; best = sp }
      }
      if (best && bestD <= (best.h * 1.5) ** 2) bands = [best]
    }
    if (!bands.length && canvas) {
      // no text layer (poster/scan): the ink rows themselves are the lines
      bands = detectInkBands(canvas, r, pv.w)
        .filter((b) => b.y + b.h > r.y && b.y < r.y + r.h)
        .map((b) => ({ x: Math.max(b.x, r.x), y: b.y, w: Math.min(b.right, r.x + r.w) - Math.max(b.x, r.x), h: b.h }))
        .filter((b) => b.w > 4)
    }
    const bandSize = bands.length
      ? Math.max(5, Math.min(96, Math.round((median(bands.map((b) => b.h)) / 1.15) * 10) / 10))
      : null
    // Only the horizontal edge. The TOP of the ink was being used as the top of
    // the text box, and those are different heights: ink starts at the cap line,
    // a text box starts a full ascent above the baseline. Anchoring one to the
    // other drops every reprint by the difference.
    const anchor = bands.length ? { x: bands[0].x } : null

    const band0 = bands.length ? bands[0] : null
    // the page's OWN font metadata (text-layer PDFs) is exact — real family,
    // weight and point size — so we trust it over the model's guess
    const fontInfo = opts?.fontInfo ?? (band0 ? await runFontInfo(page, band0.x + band0.w / 2, band0.y + band0.h / 2).catch(() => null) : null)
    // Ground truth from the file beats any reading of a picture of it.
    const known = fontInfo?.text?.trim() ? fontInfo : null
    if (!known && !cfg) {
      st.setBusy(null)
      if (!(await rasterUnder(r.x + r.w / 2, r.y + r.h / 2))) {
        st.toast('That is artwork, not type — there are no words here to edit. Lift (L) picks the shape up; Erase takes it out.', 'info')
        return
      }
      // We reach here only with INK under the click that isn't readable text-layer
      // type — a genuine near-miss on real text was already snapped to the nearest
      // run above, so this is words baked into an image and a model IS needed. (Do
      // not gate on "the page has a text layer somewhere": a hybrid page's figure
      // text still needs the model even though body copy elsewhere is selectable.)
      st.openModal({ type: 'ai' })
      st.toast('These words are part of an image — connect a model to lift them for editing. Nothing was removed.', 'info')
      return
    }
    try {
      let reading: { text: string; font: FontId; bold: boolean; color: string }
      if (known) {
        reading = { text: known.text.trim(), font: known.fontId, bold: known.bold, color: '#000000' }
      } else {
        const crop = await renderRegionToDataUrl(page, r, 3)
        st.setBusy(`Reading the print with ${cfg!.model}…`)
        reading = await readRegion(cfg!, crop)
      }
      let font = fontInfo?.fontId ?? reading.font
      // A file that fakes bold by overprinting has no bold face for pdf.js to
      // report, so the face alone says regular and the reprint came back light
      // beside the headers around it. The overprint IS the weight.
      let bold = (fontInfo?.bold ?? reading.bold) || Boolean(fontInfo?.overdrawn)
      // The words come from the PAGE when the page knows them. Font, weight and
      // size already work this way; the text was the one thing still taken from
      // the model's reading even on a run pdf.js had handed us verbatim. That is
      // not a cosmetic difference: the transcription is what every harvested
      // glyph gets labelled with, so one misread letter ("Rivergale" for
      // "Rivergate") mislabels the atlas and the retype comes out wrong.
      const printed = fontInfo?.text?.trim() || reading.text
      // A reading with nothing printable in it is a FAILURE, and it used to be
      // treated as a success: the model returning "\n" (or a stray space, or
      // nothing at all) produced an empty text object five points wide, sitting
      // on a patch that had already covered the print, under a toast that said
      // "the look is matched". The words vanished and the app said it had gone
      // well. Nothing is a legitimate answer to "what does this say" only when
      // there is nothing there — and then there is nothing to lift either.
      if (!/\S/.test(printed)) {
        st.setBusy(null)
        st.toast(
          fontInfo
            ? 'Could not read that run — nothing was changed.'
            : `${cfg?.model ?? 'The model'} could not read any words there — nothing was changed. Try a tighter drag around the line.`,
          'warn',
        )
        return
      }
      const lines = Math.max(1, bands.length)
      // size: exact from the page's font metadata, else the printed cap-height in
      // pixels, else the band height
      let size = bandSize ?? Math.max(5, Math.min(96, (r.h / lines / LINE_HEIGHT) * 0.94))
      let sourceType: ReturnType<typeof measureSourceType> = null
      if (canvas && band0) {
        sourceType = measureSourceType(canvas, band0, pv.w)
        if (sourceType) size = sizeForCapHeight(sourceType.capHeightPx, font, bold)
      }
      if (fontInfo?.size) size = fontInfo.size
      // No text layer (a poster, a scan, art like the banner): the face is only
      // the model's guess, and guessing "sans" for a wide display face leaves the
      // words ~35% short — letter-spacing then has to stretch them out to fill
      // the line. The printed width IS measured, so re-pick the palette face that
      // reproduces it at this size and the stretch stays invisible.
      if (!fontInfo && band0 && bands.length === 1 && printed && !printed.includes('\n')) {
        font = bestWidthFont(printed, size, bold, band0.w, font)
        if (sourceType) size = sizeForCapHeight(sourceType.capHeightPx, font, bold)
        // …and then check that size against the ink it claims to describe.
        //
        // Cap height is measured off the pixels, which is exactly right for a
        // line of type and meaningless for anything else. Over a banner, a logo
        // or a photograph the tallest ink in the band is the artwork, so the
        // "cap height" is the whole graphic: "6-8 June" came back at 140.7pt
        // inside a strip a fraction of that tall, because sizeForCapHeight
        // clamps at 200 and nothing downstream questioned it.
        //
        // The band's WIDTH is measured from the same pixels and is not fooled
        // the same way: whatever those words are, they fitted across it. So set
        // the words at the size just decided and, if that setting could not have
        // fitted, scale it down until it does. Tied to what was actually
        // printed rather than to a guess about it.
        const natural = measureText(printed, font, size, bold).w
        if (natural > band0.w * 1.15) {
          size = Math.max(5, Math.round(size * (band0.w / natural) * 10) / 10)
        }
      }
      // ink colour from pixels beats the model's guess
      let inkCol: string | null = null
      if (canvas && band0) {
        try {
          inkCol = sampleInkColor(canvas, { x: band0.x, y: band0.y, w: Math.min(band0.w, 420), h: band0.h }, pv.w)
        } catch { /* model colour then */ }
      }
      // The document's OWN typeface, when this run was set in an embedded one.
      // There is nothing to "match": it is the font the page was printed with,
      // so the edit is simply set in it — crisp at any zoom, right at any size,
      // and embedded verbatim on export. PDFs almost always embed a SUBSET
      // though, so only take it if it can actually set these words; otherwise
      // the palette twin, as before.
      let usableFace: string | undefined
      if (fontInfo?.loadedName && fontInfo.data) {
        rememberEmbeddedFont(fontInfo.loadedName, fontInfo.data, fontInfo.mimetype)
        if (faceCovers(fontInfo.loadedName, printed)) usableFace = fontInfo.loadedName
      }
      // Letter-spacing exists to stretch a STAND-IN face out to the width the
      // real one occupied. Where the real one is doing the setting there is
      // nothing to stretch: same face, same size, same words, therefore the same
      // width, and any correction applied on top can only move it off. Worse,
      // the correction was being measured against the palette twin and then
      // applied to the document's face — a fit computed for a font that isn't
      // the one being drawn. On a 50pt name that came out 21pt short.
      //
      // A BASE-14 run is the same situation. `stdFont` means the exporter draws
      // it in the real Helvetica, Times or Courier the page names, so there is
      // nothing to stretch there either and a correction measured against the
      // palette twin is pure error. Measured: -4.08pt across a 145pt line,
      // gone once this branch is taken.
      //
      // NOTE, because the first version of this comment got it wrong: the code
      // this replaced did NOT skip the correction for an embedded face — it
      // measured it IN that face. Turning it off there changes nothing either
      // way, because a run whose face cannot be harvested never reaches this
      // branch at all; see the embedded-run/embedded-display cases.
      // MEASURE IT IN THE FACE THAT WILL DRAW IT — always.
      //
      // Skipping the correction whenever the reprint is set in the document's
      // own face assumed "same face, same size, same words, therefore the same
      // width". trackingForWidth's own documentation says why that is wrong: it
      // assumes the page was set with no letter-spacing of its own, and designed
      // type very often is. A name across the top of a CV is usually tracked in
      // tight, and a reprint at the face's natural spacing comes out several
      // points long — letterforms matching perfectly and the line still wrong.
      //
      // The mistake worth avoiding is narrower than "measure at all": it is
      // measuring against the PALETTE TWIN and applying the result to a
      // different face. So name the face each time — the embedded family, the
      // base-14 stack, or the twin when it really is the twin doing the setting
      // — and measure against the run's own printed width.
      const drawnIn = usableFace ?? (fontInfo?.stdFont ? stdFontStack(fontInfo.stdFont) : undefined)
      let tracking = 0
      if (band0 && lines === 1 && printed && !printed.includes('\n')) {
        // The run's OWN box when the file gives us one. band0 is an ink band
        // measured off pixels, and ink is narrower than advance by a side
        // bearing at each end — targeting it pulls the reprint in by that much,
        // which is where the 4pt shortfall on a 145pt base-14 line came from.
        // Only when there is no text layer at all is the ink band the best we
        // have, and there the face is a guess anyway.
        const target = fontInfo ? fontInfo.rect.w : band0.w
        tracking = trackingForWidth(printed, font, size, bold, target, drawnIn)
      }
      // Cover the old words with the background that was ALWAYS THERE.
      //
      // Inpainting is a guess — decide which pixels were ink, remove them,
      // invent a replacement — and every artefact comes from the guess: the flat
      // block where a pattern should continue, the faint traces of the letters
      // that were supposedly removed. But the page is a stack of drawing
      // instructions, and this text is drawn ON TOP of its background: the
      // background is still in the file, exact and whole. So re-render the page
      // with these glyphs simply not drawn and take the real pixels. Nothing is
      // invented, so nothing can be wrong.
      //
      // Only possible when the text is drawn AS TEXT. Words baked into a raster
      // image (a poster, a scan, this document's own banner) have no
      // instructions to skip, and those still go to the inpainter below.
      let paper: { x?: number; y?: number; color: string; src?: string; w?: number; h?: number } = { color: '#FFFFFF' }
      let patchRect = r
      let trueBg = false
      if (fontInfo && band0) {
        try {
          const tb = await liftTrueBackground(page, fontInfo.rect, pv.w)
          if (suppressionWorked(tb, band0, pv.w) && tb) {
            // Cover exactly what the glyphs touched — which we now KNOW, having
            // measured it rather than guessed at it. Every threshold in the old
            // erase existed to stop it over-covering, because over-covering meant
            // inventing more background; with the real background in hand there
            // is nothing to invent and no reason to be timid. Erase generously
            // and the residue isn't reduced, it's absent.
            // Cover the glyphs and NOTHING else.
            //
            // The patch is a bitmap, and it is being laid into a page that is
            // otherwise vector art. Inside its bounds everything is resampled:
            // rules go soft and gain a half-pixel of weight, borders blur at the
            // edges. On an underlined heading that is instantly legible as "this
            // has been pasted over" — the letters are perfect and the rule under
            // them is fuzzy.
            //
            // The rule was never in the way. Suppression removes glyphs, so it
            // was already coming back untouched and crisp; covering it with a
            // photograph of itself is pure loss. And the diff says precisely
            // which pixels the glyphs touched, so there is no need to guess a
            // generous box and hope.
            patchRect = tb.inkBox ?? r
            paper = cropCanvasToPatch(tb.clean, patchRect, pv.w)
            trueBg = true
          }
        } catch { /* fall through to the inpainter */ }
      }
      if (!trueBg) {
        try {
          if (canvas) {
            // How much room is there before the next line of type?
            //
            // The fill takes its material from around the hole, so it must not be
            // allowed to reach a neighbouring line and mirror pieces of it in.
            // The ink bands around the target say exactly where the neighbours
            // begin.
            let above: number | undefined
            let below: number | undefined
            try {
              const near = detectInkBands(canvas, { x: r.x, y: r.y - 60, w: r.w, h: r.h + 120 }, pv.w)
              for (const b of near) {
                if (b.y + b.h <= r.y + 0.5) above = Math.min(above ?? Infinity, Math.max(1, r.y - (b.y + b.h)))
                if (b.y >= r.y + r.h - 0.5) below = Math.min(below ?? Infinity, Math.max(1, b.y - (r.y + r.h)))
              }
            } catch { /* no bands: the default padding is fine */ }
            paper = makeBlendedPatch(canvas, r, pv.w, above, below)
          }
        } catch { /* white is a fine fallback */ }
      }
      const textId = uid()
      const m0 = measureText(printed || ' ', font, size, bold, undefined, tracking, false, usableFace)
      // Where the original line SAT. Prefer what the file states outright: pdf.js
      // carries the run's baseline in its transform, exactly, and no measurement
      // of pixels can improve on it. Then a measured baseline, and only as a last
      // resort the bottom of the ink — which is the descender line, not the
      // baseline, and using it drops the reprint about a fifth of an em.
      let baselineY = fontInfo?.baseline ?? sourceType?.baselineY ?? (band0 ? band0.y + band0.h : r.y + size)

      // Words read off an image: work out WHICH face they were set in.
      //
      // Cloning the original glyphs is exact, and exact only for letters the
      // line already had. Change "Summer" to "Winter" and there is no W to lift,
      // so it falls back to a stand-in and the edit announces itself. Setting
      // the words in the identified face instead works for any characters at all.
      //
      // An earlier attempt at this searched size and letter-spacing with the
      // FONT HELD FIXED at the wrong one, and answered by distorting the type
      // until it fitted — worse than the estimate it replaced. What was missing
      // was the font itself as a variable, and three things that each capped the
      // score until fixed: the candidates were never actually loaded (all
      // scoring identically to three decimals), the compared region reached into
      // the line below, and mass was being compared instead of shape.
      let matchFace: string | undefined
      let matchWeight: number | undefined
      let fitX: number | undefined
      let useClone = true
      if (!fontInfo && canvas && band0 && printed.trim() && !printed.includes('\n')) {
        try {
          await ensureMatchFaces()
          // Identify from a HIGH-RESOLUTION render, not the shared sampling
          // canvas. Overlap is unforgiving at small sizes: a 12pt line on a 1.5x
          // canvas has strokes about two pixels wide, so being one pixel out
          // costs half the score and no face can clear a sensible bar. The same
          // line rendered larger scores a good deal higher for the same quality
          // of match. Costs one extra page render, once, on a kind of edit that
          // is already asking a model to read the words.
          let idCanvas = canvas
          try {
            const hi = await renderPageWithoutText(page, [], IDENTIFY_SCALE)
            if (hi && hi.width > canvas.width) idCanvas = hi
          } catch { /* the sampling canvas will do */ }
          const guess = identifyFace(idCanvas, band0, printed, pv.w, size, inkCol ?? undefined)
          ;(window as unknown as { __guess?: unknown }).__guess = {
            printed, band0, hintSize: size, inkCol,
            got: guess && { face: guess.matchFace ?? guess.font, weight: guess.weight, score: +guess.score.toFixed(3), margin: +guess.margin.toFixed(2), base: guess.baselineY, size: guess.size },
          }
          // Placement comes from the fit only when the FACE is trusted too.
          //
          // It is tempting to take the position from a weak match and go on
          // cloning the letterforms — finding where a line sits looks like the
          // easier half. It isn't separable: the fit lands by putting ink boxes
          // on top of one another, and the top of an ink box is the cap line, so
          // a face whose cap height differs from the real one seats the baseline
          // wrong by that difference. Tried on the banner subtitle it moved the
          // error from 1.44pt to 1.86pt.
          // Trust it when it is both decent AND clearly better than the rest of
          // the field. A bare score cannot be compared between a headline and a
          // subtitle; standing clear of the alternatives can.
          // Where the line sits is MEASURED, from the ink, and does not depend on
          // which face wins. Only the letterforms come from the match.
          const measured = baselineFromInk(idCanvas, band0, pv.w, inkCol ?? undefined)
          if (measured != null) baselineY = measured
          if (guess && guess.score >= 0.45 && guess.margin >= 1.15) {
            if (measured == null) baselineY = guess.baselineY
            fitX = guess.x
            font = guess.font
            matchFace = guess.matchFace
            matchWeight = guess.weight
            bold = (guess.weight ?? (guess.bold ? 700 : 400)) >= 600
            size = guess.size
            tracking = guess.tracking
            useClone = false
          }
        } catch { /* fall back to cloning */ }
      }

      // Somewhere for the reprint to wrap, learned from the lines around it
      // rather than from a theory about paragraphs. Short edits are unaffected:
      // there is slack before the column edge, so a changed date or name stays
      // where it was and nothing moves.
      const startX = fontInfo?.rect.x ?? fitX ?? (band0 ? band0.x : r.x + 1)
      const edge = band0 && spans?.length ? neighbourRightEdge(spans, band0) : null
      // A column edge to wrap LONGER future edits at — but NEVER narrower than the
      // words we are putting back. A single display word like "MERIDIAN", whose
      // natural width just tops its neighbour edge, would otherwise wrap to two
      // lines the instant it is reprinted (measured h doubles, the identity drops
      // half a line low and reads light). Keep the wrap box only when the reprint
      // already fits inside it; otherwise auto-grow on one line and let a genuine
      // overflow from a longer edit be the user's to see.
      const wrapCol = edge && edge - startX > 40 ? Math.round(edge - startX) : undefined
      const wrapAt = wrapCol && wrapCol >= m0.w ? wrapCol : undefined
      const m = wrapAt
        ? measureText(printed || ' ', font, size, bold, wrapAt, tracking, false, usableFace)
        : m0
      // Right-aligned figures / centred headings: read the column so an edit later
      // keeps the aligned edge fixed instead of growing off the left anchor. Only
      // auto-grow (single-line) runs — a wrapping run gets a boxW whose LEFT edge
      // IS the text's left edge, so per-line justifying it would push the reprint
      // off its own origin. Explicit alignment on a boxW box stays available via
      // the toolbar, where the box is a container the user drew on purpose.
      const alignRect = fontInfo?.rect ?? band0
      const align = !wrapAt && alignRect && spans?.length ? detectAlign(spans, alignRect) : undefined

      // Cover the print on the page, and REMOVE it from the file. Only when the
      // patch was cut from the true background of that exact rect: then the ink
      // those operators draw is precisely the ink this patch is holding, so
      // dropping them on export changes nothing anyone can see. When the words
      // had to be inpainted instead (a scan, a poster) there are no operators to
      // drop — they were never text — and the patch is the whole answer.
      const removedSpans = trueBg && fontInfo ? await spansUnderRun(fontInfo.rect) : []

      // the active doc changed while the model was reading — drop the result rather
      // than tag it with this page's id in a doc that doesn't contain this page
      if (s().active !== startDoc) { s().setBusy(null); return }
      // patch + lifted text land as ONE undoable step so a single Undo reverts the retype
      st.addObjects([
        {
          id: uid(), page: page.id, kind: 'whiteout', opacity: 1, ...patchRect, ...paper,
          ...(removedSpans.length ? { removedSpans } : {}),
        },
        {
          id: textId, page: page.id, kind: 'text', opacity: 1,
          fromPrint: true, // see runReshape's hit branch
          // The PEN ORIGIN, not the left edge of the ink. A glyph starts drawing
          // one sidebearing to the right of where its pen is set down, so a box
          // aligned to the first stroke pushes the whole line right by that much.
          // pdf.js reports the run's advance box, whose left edge IS the origin.
          x: startX,
          // Put the baseline back where it was, and let the box follow from it.
          //
          // Centring the line inside the erased rectangle instead — which is what
          // this did — ties the reprint to the shape of the HOLE rather than to
          // the typography. The hole is sized from ink, so a line with descenders
          // gives a taller hole than one without, and the same sentence lands at
          // a different height depending on whether it happens to contain a 'g'.
          // Every line measured came out low: about 2.2pt in body copy, 9pt in a
          // 50pt name — a fifth of an em each time, which is the descent.
          y: baselineY - size * BASELINE_EM,
          w: m.w, h: m.h,
          // Somewhere to wrap, taken from the lines around this one. Short edits
          // are unaffected — there is slack before the column edge, so a changed
          // date or name stays exactly where it was. Only text that outgrows the
          // column wraps, and it wraps where the column already wraps.
          ...(wrapAt ? { boxW: wrapAt } : {}),
          ...(align ? { align } : {}),
          text: printed,
          color: inkCol ?? reading.color, size, font, bold,
          ...(usableFace ? { pdfFont: usableFace, pdfSpace: spaceEmFromRun(usableFace, printed, fontInfo?.rect.w ?? 0, size) ?? spaceEmOfFace(usableFace) ?? fontInfo?.spaceEm ?? 0.25 } : {}),
          ...(matchFace ? { matchFace, matchWeight } : {}),
          ...(fontInfo?.italic && !usableFace ? { italic: true } : {}),
          ...(tracking ? { tracking } : {}),
          ...(fontInfo?.stdFont ? { stdFont: fontInfo.stdFont } : {}),
        },
      ])
      // remember the original ink so we can clone letterforms on demand. Only a
      // SINGLE band can be cloned: the clone is one bitmap seated on one
      // baseline, so on a multi-line lift it would reproduce the first line and
      // silently drop the rest. Those keep the metric-matched vector text, which
      // is complete and still editable.
      // Glyph cloning exists to reproduce a typeface we don't have. When the
      // document handed us the real one there is nothing to reproduce — and the
      // real font beats a bitmap of it on every count: crisp at any zoom, right
      // for characters that were never on the page, and exported as live text
      // rather than a picture of text.
      if (band0 && bands.length === 1 && !usableFace && useClone) {
        // Remember the original ink so "Match exactly (clone letters)" can offer a
        // pixel-identical bitmap ON DEMAND — but do NOT auto-clone. The
        // metric-matched vector text we just built is crisp at any zoom, stays
        // editable, and exports as real text; the bitmap clone is a fixed-res
        // picture that softens on zoom/export and can't show new letters.
        registerCloneSource(textId, { page: page.id, band: band0, sourceText: printed, baselineY })
      }
      st.setTool('select')
      st.setEditingText(textId)
      // Say which of the two things just happened, because they carry very
      // different confidence and the user is about to trust one of them. With a
      // text layer the file supplied the words, the family, the weight and the
      // size, and "matched" is a statement of fact. Without one, every part of
      // that is inferred — the words from a model, the size from ink measured on
      // pixels — and calling it matched is how a 140pt reprint of 20pt type gets
      // announced as a success.
      st.toast(
        lines > 1
          // Only band0 is read, erased and reprinted; the rest are counted and
          // ignored. Announcing "the print" for a box covering twelve lines let
          // people believe all twelve had been dealt with.
          ? `Replaced the first line of the ${lines} your box covers — reshape works a line at a time.`
          : fontInfo
          ? 'Lifted the print as editable text — the look is matched'
          : 'Lifted it as editable text. These words are part of a picture, so the face and size are read from the pixels — check them before you export.',
        'ok',
      )
    } catch (err) {
      // model failed — change NOTHING; an erased page with no text to edit is worse than no-op
      st.toast(`Model failed (${err instanceof Error ? err.message : err}) — nothing was changed`, 'warn')
    } finally {
      st.setBusy(null)
    }
  }

  /* ----- match-the-print: copy size/color (and font, with AI) from any text ----- */

  const doMatchPick = async (e: React.PointerEvent) => {
    e.preventDefault() // don't steal focus — the editor must stay open
    e.stopPropagation()
    const editingId = s().editingText
    setMatchPick(false)
    if (!editingId) return
    const [x, y] = toPage(e)
    const spans = spanRectsRef.current ?? (spanRectsRef.current = await getPageSpanRects(page))
    const hit = spans?.find((sp) => x >= sp.x - 2 && x <= sp.x + sp.w + 2 && y >= sp.y - 2 && y <= sp.y + sp.h + 2)
    if (!hit) {
      s().toast('No printed text there — click directly on a line', 'warn')
      return
    }
    const size = Math.max(5, Math.round((hit.h / 1.15) * 10) / 10)
    let color = '#111111'
    try {
      color = sampleInkColor(await getSamplingCanvas(page), hit, pv.w)
    } catch { /* keep default */ }
    userStyled.add(editingId)
    s().commitNow()
    s().updateObject(editingId, { size, color })
    const cfg = s().aiConfig
    if (cfg) {
      // refine typeface & weight with the connected model, without blocking the editor
      void (async () => {
        try {
          const crop = await renderRegionToDataUrl(page, hit, 3)
          const reading = await readRegion(cfg, crop)
          s().updateObject(editingId, { font: reading.font, bold: reading.bold })
          s().toast(`Matched: ${Math.round(size)}pt ${reading.font}${reading.bold ? ' bold' : ''}`, 'ok')
        } catch { /* size+color already applied */ }
      })()
    } else {
      s().toast(`Matched: ${Math.round(size)}pt + ink color (connect AI to match the typeface too)`, 'ok')
    }
  }

  // The erase/retype pipeline, reachable without a mouse.
  //
  // The automated suite needs to exercise what a click DOES, not where the click
  // landed — those are separate things and conflating them makes the tests
  // fragile for no gain: a scroll offset drifts and a real regression hides
  // behind a synthetic miss.
  useEffect(() => {
    if (!page) return
    // Keyed by page: this component is mounted once PER PAGE, so a single
    // global would be overwritten by whichever page rendered last, and every
    // call would quietly do nothing on the page actually under test.
    const w = window as unknown as { __reshapedpdfRetype?: Record<string, unknown> }
    if (!w.__reshapedpdfRetype) w.__reshapedpdfRetype = {}
    w.__reshapedpdfRetype[page.id] = (x: number, y: number) => runRetypeClick(x, y)
    return () => { if (w.__reshapedpdfRetype) delete w.__reshapedpdfRetype[page.id] }
  })

  /* ----- creation tools on the capture overlay ----- */

  const captureDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const [x, y] = toPage(e)
    capturePointer(e)

    if (tool === 'ink') setDraft({ kind: 'ink', points: [[x, y]] })
    else if (tool === 'retype') { void runRetypeClick(x, y) }
    else if (tool === 'lift') { void runLiftClick(x, y) }
    else if (tool === 'retouch') setDraft({ kind: 'retouch', points: [[x, y]], color: prefs.retouchColor })
    else if (tool === 'whiteout' && prefs.eraseMode === 'brush') setDraft({ kind: 'erase', points: [[x, y]] })
    else if (tool === 'shape') setDraft({ kind: 'shape', x1: x, y1: y, x2: x, y2: y })
    else if (tool === 'text') setDraft({ kind: 'box', tool: 'text', x1: x, y1: y, x2: x, y2: y })
    else if (tool === 'whiteout' || tool === 'redact' || tool === 'reshape' || tool === 'clean' || tool === 'markup') {
      if (tool === 'markup' && !spanRectsRef.current) {
        void getPageSpanRects(page).then((rects) => (spanRectsRef.current = rects))
      }
      setDraft({ kind: 'box', tool, x1: x, y1: y, x2: x, y2: y })
    }
  }

  const captureMove = (e: React.PointerEvent) => {
    const d = draftRef.current
    if (!d) return
    const [x, y] = toPage(e)
    if (d.kind === 'erase' || d.kind === 'retouch') {
      const last = d.points[d.points.length - 1]
      if (Math.hypot(x - last[0], y - last[1]) > 1.2) setDraft({ ...d, points: [...d.points, [x, y]] })
      return
    }
    if (d.kind === 'ink') {
      const last = d.points[d.points.length - 1]
      if (Math.hypot(x - last[0], y - last[1]) > 1.2 / zoom) {
        setDraft({ ...d, points: [...d.points, [x, y]] })
      }
    } else if (d.kind === 'shape' || d.kind === 'box') {
      let x2 = x, y2 = y
      if (d.kind === 'shape' && e.shiftKey) {
        if (shapeMode === 'line' || shapeMode === 'arrow') {
          const ang = Math.atan2(y - d.y1, x - d.x1)
          const len = Math.hypot(x - d.x1, y - d.y1)
          const snap = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4)
          x2 = d.x1 + len * Math.cos(snap)
          y2 = d.y1 + len * Math.sin(snap)
        } else {
          const dd = Math.max(Math.abs(x - d.x1), Math.abs(y - d.y1))
          x2 = d.x1 + Math.sign(x - d.x1 || 1) * dd
          y2 = d.y1 + Math.sign(y - d.y1 || 1) * dd
        }
      }
      setDraft({ ...d, x2, y2 })
    }
  }

  const captureUp = async (e: React.PointerEvent) => {
    const [x, y] = toPage(e)
    const draft = draftRef.current

    if (draft?.kind === 'erase') {
      setDraft(null)
      const pts = draft.points
      if (pts.length >= 1) {
        s().setBusy('Erasing…')
        try {
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
          for (const [px, py] of pts) { minX = Math.min(minX, px); minY = Math.min(minY, py); maxX = Math.max(maxX, px); maxY = Math.max(maxY, py) }
          // Reach out as far as the fill SAMPLES (makeBrushPatch pads up to ~60px),
          // not just the brush radius — a prior patch that far away is still drawn
          // from, so it must be composited in or the fill mirrors the old ink.
          const rad = prefs.eraseBrush + 68
          const region = { x: minX - rad, y: minY - rad, w: maxX - minX + rad * 2, h: maxY - minY + rad * 2 }
          const patch = makeBrushPatch(await sampledWithPatches(region), [pts], prefs.eraseBrush, pv.w)
          if (patch) {
            s().addObject(
              // shaped: the brush's alpha is the erase, the rect is only its bounds
              { id: uid(), page: page.id, kind: 'whiteout', opacity: 1, ...patch.rect, color: patch.color, src: patch.src, shaped: true },
              { select: false },
            )
            // stay in the eraser — sweeping several spots in a row is the norm
          } else {
            s().toast('Could not read enough background around the stroke', 'warn')
          }
        } catch {
          s().toast('Erase failed on this page', 'error')
        } finally {
          s().setBusy(null)
        }
      }
      return
    }
    if (draft?.kind === 'retouch') {
      setDraft(null)
      const pts = draft.points
      // rasterize the freehand stroke into a filled PNG patch in the chosen colour
      const rad = prefs.retouchBrush
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const [px, py] of pts) { minX = Math.min(minX, px); minY = Math.min(minY, py); maxX = Math.max(maxX, px); maxY = Math.max(maxY, py) }
      const pad = rad + 2
      const rx = Math.max(0, minX - pad), ry = Math.max(0, minY - pad)
      const rw = Math.max(2, maxX - minX + pad * 2), rh = Math.max(2, maxY - minY + pad * 2)
      const scale = 3
      const cv = document.createElement('canvas')
      cv.width = Math.ceil(rw * scale); cv.height = Math.ceil(rh * scale)
      const cx = cv.getContext('2d')!
      cx.scale(scale, scale)
      cx.strokeStyle = draft.color; cx.fillStyle = draft.color
      cx.lineCap = 'round'; cx.lineJoin = 'round'; cx.lineWidth = rad * 2
      cx.beginPath()
      pts.forEach(([px, py], i) => { const lx = px - rx, ly = py - ry; if (i === 0) cx.moveTo(lx, ly); else cx.lineTo(lx, ly) })
      if (pts.length === 1) { cx.arc(pts[0][0] - rx, pts[0][1] - ry, rad, 0, Math.PI * 2); cx.fill() } else cx.stroke()
      s().addObject({
        id: uid(), page: page.id, kind: 'whiteout', opacity: 1,
        x: rx, y: ry, w: rw, h: rh, color: draft.color, src: cv.toDataURL('image/png'),
        shaped: true, // a stroke, not a filled rectangle — see WhiteoutObj.shaped
        painted: true, // in the colour the user picked, not sampled from the page
      }, { select: false })
      return
    }
    if (draft?.kind === 'ink') {
      // A single tap (one point) used to draw nothing at all — no mark, no
      // feedback. Duplicate the point into a zero-length segment: with round line
      // caps that renders (and exports) as a dot the size of the pen, which is
      // what a tap should leave.
      const points = draft.points.length > 1
        ? draft.points
        : draft.points.length === 1 ? [draft.points[0], draft.points[0]] : []
      if (points.length) {
        s().addObject({
          id: uid(), page: page.id, kind: 'ink', opacity: 1,
          points, color: prefs.inkColor, width: prefs.inkWidth,
        })
        // hand the stroke back selected & movable — press P again for another stroke
        s().setTool('select')
      }
      setDraft(null)
      return
    }
    if (draft?.kind === 'shape') {
      const r = normRect(draft.x1, draft.y1, draft.x2, draft.y2)
      const isLine = shapeMode === 'line' || shapeMode === 'arrow'
      if ((isLine && Math.hypot(draft.x2 - draft.x1, draft.y2 - draft.y1) > 4) || (!isLine && r.w > 4 && r.h > 4)) {
        // lines always stroke; boxes need at least one of stroke/fill to exist
        const strokeOn = isLine || prefs.shapeStrokeOn || !prefs.shapeFillOn
        s().addObject({
          id: uid(), page: page.id, kind: 'shape', opacity: 1, mode: shapeMode,
          x: isLine ? draft.x1 : r.x, y: isLine ? draft.y1 : r.y,
          w: isLine ? draft.x2 - draft.x1 : r.w, h: isLine ? draft.y2 - draft.y1 : r.h,
          stroke: strokeOn ? prefs.shapeStroke : null,
          strokeWidth: prefs.shapeWidth,
          fill: !isLine && prefs.shapeFillOn ? prefs.shapeFill : null,
        })
        s().setTool('select')
      }
      setDraft(null)
      return
    }
    if (draft?.kind === 'box' && draft.tool === 'markup') {
      const r = normRect(draft.x1, draft.y1, draft.x2, draft.y2)
      setDraft(null)
      if (r.w > 4 && r.h > 3) {
        // The prefetch kicked off on pointerdown may not have landed before a
        // quick first drag ends — await it here so the very first highlight snaps
        // to the text lines instead of painting the whole dragged block.
        const startDoc = s().active
        const spans = spanRectsRef.current ?? (spanRectsRef.current = await getPageSpanRects(page).catch(() => []))
        // the span fetch can outlive a tab switch, and addObject writes to whatever
        // doc is active when it returns — don't paint a highlight into the new one
        if (s().active !== startDoc) return
        const bands = snapRectToLines(r, spans)
        s().addObject({
          id: uid(), page: page.id, kind: 'markup', opacity: 1,
          mode: s().markupMode, color: prefs.markupColor,
          rects: bands.length ? bands : [{ ...r, h: Math.max(r.h, 10) }],
        }, { select: false })
        // stays in markup — highlighting several passages in a row is the norm
      }
      return
    }
    if (draft?.kind === 'box' && draft.tool === 'reshape') {
      const r = normRect(draft.x1, draft.y1, draft.x2, draft.y2)
      setDraft(null)
      if (r.w > 6 && r.h > 6) await runReshape(r)
      return
    }
    if (draft?.kind === 'box' && draft.tool === 'clean') {
      const raw = normRect(draft.x1, draft.y1, draft.x2, draft.y2)
      setDraft(null)
      const rx = Math.max(0, raw.x), ry = Math.max(0, raw.y)
      const r = { x: rx, y: ry, w: Math.min(pv.w, raw.x + raw.w) - rx, h: Math.min(pv.h, raw.y + raw.h) - ry }
      if (r.w > 6 && r.h > 6) {
        try {
          const res = await cleanRegion(page, r)
          if (res.mode === 'elements') {
            s().toast(`Cleaned — ${res.removed} element${res.removed === 1 ? '' : 's'} taken off the page, the background underneath is the document's own`, 'ok')
          } else if (res.mode === 'aborted') {
            s().toast('The document changed while cleaning — nothing was applied', 'warn')
          } else {
            // A real raster fallback. Note what it does NOT say any more: that
            // the page is a picture. The walker finding nothing fully inside the
            // box is not evidence about the document — a box that merely clips a
            // logo qualifies — and asserting it on a wholly vector page was
            // simply wrong.
            s().toast('Cleaned — nothing here could be taken off the page, so the background was rebuilt from the pixels around it', 'ok')
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (/connect a vision model/i.test(msg)) {
            s().openModal({ type: 'ai' })
            s().toast('Connect a model and the clean tool can work out what you circled. Nothing was removed.', 'info')
          } else {
            s().toast(`Clean failed: ${msg}`, 'warn')
          }
        }
      }
      return
    }
    if (draft?.kind === 'box' && (draft.tool === 'whiteout' || draft.tool === 'redact')) {
      // Clamp to the page: a drag that starts past the top/left edge gives a
      // negative origin, and makeBlendedPatch reads the sample from x/y>=0 but
      // leaves the patch anchored at the negative origin, so the textured fill
      // lands shifted by the off-page amount. There is nothing to erase off-page
      // anyway. (redact clamps too — a mark must not claim to cover off-page area.)
      const raw = normRect(draft.x1, draft.y1, draft.x2, draft.y2)
      const rx = Math.max(0, raw.x), ry = Math.max(0, raw.y)
      const r = { x: rx, y: ry, w: Math.min(pv.w, raw.x + raw.w) - rx, h: Math.min(pv.h, raw.y + raw.h) - ry }
      if (r.w > 3 && r.h > 3) {
        if (draft.tool === 'whiteout') {
          let patch: { color: string; src?: string; w?: number; h?: number } = { color: '#FFFFFF' }
          if (prefs.autoSampleWhiteout) {
            // Sampling is a cold ~1.5x page render — hundreds of milliseconds, with
            // no busy veil — and addObject writes to whatever document is active
            // when it RETURNS. Switching tabs mid-sample used to drop an invisible
            // orphan (carrying a page id from the other file) into the new document
            // and mark it Edited, so it then falsely prompted on close. Same guard
            // as realiseLift / runReshape / peel.
            const startDoc = s().active
            try {
              patch = makeBlendedPatch(await sampledWithPatches({ x: r.x - 68, y: r.y - 68, w: r.w + 136, h: r.h + 136 }), r, pv.w)
            } catch {
              /* sampling render failed; plain white still works */
            }
            if (s().active !== startDoc) { setDraft(null); return }
          }
          // The rubber is an ERASE, so the words it covers have to leave the file
          // as well as the page — otherwise "erased" means "still there, painted
          // over", and a copy-paste hands them straight back. Only whole runs the
          // box really contains (see textSpansUnder); a run it merely clips keeps
          // its operators, because the export decides what to drop per glyph from
          // the patch itself and can do that far more finely than this can.
          //
          // Walking the page is async, so the same guard every other tool uses
          // applies: if the user switched documents while it ran, this erase
          // belongs to a page the active document may not even contain.
          const docAtErase = s().active
          const erased = await spansUnderRun(r)
          if (s().active !== docAtErase) { setDraft(null); return }
          s().addObject({
            id: uid(), page: page.id, kind: 'whiteout', opacity: 1, ...r, ...patch,
            ...(erased.length ? { removedSpans: erased } : {}),
          })
        } else {
          s().addObject({ id: uid(), page: page.id, kind: 'redact', opacity: 1, ...r })
        }
        s().setTool('select')
      }
      setDraft(null)
      return
    }

    /* click-to-place tools */
    if (draft?.kind === 'box' && draft.tool === 'text') {
      setDraft(null)
      const r = normRect(draft.x1, draft.y1, draft.x2, draft.y2)
      const size = prefs.textSize
      const m = measureText(' ', prefs.font, size, prefs.bold)
      const id = uid()
      const dragged = r.w > 24 // a real drag makes a fixed-width wrapping box; a click auto-grows
      s().addObject({
        id, page: page.id, kind: 'text', opacity: 1,
        x: dragged ? r.x : x,
        y: dragged ? r.y : Math.max(0, y - size * 0.7),
        w: dragged ? r.w : 60, h: m.h,
        text: '', color: prefs.textColor, size, font: prefs.font, bold: prefs.bold,
        ...(dragged ? { boxW: r.w } : {}),
      })
      freshTextIds.add(id)
      // hand off to Select so the capture overlay can never sit over the editor/toolbar
      s().setTool('select')
      s().setEditingText(id)
      if (prefs.autoMatchText) void applyPrintMatch(id)
      return
    }
    if (tool === 'note') {
      const id = uid()
      s().addObject({
        id, page: page.id, kind: 'note', opacity: 1,
        x: Math.max(0, x - NOTE_SIZE / 2), y: Math.max(0, y - NOTE_SIZE / 2),
        text: '', color: prefs.noteColor,
      })
      s().setTool('select') // one pin per click — no accidental pin trails
      setNoteEdit(id)
      return
    }
    if (tool === 'image') {
      const files = await pickFiles()
      const img = files.find((f) => f.bytes[0] === 0x89 || f.bytes[0] === 0xff)
      if (img) {
        const mime = img.bytes[0] === 0x89 ? 'image/png' : 'image/jpeg'
        await placeImageOnPage(bytesToDataUrl(img.bytes, mime), { page: page.id, x, y })
      } else if (files.length) {
        // a file was chosen but it wasn't PNG/JPEG (GIF, WebP, HEIC…): say so
        // instead of silently doing nothing
        s().toast('Only PNG and JPEG images can be placed', 'warn')
      }
      return
    }
    if (tool === 'signature') {
      s().openModal({ type: 'signature', placeAt: { page: page.id, x, y } })
      return
    }
  }

  /* ----- rendering ----- */

  // never let the drawing overlay cover an open text editor + its toolbar
  const captureActive =
    !editingText && ['markup', 'ink', 'shape', 'text', 'note', 'image', 'signature', 'retype', 'reshape', 'clean', 'whiteout', 'retouch', 'redact', 'lift'].includes(tool)

  const renderHandles = (obj: AnyObj): JSX.Element | null => {
    // notes are fixed-size; markup is anchored to text lines — neither resizes
    if (obj.kind === 'note' || obj.kind === 'markup') return null
    const knob = 4.5 / zoom // half-size of a handle, screen-constant
    if (obj.kind === 'shape' && (obj.mode === 'line' || obj.mode === 'arrow')) {
      const pts: [1 | 2, number, number][] = [
        [1, obj.x, obj.y],
        [2, obj.x + obj.w, obj.y + obj.h],
      ]
      return (
        <>
          {pts.map(([which, cx, cy]) => (
            <g key={which} className="reg-handle" transform={`translate(${cx}, ${cy})`}
              onPointerDown={(e) => startEndpoint(e, obj, which)}
              onPointerMove={onGestureMove} onPointerUp={endGesture}>
              <circle r={knob * 2.6} fill="transparent" stroke="none" />
              <circle className="knob" r={knob} strokeWidth={1.25 / zoom} />
            </g>
          ))}
        </>
      )
    }
    const b = objBounds(obj)
    const corners: [Corner, number, number, string][] = [
      ['nw', b.x, b.y, 'nwse-resize'],
      ['ne', b.x + b.w, b.y, 'nesw-resize'],
      ['sw', b.x, b.y + b.h, 'nesw-resize'],
      ['se', b.x + b.w, b.y + b.h, 'nwse-resize'],
    ]
    return (
      <>
        {corners.map(([corner, cx, cy, cursor]) => (
          <g key={corner} className="reg-handle" transform={`translate(${cx}, ${cy})`} style={{ cursor }}
            onPointerDown={(e) => startResize(e, obj, corner)}
            onPointerMove={onGestureMove} onPointerUp={endGesture}>
            <circle r={knob * 2.6} fill="transparent" stroke="none" />
            <rect
              className="knob"
              x={-knob} y={-knob} width={knob * 2} height={knob * 2}
              rx={1.8 / zoom}
              strokeWidth={1.25 / zoom}
            />
          </g>
        ))}
      </>
    )
  }

  const openCtxMenu = (e: React.MouseEvent, obj: AnyObj) => {
    if (tool !== 'select') return
    e.preventDefault()
    e.stopPropagation()
    if (!doc.selection.includes(obj.id)) s().setSelection([obj.id])
    setCtxMenu({ x: e.clientX, y: e.clientY, id: obj.id })
  }

  const svgObj = (obj: AnyObj): JSX.Element | null => {
    const interactive = tool === 'select'
    const common = {
      className: 'obj-hit',
      style: { pointerEvents: interactive ? ('auto' as const) : ('none' as const), cursor: 'move' },
      onPointerDown: (e: React.PointerEvent) => startMove(e, obj),
      onPointerMove: onGestureMove,
      onPointerUp: endGesture,
      onPointerEnter: () => interactive && setHoverId(obj.id),
      onPointerLeave: () => setHoverId((h) => (h === obj.id ? null : h)),
      onContextMenu: (e: React.MouseEvent) => openCtxMenu(e, obj),
      opacity: obj.opacity,
    }
    switch (obj.kind) {
      case 'markup': {
        // thin underlines/strikes are impossible to grab — give the whole extent a hit rect
        const b = objBounds(obj)
        return (
          <g key={obj.id} {...common}>
            <rect x={b.x} y={b.y} width={b.w} height={Math.max(b.h, 10)} fill="transparent" />
            {obj.rects.map((r, i) =>
              obj.mode === 'highlight' ? (
                <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill={obj.color} opacity={0.42} style={{ mixBlendMode: 'multiply' }} />
              ) : obj.mode === 'underline' ? (
                <rect key={i} x={r.x} y={r.y + r.h - 1.1} width={r.w} height={1.7} fill={obj.color} />
              ) : (
                <rect key={i} x={r.x} y={r.y + r.h * 0.58 - 0.85} width={r.w} height={1.7} fill={obj.color} />
              ),
            )}
          </g>
        )
      }
      case 'ink':
        return (
          <g key={obj.id} {...common}>
            <path d={inkPath(obj.points)} fill="none" stroke={obj.color} strokeWidth={obj.width}
              strokeLinecap="round" strokeLinejoin="round" />
            {/* generous invisible grab area along the stroke */}
            <path d={inkPath(obj.points)} fill="none" stroke="transparent"
              strokeWidth={Math.max(14, obj.width + 10)} strokeLinecap="round" strokeLinejoin="round" />
          </g>
        )
      case 'vector': {
        // Drawn through a transform rather than by rewriting the path: the
        // geometry is authored once, in its own space, and the box decides where
        // and how big. That is what keeps it crisp at any zoom and lets the
        // fill and stroke stay editable afterwards.
        const sx = obj.srcW > 0.01 ? obj.w / obj.srcW : 1
        const sy = obj.srcH > 0.01 ? obj.h / obj.srcH : 1
        return (
          <g key={obj.id} {...common}>
            <g transform={`translate(${obj.x} ${obj.y}) scale(${sx} ${sy})`}>
              <path d={obj.d}
                fill={obj.fill ?? 'none'}
                fillRule={obj.evenOdd ? 'evenodd' : 'nonzero'}
                stroke={obj.stroke ?? 'none'}
                strokeWidth={obj.stroke ? obj.strokeWidth : 0}
                vectorEffect="non-scaling-stroke" />
              {!obj.fill && (
                <path d={obj.d} fill="none" stroke="transparent"
                  strokeWidth={Math.max(14, obj.strokeWidth + 10)} vectorEffect="non-scaling-stroke" />
              )}
            </g>
          </g>
        )
      }
      case 'shape': {
        if (obj.mode === 'rect') {
          return (
            <g key={obj.id} {...common}>
              <rect x={obj.x} y={obj.y} width={obj.w} height={obj.h}
                fill={obj.fill ?? 'none'} stroke={obj.stroke ?? 'none'} strokeWidth={obj.stroke ? obj.strokeWidth : 0} />
              {!obj.fill && (
                <rect x={obj.x} y={obj.y} width={obj.w} height={obj.h}
                  fill="transparent" stroke="transparent" strokeWidth={Math.max(14, obj.strokeWidth + 10)} />
              )}
            </g>
          )
        }
        if (obj.mode === 'ellipse') {
          return (
            <g key={obj.id} {...common}>
              <ellipse cx={obj.x + obj.w / 2} cy={obj.y + obj.h / 2} rx={obj.w / 2} ry={obj.h / 2}
                fill={obj.fill ?? 'none'} stroke={obj.stroke ?? 'none'} strokeWidth={obj.stroke ? obj.strokeWidth : 0} />
              {!obj.fill && (
                <ellipse cx={obj.x + obj.w / 2} cy={obj.y + obj.h / 2} rx={obj.w / 2} ry={obj.h / 2}
                  fill="transparent" stroke="transparent" strokeWidth={Math.max(14, obj.strokeWidth + 10)} />
              )}
            </g>
          )
        }
        const x2 = obj.x + obj.w
        const y2 = obj.y + obj.h
        const lineStroke = obj.stroke ?? '#17171B'
        return (
          <g key={obj.id} {...common} stroke={lineStroke} strokeWidth={obj.strokeWidth} strokeLinecap="round">
            <line x1={obj.x} y1={obj.y} x2={x2} y2={y2} />
            {/* generous invisible hit area */}
            <line x1={obj.x} y1={obj.y} x2={x2} y2={y2} stroke="transparent" strokeWidth={Math.max(14, obj.strokeWidth + 10)} />
            {obj.mode === 'arrow' &&
              arrowHead(obj.x, obj.y, x2, y2, obj.strokeWidth).map(([hx, hy], i) => (
                <line key={i} x1={x2} y1={y2} x2={hx} y2={hy} />
              ))}
          </g>
        )
      }
      case 'whiteout': {
        if (!obj.src) return <rect key={obj.id} {...common} x={obj.x} y={obj.y} width={obj.w} height={obj.h} fill={obj.color} />
        // A textured patch turns with its page: draw it at natural (un-swapped)
        // size, centred, and SVG-rotate around the centre so it fills the box.
        const rot = obj.rot ?? 0
        const nw = rot % 180 === 0 ? obj.w : obj.h
        const nh = rot % 180 === 0 ? obj.h : obj.w
        const cx = obj.x + obj.w / 2, cy = obj.y + obj.h / 2
        return (
          <image key={obj.id} {...common} href={obj.src}
            x={cx - nw / 2} y={cy - nh / 2} width={nw} height={nh} preserveAspectRatio="none"
            transform={rot ? `rotate(${rot} ${cx} ${cy})` : undefined} />
        )
      }
      case 'redact':
        return (
          <g key={obj.id} {...common}>
            <rect x={obj.x} y={obj.y} width={obj.w} height={obj.h} fill="#0c0c10" />
            <rect x={obj.x} y={obj.y} width={obj.w} height={obj.h} fill={`url(#hatch-${page.id})`} />
          </g>
        )
      default:
        return null
    }
  }

  const selectedObjs = selection.map((id) => doc.objects[id]).filter(Boolean) as AnyObj[]
  const hoverObj = hoverId && !selection.includes(hoverId) ? doc.objects[hoverId] : null

  return (
    <>
      <svg
        ref={svgRef}
        className="objects-svg"
        viewBox={`0 0 ${pv.w} ${pv.h}`}
        preserveAspectRatio="none"
        style={{ pointerEvents: 'none' }}
      >
        <defs>
          <pattern id={`hatch-${page.id}`} width="7" height="7" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
            <line x1="0" y1="0" x2="0" y2="7" stroke="rgba(255,255,255,0.13)" strokeWidth="1.4" />
          </pattern>
        </defs>

        {objs.map(svgObj)}

        {/* drafts */}
        {draft?.kind === 'ink' && (
          <path d={inkPath(draft.points)} fill="none" stroke={prefs.inkColor} strokeWidth={prefs.inkWidth} strokeLinecap="round" strokeLinejoin="round" />
        )}
        {draft?.kind === 'shape' && (() => {
          const r = normRect(draft.x1, draft.y1, draft.x2, draft.y2)
          const dStroke = prefs.shapeStrokeOn || !prefs.shapeFillOn ? prefs.shapeStroke : 'none'
          const dFill = prefs.shapeFillOn ? prefs.shapeFill : 'none'
          if (shapeMode === 'rect') return <rect x={r.x} y={r.y} width={r.w} height={r.h} fill={dFill} stroke={dStroke} strokeWidth={prefs.shapeWidth} />
          if (shapeMode === 'ellipse') return <ellipse cx={r.x + r.w / 2} cy={r.y + r.h / 2} rx={r.w / 2} ry={r.h / 2} fill={dFill} stroke={dStroke} strokeWidth={prefs.shapeWidth} />
          return (
            <g stroke={prefs.shapeStroke} strokeWidth={prefs.shapeWidth} strokeLinecap="round">
              <line x1={draft.x1} y1={draft.y1} x2={draft.x2} y2={draft.y2} />
              {shapeMode === 'arrow' && arrowHead(draft.x1, draft.y1, draft.x2, draft.y2, prefs.shapeWidth).map(([hx, hy], i) => (
                <line key={i} x1={draft.x2} y1={draft.y2} x2={hx} y2={hy} />
              ))}
            </g>
          )
        })()}
        {draft?.kind === 'erase' && (
          <polyline
            points={draft.points.map((p) => p.join(',')).join(' ')}
            fill="none"
            stroke="rgba(255, 92, 31, 0.4)"
            strokeWidth={prefs.eraseBrush * 2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {draft?.kind === 'retouch' && (
          <polyline
            points={draft.points.map((p) => p.join(',')).join(' ')}
            fill="none"
            stroke={draft.color}
            strokeWidth={prefs.retouchBrush * 2}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.9}
          />
        )}
        {draft?.kind === 'box' && draft.tool === 'markup' && (() => {
          const r = normRect(draft.x1, draft.y1, draft.x2, draft.y2)
          const bands = snapRectToLines(r, spanRectsRef.current ?? [])
          return (
            <g>
              <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="none" stroke="rgba(255,92,31,0.55)" strokeWidth={1 / zoom} rx={2 / zoom} />
              {(bands.length ? bands : [r]).map((b, i) => (
                <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} fill={prefs.markupColor} opacity={0.4} style={{ mixBlendMode: 'multiply' }} />
              ))}
            </g>
          )
        })()}
        {draft?.kind === 'box' && draft.tool !== 'markup' && (() => {
          const r = normRect(draft.x1, draft.y1, draft.x2, draft.y2)
          if (draft.tool === 'text') {
            // neutral text-box preview: this becomes a fixed-width wrapping box
            return <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={3 / zoom} fill="rgba(255,255,255,0.35)" stroke="rgba(22,22,26,0.5)" strokeWidth={1 / zoom} strokeDasharray={`${5 / zoom} ${4 / zoom}`} />
          }
          const fill =
            draft.tool === 'clean' ? 'rgba(255,92,31,0.10)'
            : draft.tool === 'whiteout' ? 'rgba(255,255,255,0.85)'
            : draft.tool === 'redact' ? 'rgba(12,12,16,0.75)'
            : 'rgba(255,92,31,0.12)'
          return <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={2 / zoom} fill={fill} stroke="var(--ember)" strokeWidth={1.25 / zoom} />
        })()}
        {tool === 'lift' && myLift && (
          <g pointerEvents="none">
            <rect
              x={myLift.rect.x} y={myLift.rect.y}
              width={myLift.rect.w} height={myLift.rect.h}
              rx={2 / zoom} fill="rgba(255,92,31,0.10)" stroke="var(--ember)"
              strokeWidth={1.25 / zoom} strokeDasharray={`${5 / zoom} ${4 / zoom}`}
            />
            <text
              x={myLift.rect.x} y={myLift.rect.y - 4 / zoom}
              fill="var(--ember)" fontSize={11 / zoom} style={{ userSelect: 'none' }}
            >
              {myLift.label} — Enter to lift
            </text>
          </g>
        )}

        {/* hover + selection chrome */}
        {hoverObj && !isLineLike(hoverObj) && (() => {
          const b = objBounds(hoverObj)
          const p = 3 / zoom
          return <rect className="hover-outline" x={b.x - p} y={b.y - p} width={b.w + p * 2} height={b.h + p * 2} rx={3 / zoom} />
        })()}
        {selectedObjs.map((o) => {
          if (editingText === o.id) return null // the inline editor is the chrome
          const b = objBounds(o)
          const p = 3 / zoom
          return (
            <g key={`sel-${o.id}`}>
              {/* lines & arrows get endpoint knobs only — a bounding box is just noise */}
              {!isLineLike(o) && (
                <rect className="sel-outline" x={b.x - p} y={b.y - p} width={b.w + p * 2} height={b.h + p * 2} rx={3 / zoom} />
              )}
              {selection.length === 1 && renderHandles(o)}
            </g>
          )
        })}
      </svg>

      {/* HTML objects: text, notes, images */}
      <div className="html-layer" style={{ width: pv.w, height: pv.h, transform: `scale(${zoom})` }}>
        {objs.map((obj) => {
          if (obj.kind === 'text') {
            if (editingText === obj.id) return null
            const handlers = {
              onPointerDown: (e: React.PointerEvent) => startMove(e, obj),
              onPointerMove: onGestureMove,
              onPointerUp: endGesture,
              onPointerEnter: () => tool === 'select' && setHoverId(obj.id),
              onPointerLeave: () => setHoverId((h) => (h === obj.id ? null : h)),
              onContextMenu: (e: React.MouseEvent) => openCtxMenu(e, obj),
              onDoubleClick: () => {
                s().setSelection([obj.id])
                s().setEditingText(obj.id)
              },
            }
            const trot = obj.rot ?? 0
            if (obj.glyphSrc) {
              // pixel-identical rendering composed from the page's own glyphs —
              // drawn at its own glyph size, centred on the box and turned when the
              // page was rotated (the box swapped but the bitmap keeps its size)
              const gw = obj.glyphW ?? obj.w, gh = obj.glyphH ?? obj.h
              const pos = trot
                ? { left: obj.x + obj.w / 2 - gw / 2, top: obj.y + obj.h / 2 - gh / 2, transform: `rotate(${trot}deg)` }
                : { left: obj.x, top: obj.y }
              return (
                <img
                  key={obj.id}
                  className="obj-text obj-glyph"
                  src={obj.glyphSrc}
                  draggable={false}
                  alt={obj.text}
                  style={{
                    position: 'absolute', ...pos, width: gw, height: gh,
                    opacity: obj.opacity, cursor: tool === 'select' ? 'move' : undefined,
                    pointerEvents: tool === 'select' ? 'auto' : 'none',
                  }}
                  {...handlers}
                />
              )
            }
            // Turned text (rotated page): lay it out at its natural width and CSS-
            // rotate the whole block, centred on the box. Upright text is untouched.
            const rs = trot ? contentRotStyle(obj) : null
            return (
              <div
                key={obj.id}
                className="obj-text"
                style={{
                  left: rs ? rs.left : obj.x, top: rs ? rs.top : obj.y, fontSize: obj.size, color: obj.color,
                  fontFamily: obj.pdfFont || obj.matchFace ? faceStack(obj.font, obj.pdfFont, obj.matchFace) : (obj.stdFont && stdFontStack(obj.stdFont)) ?? FONT_STACKS[obj.font], fontWeight: obj.matchWeight ?? (obj.pdfFont ? 400 : obj.bold ? 700 : 400),
                  fontStyle: obj.italic ? 'italic' : undefined,
                  letterSpacing: obj.tracking ? `${obj.tracking}px` : undefined,
                  width: rs ? rs.width : obj.boxW,
                  ...(rs ? { transform: rs.transform } : {}),
                  // Only a real wrap box (boxW) wraps. A rotated AUTO-grow run is
                  // pinned to its natural width for centring, but must NOT break —
                  // with letter-spacing the DOM lays it out a hair wider than the
                  // pin, and break-word would then wrap the last glyph to a second
                  // line. `pre` lets that hair overflow invisibly instead.
                  whiteSpace: obj.boxW ? 'pre-wrap' : 'pre',
                  wordBreak: obj.boxW ? 'break-word' : undefined,
                  textAlign: obj.align ?? undefined,
                  opacity: obj.opacity, cursor: tool === 'select' ? 'move' : undefined,
                  pointerEvents: tool === 'select' ? 'auto' : 'none',
                }}
                {...handlers}
              >
                {obj.text || ' '}
              </div>
            )
          }
          if (obj.kind === 'note') {
            return (
              <div
                key={obj.id}
                className="obj-note"
                style={{
                  left: obj.x, top: obj.y, background: obj.color, opacity: obj.opacity,
                  cursor: tool === 'select' ? 'pointer' : undefined,
                  pointerEvents: tool === 'select' ? 'auto' : 'none',
                }}
                onContextMenu={(e) => openCtxMenu(e, obj)}
                title={obj.text}
                onPointerDown={(e) => startMove(e, obj)}
                onPointerMove={onGestureMove}
                onPointerUp={() => {
                  // a click (no drag) opens the note — dragging just moves it
                  const g = gesture.current
                  endGesture()
                  if (g?.mode === 'move' && !g.committed) setNoteEdit(obj.id)
                }}
              >
                <StickyNote size={15} />
              </div>
            )
          }
          if (obj.kind === 'image') {
            return (
              <div
                key={obj.id}
                className="obj-image"
                style={{
                  ...contentRotStyle(obj), opacity: obj.opacity,
                  cursor: tool === 'select' ? 'move' : undefined,
                  pointerEvents: tool === 'select' ? 'auto' : 'none',
                }}
                onPointerDown={(e) => startMove(e, obj)}
                onPointerMove={onGestureMove}
                onPointerUp={endGesture}
                onContextMenu={(e) => openCtxMenu(e, obj)}
                onPointerEnter={() => tool === 'select' && setHoverId(obj.id)}
                onPointerLeave={() => setHoverId((h) => (h === obj.id ? null : h))}
              >
                <img src={obj.src} draggable={false} alt="" />
              </div>
            )
          }
          return null
        })}

        {editingText && doc.objects[editingText]?.page === page.id && (
          <>
            <TextEditToolbar
              obj={doc.objects[editingText] as TextObj}
              zoom={zoom}
              matching={matchPick}
              onMatch={() => {
                setMatchPick((m) => !m)
                if (!matchPick) {
                  void getPageSpanRects(page).then((r) => (spanRectsRef.current = r))
                  s().toast('Click any printed text to copy its style', 'info')
                }
              }}
            />
            <TextEditor key={editingText} obj={doc.objects[editingText] as TextObj} zoom={zoom} />
          </>
        )}
        {noteEdit && doc.objects[noteEdit]?.page === page.id && (
          <NoteEditor obj={doc.objects[noteEdit] as NoteObj} zoom={zoom} onClose={() => setNoteEdit(null)} />
        )}
      </div>

      {/* match-the-print picker sits above everything while active */}
      {matchPick && (
        <div
          className="overlay-capture"
          style={{ cursor: 'crosshair', zIndex: 40, touchAction: 'none' }}
          onPointerDown={(e) => void doMatchPick(e)}
        />
      )}

      {/* creation capture overlay */}
      {captureActive && (
        <div
          className="overlay-capture"
          style={{ cursor: tool === 'text' || tool === 'retype' ? 'text' : 'crosshair', touchAction: 'none' }}
          onPointerDown={captureDown}
          onPointerMove={captureMove}
          onPointerUp={(e) => void captureUp(e)}
        />
      )}

      {/* right-click menu on objects */}
      {ctxMenu && doc.objects[ctxMenu.id] && (() => {
        const obj = doc.objects[ctxMenu.id]
        const run = (fn: () => void) => () => {
          setCtxMenu(null)
          fn()
        }
        return (
          <div
            className="ctx-menu"
            style={{ left: Math.min(ctxMenu.x, window.innerWidth - 200), top: Math.min(ctxMenu.y, window.innerHeight - 230) }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {obj.kind === 'text' && (
              <button onClick={run(() => s().setEditingText(obj.id))}><Pencil size={14} /> Edit text</button>
            )}
            {obj.kind === 'text' && obj.glyphSrc && (
              <button onClick={run(() => uncloneTextLook(obj.id))}><Type size={14} /> Switch to matched font</button>
            )}
            {obj.kind === 'text' && !obj.glyphSrc && hasCloneSource(obj.id) && (
              <button onClick={run(() => void cloneTextLook(obj.id))}><Wand2 size={14} /> Match exactly (clone letters)</button>
            )}
            {obj.kind === 'note' && (
              <button onClick={run(() => setNoteEdit(obj.id))}><Pencil size={14} /> Open note</button>
            )}
            {(obj.kind === 'text' || obj.kind === 'whiteout') && (
              <button onClick={run(() => void blendObjects([obj.id]))}>
                <Wand2 size={14} /> Blend into print
              </button>
            )}
            <button onClick={run(() => s().bringToFront([obj.id]))}><ArrowUpToLine size={14} /> Bring to front</button>
            <button onClick={run(() => s().sendToBack([obj.id]))}><ArrowDownToLine size={14} /> Send to back</button>
            <button onClick={run(() => s().duplicateSelection())}><Copy size={14} /> Duplicate <span className="kbd" style={{ marginLeft: 'auto' }}>⌘D</span></button>
            <div className="sep" />
            <button style={{ color: 'var(--danger)' }} onClick={run(() => s().removeObjects([obj.id]))}>
              <Trash2 size={14} /> Delete <span className="kbd" style={{ marginLeft: 'auto' }}>⌫</span>
            </button>
          </div>
        )
      })()}
    </>
  )
})
