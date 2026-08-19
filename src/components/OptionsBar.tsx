import { Bold, Circle, Highlighter, Minus, MoveUpRight, Sparkles, Square, Underline, Strikethrough, Signature, ImagePlus, Wand2, Replace, Paintbrush } from 'lucide-react'
import { useStore, useActiveDoc } from '../core/store'
import type { Prefs } from '../core/store'
import { pickFiles } from '../native'
import { openIncoming } from '../core/actions'
import { blendObjects, userStyled } from '../core/blend'
import { cloneTextLook, hasCloneSource, uncloneTextLook } from '../core/retype'
import { FONTS, FONT_IDS } from '../core/types'
import type { AnyObj, FontId, MarkupMode } from '../core/types'

const MARKUP_COLORS = ['#FFDE5C', '#8CE99A', '#74C0FC', '#F783AC', '#FF9A5C']
const INK_COLORS = ['#2456D6', '#D6382E', '#17171B', '#0B7A4B', '#FF5C1F']
const TEXT_COLORS = ['#17171B', '#2456D6', '#D6382E', '#5C5B55', '#FFFFFF']
const SHAPE_COLORS = ['#D6382E', '#2456D6', '#17171B', '#0B7A4B', '#FF5C1F']
const FILL_COLORS = ['#FFE066', '#FFFFFF', '#D3F9D8', '#D0EBFF', '#FFE3E3']
const NOTE_COLORS = ['#FFB454', '#FFDE5C', '#8CE99A', '#74C0FC', '#F783AC']

function Swatches({ colors, value, onPick, disabled }: { colors: string[]; value: string; onPick: (c: string) => void; disabled?: boolean }): JSX.Element {
  return (
    <div className="swatches" style={disabled ? { opacity: 0.35, pointerEvents: 'none' } : undefined}>
      {colors.map((c) => (
        <button
          key={c}
          className={`swatch ${value.toLowerCase() === c.toLowerCase() ? 'active' : ''}`}
          style={{ background: c }}
          title={c}
          onClick={() => onPick(c)}
        />
      ))}
      <span className="swatch-custom" title="Custom color…">
        <span style={{ fontSize: 11 }}>+</span>
        <input type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'} onChange={(e) => onPick(e.target.value)} />
      </span>
    </div>
  )
}

function ToggleChip({ on, label, onToggle }: { on: boolean; label: string; onToggle: (v: boolean) => void }): JSX.Element {
  return (
    <label className="opt-group" style={{ cursor: 'pointer', gap: 5 }}>
      <input type="checkbox" style={{ accentColor: 'var(--ember)' }} checked={on} onChange={(e) => onToggle(e.target.checked)} />
      <span className="opt-label">{label}</span>
    </label>
  )
}

function PrefWidthSlider({ prefKey, min = 1, max = 14 }: { prefKey: 'inkWidth' | 'shapeWidth'; min?: number; max?: number }): JSX.Element {
  const val = useStore((s) => s.prefs[prefKey])
  const setPref = useStore((s) => s.setPref)
  return (
    <div className="mini-slider" title="Stroke width">
      <input
        type="range" min={min} max={max} step={0.5} value={val}
        onChange={(e) => setPref(prefKey, Number(e.target.value) as Prefs[typeof prefKey])}
      />
      <span className="mini-val">{val}</span>
    </div>
  )
}

/* ---------------- editing the SELECTED object from the bar ---------------- */

function ObjSlider({ obj, field, min = 0.5, max = 16 }: { obj: AnyObj; field: 'strokeWidth' | 'width'; min?: number; max?: number }): JSX.Element {
  const s = useStore.getState
  const val = (obj as unknown as Record<string, number>)[field] ?? 2
  return (
    <div className="mini-slider" title="Width">
      <input
        type="range" min={min} max={max} step={0.5} value={val}
        onPointerDown={() => s().commitNow()}
        onChange={(e) => s().updateObject(obj.id, { [field]: Number(e.target.value) } as Partial<AnyObj>)}
      />
      <span className="mini-val">{val}</span>
    </div>
  )
}

