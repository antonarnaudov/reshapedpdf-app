import { memo, useEffect, useRef, useState } from 'react'
import { useStore } from '../core/store'
import { pageViewSize } from '../pdf/registry'
import { renderPageToCanvas, renderTextLayer, cancelRender } from '../pdf/render'
import { ObjectsLayer } from './ObjectsLayer'
import { FormLayer } from './FormLayer'
import type { PageRef } from '../core/types'

export const PageView = memo(function PageView({
  page, index, visible,
}: {
  page: PageRef
  index: number
  visible: boolean
}): JSX.Element {
  const zoom = useStore((s) => s.zoom)
  const tool = useStore((s) => s.tool)
  const searchMatches = useStore((s) => s.searchMatches)
  const searchActive = useStore((s) => s.searchActive)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const [renderZoom, setRenderZoom] = useState(zoom)
  const renderedRotRef = useRef<number | null>(null)

  const pv = pageViewSize(page)

  // debounce the expensive canvas re-render while zooming (CSS stretches in the meantime)
  useEffect(() => {
    const t = window.setTimeout(() => setRenderZoom(zoom), 160)
    return () => window.clearTimeout(t)
  }, [zoom])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    if (!visible) {
      // Hand the pixels back. A page canvas is width x height x 4 bytes — an A4 at
      // 150% is ~5 MB — and every page scrolled past kept its own for the life of
      // the document, so a long PDF grew without bound until the tab died. Nothing
      // was leaking in the JS sense; the canvases were simply never let go.
      // Zeroing the dimensions frees the backing store, and the effect re-runs to
      // repaint the moment the page scrolls back into the band.
      if (canvas.width || canvas.height) { canvas.width = 0; canvas.height = 0 }
      return
    }
    void renderPageToCanvas(page.id, page, renderZoom, canvas)
    return () => cancelRender(page.id)
  }, [visible, renderZoom, page, page.extraRot])

  // text layer: build once per rotation, scale via CSS var
  useEffect(() => {
    if (!visible || !textRef.current) return
    if (renderedRotRef.current === page.extraRot) return
    renderedRotRef.current = page.extraRot
    void renderTextLayer(page, textRef.current)
  }, [visible, page, page.extraRot])

  const pageMatches = searchMatches
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.page === page.id)

  // only Select mode does native text selection; the markup tool snaps to lines itself
  const textSelectable = tool === 'select'

  return (
    <div
      className="page-shell"
      data-page-id={page.id}
      data-page-index={index}
      style={{ width: pv.w * zoom, height: pv.h * zoom }}
      onPointerDown={(e) => {
        // clicking bare paper (canvas / text layer) clears the selection
        const t = e.target as HTMLElement
        if (tool === 'select' && (t.classList?.contains('page-canvas') || t.closest?.('.textLayer'))) {
          useStore.getState().setSelection([])
        }
      }}
    >
      <span className="page-chip mono">{index + 1}</span>
      <canvas ref={canvasRef} className="page-canvas" />
      <div
        ref={textRef}
        className="textLayer"
        style={{ '--scale-factor': zoom, pointerEvents: textSelectable ? 'auto' : 'none' } as React.CSSProperties}
      />
      {pageMatches.length > 0 && (
        <svg className="objects-svg" style={{ zIndex: 2, pointerEvents: 'none' }} viewBox={`0 0 ${pv.w} ${pv.h}`} preserveAspectRatio="none">
          {pageMatches.map(({ m, i }) =>
            m.rects.map((r, j) => (
              <rect
                key={`${i}-${j}`}
                className={`search-hl ${i === searchActive ? 'flash' : 'dim'}`}
                x={r.x} y={r.y} width={r.w} height={r.h} rx={2}
              />
            )),
          )}
        </svg>
      )}
      <FormLayer page={page} zoom={zoom} />
      <ObjectsLayer page={page} pv={pv} zoom={zoom} />
    </div>
  )
})
