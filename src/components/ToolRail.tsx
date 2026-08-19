import { Fragment } from 'react'
import { useStore } from '../core/store'
import { TOOL_ACTIONS } from '../core/actions'

const GROUP_LABEL: Record<string, string> = { edit: 'Edit', ai: 'AI' }
const GROUP_TITLE: Record<string, string> = {
  edit: 'Edit the page — works offline',
  ai: 'AI — needs a connected model',
}

export function ToolRail(): JSX.Element {
  const tool = useStore((s) => s.tool)
  const setTool = useStore((s) => s.setTool)
  const labelled = new Set<string>() // first tool of a group gets the header

  return (
    <nav className="toolrail" aria-label="Tools">
      {TOOL_ACTIONS.map((t) => {
        const Icon = t.icon!
        const g = t.group ?? ''
        const firstOfGroup = g !== '' && !labelled.has(g)
        if (g) labelled.add(g)
        // 'ai' tools get the full ember wash; an 'assist' tool (local, but can use
        // a model in one case) gets a hollow ring so the overlap is visible
        const cls = t.group === 'ai' ? 'ai' : t.assist ? 'assist' : ''
        return (
          <Fragment key={t.id}>
            {t.id === 'markup' && <div className="divider-h" />}
            {firstOfGroup && (
              <div className={`rail-label ${g}`} title={GROUP_TITLE[g]}>{GROUP_LABEL[g]}</div>
            )}
            <button
              className={`tool-btn ${cls} ${tool === t.id ? 'active' : ''}`}
              title={`${t.title} (${t.kbd})`}
              onClick={() => setTool(t.id)}
            >
              <Icon size={17} />
            </button>
          </Fragment>
        )
      })}
    </nav>
  )
}
