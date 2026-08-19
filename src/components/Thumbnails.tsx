import { useEffect, useRef, useState } from 'react'
import { Copy, RotateCcw, RotateCw, Scissors, Trash2 } from 'lucide-react'
import { shallow } from 'zustand/shallow'
import { useStore, useActiveDoc } from '../core/store'
import { renderPageToCanvas } from '../pdf/render'
import { pageViewSize } from '../pdf/registry'
import { extractPages, suggestedFileName } from '../pdf/exporter'
import { saveBytes } from '../native'
import { inkPath, arrowHead } from '../core/geometry'
import type { AnyObj, PageRef } from '../core/types'

const NO_OBJS: AnyObj[] = []

/** Live, purely presentational mirror of a page's annotations for the thumbnail. */
function MiniObjects({ page, pv }: { page: PageRef; pv: { w: number; h: number } }): JSX.Element | null {
  const objs = useStore(
    (s) => {
      const d = s.active ? s.docs[s.active] : null
      if (!d) return NO_OBJS
      const list = d.objOrder.map((id) => d.objects[id]).filter((o) => o && o.page === page.id) as AnyObj[]
      return list.length ? list : NO_OBJS
    },
    shallow,
  )
  if (objs.length === 0) return null
  return (
    <svg
      viewBox={`0 0 ${pv.w} ${pv.h}`}
      preserveAspectRatio="none"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
    >
      {objs.map((o) => {
        switch (o.kind) {
          case 'markup':
            return o.rects.map((r, i) =>
              o.mode === 'highlight' ? (
                <rect key={`${o.id}${i}`} x={r.x} y={r.y} width={r.w} height={r.h} fill={o.color} opacity={0.45} style={{ mixBlendMode: 'multiply' }} />
              ) : (
                <rect key={`${o.id}${i}`} x={r.x} y={o.mode === 'underline' ? r.y + r.h - 1 : r.y + r.h * 0.58} width={r.w} height={2.5} fill={o.color} />
              ),
            )
          case 'ink':
            return <path key={o.id} d={inkPath(o.points)} fill="none" stroke={o.color} strokeWidth={o.width * 1.4} strokeLinecap="round" />
          case 'shape': {
            if (o.mode === 'rect') return <rect key={o.id} x={o.x} y={o.y} width={o.w} height={o.h} fill={o.fill ?? 'none'} stroke={o.stroke ?? 'none'} strokeWidth={o.strokeWidth * 1.4} />
            if (o.mode === 'ellipse') return <ellipse key={o.id} cx={o.x + o.w / 2} cy={o.y + o.h / 2} rx={o.w / 2} ry={o.h / 2} fill={o.fill ?? 'none'} stroke={o.stroke ?? 'none'} strokeWidth={o.strokeWidth * 1.4} />
            const x2 = o.x + o.w, y2 = o.y + o.h
            return (
              <g key={o.id} stroke={o.stroke ?? '#17171B'} strokeWidth={o.strokeWidth * 1.4} strokeLinecap="round">
                <line x1={o.x} y1={o.y} x2={x2} y2={y2} />
                {o.mode === 'arrow' && arrowHead(o.x, o.y, x2, y2, o.strokeWidth).map(([hx, hy], i) => (
                  <line key={i} x1={x2} y1={y2} x2={hx} y2={hy} />
                ))}
              </g>
            )
          }
          case 'whiteout':
            return o.src
              ? <image key={o.id} href={o.src} x={o.x} y={o.y} width={o.w} height={o.h} preserveAspectRatio="none" />
              : <rect key={o.id} x={o.x} y={o.y} width={o.w} height={o.h} fill={o.color} />
          case 'redact':
            return <rect key={o.id} x={o.x} y={o.y} width={o.w} height={o.h} fill="#0c0c10" />
          case 'image':
            return <image key={o.id} href={o.src} x={o.x} y={o.y} width={o.w} height={o.h} preserveAspectRatio="none" />
          case 'text':
            return (
              <text key={o.id} x={o.x} y={o.y + o.size} fontSize={o.size} fill={o.color} fontWeight={o.bold ? 700 : 400} style={{ fontFamily: 'Helvetica, sans-serif' }}>
                {o.text.split('\n')[0]}
              </text>
            )
          case 'note':
            return <circle key={o.id} cx={o.x + 13} cy={o.y + 13} r={9} fill={o.color} stroke="rgba(0,0,0,.25)" />
          default:
            return null
        }
      })}
    </svg>
  )
}

