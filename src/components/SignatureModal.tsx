import { useEffect, useRef, useState } from 'react'
import { Trash2, Upload } from 'lucide-react'
import { useStore, activeDoc } from '../core/store'
import { capturePointer } from '../core/pointer'
import { pageViewSize } from '../pdf/registry'
import { pickFiles } from '../native'
import { bytesToDataUrl } from '../core/actions'
import { uid } from '../core/types'
import type { SignatureData } from '../core/types'

/** Crop a canvas to its non-transparent bounds and return a PNG data URL. */
function trimCanvas(canvas: HTMLCanvasElement): SignatureData | null {
  const ctx = canvas.getContext('2d')!
  const { width, height } = canvas
  const data = ctx.getImageData(0, 0, width, height).data
  let x1 = width, y1 = height, x2 = 0, y2 = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        x1 = Math.min(x1, x); y1 = Math.min(y1, y)
        x2 = Math.max(x2, x); y2 = Math.max(y2, y)
      }
    }
  }
  if (x2 <= x1 || y2 <= y1) return null
  const pad = 6
  x1 = Math.max(0, x1 - pad); y1 = Math.max(0, y1 - pad)
  x2 = Math.min(width - 1, x2 + pad); y2 = Math.min(height - 1, y2 + pad)
  const out = document.createElement('canvas')
  out.width = x2 - x1 + 1
  out.height = y2 - y1 + 1
  out.getContext('2d')!.drawImage(canvas, x1, y1, out.width, out.height, 0, 0, out.width, out.height)
  return { src: out.toDataURL('image/png'), w: out.width, h: out.height }
}

const SIG_FONTS = "'Snell Roundhand', 'Savoye LET', 'Segoe Script', 'Dancing Script', cursive"

