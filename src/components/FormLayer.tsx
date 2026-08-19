import { memo } from 'react'
import { Check } from 'lucide-react'
import { useStore, useActiveDoc } from '../core/store'
import { pageGeom } from '../pdf/registry'
import { userRectToView } from '../core/geometry'
import type { FormField, PageRef } from '../core/types'

function FieldView({ field, pageRef }: { field: FormField; pageRef: PageRef }): JSX.Element | null {
  const value = useStore((s) => {
    const d = s.active ? s.docs[s.active] : null
    return d?.formValues[field.name]
  })
  const setFormValue = useStore((s) => s.setFormValue)

  const r = userRectToView(pageGeom(pageRef), field.urect)
  if (r.w < 2 || r.h < 2) return null

  const style: React.CSSProperties = {
    left: r.x, top: r.y, width: r.w, height: r.h,
    opacity: field.readOnly ? 0.55 : 1,
    pointerEvents: field.readOnly ? 'none' : 'auto',
  }

  if (field.type === 'checkbox') {
    return (
      <div className="ff" style={style}>
        <div
          className="ff-check"
          role="checkbox"
          aria-checked={value === true}
          onClick={() => setFormValue(field.name, value !== true)}
        >
          {value === true && <Check size={Math.min(r.w, r.h) * 0.78} strokeWidth={3} />}
        </div>
      </div>
    )
  }

  if (field.type === 'radio') {
    const on = value === field.radioValue
    return (
      <div className="ff" style={style}>
        <div
          className="ff-check"
          style={{ borderRadius: '50%' }}
          role="radio"
          aria-checked={on}
          onClick={() => setFormValue(field.name, field.radioValue ?? 'On')}
        >
          {on && (
            <span
              style={{
                width: '52%', height: '52%', borderRadius: '50%', background: '#141416', display: 'block',
              }}
            />
          )}
        </div>
      </div>
    )
  }

  if (field.type === 'choice') {
    return (
      <div className="ff" style={style}>
        <select
          className="ff-select"
          style={{ fontSize: Math.max(8, Math.min(13, r.h * 0.55)) }}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => setFormValue(field.name, e.target.value)}
        >
          <option value="" disabled hidden />
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>
    )
  }

  const fontSize = field.multiline ? 11 : Math.max(8, Math.min(15, r.h * 0.58))
  const common = {
    className: 'ff-text',
    style: { fontSize } as React.CSSProperties,
    value: typeof value === 'string' ? value : '',
    maxLength: field.maxLen,
    placeholder: '',
    spellCheck: false,
  }

  return (
    <div className="ff" style={style}>
      {field.multiline ? (
        <textarea {...common} onChange={(e) => setFormValue(field.name, e.target.value)} />
      ) : (
        <input
          {...common}
          type={field.password ? 'password' : 'text'}
          onChange={(e) => setFormValue(field.name, e.target.value)}
        />
      )}
    </div>
  )
}

export const FormLayer = memo(function FormLayer({ page, zoom }: { page: PageRef; zoom: number }): JSX.Element | null {
  const doc = useActiveDoc()
  if (!doc) return null
  const fields = doc.fields.filter((f) => f.page === page.id)
  if (fields.length === 0) return null
  return (
    <div className="form-layer" style={{ transform: `scale(${zoom})` }}>
      {fields.map((f) => (
        <FieldView key={f.id} field={f} pageRef={page} />
      ))}
    </div>
  )
})