function Thumb({
  page, index, current, selected,
  onClick, onContext, onDragStart, onDragEnd, onDragOver, onDrop, dropEdge, dragging,
}: {
  page: PageRef
  index: number
  current: boolean
  selected: boolean
  onClick: (e: React.MouseEvent) => void
  onContext: (e: React.MouseEvent) => void
  onDragStart: () => void
  onDragEnd: () => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  dropEdge: 'top' | 'bottom' | null
  dragging: boolean
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rotatePages = useStore((s) => s.rotatePages)
  const pv = pageViewSize(page)

  // Render a thumbnail only once it is somewhere near the rail's viewport.
  //
  // Every page used to start rendering the instant the panel mounted, and the
  // panel is open by default — so opening a 500-page document fired 500
  // concurrent pdf.js renders at once and the window locked up before the first
  // page appeared. An observer costs nothing and turns that into the dozen the
  // user can actually see.
  const frameRef = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  useEffect(() => {
    const el = frameRef.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => { for (const e of entries) if (e.isIntersecting) setNear(true) },
      { rootMargin: '600px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !near) return
    void renderPageToCanvas(`thumb-${page.id}`, page, 178 / pv.w, canvas)
  }, [near, page, page.extraRot, pv.w])

  return (
    <div
      className={`thumb ${current ? 'current' : ''} ${selected ? 'selected' : ''} ${dragging ? 'dragging' : ''}`}
      draggable
      onClick={onClick}
      onContextMenu={onContext}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {dropEdge === 'top' && <div className="thumb-drop" style={{ top: -6 }} />}
      <div ref={frameRef} className="thumb-frame" style={{ aspectRatio: `${pv.w} / ${pv.h}` }}>
        <canvas ref={canvasRef} />
        <MiniObjects page={page} pv={pv} />
        <div className="thumb-actions">
          <button title="Rotate" onClick={(e) => { e.stopPropagation(); rotatePages([page.id], 1) }}>
            <RotateCw size={12} />
          </button>
        </div>
      </div>
      <div className="thumb-meta">
        <span className="thumb-num">{index + 1}</span>
      </div>
      {dropEdge === 'bottom' && <div className="thumb-drop" style={{ bottom: -6 }} />}
    </div>
  )
}

interface CtxMenu {
  x: number
  y: number
  pageId: string
}

export function Thumbnails(): JSX.Element | null {
  const doc = useActiveDoc()
  const s = useStore.getState
  const [selected, setSelected] = useState<string[]>([])
  // The shift-select anchor is a page ID, not an index — a drag-reorder or a
  // delete changes the order, and an index would then point at the wrong page
  // (shift-selecting, then Delete, could remove pages the user never highlighted).
  const [anchor, setAnchor] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<{ id: string; edge: 'top' | 'bottom' } | null>(null)
  const [menu, setMenu] = useState<CtxMenu | null>(null)

  useEffect(() => {
    setSelected([])
    setAnchor(null)
  }, [doc?.id])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close, { capture: true })
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close, { capture: true })
    }
  }, [menu])

  if (!doc) return null

  const targetIds = (clickedId: string): string[] =>
    selected.includes(clickedId) && selected.length > 0 ? selected : [clickedId]

  const handleClick = (e: React.MouseEvent, page: PageRef, index: number) => {
    const aIdx = anchor ? doc.pages.findIndex((p) => p.id === anchor) : -1
    if (e.shiftKey && aIdx >= 0) {
      const [a, b] = [Math.min(aIdx, index), Math.max(aIdx, index)]
      setSelected(doc.pages.slice(a, b + 1).map((p) => p.id))
    } else if (e.metaKey || e.ctrlKey) {
      setSelected((prev) => (prev.includes(page.id) ? prev.filter((i) => i !== page.id) : [...prev, page.id]))
      setAnchor(page.id)
    } else {
      setSelected([page.id])
      setAnchor(page.id)
      s().requestScroll(page.id)
    }
  }

  const doDrop = (targetId: string, edge: 'top' | 'bottom') => {
    if (!dragId) return
    const ids = targetIds(dragId)
    const targetIdx = doc.pages.findIndex((p) => p.id === targetId)
    if (targetIdx < 0) return
    s().movePages(ids, edge === 'top' ? targetIdx : targetIdx + 1)
    setDragId(null)
    setDropAt(null)
  }

  const extractSel = async (ids: string[]) => {
    s().setBusy('Extracting pages…')
    try {
      const bytes = await extractPages(doc, ids)
      // false = the user cancelled the Save dialog; don't claim a save that
      // didn't happen.
      if ((await saveBytes(suggestedFileName(doc, 'pages'), bytes)).ok) {
        s().toast(`Extracted ${ids.length} page${ids.length > 1 ? 's' : ''}`, 'ok')
      }
    } catch (err) {
      s().toast('Extract failed: ' + (err instanceof Error ? err.message : String(err)), 'error')
    } finally {
      s().setBusy(null)
    }
  }

  return (
    <>
      {doc.pages.map((page, i) => (
        <Thumb
          key={page.id}
          page={page}
          index={i}
          current={doc.currentPage === i}
          selected={selected.includes(page.id)}
          dragging={dragId === page.id}
          dropEdge={dropAt?.id === page.id ? dropAt.edge : null}
          onClick={(e) => handleClick(e, page, i)}
          onContext={(e) => {
            e.preventDefault()
            e.stopPropagation()
            if (!selected.includes(page.id)) {
              setSelected([page.id])
              setAnchor(page.id)
            }
            setMenu({ x: e.clientX, y: e.clientY, pageId: page.id })
          }}
          onDragStart={() => setDragId(page.id)}
          onDragEnd={() => { setDragId(null); setDropAt(null) }}
          onDragOver={(e) => {
            e.preventDefault()
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
            setDropAt({ id: page.id, edge: e.clientY < r.top + r.height / 2 ? 'top' : 'bottom' })
          }}
          onDrop={(e) => {
            e.preventDefault()
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
            doDrop(page.id, e.clientY < r.top + r.height / 2 ? 'top' : 'bottom')
          }}
        />
      ))}

      {menu && (
        <div className="ctx-menu" style={{ left: Math.min(menu.x, window.innerWidth - 210), top: Math.min(menu.y, window.innerHeight - 260) }}>
          <button onClick={() => s().rotatePages(targetIds(menu.pageId), 1)}><RotateCw size={14} /> Rotate clockwise</button>
          <button onClick={() => s().rotatePages(targetIds(menu.pageId), -1)}><RotateCcw size={14} /> Rotate counter-clockwise</button>
          <button onClick={() => s().duplicatePage(menu.pageId)}><Copy size={14} /> Duplicate page</button>
          <button onClick={() => void extractSel(targetIds(menu.pageId))}><Scissors size={14} /> Extract to new PDF</button>
          <div className="sep" />
          <button onClick={() => { const ids = targetIds(menu.pageId); if (ids.length < doc.pages.length) { s().deletePages(ids); setSelected([]) } else s().deletePages(ids) }}>
            <Trash2 size={14} /> Delete {targetIds(menu.pageId).length > 1 ? `${targetIds(menu.pageId).length} pages` : 'page'}
          </button>
        </div>
      )}
    </>
  )
}