function SelectionOptions(): JSX.Element {
  const doc = useActiveDoc()
  const s = useStore.getState
  const sel = doc?.selection ?? []
  const obj = sel.length === 1 ? doc?.objects[sel[0]] : undefined

  if (!obj) {
    return (
      <>
        <span className="opt-label" style={{ textTransform: 'none', letterSpacing: 0 }}>
          {sel.length > 1
            ? `${sel.length} objects — drag to move · ⌫ deletes · ⌘D duplicates`
            : 'Drag to move · handles to resize · double-click text to edit · right-click pages in the panel for more'}
        </span>
        {sel.length > 1 && (
          <>
            <div className="divider-v" />
            <button
              className="btn outline"
              style={{ height: 26, fontSize: 12 }}
              title="Blend the selected edits into the print"
              onClick={() => void blendObjects(sel)}
            >
              <Wand2 size={13} /> Blend all
            </button>
          </>
        )}
      </>
    )
  }

  const edit = (patch: Partial<AnyObj>) => {
    if (obj.kind === 'text') userStyled.add(obj.id)
    s().commitNow()
    s().updateObject(obj.id, patch)
  }

  switch (obj.kind) {
    case 'shape': {
      const lineLike = obj.mode === 'line' || obj.mode === 'arrow'
      if (lineLike) {
        return (
          <>
            <div className="opt-group">
              <span className="opt-label">{obj.mode}</span>
              <Swatches colors={SHAPE_COLORS} value={obj.stroke ?? '#17171B'} onPick={(c) => edit({ stroke: c })} />
            </div>
            <div className="divider-v" />
            <ObjSlider obj={obj} field="strokeWidth" />
          </>
        )
      }
      return (
        <>
          <div className="opt-group">
            <ToggleChip
              on={Boolean(obj.stroke)}
              label="Stroke"
              onToggle={(v) =>
                edit(v ? { stroke: '#D6382E' } : { stroke: null, ...(obj.fill ? {} : { fill: '#FFE066' }) })
              }
            />
            <Swatches colors={SHAPE_COLORS} value={obj.stroke ?? ''} disabled={!obj.stroke} onPick={(c) => edit({ stroke: c })} />
          </div>
          <ObjSlider obj={obj} field="strokeWidth" />
          <div className="divider-v" />
          <div className="opt-group">
            <ToggleChip
              on={Boolean(obj.fill)}
              label="Fill"
              onToggle={(v) =>
                edit(v ? { fill: '#FFE066' } : { fill: null, ...(obj.stroke ? {} : { stroke: '#D6382E' }) })
              }
            />
            <Swatches colors={FILL_COLORS} value={obj.fill ?? ''} disabled={!obj.fill} onPick={(c) => edit({ fill: c })} />
          </div>
        </>
      )
    }
    case 'ink':
      return (
        <>
          <div className="opt-group">
            <span className="opt-label">Stroke</span>
            <Swatches colors={INK_COLORS} value={obj.color} onPick={(c) => edit({ color: c })} />
          </div>
          <div className="divider-v" />
          <ObjSlider obj={obj} field="width" />
        </>
      )
    case 'text': {
      const cloned = Boolean(obj.glyphSrc)
      const cloneable = !cloned && hasCloneSource(obj.id)
      return (
        <>
          <button
            className="btn outline"
            style={{ height: 26, fontSize: 12 }}
            title="Blend into the print — match the surrounding size, baseline, column and ink"
            onClick={() => void blendObjects([obj.id])}
          >
            <Wand2 size={13} /> Blend
          </button>
          {cloneable && (
            <button
              className="btn outline"
              style={{ height: 26, fontSize: 12 }}
              title="Recompose this text from the document's own letters — pixel-identical"
              onClick={() => void cloneTextLook(obj.id)}
            >
              <Sparkles size={13} /> Match exactly
            </button>
          )}
          {cloned && (
            <button
              className="btn outline"
              style={{ height: 26, fontSize: 12 }}
              title="Switch back to editable matched font"
              onClick={() => uncloneTextLook(obj.id)}
            >
              <Sparkles size={13} /> Cloned — undo
            </button>
          )}
          <div className="divider-v" />
          <div className="opt-group">
            <span className="select-wrap">
              <select className="select" value={obj.font} onChange={(e) => edit({ font: e.target.value as FontId })}>
                {FONT_IDS.map((id) => (
                  <option key={id} value={id}>{FONTS[id].label}</option>
                ))}
              </select>
            </span>
            <div className="stepper" title="Font size">
              <button onClick={() => edit({ size: Math.max(5, obj.size - 1) })}>−</button>
              <span className="val">{Math.round(obj.size)}</span>
              <button onClick={() => edit({ size: Math.min(120, obj.size + 1) })}>+</button>
            </div>
            <button className={`btn-icon ${obj.bold ? 'on' : ''}`} title="Bold" onClick={() => edit({ bold: !obj.bold })}>
              <Bold size={15} />
            </button>
          </div>
          <div className="divider-v" />
          <Swatches colors={TEXT_COLORS} value={obj.color} onPick={(c) => edit({ color: c })} />
        </>
      )
    }
    case 'markup':
      return (
        <>
          <div className="opt-group">
            <div className="seg">
              <button className={obj.mode === 'highlight' ? 'on' : ''} onClick={() => edit({ mode: 'highlight' as MarkupMode })} title="Highlight"><Highlighter size={14} /></button>
              <button className={obj.mode === 'underline' ? 'on' : ''} onClick={() => edit({ mode: 'underline' as MarkupMode })} title="Underline"><Underline size={14} /></button>
              <button className={obj.mode === 'strike' ? 'on' : ''} onClick={() => edit({ mode: 'strike' as MarkupMode })} title="Strike"><Strikethrough size={14} /></button>
            </div>
          </div>
          <div className="divider-v" />
          <Swatches colors={MARKUP_COLORS} value={obj.color} onPick={(c) => edit({ color: c })} />
        </>
      )
    case 'note':
      return (
        <div className="opt-group">
          <span className="opt-label">Note</span>
          <Swatches colors={NOTE_COLORS} value={obj.color} onPick={(c) => edit({ color: c })} />
        </div>
      )
    case 'whiteout':
      return (
        <div className="opt-group">
          <span className="opt-label">Patch</span>
          <button
            className="btn outline"
            style={{ height: 26, fontSize: 12 }}
            title="Reconstruct the background under this patch"
            onClick={() => void blendObjects([obj.id])}
          >
            <Wand2 size={13} /> Re-blend
          </button>
          <Swatches colors={['#FFFFFF', '#F4F1EA', '#FFF8E1']} value={obj.color} onPick={(c) => edit({ color: c, src: undefined })} />
          <span className="opt-label" style={{ textTransform: 'none', letterSpacing: 0 }}>
            {/* `src` alone cannot tell these apart: an auto-sampled box patch, a
                lift/clean patch and a hand-painted retouch stroke all carry one.
                Only the last was chosen by the user, two clicks earlier, and
                calling it "reconstructed from the page" is simply untrue. */}
            {obj.painted
              ? 'hand-painted — pick a color to change it'
              : obj.src ? 'reconstructed from the surrounding page — pick a color to flatten' : 'drawn patches auto-match the paper'}
          </span>
        </div>
      )
    default:
      return (
        <span className="opt-label" style={{ textTransform: 'none', letterSpacing: 0 }}>
          Drag to move · handles to resize · ⌫ deletes · ⌘D duplicates
        </span>
      )
  }
}

