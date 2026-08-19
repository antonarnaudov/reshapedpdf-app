import { Command, Download, FolderOpen, Moon, Redo2, Search, Sparkles, Sun, Undo2, X } from 'lucide-react'
import { useStore } from '../core/store'
import { openFilePicker } from '../core/actions'

/** The ReshapedPDF mark: a paper sheet with a folded corner and text lines, wearing the ember PDF band. */
export const BrandMark = ({ size = 21 }: { size?: number }): JSX.Element => (
  <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
    <defs>
      <linearGradient id="mark-heat" x1="0" y1="0" x2="1" y2="0.35">
        <stop offset="0" stopColor="#FF5C1F" />
        <stop offset="1" stopColor="#FFB454" />
      </linearGradient>
    </defs>
    {/* page with a folded top-right corner */}
    <path fill="#EFECE4" d="M10 2 H19 L26 9 V28 Q26 30 24 30 H10 Q8 30 8 28 V4 Q8 2 10 2 Z" />
    <path fill="#D7D2C6" d="M19 2 L26 9 H19 Z" />
    {/* printed lines */}
    <rect x="11" y="7" width="5" height="1.7" rx="0.85" fill="#B9B3A6" />
    <rect x="11" y="11" width="12" height="1.7" rx="0.85" fill="#B9B3A6" />
    <rect x="11" y="25" width="9" height="1.7" rx="0.85" fill="#C6C0B3" />
    {/* PDF band wrapping past the page's left edge */}
    <path fill="#A63E10" d="M5 22.6 L8 22.6 L8 24.6 Z" />
    <rect x="5" y="15" width="19" height="7.6" rx="1.6" fill="url(#mark-heat)" />
    <text
      x="14.5" y="20.8" textAnchor="middle"
      fontFamily="Arial, Helvetica, sans-serif" fontWeight="800" fontSize="5.8" letterSpacing="0.45"
      fill="#FFFFFF"
    >
      PDF
    </text>
  </svg>
)

export function TopBar(): JSX.Element {
  const docOrder = useStore((s) => s.docOrder)
  const docs = useStore((s) => s.docs)
  const active = useStore((s) => s.active)
  const theme = useStore((s) => s.theme)
  const panel = useStore((s) => s.panel)
  const canUndo = useStore((s) => (s.active ? (s.docs[s.active]?.undo.length ?? 0) > 0 : false))
  const canRedo = useStore((s) => (s.active ? (s.docs[s.active]?.redo.length ?? 0) > 0 : false))
  const s = useStore.getState

  return (
    <header className="topbar">
      <div className="brand" title="ReshapedPDF — reshape any PDF">
        <BrandMark />
        <span className="brand-word">Reshaped<em>PDF</em></span>
      </div>

      <div className="doc-tabs">
        {docOrder.map((id) => {
          const d = docs[id]
          if (!d) return null
          const requestClose = () => {
            if (d.dirty) s().openModal({ type: 'confirm-close', docId: id })
            else s().closeDoc(id)
          }
          return (
            <div
              key={id}
              className={`doc-tab ${id === active ? 'active' : ''}`}
              onClick={() => s().setActive(id)}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault()
                  requestClose()
                }
              }}
              title={d.name}
            >
              <span className={`ember-dot ${d.dirty ? '' : 'cool'}`} title={d.dirty ? 'Unsaved changes' : 'Saved'} />
              <span className="tab-name">{d.name}</span>
              <span
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation()
                  requestClose()
                }}
              >
                <X size={13} />
              </span>
            </div>
          )
        })}
      </div>

      <div className="topbar-actions">
        <button className="btn-icon" title="Undo (⌘Z)" disabled={!canUndo} onClick={() => s().undo()}>
          <Undo2 size={17} />
        </button>
        <button className="btn-icon" title="Redo (⇧⌘Z)" disabled={!canRedo} onClick={() => s().redo()}>
          <Redo2 size={17} />
        </button>
        <div className="divider-v" />
        <button
          className={`btn-icon ${panel === 'search' ? 'on' : ''}`}
          title="Search (⌘F)"
          disabled={!active}
          onClick={() => s().setPanel('search')}
        >
          <Search size={17} />
        </button>
        <button className="btn-icon" title="AI blending (preview)" onClick={() => s().openModal({ type: 'ai' })}>
          <Sparkles size={17} />
        </button>
        <button
          className="btn-icon"
          title="Switch bench lighting"
          onClick={() => s().setTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
        </button>
        <button className="btn-icon" title="Command palette (⌘K)" onClick={() => s().setPalette(true)}>
          <Command size={16} />
        </button>
        <div className="divider-v" />
        <button className="btn outline" title="Open PDF or images (⌘O)" onClick={() => void openFilePicker()}>
          <FolderOpen size={15} /> <span className="btn-label">Open</span>
        </button>
        <button className="btn primary" title="Export PDF (⌘S)" disabled={!active} onClick={() => s().openModal({ type: 'export' })}>
          <Download size={15} /> <span className="btn-label">Export</span>
        </button>
      </div>
    </header>
  )
}
