import { ArrowDownToLine, ArrowUpToLine, Copy, Layers, RotateCcw, RotateCw, Sparkles, Trash2 } from 'lucide-react'
import { useStore, useActiveDoc, activeDoc } from '../core/store'
import { pageViewSize } from '../pdf/registry'
import { peelPage, cancelPeel } from '../core/peel'
import { peelers } from './ObjectsLayer'
import { FONTS, FONT_IDS } from '../core/types'
import type { AnyObj, FontId } from '../core/types'

const KIND_LABEL: Record<string, string> = {
  markup: 'Markup', ink: 'Pen stroke', shape: 'Shape', text: 'Text', note: 'Note',
  image: 'Image', whiteout: 'White-out patch', redact: 'Redaction',
}

function ColorRow({ label, value, onChange }: { label: string; value: string; onChange: (c: string) => void }): JSX.Element {
  return (
    <div className="prop-row">
      <span className="prop-label">{label}</span>
      <label className="swatch" style={{ background: value, width: 24, height: 24, cursor: 'pointer' }}>
        <input
          type="color"
          value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'}
          style={{ opacity: 0, width: '100%', height: '100%', cursor: 'pointer' }}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
    </div>
  )
}

function ObjectProps({ obj }: { obj: AnyObj }): JSX.Element {
  const s = useStore.getState
  const edit = (patch: Partial<AnyObj>, commit = true) => {
    if (commit) s().commitNow()
    s().updateObject(obj.id, patch)
  }

  return (
    <>
      <div className="prop-section">
        <div className="rp-title" style={{ marginBottom: 6 }}>{KIND_LABEL[obj.kind] ?? 'Object'}</div>

        {'color' in obj && obj.kind !== 'whiteout' && (
          <ColorRow label="Color" value={obj.color} onChange={(c) => edit({ color: c } as Partial<AnyObj>)} />
        )}
        {obj.kind === 'whiteout' && (
          <ColorRow label="Patch color" value={obj.color} onChange={(c) => edit({ color: c, src: undefined } as Partial<AnyObj>)} />
        )}
        {obj.kind === 'shape' && (() => {
          const lineLike = obj.mode === 'line' || obj.mode === 'arrow'
          return (
            <>
              {!lineLike && (
                <div className="prop-row">
                  <span className="prop-label">Stroke</span>
                  <input
                    type="checkbox" style={{ accentColor: 'var(--ember)' }}
                    checked={Boolean(obj.stroke)}
                    onChange={(e) =>
                      edit((e.target.checked
                        ? { stroke: '#D6382E' }
                        : { stroke: null, ...(obj.fill ? {} : { fill: '#FFE066' }) }) as Partial<AnyObj>)
                    }
                  />
                </div>
              )}
              {(lineLike || obj.stroke) && (
                <ColorRow label={lineLike ? 'Color' : 'Stroke color'} value={obj.stroke ?? '#17171B'} onChange={(c) => edit({ stroke: c } as Partial<AnyObj>)} />
              )}
              <div className="prop-row">
                <span className="prop-label">Width</span>
                <input
                  type="range" min={0.5} max={16} step={0.5} value={obj.strokeWidth} style={{ width: 132, accentColor: 'var(--ember)' }}
                  onPointerDown={() => s().commitNow()}
                  onChange={(e) => edit({ strokeWidth: Number(e.target.value) } as Partial<AnyObj>, false)}
                />
              </div>
              {!lineLike && (
                <div className="prop-row">
                  <span className="prop-label">Fill</span>
                  <input
                    type="checkbox" style={{ accentColor: 'var(--ember)' }}
                    checked={Boolean(obj.fill)}
                    onChange={(e) =>
                      edit((e.target.checked
                        ? { fill: '#FFE066' }
                        : { fill: null, ...(obj.stroke ? {} : { stroke: '#D6382E' }) }) as Partial<AnyObj>)
                    }
                  />
                </div>
              )}
              {!lineLike && obj.fill && (
                <ColorRow label="Fill color" value={obj.fill} onChange={(c) => edit({ fill: c } as Partial<AnyObj>)} />
              )}
            </>
          )
        })()}
        {obj.kind === 'ink' && (
          <div className="prop-row">
            <span className="prop-label">Width</span>
            <input
              type="range" min={0.5} max={16} step={0.5} value={obj.width} style={{ width: 132, accentColor: 'var(--ember)' }}
              onPointerDown={() => s().commitNow()}
              onChange={(e) => edit({ width: Number(e.target.value) } as Partial<AnyObj>, false)}
            />
          </div>
        )}
        {obj.kind === 'text' && (
          <>
            <div className="prop-row">
              <span className="prop-label">Font</span>
              <span className="select-wrap">
                {/* every face in the palette — retype and the matcher assign all
                    nine, and a box set to one of the other six used to render this
                    control blank, with no way back to a named font */}
                <select className="select" value={obj.font} onChange={(e) => edit({ font: e.target.value as FontId } as Partial<AnyObj>)}>
                  {FONT_IDS.map((id) => <option key={id} value={id}>{FONTS[id].label}</option>)}
                </select>
              </span>
            </div>
            <div className="prop-row">
              <span className="prop-label">Size</span>
              <input
                className="input" type="number" min={5} max={120} value={Math.round(obj.size)}
                onChange={(e) => edit({ size: Number(e.target.value) || obj.size } as Partial<AnyObj>)}
              />
            </div>
            <div className="prop-row">
              <span className="prop-label">Bold</span>
              <input type="checkbox" style={{ accentColor: 'var(--ember)' }} checked={obj.bold} onChange={(e) => edit({ bold: e.target.checked } as Partial<AnyObj>)} />
            </div>
          </>
        )}

        <div className="prop-row">
          <span className="prop-label">Opacity</span>
          <input
            type="range" min={0.1} max={1} step={0.05} value={obj.opacity} style={{ width: 132, accentColor: 'var(--ember)' }}
            onPointerDown={() => s().commitNow()}
            onChange={(e) => s().updateObject(obj.id, { opacity: Number(e.target.value) })}
          />
        </div>
      </div>

      <div className="prop-section">
        <div className="rp-actions">
          <button className="btn" onClick={() => s().bringToFront([obj.id])}><ArrowUpToLine size={14} /> Front</button>
          <button className="btn" onClick={() => s().sendToBack([obj.id])}><ArrowDownToLine size={14} /> Back</button>
          <button className="btn" onClick={() => s().duplicateSelection()}><Copy size={14} /> Duplicate</button>
          <button className="btn" style={{ color: 'var(--danger)' }} onClick={() => s().removeObjects([obj.id])}>
            <Trash2 size={14} /> Delete
          </button>
        </div>
      </div>
    </>
  )
}

