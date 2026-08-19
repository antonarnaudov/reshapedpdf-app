import { useEffect, useState } from 'react'
import { Copy, Highlighter, Strikethrough, Underline } from 'lucide-react'
import { useStore, activeDoc } from '../core/store'
import { uid } from '../core/types'
import type { MarkupMode, Rect } from '../core/types'

interface Pending {
  pageId: string
  rects: Rect[]
  clientX: number
  clientY: number
  text: string
}

/** Merge per-span client rects into per-line bands so markup looks continuous. */
function mergeLineRects(rects: Rect[]): Rect[] {
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x)
  const out: Rect[] = []
  for (const r of sorted) {
    if (r.w < 0.5 || r.h < 0.5) continue
    const last = out[out.length - 1]
    if (last && Math.abs(last.y - r.y) < last.h * 0.55 && r.x <= last.x + last.w + 14) {
      const x2 = Math.max(last.x + last.w, r.x + r.w)
      last.w = x2 - last.x
      last.h = Math.max(last.h, r.h)
    } else {
      out.push({ ...r })
    }
  }
  return out
}

function grabSelection(): Pending | null {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  // anchor on where the selection STARTED — drags routinely end outside the text layer
  const anchor = sel.anchorNode
  const el = anchor instanceof Element ? anchor : anchor?.parentElement
  const shell = el?.closest<HTMLElement>('.page-shell')
  if (!shell || !el?.closest('.textLayer')) return null

  const zoom = useStore.getState().zoom
  const shellRect = shell.getBoundingClientRect()
  const rects: Rect[] = []
  for (const cr of Array.from(range.getClientRects())) {
    if (cr.width < 1 || cr.height < 1) continue
    // clamp to this page only
    if (cr.bottom < shellRect.top || cr.top > shellRect.bottom) continue
    rects.push({
      x: (cr.left - shellRect.left) / zoom,
      y: (cr.top - shellRect.top) / zoom,
      w: cr.width / zoom,
      h: cr.height / zoom,
    })
  }
  if (rects.length === 0) return null
  const first = range.getClientRects()[0]
  return {
    pageId: shell.dataset.pageId!,
    rects: mergeLineRects(rects),
    clientX: first.left + Math.min(180, first.width / 2),
    clientY: first.top,
    text: sel.toString(),
  }
}

export function SelectionPopover(): JSX.Element | null {
  const tool = useStore((s) => s.tool)
  const markupMode = useStore((s) => s.markupMode)
  const prefs = useStore((s) => s.prefs)
  const [pending, setPending] = useState<Pending | null>(null)

  useEffect(() => {
    // Select mode only: a finished text selection gets quick actions.
    // The markup TOOL never touches browser selection — it snaps boxes to lines.
    const onUp = () => {
      setTimeout(() => {
        const s = useStore.getState()
        if (!activeDoc() || s.tool !== 'select') return
        const grabbed = grabSelection()
        if (grabbed) setPending(grabbed)
      }, 10)
    }
    const onChange = () => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed) setPending(null)
    }
    document.addEventListener('mouseup', onUp)
    document.addEventListener('selectionchange', onChange)
    return () => {
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('selectionchange', onChange)
    }
  }, [])

  useEffect(() => {
    setPending(null)
  }, [tool])

  if (!pending) return null

  const apply2 = (mode: MarkupMode) => {
    apply(pending, mode, prefs.markupColor)
    setPending(null)
  }

  return (
    <div
      className="sel-popover"
      style={{
        left: Math.max(8, Math.min(pending.clientX - 70, window.innerWidth - 190)),
        top: Math.max(8, pending.clientY - 44),
      }}
      onPointerDown={(e) => e.preventDefault()}
    >
      <button className="btn-icon" title={`Highlight (${prefs.markupColor})`} onClick={() => apply2('highlight')}>
        <Highlighter size={16} />
      </button>
      <button className="btn-icon" title="Underline" onClick={() => apply2('underline')}>
        <Underline size={16} />
      </button>
      <button className="btn-icon" title="Strike through" onClick={() => apply2('strike')}>
        <Strikethrough size={16} />
      </button>
      <div className="divider-v" />
      <button
        className="btn-icon"
        title="Copy text"
        onClick={() => {
          // Say what actually happened. The clipboard write can be refused — no
          // permission, an insecure origin, no clipboard API at all — and the
          // toast used to fire regardless, so the user walks away believing they
          // have the text and pastes nothing.
          void (navigator.clipboard?.writeText(pending.text) ?? Promise.reject(new Error('no clipboard')))
            .then(() => useStore.getState().toast('Text copied', 'ok'))
            .catch(() => useStore.getState().toast('Your browser would not let ReshapedPDF write to the clipboard', 'warn'))
          window.getSelection()?.removeAllRanges()
          setPending(null)
        }}
      >
        <Copy size={15} />
      </button>
    </div>
  )
}

function apply(p: Pending, mode: MarkupMode, color: string): void {
  useStore.getState().addObject({
    id: uid(), page: p.pageId, kind: 'markup', opacity: 1,
    mode, rects: p.rects, color,
  })
  window.getSelection()?.removeAllRanges()
  void markupModeNoop
}

const markupModeNoop = null