/* ---------------- reshape tool status ---------------- */

function ReshapeOptions(): JSX.Element {
  const aiConfig = useStore((s) => s.aiConfig)
  const s = useStore.getState
  return (
    <div className="opt-group">
      {aiConfig ? (
        <>
          <span className="opt-label" style={{ textTransform: 'none', letterSpacing: 0 }}>
            Over YOUR text → blends it in · empty spot → new matching text · over print → <b className="mono" style={{ fontWeight: 600 }}>{aiConfig.model}</b> lifts it, nothing lost
          </span>
          <button className="btn outline" style={{ height: 26, fontSize: 12 }} onClick={() => s().openModal({ type: 'ai' })}>
            <Sparkles size={13} /> Change model
          </button>
        </>
      ) : (
        <>
          <span className="opt-label" style={{ textTransform: 'none', letterSpacing: 0 }}>
            {/* The gate is `!known && !cfg` — a model is needed only where the
                page has no text layer to read. Printed digital text is replaced
                locally, and telling people otherwise sent them to install a
                model to edit words the file already spells out. */}
            Empty spot → new matching text · printed text → replaced on the spot · words inside a picture need a model
          </span>
          <button className="btn primary" style={{ height: 26, fontSize: 12 }} onClick={() => s().openModal({ type: 'ai' })}>
            <Sparkles size={13} /> Connect
          </button>
        </>
      )}
    </div>
  )
}