function AiCard(): JSX.Element {
  const aiConfig = useStore((st) => st.aiConfig)
  const busy = useStore((st) => st.busy)
  const peeling = typeof busy === 'string' && (busy.startsWith('Peeling') || busy.startsWith('Finding the text'))
  const s = useStore.getState
  return (
    <div className="ai-card">
      <h4><Sparkles size={14} color="var(--ember)" /> AI assist <span className="ai-opt">optional</span></h4>
      {aiConfig ? (
        <>
          <p>
            Connected to <b className="mono" style={{ fontWeight: 600 }}>{aiConfig.model}</b>. On top of the local editing tools, it adds:
          </p>
          <ul className="ai-modes">
            <li><b>AI clean</b> <span className="kbd">C</span> — draw around a logo, a stamp, anything: it comes off the page and the real background underneath comes back.</li>
            <li><b>AI blend</b> <span className="kbd">R</span> — drag over text/images you added to fit them into the print, or over empty space for new matched text.</li>
            <li><b>Peel a scan</b> — turn a scanned page into editable text layers over a rebuilt background (button below).</li>
            <li><b>Read scans</b> — <b>Retype</b> and <b>Erase</b> also work on scanned / image text, not just digital text.</li>
          </ul>
          {peeling ? (
            <button
              className="btn outline" style={{ width: '100%', justifyContent: 'center', marginBottom: 8 }}
              onClick={() => cancelPeel()}
            >
              <Layers size={14} /> {busy} — stop
            </button>
          ) : (
            <button
              className="btn" style={{ width: '100%', justifyContent: 'center', marginBottom: 8 }}
              disabled={Boolean(busy)}
              onClick={async () => {
                const d = activeDoc(); const p = d?.pages[d.currentPage]
                if (!p) return
                try {
                  const r = await peelPage(p)
                  // peelPage already speaks for itself on the paths it handles
                  // (busy, empty page, stopped part-way), so say nothing twice.
                  if (r.outcome === 'busy' || r.outcome === 'empty' || r.outcome === 'stopped') { /* already reported */ }
                  else if (r.outcome === 'ok') {
                    s().toast(`Peeled ${r.layers} text layer${r.layers === 1 ? '' : 's'}${r.skipped ? `, ${r.skipped} skipped` : ''} — now editable`, 'ok')
                  } else if (r.outcome === 'allskipped') {
                    s().toast(`Found ${r.blocks} block${r.blocks === 1 ? '' : 's'} but could not read ${r.blocks === 1 ? 'it' : 'any of them'} — nothing was changed`, 'warn')
                  } else {
                    s().toast('The document changed while peeling — nothing was applied', 'warn')
                  }
                } catch (e) {
                  s().toast(`Peel failed: ${e instanceof Error ? e.message : String(e)}`, 'warn')
                }
              }}
            >
              <Layers size={14} /> Peel this page to layers
            </button>
          )}
          {/* The other peel: this one needs no model at all, because it reads
              the page's own drawing program rather than a picture of it. Offered
              beside the raster one because the words are nearly the same and the
              difference matters — one asks a model what it can see, the other
              asks the file what it drew. */}
          <button
            className="btn" style={{ width: '100%', justifyContent: 'center', marginBottom: 8 }}
            disabled={Boolean(busy)}
            title="Hand back every run, path and picture on this page as an editable object — no model needed"
            onClick={async () => {
              const d = activeDoc(); const p = d?.pages[d.currentPage]
              if (!p) return
              try {
                const fn = peelers.get(p.id)
                if (!fn) { s().toast('That page is not on screen yet — scroll to it first', 'info'); return }
                const r = await fn()
                if (!r.peeled) s().toast('Nothing on this page could be taken apart — it may be a flat scan, in which case peel it to layers instead', 'info')
                else s().toast(`Took the page apart — ${r.peeled} element${r.peeled === 1 ? '' : 's'} now editable${r.skipped ? `, ${r.skipped} skipped` : ''}. One undo puts it back.`, 'ok')
              } catch (e) {
                s().toast(`Could not take the page apart: ${e instanceof Error ? e.message : String(e)}`, 'warn')
              }
            }}
          >
            <Layers size={14} /> Take this page apart
          </button>
          <button className="btn outline" style={{ width: '100%', justifyContent: 'center' }} onClick={() => s().openModal({ type: 'ai' })}>
            Model settings
          </button>
        </>
      ) : (
        <>
          <p>
            <b>AI clean</b> — draw around anything and it comes off the page — needs a model.
            Everything else works without one: <b>Retype</b> (digital text), <b>Erase</b>, <b>Retouch</b>, <b>Redact</b> and <b>Lift</b> all run locally.
            Connect a vision model to also read <b>scanned</b> text, blend added content into the print, and peel a scan into editable layers.
            Any model works: local Ollama, LM Studio, or an API key.
          </p>
          <button className="btn outline" style={{ width: '100%', justifyContent: 'center' }} onClick={() => s().openModal({ type: 'ai' })}>
            Connect a model
          </button>
        </>
      )}
    </div>
  )
}

