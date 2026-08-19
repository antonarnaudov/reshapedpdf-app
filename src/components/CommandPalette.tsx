import { useEffect, useMemo, useRef, useState } from 'react'
import { CornerDownLeft } from 'lucide-react'
import { useStore } from '../core/store'
import { paletteActions } from '../core/actions'
import type { Action } from '../core/actions'

function fuzzyScore(title: string, query: string): number {
  const t = title.toLowerCase()
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  let score = 0
  for (const tok of tokens) {
    const idx = t.indexOf(tok)
    if (idx < 0) return -1
    score += idx === 0 ? 3 : t[idx - 1] === ' ' ? 2 : 1
  }
  return score
}

export function CommandPalette(): JSX.Element | null {
  const open = useStore((s) => s.palette)
  const s = useStore.getState
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
      setTimeout(() => inputRef.current?.focus(), 10)
    }
  }, [open])

  const items = useMemo(() => {
    if (!open) return []
    const all = paletteActions()
    if (!query.trim()) return all
    return all
      .map((a) => ({ a, score: fuzzyScore(a.title, query) }))
      .filter((x) => x.score >= 0)
      .sort((x, y) => y.score - x.score)
      .map((x) => x.a)
  }, [open, query])

  useEffect(() => {
    setActive(0)
  }, [query])

  useEffect(() => {
    listRef.current?.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!open) return null

  const run = (a: Action) => {
    s().setPalette(false)
    void a.run()
  }

  const grouped: { group: string; items: { a: Action; idx: number }[] }[] = []
  items.forEach((a, idx) => {
    const last = grouped[grouped.length - 1]
    if (last && last.group === a.group) last.items.push({ a, idx })
    else grouped.push({ group: a.group, items: [{ a, idx }] })
  })

  return (
    <div className="palette-scrim" onPointerDown={(e) => e.target === e.currentTarget && s().setPalette(false)}>
      <div className="palette">
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Strike while the iron is hot — search commands…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
            else if (e.key === 'Enter' && items[active]) run(items[active])
            else if (e.key === 'Escape') s().setPalette(false)
          }}
        />
        <div className="palette-list" ref={listRef}>
          {items.length === 0 && <div className="palette-empty">Nothing on the bench matches “{query}”.</div>}
          {grouped.map(({ group, items: gi }) => (
            <div key={group}>
              <div className="palette-group">{group}</div>
              {gi.map(({ a, idx }) => {
                const Icon = a.icon
                return (
                  <button
                    key={a.id}
                    className={`palette-item ${idx === active ? 'active' : ''}`}
                    onPointerEnter={() => setActive(idx)}
                    onClick={() => run(a)}
                  >
                    <span className="pi-icon">{Icon ? <Icon size={15} /> : <CornerDownLeft size={15} />}</span>
                    {a.title}
                    {a.kbd && <span className="kbd pi-kbd">{a.kbd}</span>}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
