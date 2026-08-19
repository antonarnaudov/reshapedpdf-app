import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, FilePlus2, FilePlus, LayoutGrid, MessageSquareText, Search, StickyNote } from 'lucide-react'
import { useStore, useActiveDoc } from '../core/store'
import { searchDoc, invalidateSearchCache } from '../pdf/textsearch'
import { insertPdfAfterCurrent } from '../core/actions'
import { makeBlankPdf } from '../pdf/sample'
import { loadPdfSource } from '../pdf/loader'
import { pageViewSize } from '../pdf/registry'
import { Thumbnails } from './Thumbnails'
import { NOTE_SIZE } from '../core/types'

function SearchPanel(): JSX.Element | null {
  const doc = useActiveDoc()
  const query = useStore((s) => s.searchQuery)
  const matches = useStore((s) => s.searchMatches)
  const active = useStore((s) => s.searchActive)
  const s = useStore.getState
  const inputRef = useRef<HTMLInputElement>(null)
  const [running, setRunning] = useState(false)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // page structure changed (rotate/delete/merge): stale geometry, re-derive
  useEffect(() => {
    invalidateSearchCache()
  }, [doc?.pages])

  useEffect(() => {
    if (!doc) return
    const t = window.setTimeout(async () => {
      if (query.trim().length < 2) {
        s().setSearchResults([])
        return
      }
      setRunning(true)
      try {
        s().setSearchResults(await searchDoc(doc, query))
      } finally {
        setRunning(false)
      }
    }, 280)
    return () => window.clearTimeout(t)
  }, [query, doc?.pages, doc?.id])

  if (!doc) return null

  const step = (dir: 1 | -1) => {
    if (!matches.length) return
    s().setSearchActive((active + dir + matches.length) % matches.length)
  }

  return (
    <>
      <div className="search-box">
        <input
          ref={inputRef}
          className="input"
          placeholder="Find in document…"
          value={query}
          onChange={(e) => s().setSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') step(e.shiftKey ? -1 : 1)
          }}
        />
        <button className="btn-icon" style={{ width: 26 }} onClick={() => step(-1)} title="Previous (⇧Enter)"><ChevronUp size={15} /></button>
        <button className="btn-icon" style={{ width: 26 }} onClick={() => step(1)} title="Next (Enter)"><ChevronDown size={15} /></button>
      </div>
      <div className="search-count" style={{ padding: '0 6px 6px' }}>
        {running ? 'Searching…' : query.trim().length >= 2 ? `${matches.length} match${matches.length === 1 ? '' : 'es'}` : 'Type at least 2 characters'}
      </div>
      {matches.map((m, i) => (
        <div key={i} className={`search-hit ${i === active ? 'active' : ''}`} onClick={() => s().setSearchActive(i)}>
          <span className="hit-page">PAGE {m.pageIndex + 1}</span>
          {highlightSnippet(m.snippet, query)}
        </div>
      ))}
    </>
  )
}

function highlightSnippet(snippet: string, query: string): JSX.Element {
  const idx = snippet.toLowerCase().indexOf(query.toLowerCase())
  if (idx < 0) return <span>{snippet}</span>
  return (
    <span>
      {snippet.slice(0, idx)}
      <mark>{snippet.slice(idx, idx + query.length)}</mark>
      {snippet.slice(idx + query.length)}
    </span>
  )
}

function CommentsPanel(): JSX.Element | null {
  const doc = useActiveDoc()
  const s = useStore.getState
  if (!doc) return null

  const notes = doc.objOrder
    .map((id) => doc.objects[id])
    .filter((o) => o && o.kind === 'note')

  const total = notes.length + doc.comments.length
  if (total === 0) {
    return (
      <div className="panel-empty">
        No comments yet.<br />
        Pin one with the note tool <StickyNote size={12} style={{ verticalAlign: -2 }} /> — it exports as a real PDF annotation.
      </div>
    )
  }

  return (
    <>
      {notes.map((o) => {
        if (o.kind !== 'note') return null
        const pageIdx = doc.pages.findIndex((p) => p.id === o.page)
        return (
          <div key={o.id} className="comment-item" onClick={() => {
            s().requestScroll(o.page, { x: o.x, y: o.y, w: NOTE_SIZE, h: NOTE_SIZE })
            s().setSelection([o.id])
          }}>
            <div className="comment-head">
              <span className="comment-author">You</span>
              <span className="comment-page">p. {pageIdx + 1}</span>
            </div>
            <div className="comment-text">{o.text || <i style={{ color: 'var(--ink-faint)' }}>Empty note</i>}</div>
          </div>
        )
      })}
      {doc.comments.map((c, i) => {
        const pageIdx = doc.pages.findIndex((p) => p.id === c.page)
        if (pageIdx < 0) return null
        return (
          <div key={`imp-${i}`} className="comment-item" onClick={() => s().requestScroll(c.page)}>
            <div className="comment-head">
              <span className="comment-author">{c.author || 'Imported'}</span>
              <span className="comment-page">p. {pageIdx + 1}</span>
            </div>
            <div className="comment-text">{c.text}</div>
          </div>
        )
      })}
    </>
  )
}

export function Sidebar(): JSX.Element {
  const panel = useStore((s) => s.panel)
  const doc = useActiveDoc()
  const s = useStore.getState

  // collapsed: a slim rail keeps the panel buttons alive — nothing ever disappears
  if (!panel) {
    return (
      <aside className="sidebar rail">
        <button className="panel-tab" onClick={() => s().setPanel('pages')} title="Pages"><LayoutGrid size={16} /></button>
        <button className="panel-tab" onClick={() => s().setPanel('search')} title="Search (⌘F)"><Search size={16} /></button>
        <button className="panel-tab" onClick={() => s().setPanel('comments')} title="Comments"><MessageSquareText size={16} /></button>
      </aside>
    )
  }

  const insertBlank = async () => {
    if (!doc) return
    // match the current page's displayed size so the blank slots in naturally
    const cur = doc.pages[doc.currentPage]
    const pv = cur ? pageViewSize(cur) : { w: 612, h: 792 }
    const bytes = await makeBlankPdf(pv.w, pv.h)
    const loaded = await loadPdfSource(bytes)
    s().insertPagesFromSource(loaded, doc.currentPage)
    s().toast('Blank page added after this one', 'ok')
  }

  return (
    <aside className="sidebar">
      <div className="panel-tabs">
        <button className={`panel-tab ${panel === 'pages' ? 'active' : ''}`} onClick={() => s().setPanel('pages')} title="Pages">
          <LayoutGrid size={14} /> Pages
        </button>
        <button className={`panel-tab ${panel === 'search' ? 'active' : ''}`} onClick={() => s().setPanel('search')} title="Search (⌘F)">
          <Search size={14} />
        </button>
        <button className={`panel-tab ${panel === 'comments' ? 'active' : ''}`} onClick={() => s().setPanel('comments')} title="Comments">
          <MessageSquareText size={14} />
        </button>
      </div>
      <div className="panel-body">
        {panel === 'pages' && <Thumbnails />}
        {panel === 'search' && <SearchPanel />}
        {panel === 'comments' && <CommentsPanel />}
      </div>
      {panel === 'pages' && (
        <div className="sidebar-footer">
          <button className="btn outline" onClick={() => void insertBlank()} title="Insert a blank page after the current one">
            <FilePlus2 size={14} /> Blank
          </button>
          <button className="btn outline" onClick={() => void insertPdfAfterCurrent()} title="Merge another PDF after the current page">
            <FilePlus size={14} /> Merge
          </button>
        </div>
      )}
    </aside>
  )
}