/* ---------------- the bar ---------------- */

export function OptionsBar(): JSX.Element | null {
  const tool = useStore((s) => s.tool)
  const markupMode = useStore((s) => s.markupMode)
  const shapeMode = useStore((s) => s.shapeMode)
  const prefs = useStore((s) => s.prefs)
  const aiConfigured = useStore((s) => Boolean(s.aiConfig))
  const s = useStore.getState

  const pick = <K extends keyof Prefs>(k: K) => (v: Prefs[K]) => s().setPref(k, v)
  const lineMode = shapeMode === 'line' || shapeMode === 'arrow'

  return (
    <div className="optionsbar">
      {tool === 'select' && <SelectionOptions />}

      {tool === 'markup' && (
        <>
          <div className="opt-group">
            <div className="seg">
              <button className={markupMode === 'highlight' ? 'on' : ''} onClick={() => s().setMarkupMode('highlight')} title="Highlight">
                <Highlighter size={14} /> Highlight
              </button>
              <button className={markupMode === 'underline' ? 'on' : ''} onClick={() => s().setMarkupMode('underline')} title="Underline">
                <Underline size={14} />
              </button>
              <button className={markupMode === 'strike' ? 'on' : ''} onClick={() => s().setMarkupMode('strike')} title="Strike through">
                <Strikethrough size={14} />
              </button>
            </div>
          </div>
          <div className="divider-v" />
          <div className="opt-group">
            <span className="opt-label">Color</span>
            <Swatches colors={MARKUP_COLORS} value={prefs.markupColor} onPick={pick('markupColor')} />
          </div>
          <div className="divider-v" />
          <span className="opt-label" style={{ textTransform: 'none', letterSpacing: 0 }}>
            Drag a box over text — the marker snaps to exactly those lines
          </span>
        </>
      )}

      {tool === 'ink' && (
        <>
          <div className="opt-group">
            <span className="opt-label">Pen</span>
            <Swatches colors={INK_COLORS} value={prefs.inkColor} onPick={pick('inkColor')} />
          </div>
          <div className="divider-v" />
          <PrefWidthSlider prefKey="inkWidth" />
          <div className="divider-v" />
          <span className="opt-label" style={{ textTransform: 'none', letterSpacing: 0 }}>
            Each stroke lands selected — press P for the next one
          </span>
        </>
      )}

      {tool === 'text' && (
        <>
          <div className="opt-group">
            <span className="opt-label">Font</span>
            <span className="select-wrap">
              <select className="select" value={prefs.font} onChange={(e) => s().setPref('font', e.target.value as FontId)}>
                {FONT_IDS.map((id) => (
                  <option key={id} value={id}>{FONTS[id].label}</option>
                ))}
              </select>
            </span>
            <div className="stepper" title="Font size">
              <button onClick={() => s().setPref('textSize', Math.max(6, prefs.textSize - 1))}>−</button>
              <span className="val">{prefs.textSize}</span>
              <button onClick={() => s().setPref('textSize', Math.min(96, prefs.textSize + 1))}>+</button>
            </div>
            <button
              className={`btn-icon ${prefs.bold ? 'on' : ''}`}
              title="Bold"
              onClick={() => s().setPref('bold', !prefs.bold)}
            >
              <Bold size={15} />
            </button>
          </div>
          <div className="divider-v" />
          <div className="opt-group">
            <span className="opt-label">Color</span>
            <Swatches colors={TEXT_COLORS} value={prefs.textColor} onPick={pick('textColor')} />
          </div>
          <div className="divider-v" />
          <ToggleChip on={prefs.autoMatchText} label="Match print" onToggle={(v) => s().setPref('autoMatchText', v)} />
          <div className="divider-v" />
          <span className="opt-label" style={{ textTransform: 'none', letterSpacing: 0 }}>
            {prefs.autoMatchText ? 'Click to place — new text takes the surrounding style' : 'Click on the page to place text'}
          </span>
        </>
      )}

      {tool === 'note' && (
        <div className="opt-group">
          <span className="opt-label">Note color</span>
          <Swatches colors={NOTE_COLORS} value={prefs.noteColor} onPick={pick('noteColor')} />
          <span className="opt-label" style={{ textTransform: 'none', letterSpacing: 0, marginLeft: 10 }}>
            Exports as a real PDF comment
          </span>
        </div>
      )}

      {tool === 'shape' && (
        <>
          <div className="opt-group">
            <div className="seg">
              <button className={shapeMode === 'rect' ? 'on' : ''} onClick={() => s().setShapeMode('rect')} title="Rectangle"><Square size={14} /></button>
              <button className={shapeMode === 'ellipse' ? 'on' : ''} onClick={() => s().setShapeMode('ellipse')} title="Ellipse"><Circle size={14} /></button>
              <button className={shapeMode === 'line' ? 'on' : ''} onClick={() => s().setShapeMode('line')} title="Line"><Minus size={14} /></button>
              <button className={shapeMode === 'arrow' ? 'on' : ''} onClick={() => s().setShapeMode('arrow')} title="Arrow"><MoveUpRight size={14} /></button>
            </div>
          </div>
          <div className="divider-v" />
          {lineMode ? (
            <>
              <div className="opt-group">
                <span className="opt-label">Color</span>
                <Swatches colors={SHAPE_COLORS} value={prefs.shapeStroke} onPick={pick('shapeStroke')} />
              </div>
              <PrefWidthSlider prefKey="shapeWidth" />
            </>
          ) : (
            <>
              <div className="opt-group">
                <ToggleChip
                  on={prefs.shapeStrokeOn}
                  label="Stroke"
                  onToggle={(v) => {
                    s().setPref('shapeStrokeOn', v)
                    if (!v && !prefs.shapeFillOn) s().setPref('shapeFillOn', true) // never both off — swap
                  }}
                />
                <Swatches colors={SHAPE_COLORS} value={prefs.shapeStroke} disabled={!prefs.shapeStrokeOn} onPick={pick('shapeStroke')} />
              </div>
              <PrefWidthSlider prefKey="shapeWidth" />
              <div className="divider-v" />
              <div className="opt-group">
                <ToggleChip
                  on={prefs.shapeFillOn}
                  label="Fill"
                  onToggle={(v) => {
                    s().setPref('shapeFillOn', v)
                    if (!v && !prefs.shapeStrokeOn) s().setPref('shapeStrokeOn', true)
                  }}
                />
                <Swatches colors={FILL_COLORS} value={prefs.shapeFill} disabled={!prefs.shapeFillOn} onPick={pick('shapeFill')} />
              </div>
            </>
          )}
        </>
      )}

      {tool === 'image' && (
        <div className="opt-group">
          <button
            className="btn outline"
            onClick={async () => {
              const files = await pickFiles()
              if (!files.length) return // the picker was dismissed; nothing to say
              // Hand the whole selection to the same intake the drop target uses:
              // it takes GIF/BMP/WebP too (re-encoding them on the way in) and says
              // so when a file is not an image at all. This button used to accept
              // only PNG/JPEG and, for anything else, do nothing whatsoever.
              await openIncoming(files)
            }}
          >
            <ImagePlus size={15} /> Choose image…
          </button>
          <span className="opt-label" style={{ textTransform: 'none', letterSpacing: 0 }}>
            …or drag & drop a PNG / JPEG straight onto the page
          </span>
        </div>
      )}

      {tool === 'signature' && (
        <div className="opt-group">
          <button className="btn outline" onClick={() => s().openModal({ type: 'signature' })}>
            <Signature size={15} /> Signatures…
          </button>
          <span className="opt-label" style={{ textTransform: 'none', letterSpacing: 0 }}>
            Click on the page where you want to sign
          </span>
        </div>
      )}

      {tool === 'retype' && (
        <div className="opt-group">
          <Replace size={14} style={{ color: 'var(--ember)' }} />
          <span className="opt-label" style={{ textTransform: 'none', letterSpacing: 0 }}>
            Click any printed text — it becomes editable and stays looking identical when you change the words.
            {aiConfigured ? '' : ' Digital text works offline; a scanned page asks for a model once.'}
          </span>
          {!aiConfigured && (
            <button className="btn outline" style={{ height: 26, fontSize: 12 }} onClick={() => s().openModal({ type: 'ai' })}>
              <Sparkles size={13} /> Add a model (for scans)
            </button>
          )}
        </div>
      )}

      {tool === 'reshape' && <ReshapeOptions />}

      {tool === 'retouch' && (
        <>
          <div className="opt-group">
            <Paintbrush size={14} style={{ color: 'var(--ember)' }} />
            <span className="opt-label">Color</span>
            <Swatches colors={['#FFFFFF', '#000000', '#F4F1EA', '#212126', '#2456D6']} value={prefs.retouchColor} onPick={(c) => s().setPref('retouchColor', c)} />
          </div>
          <div className="divider-v" />
          <div className="opt-group" title="Brush size">
            <span className="opt-label">Size</span>
            <input type="range" min={1} max={30} value={prefs.retouchBrush} style={{ width: 90, accentColor: 'var(--ember)' }} onChange={(e) => s().setPref('retouchBrush', Number(e.target.value))} />
            <span className="mini-val">{prefs.retouchBrush}</span>
          </div>
          <div className="divider-v" />
          <span className="opt-label" style={{ textTransform: 'none', letterSpacing: 0 }}>
            Paint by hand to touch up stray pixels — pick a color, or grab one from the page with the pipette in the color picker
          </span>
        </>
      )}

      {tool === 'whiteout' && (
        <>
          <div className="opt-group">
            <div className="seg">
              <button className={prefs.eraseMode === 'brush' ? 'on' : ''} onClick={() => s().setPref('eraseMode', 'brush')} title="Paint over anything — the background is rebuilt underneath">
                Brush
              </button>
              <button className={prefs.eraseMode === 'box' ? 'on' : ''} onClick={() => s().setPref('eraseMode', 'box')} title="Drag a rectangle to patch">
                Box
              </button>
            </div>
          </div>
          {prefs.eraseMode === 'brush' && (
            <>
              <div className="divider-v" />
              <div className="opt-group" title="Brush size">
                <span className="opt-label">Size</span>
                <input
                  type="range"
                  min={4}
                  max={48}
                  value={prefs.eraseBrush}
                  style={{ width: 90, accentColor: 'var(--ember)' }}
                  onChange={(e) => s().setPref('eraseBrush', Number(e.target.value))}
                />
                <span className="mini-val">{prefs.eraseBrush}</span>
              </div>
            </>
          )}
          <div className="divider-v" />
          <span className="opt-label" style={{ textTransform: 'none', letterSpacing: 0 }}>
            {prefs.eraseMode === 'brush'
              // The brush PAINTS over. Its stroke is a shape, and a shape's
              // bounding box says nothing about which glyphs it actually
              // covered, so the exporter deliberately leaves shaped patches out
              // of the removal pass — the words stay in the file and pdftotext
              // still finds them. "Like it was never printed" said the opposite.
              ? 'Sweep over anything — the background is rebuilt behind it. The words stay in the file: use Box mode or Redact when removal has to be real'
              : 'Drag a box — the patch takes on the paper, gradients and grain underneath, and the covered words leave the file'}
          </span>
        </>
      )}

      {tool === 'redact' && (
        <span className="opt-label" style={{ textTransform: 'none', letterSpacing: 0 }}>
          Drag over sensitive content. On export it is cut out of the page’s own drawing instructions — the rest of the page stays real text. Only a page that cannot be cut safely is re-forged as an image.
        </span>
      )}

      {/* Lift and AI clean have nothing to configure — but an empty bar reads as a
          half-finished tool, so they say what to do instead. */}
      {tool === 'lift' && (
        <span className="opt-label" style={{ textTransform: 'none', letterSpacing: 0 }}>
          Click any element to pull it out as an editable object — click the same spot again to reach the one underneath. Enter lifts it, Esc cancels.
        </span>
      )}

      {tool === 'clean' && (
        <span className="opt-label" style={{ textTransform: 'none', letterSpacing: 0 }}>
          Draw around anything you want gone — a logo, a stamp, a photo. Your model works out where it ends; the real background underneath comes back with it.
        </span>
      )}
    </div>
  )
}
