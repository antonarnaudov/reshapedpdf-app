import { useEffect, useRef, useState } from 'react'
import { Sparkles, Wand2, X } from 'lucide-react'
import { useStore, useActiveDoc } from '../core/store'
import { exportDoc, extractPages, canUseFastPath, suggestedFileName, takeExportNotes } from '../pdf/exporter'
import { saveBytes } from '../native'
import { SignatureModal } from './SignatureModal'
import { PROVIDER_PRESETS, detectMachine, ramFitParamsB, estGBForParams } from '../ai/catalog'
import type { MachineInfo, ProviderPreset } from '../ai/catalog'
import {
  testConnection, listLocalModels, isVisionModelName, normalizeBaseUrl,
  fetchOllamaVisionCatalog, fetchOllamaSizeTags, ollamaPull,
} from '../ai/client'
import type { CatalogModel, LocalModel } from '../ai/client'
import type { DocState } from '../core/types'

/**
 * The frame every sheet sits in — and the keyboard behaviour they all owe the
 * user: focus lands inside, Tab cannot wander out behind the scrim, Escape closes,
 * and Enter does the obvious thing (`onConfirm`, wired by the sheets that have one
 * primary action) instead of nothing at all.
 */
function Shell({ title, children, wide, onConfirm }: {
  title: string; children: React.ReactNode; wide?: boolean; onConfirm?: () => void
}): JSX.Element {
  const close = useStore((s) => s.closeModal)
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const card = cardRef.current
    if (!card) return
    // focus the first thing worth typing into, else the card itself, so the very
    // first Tab moves WITHIN the sheet rather than into the page behind it
    const first = card.querySelector<HTMLElement>('input, select, textarea, button:not(.btn-icon)')
    ;(first ?? card).focus()
  }, [])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return }
    if (e.key === 'Enter' && onConfirm) {
      const t = e.target as HTMLElement
      // a textarea owns Enter, and a focused button owns its own activation
      if (t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON') return
      e.preventDefault()
      onConfirm()
      return
    }
    if (e.key !== 'Tab') return
    const card = cardRef.current
    if (!card) return
    const focusables = [...card.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((el) => el.offsetParent !== null)
    if (!focusables.length) return
    const firstEl = focusables[0], lastEl = focusables[focusables.length - 1]
    if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus() }
    else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus() }
  }

  return (
    <div className="modal-scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={cardRef}
        className={`modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="btn-icon" onClick={close} aria-label="Close"><X size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  )
}

/* ---------------- export ---------------- */

function ExportModal({ doc }: { doc: DocState }): JSX.Element {
  const s = useStore.getState
  const [name, setName] = useState(suggestedFileName(doc))
  const [flattenForms, setFlattenForms] = useState(false)
  const [optimize, setOptimize] = useState(true)
  const [trueRedact, setTrueRedact] = useState(true)
  const [pageNumbers, setPageNumbers] = useState(false)

  const hasFields = doc.fields.length > 0
  const hasRedactions = doc.objOrder.some((id) => doc.objects[id]?.kind === 'redact')
  const opts = { flattenForms, optimize, trueRedact: trueRedact && hasRedactions, pageNumbers }
  const formsPreserved = hasFields && canUseFastPath(doc, opts) && !flattenForms

  const run = async () => {
    s().setBusy('Forging your PDF…')
    try {
      const bytes = await exportDoc(doc, opts)
      // Anything the export could not take out of the file. Read immediately:
      // the notes belong to the export that just finished.
      const notes = takeExportNotes()
      const { ok, confirmed } = await saveBytes(name.endsWith('.pdf') ? name : `${name}.pdf`, bytes)
      if (ok) {
        // pass the doc the export was BUILT from — anything that landed while the
        // native Save dialog was open is not in the file and must stay Edited
        s().markSaved(doc.id, doc)
        s().toast(
          // `confirmed` is false only on the browsers with no save dialog, where a
          // download is handed to the browser and nothing can be observed after
          // that. Saying "Exported" there claims knowledge we do not have.
          confirmed
            ? `Exported — ${doc.pages.length} pages, ${(bytes.length / 1024).toFixed(0)} KB`
            : `Download started — ${doc.pages.length} pages, ${(bytes.length / 1024).toFixed(0)} KB. Check your downloads folder.`,
          'ok',
        )
        // Said after the success line, not instead of it: the file was written,
        // and this is the one thing about it the user would not otherwise know.
        // Silence here is how "removal is real" becomes untrue without anyone
        // finding out until a reader copies the text back out.
        for (const n of notes) s().toast(`Heads up — ${n}`, 'warn')
        s().closeModal()
      } else {
        // Cancelling the OS Save dialog used to close this modal too, throwing away
        // the typed filename and every option with nothing written and nothing said.
        // ExtractModal already gets this right; keep the sheet open so Export retries.
        s().toast('Export cancelled — nothing was written', 'info')
      }
    } catch (err) {
      console.error(err)
      s().toast('Export failed: ' + (err instanceof Error ? err.message : String(err)), 'error')
    } finally {
      s().setBusy(null)
    }
  }

  return (
    <Shell title="Export PDF" onConfirm={() => void run()}>
      <div className="modal-body">
        <div className="field">
          <label>File name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} autoFocus />
        </div>

        {hasFields && (
          <label className="check-row">
            <input type="checkbox" checked={flattenForms} onChange={(e) => setFlattenForms(e.target.checked)} />
            <span>
              <span className="cr-title">Flatten form fields</span>
              <div className="cr-sub">
                {/* canUseFastPath declines for three unrelated reasons, and this
                    used to name only one of them. On a form with a single
                    redaction and nothing else touched, it asserted that pages
                    had been merged or reordered — neither of which happened. */}
                {formsPreserved || flattenForms
                  ? 'Off: fields stay interactive with your values filled in. On: values become permanent ink.'
                  : trueRedact && hasRedactions
                    ? 'True redaction re-forges the marked pages, so field values are stamped as text either way — untick it above to keep the fields interactive.'
                    : 'Pages were merged or reordered, so field values are stamped as text either way.'}
              </div>
            </span>
          </label>
        )}

        {hasRedactions && (
          <label className="check-row">
            <input type="checkbox" checked={trueRedact} onChange={(e) => setTrueRedact(e.target.checked)} />
            <span>
              <span className="cr-title">True redaction</span>
              <div className="cr-sub">
                Redacted pages are re-forged as images so covered content is permanently removed — not just
                hidden. Text on those pages is no longer selectable.
              </div>
            </span>
          </label>
        )}

        <label className="check-row">
          <input type="checkbox" checked={pageNumbers} onChange={(e) => setPageNumbers(e.target.checked)} />
          <span>
            <span className="cr-title">Stamp page numbers</span>
            <div className="cr-sub">“1 / {doc.pages.length}” centered in every footer.</div>
          </span>
        </label>

        <label className="check-row">
          <input type="checkbox" checked={optimize} onChange={(e) => setOptimize(e.target.checked)} />
          <span>
            <span className="cr-title">Optimize size</span>
            <div className="cr-sub">Pack objects into compressed streams. Safe for all modern viewers.</div>
          </span>
        </label>
      </div>
      <div className="modal-foot">
        <button className="btn outline" onClick={() => s().closeModal()}>Cancel</button>
        <button className="btn primary" onClick={() => void run()}>Export</button>
      </div>
    </Shell>
  )
}

/* ---------------- extract ---------------- */

function parseRange(input: string, total: number): number[] {
  const out = new Set<number>()
  for (const tok of input.split(',')) {
    const t = tok.trim()
    if (!t) continue
    const m = t.match(/^(\d+)\s*[-–]\s*(\d+)$/)
    if (m) {
      const a = parseInt(m[1], 10)
      const b = parseInt(m[2], 10)
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (i >= 1 && i <= total) out.add(i)
    } else {
      const n = parseInt(t, 10)
      if (!Number.isNaN(n) && n >= 1 && n <= total) out.add(n)
    }
  }
  return [...out].sort((a, b) => a - b)
}

function ExtractModal({ doc }: { doc: DocState }): JSX.Element {
  const s = useStore.getState
  const [range, setRange] = useState(`1-${doc.pages.length}`)
  const pages = parseRange(range, doc.pages.length)

  const run = async () => {
    if (pages.length === 0) return
    s().setBusy('Extracting pages…')
    try {
      const ids = pages.map((n) => doc.pages[n - 1].id)
      const bytes = await extractPages(doc, ids)
      // saveBytes returns false when the user cancels the Save dialog — don't
      // claim success for a file that was never written.
      if ((await saveBytes(suggestedFileName(doc, `p${pages[0]}-${pages[pages.length - 1]}`), bytes)).ok) {
        s().toast(`Extracted ${pages.length} page${pages.length > 1 ? 's' : ''} to a new PDF`, 'ok')
        s().closeModal()
      }
    } catch (err) {
      s().toast('Extract failed: ' + (err instanceof Error ? err.message : String(err)), 'error')
    } finally {
      s().setBusy(null)
    }
  }

  return (
    <Shell title="Extract pages" onConfirm={() => { if (pages.length) void run() }}>
      <div className="modal-body">
        <div className="field">
          <label>Pages (e.g. 1-3, 7, 12)</label>
          <input className="input" value={range} onChange={(e) => setRange(e.target.value)} autoFocus />
        </div>
        <div className="rp-info">
          {pages.length > 0
            ? <>Selected <b>{pages.length}</b> of {doc.pages.length} pages. Annotations on them come along.</>
            : 'No valid pages selected yet.'}
        </div>
      </div>
      <div className="modal-foot">
        <button className="btn outline" onClick={() => s().closeModal()}>Cancel</button>
        <button className="btn primary" disabled={pages.length === 0} onClick={() => void run()}>Extract</button>
      </div>
    </Shell>
  )
}

/* ---------------- metadata ---------------- */

function MetadataModal({ doc }: { doc: DocState }): JSX.Element {
  const s = useStore.getState
  const [meta, setMeta] = useState(doc.meta)
  const upd = (k: keyof typeof meta) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setMeta({ ...meta, [k]: e.target.value })

  return (
    <Shell title="Document properties">
      <div className="modal-body">
        <div className="field"><label>Title</label><input className="input" value={meta.title} onChange={upd('title')} /></div>
        <div className="field"><label>Author</label><input className="input" value={meta.author} onChange={upd('author')} /></div>
        <div className="field"><label>Subject</label><input className="input" value={meta.subject} onChange={upd('subject')} /></div>
        <div className="field"><label>Keywords (comma-separated)</label><input className="input" value={meta.keywords} onChange={upd('keywords')} /></div>
        <div className="rp-info">Written into the PDF on export.</div>
      </div>
      <div className="modal-foot">
        <button className="btn outline" onClick={() => s().closeModal()}>Cancel</button>
        <button className="btn primary" onClick={() => { s().setMeta(meta); s().toast('Properties staged for export', 'ok'); s().closeModal() }}>
          Save
        </button>
      </div>
    </Shell>
  )
}

/* ---------------- shortcuts ---------------- */

const SHORTCUTS: [string, string][] = [
  ['⌘K', 'Command palette'], ['⌘O', 'Open files'], ['⌘S', 'Export PDF'], ['⌘F', 'Search'],
  ['⌘Z / ⇧⌘Z', 'Undo / redo'], ['⌘D', 'Duplicate selection'], ['⌫', 'Delete selection'],
  ['V', 'Select'], ['H', 'Highlight'], ['P', 'Pen'], ['T', 'Text'], ['N', 'Note'], ['S', 'Shapes'],
  ['I', 'Image'], ['E', 'Signature'],
  ['G', 'Retype — change printed words'], ['W', 'Erase'], ['B', 'Retouch brush'], ['X', 'Redact'], ['L', 'Lift an element out'],
  ['R', 'AI blend'], ['C', 'AI clean — draw around anything to remove it'],
  ['Space + drag', 'Pan the page'], ['⌘ + scroll', 'Zoom at cursor'], ['⌘0 / ⌘1', 'Fit width / 100%'],
  ['Arrows', 'Nudge selection'], ['⇧ + drag', 'Constrain shapes'], ['Esc', 'Deselect / back to Select'],
]

function ShortcutsModal(): JSX.Element {
  return (
    <Shell title="Keyboard shortcuts" wide>
      <div className="modal-body">
        <div className="sc-grid">
          {SHORTCUTS.map(([keys, what]) => (
            <div key={keys} className="sc-row">
              <span>{what}</span>
              <span className="keys"><span className="kbd">{keys}</span></span>
            </div>
          ))}
        </div>
      </div>
    </Shell>
  )
}

/* ---------------- live local-model manager ---------------- */

function LocalModelManager({
  presetId, baseUrl, machine, model, setModel,
}: {
  presetId: string
  baseUrl: string
  machine: MachineInfo | null
  model: string
  setModel: (m: string) => void
}): JSX.Element {
  const [installed, setInstalled] = useState<LocalModel[] | null>(null)
  const [serverDown, setServerDown] = useState(false)
  const [starting, setStarting] = useState(false)
  const [catalog, setCatalog] = useState<CatalogModel[] | 'loading' | null>('loading')
  const [tags, setTags] = useState<Record<string, { tag: string; paramsB: number }[] | 'loading' | null>>({})
  const [expanded, setExpanded] = useState<string | null>(null)
  const [pull, setPull] = useState<{ model: string; pct: number; status: string } | null>(null)
  const maxB = ramFitParamsB(machine?.ramGB ?? null)

  const startServer = async () => {
    const native = window.reshapedpdfNative
    if (!native?.startOllama) return
    setStarting(true)
    const res = await native.startOllama()
    if (!res.ok) {
      setStarting(false)
      useStore.getState().toast(
        res.reason === 'not-installed'
          ? 'Ollama isn’t installed — get it from ollama.com/download first'
          : `Could not start Ollama: ${res.reason}`,
        'warn',
      )
      return
    }
    // give the server a moment, then poll until it answers
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 800))
      try {
        const list = await listLocalModels(baseUrl)
        setInstalled(list)
        setServerDown(false)
        setStarting(false)
        useStore.getState().toast('Ollama is running', 'ok')
        return
      } catch { /* keep polling */ }
    }
    setStarting(false)
    useStore.getState().toast('Ollama didn’t come up — try starting it manually', 'warn')
  }

  const refreshInstalled = async () => {
    try {
      const list = await listLocalModels(baseUrl)
      setInstalled(list)
      setServerDown(false)
    } catch {
      setInstalled(null)
      setServerDown(true)
    }
  }

  useEffect(() => {
    void refreshInstalled()
    if (presetId === 'ollama') {
      void fetchOllamaVisionCatalog().then(setCatalog)
    } else {
      setCatalog(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetId, baseUrl])

  const expand = (name: string) => {
    setExpanded((cur) => (cur === name ? null : name))
    if (!tags[name]) {
      setTags((t) => ({ ...t, [name]: 'loading' }))
      void fetchOllamaSizeTags(name).then((res) => setTags((t) => ({ ...t, [name]: res })))
    }
  }

  const install = async (fullTag: string) => {
    setPull({ model: fullTag, pct: 0, status: 'starting' })
    try {
      await ollamaPull(baseUrl, fullTag, (pct, status) => setPull({ model: fullTag, pct, status }))
      setPull(null)
      setModel(fullTag)
      await refreshInstalled()
      useStore.getState().toast(`${fullTag} installed and selected`, 'ok')
    } catch (err) {
      setPull(null)
      useStore.getState().toast(`Install failed: ${err instanceof Error ? err.message : err}`, 'error')
    }
  }

  const looksVision = (m: LocalModel) => m.vision ?? isVisionModelName(m.id)
  const visionFirst = (installed ?? []).slice().sort((a, b) => Number(looksVision(b)) - Number(looksVision(a)))

  return (
    <div className="ai-note" style={{ borderStyle: 'solid' }}>
      <div style={{ marginBottom: 7 }}>
        <b style={{ color: 'var(--ink)' }}>On this machine</b>
        {machine?.ramGB != null && <span> — {machine.ramGB} GB RAM{machine.appleSilicon ? ' · Apple Silicon' : ''} → up to ~{maxB}B models</span>}
      </div>

      {serverDown && (
        <div style={{ color: 'var(--warn)', marginBottom: 8 }}>
          Can't reach {baseUrl} — is {presetId === 'ollama' ? 'Ollama' : 'the LM Studio server'} running{presetId === 'lmstudio' ? ' on port 1234' : ''}?
          {!window.reshapedpdfNative && import.meta.env.DEV && (
            <div style={{ fontSize: 11, marginTop: 3 }}>
              (Dev build: LM Studio :1234 and Ollama :11434 are proxied automatically — a custom host/port isn't. Check the server is up on its default port.)
            </div>
          )}
          {!window.reshapedpdfNative && !import.meta.env.DEV && (
            <div style={{ fontSize: 11, marginTop: 3 }}>
              (A browser build reaches the server from the page, so it must send CORS headers — or use the desktop app, which doesn't need them.)
            </div>
          )}
          {presetId === 'ollama' && window.reshapedpdfNative?.startOllama && (
            <button className="btn primary" style={{ height: 22, fontSize: 11, marginLeft: 8 }} disabled={starting} onClick={() => void startServer()}>
              {starting ? 'Starting…' : 'Start Ollama'}
            </button>
          )}
          <button className="btn outline" style={{ height: 22, fontSize: 11, marginLeft: 8 }} onClick={() => void refreshInstalled()}>Retry</button>
        </div>
      )}

      {installed !== null && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: presetId === 'ollama' ? 10 : 0 }}>
          {installed.length === 0 && <span style={{ color: 'var(--ink-faint)' }}>No models installed yet.</span>}
          {visionFirst.map((m) => (
            <button
              key={m.id}
              className={`btn outline ${model === m.id ? 'primary' : ''}`}
              style={{ height: 25, fontSize: 11.5, padding: '0 9px', fontFamily: 'var(--font-mono)' }}
              title={looksVision(m) ? 'Vision-capable — click to use' : 'Might not accept images'}
              onClick={() => setModel(m.id)}
            >
              {looksVision(m) ? '★ ' : ''}{m.id}
            </button>
          ))}
        </div>
      )}

      {presetId === 'ollama' && (
        <>
          <div style={{ margin: '4px 0 6px', color: 'var(--ink-dim)' }}>
            <b style={{ color: 'var(--ink)' }}>Latest vision models</b> — live from ollama.com{catalog === 'loading' ? '…' : ''}
          </div>
          {catalog === 'loading' && <span style={{ color: 'var(--ink-faint)' }}>Fetching the current catalog…</span>}
          {catalog === null && (
            <div style={{ color: 'var(--ink-dim)' }}>
              Couldn't fetch the live catalog here. Browse{' '}
              <a href="https://ollama.com/search?c=vision" target="_blank" rel="noreferrer" style={{ color: 'var(--ember)' }}>
                ollama.com/search?c=vision
              </a>{' '}
              — pick the newest VL/vision model ≤ ~{maxB}B for your RAM, then <code className="mono">ollama pull model:tag</code> and Retry above.
            </div>
          )}
          {Array.isArray(catalog) && (() => {
            const doc = catalog.filter((m) => m.docFocused)
            const general = catalog.filter((m) => !m.docFocused)
            const chip = (m: CatalogModel) => (
              <button
                key={m.name}
                className={`btn outline ${expanded === m.name ? 'primary' : ''}`}
                style={{ height: 25, fontSize: 11.5, padding: '0 9px', fontFamily: 'var(--font-mono)' }}
                onClick={() => expand(m.name)}
              >
                {m.name} ▾
              </button>
            )
            return (
              <>
                {doc.length > 0 && (
                  <>
                    <div style={{ fontSize: 10.5, letterSpacing: '0.07em', color: 'var(--ok)', margin: '2px 0 5px' }}>
                      BUILT FOR DOCUMENTS &amp; OCR — best fit for reading print
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>{doc.map(chip)}</div>
                  </>
                )}
                {general.length > 0 && (
                  <>
                    <div style={{ fontSize: 10.5, letterSpacing: '0.07em', color: 'var(--ink-faint)', margin: '2px 0 5px' }}>
                      GENERAL MULTIMODAL — vision-capable, usually larger
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{general.map(chip)}</div>
                  </>
                )}
              </>
            )
          })()}
          {expanded && (
            <div style={{ marginTop: 8 }}>
              {tags[expanded] === 'loading' && <span style={{ color: 'var(--ink-faint)' }}>Loading sizes…</span>}
              {tags[expanded] === null && <span style={{ color: 'var(--ink-faint)' }}>No size variants found — try <code className="mono">ollama pull {expanded}</code> manually.</span>}
              {Array.isArray(tags[expanded]) && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {(tags[expanded] as { tag: string; paramsB: number }[]).map(({ tag, paramsB }) => {
                    const fits = paramsB <= maxB
                    const full = `${expanded}:${tag}`
                    return (
                      <button
                        key={tag}
                        className="btn outline"
                        disabled={!fits || Boolean(pull)}
                        style={{ height: 25, fontSize: 11.5, padding: '0 9px', fontFamily: 'var(--font-mono)', opacity: fits ? 1 : 0.4 }}
                        title={fits ? `Install ${full} (~${estGBForParams(paramsB)} GB)` : `Too big for ${machine?.ramGB ?? '?'} GB RAM`}
                        onClick={() => void install(full)}
                      >
                        ⇣ {tag} · ~{estGBForParams(paramsB)} GB{!fits ? ' — too big' : ''}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )}
          {pull && (
            <div style={{ marginTop: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, marginBottom: 4 }}>
                <span className="mono">{pull.model}</span>
                <span className="mono" style={{ color: 'var(--ink-dim)' }}>{pull.pct >= 0 ? `${pull.pct}%` : pull.status}</span>
              </div>
              <div className="pull-bar"><span style={{ width: `${Math.max(pull.pct, 2)}%` }} /></div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/* ---------------- AI blending: bring your own model ---------------- */

function AiModal(): JSX.Element {
  const s = useStore.getState
  const existing = useStore((st) => st.aiConfig)
  const [presetId, setPresetId] = useState(existing?.presetId ?? 'ollama')
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? PROVIDER_PRESETS[0].baseUrl)
  const [model, setModel] = useState(existing?.model ?? PROVIDER_PRESETS[0].model)
  const [apiKey, setApiKey] = useState(existing?.apiKey ?? '')
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [machine, setMachine] = useState<MachineInfo | null>(null)

  useEffect(() => {
    void detectMachine().then(setMachine)
  }, [])

  const preset = PROVIDER_PRESETS.find((p) => p.id === presetId) ?? PROVIDER_PRESETS[0]
  const isLocalPreset = preset.local === true

  const pick = (p: ProviderPreset) => {
    if (p.comingSoon) return
    setPresetId(p.id)
    setBaseUrl(p.baseUrl)
    setModel(p.model)
    setTest(null)
  }

  const cfg = { presetId, baseUrl: baseUrl.trim(), model: model.trim(), apiKey: apiKey.trim() }
  const valid = cfg.baseUrl.length > 0 && cfg.model.length > 0

  const runTest = async () => {
    setTesting(true)
    setTest(null)
    setTest(await testConnection(cfg))
    setTesting(false)
  }

  return (
    <Shell title="AI blending — bring your own model" wide>
      <div className="modal-body">
        <div className="rp-info" style={{ marginBottom: 12 }}>
          The <b>AI edit</b> tool <Wand2 size={12} style={{ verticalAlign: -1 }} /> (press <span className="kbd">R</span>)
          reads any printed text you drag over and lets you retype it — the change is recomposed from the
          page’s own letters, so it looks like it was printed that way. It also blends text you’ve added
          into the surrounding print and adds new matched text on blank areas. Connect any vision model below.
          <b> Local models keep every pixel on your machine.</b>
        </div>

        <div className="ai-presets">
          {PROVIDER_PRESETS.map((p) => (
            <button
              key={p.id}
              className={`ai-preset ${presetId === p.id ? 'on' : ''} ${p.comingSoon ? 'soon' : ''}`}
              onClick={() => pick(p)}
              disabled={p.comingSoon}
            >
              <span className="ap-head">
                {p.label}
                {p.local && <span className="ap-badge">LOCAL</span>}
                {p.comingSoon && <span className="ap-badge soon">SOON</span>}
              </span>
              <span className="ap-blurb">{p.blurb}</span>
            </button>
          ))}
        </div>

        <div className="field" style={{ marginTop: 14 }}>
          <label>Endpoint (OpenAI-compatible /v1 root)</label>
          <input className="input mono" style={{ fontSize: 12, width: '100%' }} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:11434/v1" spellCheck={false} />
        </div>
        <div className="field">
          <label>Vision model</label>
          <input className="input mono" style={{ fontSize: 12, width: '100%' }} value={model} onChange={(e) => setModel(e.target.value)} placeholder="qwen2.5vl:3b" spellCheck={false} />
        </div>
        {(preset.needsKey || presetId === 'custom') && (
          <div className="field">
            <label>
              API key{' '}
              {preset.keyUrl && (
                <a href={preset.keyUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--ember)' }}>
                  (get one)
                </a>
              )}
            </label>
            <input className="input mono" style={{ fontSize: 12, width: '100%' }} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={preset.needsKey ? 'sk-…' : 'optional'} spellCheck={false} />
          </div>
        )}
        {isLocalPreset && (
          <LocalModelManager
            key={presetId + baseUrl}
            presetId={presetId}
            baseUrl={baseUrl}
            machine={machine}
            model={model}
            setModel={(m) => { setModel(m); setTest(null) }}
          />
        )}
        {preset.note && !isLocalPreset && <div className="ai-note">{preset.note}</div>}

        <div className="test-row">
          <button className="btn outline" disabled={!valid || testing} onClick={() => void runTest()}>
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          {test && (
            <span className={`test-result ${test.ok ? 'ok' : 'err'}`}>
              {test.ok ? '✓ ' : '✕ '}{test.message}
            </span>
          )}
        </div>
      </div>
      <div className="modal-foot">
        {existing && (
          <button
            className="btn"
            style={{ marginRight: 'auto', color: 'var(--danger)' }}
            onClick={() => { s().setAiConfig(null); s().toast('Model disconnected', 'info'); s().closeModal() }}
          >
            Disconnect
          </button>
        )}
        <button className="btn outline" onClick={() => s().closeModal()}>Cancel</button>
        <button
          className="btn primary"
          disabled={!valid}
          onClick={() => {
            s().setAiConfig({ ...cfg, baseUrl: normalizeBaseUrl(cfg.baseUrl) })
            s().toast('Connected — press R and drag over any printed text', 'ok')
            s().closeModal()
          }}
        >
          <Sparkles size={14} /> Save & use
        </button>
      </div>
    </Shell>
  )
}

/* ---------------- close unsaved ---------------- */

function ConfirmCloseModal({ docId }: { docId: string }): JSX.Element | null {
  const s = useStore.getState
  const doc = useStore((st) => st.docs[docId])
  if (!doc) return null
  return (
    <Shell title="Close without exporting?">
      <div className="modal-body">
        <div className="rp-info" style={{ fontSize: 13, lineHeight: 1.65 }}>
          <b>“{doc.name}”</b> has edits that haven't been exported. Close it now and they're
          gone — ReshapedPDF never touches your original file.
        </div>
      </div>
      <div className="modal-foot">
        <button className="btn outline" onClick={() => s().closeModal()}>Keep working</button>
        <button
          className="btn"
          style={{ color: 'var(--danger)', border: '1px solid var(--hairline-strong)' }}
          onClick={() => { s().closeModal(); s().closeDoc(docId) }}
        >
          Discard & close
        </button>
        <button
          className="btn primary"
          onClick={() => { s().closeModal(); s().setActive(docId); s().openModal({ type: 'export' }) }}
        >
          Export first
        </button>
      </div>
    </Shell>
  )
}

/* ---------------- host ---------------- */

export function Modals(): JSX.Element | null {
  const modal = useStore((s) => s.modal)
  const doc = useActiveDoc()
  if (!modal) return null

  switch (modal.type) {
    // Keyed by document: these sheets hold a filename and options typed FOR one
    // document, and React would otherwise keep the instance across a document
    // switch — so opening another PDF while the Export sheet was up left the
    // first file's name and settings pointed at the new file, ready to export the
    // wrong thing under the wrong name. A key remounts them with the right seed.
    case 'export':
      return doc ? <ExportModal key={doc.id} doc={doc} /> : null
    case 'extract':
      return doc ? <ExtractModal key={doc.id} doc={doc} /> : null
    case 'metadata':
      return doc ? <MetadataModal doc={doc} /> : null
    case 'shortcuts':
      return <ShortcutsModal />
    case 'ai':
      return <AiModal />
    case 'signature':
      return (
        <Shell title="Your signature" wide>
          <div className="modal-body">
            <SignatureModal placeAt={modal.placeAt} />
          </div>
        </Shell>
      )
    case 'confirm-close':
      return <ConfirmCloseModal docId={modal.docId} />
  }
}