export function RightPanel(): JSX.Element | null {
  const doc = useActiveDoc()
  const s = useStore.getState
  if (!doc) return null

  const sel = doc.selection.map((id) => doc.objects[id]).filter(Boolean) as AnyObj[]
  const page = doc.pages[doc.currentPage]
  const pv = page ? pageViewSize(page) : { w: 0, h: 0 }
  const mm = (pt: number) => Math.round(pt * 0.352778)
  const annCount = doc.objOrder.length

  return (
    <aside className="rightpanel">
      <div className="rp-head">
        <span className="rp-title">{sel.length ? `Selection (${sel.length})` : 'This document'}</span>
      </div>
      <div className="rp-body">
        {sel.length === 1 && <ObjectProps obj={sel[0]} />}
        {sel.length > 1 && (
          <div className="prop-section">
            <div className="rp-actions">
              <button className="btn" onClick={() => s().duplicateSelection()}><Copy size={14} /> Duplicate</button>
              <button className="btn" style={{ color: 'var(--danger)' }} onClick={() => s().removeObjects(doc.selection)}>
                <Trash2 size={14} /> Delete all
              </button>
            </div>
          </div>
        )}

        {sel.length === 0 && (
          <>
            <div className="prop-section">
              <div className="rp-info">
                <b>{doc.name}</b><br />
                {doc.pages.length} page{doc.pages.length > 1 ? 's' : ''} · {annCount} annotation{annCount === 1 ? '' : 's'}
                {doc.fields.length > 0 && <> · {doc.fields.length} form fields</>}
              </div>
            </div>
            {page && (
              <div className="prop-section">
                <div className="rp-title" style={{ marginBottom: 6 }}>Page {doc.currentPage + 1}</div>
                <div className="rp-info">
                  {Math.round(pv.w)} × {Math.round(pv.h)} pt · {mm(pv.w)} × {mm(pv.h)} mm
                </div>
                <div className="rp-actions">
                  <button className="btn" onClick={() => s().rotatePages([page.id], -1)}><RotateCcw size={14} /> Rotate</button>
                  <button className="btn" onClick={() => s().rotatePages([page.id], 1)}><RotateCw size={14} /> Rotate</button>
                </div>
              </div>
            )}
            <AiCard />
          </>
        )}
      </div>
    </aside>
  )
}
