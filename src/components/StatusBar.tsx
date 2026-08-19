import { useEffect, useState } from 'react'
import { ChevronDown, Minus, Plus } from 'lucide-react'
import { useStore, useActiveDoc } from '../core/store'

// One line per tool, and there must BE one per tool: a blank status bar is how a
// new user learns nothing about the tool they just picked. Keep in step with
// TOOL_ACTIONS in core/actions.tsx.
const TOOL_HINTS: Record<string, string> = {
  select: 'Select — drag to move, registration handles to resize. Double-click text to edit.',
  markup: 'Markup — drag a box over text; it snaps to exactly those lines. Works on scans too.',
  ink: 'Pen — draw a stroke; it lands selected so you can move or resize it. Press P for another.',
  text: 'Text — click anywhere to start typing. Enter for a new line, Esc to finish.',
  note: 'Note — click to pin a comment. It exports as a real PDF annotation.',
  shape: 'Shapes — drag to draw (Shift constrains). The shape lands selected and adjustable.',
  image: 'Image — click the page to place, or drop a PNG/JPEG anywhere.',
  signature: 'Sign — click the page where the signature belongs.',
  reshape: 'AI reshape — drag over printed text. Your model reads it, matches the style, and you retype.',
  whiteout: 'Erase — drag a box (or sweep the brush) over a mistake. The background is rebuilt underneath, and covered words leave the file too.',
  redact: 'Redact — drag over secrets; the box lands selected. True removal happens on export.',
  retype: 'Retype — drag over printed words to change them. The reprint keeps the page\u2019s own type, and the original leaves the file.',
  retouch: 'Retouch — a clone brush for stray pixels: pick a colour and paint. Nothing is removed from the file.',
  lift: 'Lift — click any element to pull it out as an editable object; click again to reach the one beneath. Enter lifts it.',
  clean: 'AI clean — draw around anything you want gone. Your model works out its extent, and the real background underneath comes back.',
}

export function StatusBar(): JSX.Element | null {
  const doc = useActiveDoc()
  const tool = useStore((s) => s.tool)
  const zoom = useStore((s) => s.zoom)
  const fitMode = useStore((s) => s.fitMode)
  const s = useStore.getState
  const [pageInput, setPageInput] = useState('')

  useEffect(() => {
    if (doc) setPageInput(String(doc.currentPage + 1))
  }, [doc?.currentPage, doc])

  if (!doc) return null

  const selCount = doc.selection.length
  const hint =
    tool === 'select' && selCount > 0
      ? `${selCount} selected — drag to move · corner handles resize · ⌫ deletes · ⌘D duplicates`
      : TOOL_HINTS[tool]

  const jump = () => {
    const n = parseInt(pageInput, 10)
    if (!Number.isNaN(n) && n >= 1 && n <= doc.pages.length) {
      const ref = doc.pages[n - 1]
      s().requestScroll(ref.id)
    } else {
      setPageInput(String(doc.currentPage + 1))
    }
  }

  return (
    <footer className="statusbar">
      <span className="status-hint">{hint}</span>

      <div className="page-jump mono">
        <span>Page</span>
        <input
          value={pageInput}
          onChange={(e) => setPageInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && jump()}
          onBlur={jump}
        />
        <span>/ {doc.pages.length}</span>
      </div>

      <div className="divider-v" />

      <div className="zoom-ctl">
        <button className="btn-icon" style={{ width: 24, height: 24 }} title="Zoom out (⌘−)" onClick={() => s().setZoom(zoom / 1.2)}>
          <Minus size={14} />
        </button>
        <span
          className="zval"
          title={fitMode ? `Fitting ${fitMode} — click to switch` : 'Click to fit width'}
          onClick={() => s().setFit(fitMode === 'width' ? 'page' : 'width')}
        >
          {Math.round(zoom * 100)}%
        </span>
        <button className="btn-icon" style={{ width: 24, height: 24 }} title="Zoom in (⌘+)" onClick={() => s().setZoom(zoom * 1.2)}>
          <Plus size={14} />
        </button>
        <button className="btn-icon" style={{ width: 24, height: 24 }} title="Fit width (⌘0)" onClick={() => s().setFit('width')}>
          <ChevronDown size={14} />
        </button>
      </div>

      <div className="divider-v" />

      <div className="save-state">
        <span className={`ember-dot ${doc.dirty ? '' : 'cool'}`} />
        {doc.dirty ? 'Edited — still hot' : 'Saved'}
      </div>
    </footer>
  )
}
