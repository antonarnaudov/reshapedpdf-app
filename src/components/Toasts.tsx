import { Check, CircleAlert, Info, TriangleAlert } from 'lucide-react'
import { useStore } from '../core/store'

const ICONS = {
  ok: Check,
  info: Info,
  warn: TriangleAlert,
  error: CircleAlert,
}

export function Toasts(): JSX.Element {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)
  return (
    <div className="toasts">
      {toasts.map((t) => {
        const Icon = ICONS[t.type]
        return (
          <div key={t.id} className={`toast ${t.type}`} onClick={() => dismiss(t.id)}>
            <span className="t-ico"><Icon size={15} /></span>
            {t.text}
          </div>
        )
      })}
    </div>
  )
}