export function SignatureModal({ placeAt }: { placeAt?: { page: string; x: number; y: number } }): JSX.Element {
  const s = useStore.getState
  const signatures = useStore((st) => st.signatures)
  const [tab, setTab] = useState<'draw' | 'type' | 'upload'>('draw')
  const [typed, setTyped] = useState('')
  const [inkColor, setInkColor] = useState('#1d2740')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawing = useRef<{ pts: [number, number][] } | null>(null)
  const [hasInk, setHasInk] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || tab !== 'draw') return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = canvas.clientWidth * dpr
    canvas.height = canvas.clientHeight * dpr
    const ctx = canvas.getContext('2d')!
    ctx.scale(dpr, dpr)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    setHasInk(false)
  }, [tab])

  const strokeTo = (pts: [number, number][]) => {
    const ctx = canvasRef.current!.getContext('2d')!
    ctx.strokeStyle = inkColor
    ctx.lineWidth = 2.4
    ctx.beginPath()
    if (pts.length < 3) {
      const [x, y] = pts[pts.length - 1]
      ctx.moveTo(x, y)
      ctx.lineTo(x + 0.1, y)
    } else {
      const n = pts.length
      ctx.moveTo((pts[n - 3][0] + pts[n - 2][0]) / 2, (pts[n - 3][1] + pts[n - 2][1]) / 2)
      ctx.quadraticCurveTo(pts[n - 2][0], pts[n - 2][1], (pts[n - 2][0] + pts[n - 1][0]) / 2, (pts[n - 2][1] + pts[n - 1][1]) / 2)
    }
    ctx.stroke()
  }

  const padPos = (e: React.PointerEvent): [number, number] => {
    const r = canvasRef.current!.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }

  const clearPad = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.getContext('2d')!.clearRect(0, 0, canvas.width, canvas.height)
    setHasInk(false)
  }

  const makeTyped = (): SignatureData | null => {
    const name = typed.trim()
    if (!name) return null
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')!
    // Size the canvas to the measured text so a long legal name is not clipped by a
    // fixed 900px width. Setting canvas.width RESETS the context, so measure first,
    // then re-apply the font/fill before drawing.
    ctx.font = `64px ${SIG_FONTS}`
    const w = Math.ceil(ctx.measureText(name).width)
    canvas.width = Math.max(200, w + 48)
    canvas.height = 240
    ctx.font = `64px ${SIG_FONTS}`
    ctx.fillStyle = inkColor
    ctx.textBaseline = 'middle'
    ctx.fillText(name, 24, 130)
    return trimCanvas(canvas)
  }

  const place = async (sig: SignatureData) => {
    const doc = activeDoc()
    if (!doc) return
    const ref = placeAt ? doc.pages.find((p) => p.id === placeAt.page) : doc.pages[doc.currentPage]
    if (!ref) return
    const pv = pageViewSize(ref)
    // place at roughly the size it was drawn — never blow a small signature up
    const w = Math.min(Math.max(sig.w * 0.42, 70), pv.w * 0.32, 200)
    const h = (sig.h / sig.w) * w
    const x = placeAt ? placeAt.x - w / 2 : (pv.w - w) / 2
    const y = placeAt ? placeAt.y - h / 2 : pv.h * 0.62
    s().addObject({
      id: uid(), page: ref.id, kind: 'image', opacity: 1, isSignature: true,
      x: Math.max(0, Math.min(x, pv.w - w)), y: Math.max(0, Math.min(y, pv.h - h)), w, h, src: sig.src,
    })
    s().setTool('select')
    s().closeModal()
    s().toast('Signed. Drag to fine-tune the position.', 'ok')
  }

  const saveAndPlace = async (sig: SignatureData | null) => {
    if (!sig) return
    s().addSignature(sig)
    await place(sig)
  }

  return (
    <>
      <div className="sig-tabs">
        <button className={tab === 'draw' ? 'on' : ''} onClick={() => setTab('draw')}>Draw</button>
        <button className={tab === 'type' ? 'on' : ''} onClick={() => setTab('type')}>Type</button>
        <button className={tab === 'upload' ? 'on' : ''} onClick={() => setTab('upload')}>Upload</button>
      </div>

      {tab === 'draw' && (
        <>
          <div className="sig-pad-wrap">
            <div className="baseline" />
            <canvas
              ref={canvasRef}
              className="sig-pad"
              onPointerDown={(e) => {
                capturePointer(e)
                drawing.current = { pts: [padPos(e)] }
                strokeTo(drawing.current.pts)
                setHasInk(true)
              }}
              onPointerMove={(e) => {
                if (!drawing.current) return
                drawing.current.pts.push(padPos(e))
                strokeTo(drawing.current.pts)
              }}
              onPointerUp={() => (drawing.current = null)}
            />
          </div>
          <div className="sig-row">
            <div className="swatches">
              {['#1d2740', '#17171B', '#2456D6'].map((c) => (
                <button key={c} className={`swatch ${inkColor === c ? 'active' : ''}`} style={{ background: c }} onClick={() => setInkColor(c)} />
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn outline" onClick={clearPad}>Clear</button>
              <button className="btn primary" disabled={!hasInk} onClick={() => void saveAndPlace(trimCanvas(canvasRef.current!))}>
                {placeAt ? 'Sign here' : 'Save signature'}
              </button>
            </div>
          </div>
        </>
      )}

      {tab === 'type' && (
        <>
          <input
            className="sig-type-input"
            style={{ fontFamily: SIG_FONTS, color: inkColor }}
            placeholder="Anton Arnaudov"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoFocus
          />
          <div className="sig-row">
            <div className="swatches">
              {['#1d2740', '#17171B', '#2456D6'].map((c) => (
                <button key={c} className={`swatch ${inkColor === c ? 'active' : ''}`} style={{ background: c }} onClick={() => setInkColor(c)} />
              ))}
            </div>
            <button className="btn primary" disabled={!typed.trim()} onClick={() => void saveAndPlace(makeTyped())}>
              {placeAt ? 'Sign here' : 'Save signature'}
            </button>
          </div>
        </>
      )}

      {tab === 'upload' && (
        <div style={{ textAlign: 'center', padding: '18px 0' }}>
          <button
            className="btn outline"
            onClick={async () => {
              const files = await pickFiles()
              const img = files[0]
              if (!img) return
              // Sniff a mime from the signature bytes — the browser sniffs anyway,
              // but a right label avoids a data URL some viewers reject. PNG/JPEG/
              // GIF/BMP/WebP all render; anything else the probe's onerror catches
              // so the user is told instead of the old silent no-op.
              const b = img.bytes
              const mime =
                b[0] === 0x89 ? 'image/png'
                  : b[0] === 0xff ? 'image/jpeg'
                    : b[0] === 0x47 ? 'image/gif'
                      : b[0] === 0x42 && b[1] === 0x4d ? 'image/bmp'
                      : b[0] === 0x52 && b[8] === 0x57 ? 'image/webp'
                        : 'image/png'
              const src = bytesToDataUrl(img.bytes, mime)
              const probe = new Image()
              probe.onload = () => void saveAndPlace({ src, w: probe.naturalWidth, h: probe.naturalHeight })
              probe.onerror = () => s().toast('Could not read that image', 'error')
              probe.src = src
            }}
          >
            <Upload size={15} /> Choose an image of your signature
          </button>
          <p style={{ color: 'var(--ink-faint)', fontSize: 12, marginTop: 10 }}>
            PNGs with transparent backgrounds look best.
          </p>
        </div>
      )}

      {signatures.length > 0 && (
        <>
          <div className="rp-title" style={{ margin: '16px 0 2px' }}>Saved signatures</div>
          <div className="sig-lib">
            {signatures.map((sig, i) => (
              <div key={i} className="sig-item" onClick={() => void place(sig)} title="Click to place">
                <img src={sig.src} alt={`Signature ${i + 1}`} />
                <button
                  className="sig-del"
                  onClick={(e) => {
                    e.stopPropagation()
                    s().removeSignature(i)
                  }}
                >
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  )
}
