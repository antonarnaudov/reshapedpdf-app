import { useEffect, useState } from 'react'
import { useStore, useActiveDoc, activeDoc } from '../core/store'
import { isElectron } from '../native'
import { openFilePicker, openIncoming, openSample, printActive, placeImageOnPage, TOOL_KEYS } from '../core/actions'
import { translateObj } from '../core/geometry'
import { exportDoc, canUseFastPath } from '../pdf/exporter'
import { loadPdfSource } from '../pdf/loader'
import { pageViewSize, pageGeom, getLibDoc } from '../pdf/registry'
import { walkPageContent, layersAt } from '../pdf/contentwalk'
import { ensureMatchFaces, identifyFace } from '../core/typematch'
import { getSamplingCanvas, renderPageWithoutText } from '../pdf/render'
import { blendObjects } from '../core/blend'
import { makeBlendedPatch, detectInkBands, makeBrushPatch } from '../pdf/patch'
import { runFontInfo } from '../pdf/fontinfo'
import { searchDoc, invalidateSearchCache } from '../pdf/textsearch'
import { wrapLines } from '../core/measure'
import { detectAlign, peelers } from './ObjectsLayer'
import { peelPage } from '../core/peel'
import { cloneTextLook } from '../core/retype'
import { FONTS, FONT_IDS } from '../core/types'
import { TopBar } from './TopBar'
import { ToolRail } from './ToolRail'
import { OptionsBar } from './OptionsBar'
import { Sidebar } from './Sidebar'
import { Viewer } from './Viewer'
import { RightPanel } from './RightPanel'
import { StatusBar } from './StatusBar'
import { EmptyState } from './EmptyState'
import { CommandPalette } from './CommandPalette'
import { Modals } from './Modals'
import { Toasts } from './Toasts'
import { UpdateBanner } from './UpdateBanner'

/* ---------------- keyboard shortcuts ---------------- */

let lastNudge = 0
let lastNudgeSig = '' // active doc + selection at the last nudge; a change starts a new undo unit

function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState()
      const typing = (e.target as HTMLElement)?.closest?.('input, textarea, select, [contenteditable]')
      const mod = e.metaKey || e.ctrlKey

      if (e.key === 'Escape') {
        if (s.modal) return s.closeModal()
        if (s.palette) return s.setPalette(false)
        if (s.editingText) return s.setEditingText(null)
        const d = activeDoc()
        if (d && d.selection.length) return s.setSelection([])
        if (s.tool !== 'select') return s.setTool('select')
        return
      }

      // A modal owns the screen — don't let page shortcuts fire underneath it
      // (Delete/Backspace removing the selected object while you type a filename,
      // a letter switching tools, arrows nudging). Escape, handled above, still
      // closes it. The command palette manages its own input focus.
      if (s.modal) return
      // The command palette is a modal-like overlay, but it only holds focus via
      // its input — click a non-focusable part of it and focus falls to <body>, so
      // `typing` goes null and the non-mod page shortcuts below would fire against
      // the hidden document (Delete removing the SELECTED object, letters switching
      // tools, arrows nudging) with no visible feedback. Block those while it's
      // open; mod combos (Cmd+K to close it) still pass through.
      if (s.palette && !mod) return

      if (mod) {
        const k = e.key.toLowerCase()
        // While typing in a field or the text editor, let the browser own the
        // native editing keys — Cmd+Z must undo the typed characters, not the
        // whole document (which wiped the field), and Cmd+D/F must not fire.
        if (typing && (k === 'z' || k === 'y' || k === 'd' || k === 'f')) return
        if (k === 'k') { e.preventDefault(); return s.setPalette(!s.palette) }
        if (k === 'o') { e.preventDefault(); return void openFilePicker() }
        if (k === 's') { e.preventDefault(); if (activeDoc()) s.openModal({ type: 'export' }); return }
        if (k === 'z') { e.preventDefault(); return e.shiftKey ? s.redo() : s.undo() }
        if (k === 'y') { e.preventDefault(); return s.redo() }
        if (k === 'f') {
          e.preventDefault()
          if (activeDoc()) {
            if (s.panel !== 'search') s.setPanel('search')
            else document.querySelector<HTMLInputElement>('.search-box input')?.select()
          }
          return
        }
        if (k === 'p') { e.preventDefault(); if (activeDoc()) void printActive(); return }
        if (k === 'd') { e.preventDefault(); if (!e.repeat) s.duplicateSelection(); return } // holding it must not cascade
        if (k === '=' || k === '+') { e.preventDefault(); return s.setZoom(s.zoom * 1.2) }
        if (k === '-') { e.preventDefault(); return s.setZoom(s.zoom / 1.2) }
        if (k === '0') { e.preventDefault(); return s.setFit('width') }
        if (k === '1') { e.preventDefault(); return s.setZoom(1) }
        return
      }

      if (typing) return

      const d = activeDoc()
      if (e.key === '?') { e.preventDefault(); return s.openModal({ type: 'shortcuts' }) }

      if (d && (e.key === 'PageDown' || e.key === 'PageUp')) {
        e.preventDefault()
        const next = d.currentPage + (e.key === 'PageDown' ? 1 : -1)
        const ref = d.pages[Math.max(0, Math.min(d.pages.length - 1, next))]
        if (ref) s.requestScroll(ref.id)
        return
      }

      if (d && (e.key === 'Delete' || e.key === 'Backspace') && d.selection.length) {
        e.preventDefault()
        return s.removeObjects(d.selection)
      }

      if (d && d.selection.length && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault()
        const step = e.shiftKey ? 10 : 1
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
        // Coalesce a streak of nudges into ONE undo step — but only within the
        // same selection on the same doc. Nudging A, then quickly selecting B and
        // nudging it, must be two undo units, not one.
        const now = Date.now()
        const sig = `${s.active}:${d.selection.join(',')}`
        if (now - lastNudge > 650 || sig !== lastNudgeSig) s.commitNow()
        lastNudge = now
        lastNudgeSig = sig
        for (const id of d.selection) {
          const o = activeDoc()?.objects[id]
          if (o) s.replaceObject(translateObj(o, dx, dy))
        }
        return
      }

      if (d) {
        // Taken from TOOL_ACTIONS itself, which is also what prints the letter in
        // the rail tooltip, the command palette and the shortcuts sheet. The map
        // used to be typed out again here, so the newest tool advertised a key
        // in three places and did nothing when it was pressed.
        const t = TOOL_KEYS[e.key.toLowerCase()]
        if (t) return s.setTool(t)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/* ---------------- drag & drop ---------------- */

function useDropFiles(): boolean {
  const [dragging, setDragging] = useState(false)
  useEffect(() => {
    let depth = 0
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth++
      setDragging(true)
    }
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    // A drop of an editable field's own text (drag selected text into an input /
    // textarea) must keep its NATIVE insert — those elements are drop targets by
    // default, so we simply don't cancel there. Everywhere else we cancel a stray
    // non-file drop so the browser can't navigate the SPA away and lose the session.
    const intoEditable = (e: DragEvent) =>
      !hasFiles(e) && e.target instanceof HTMLElement && !!e.target.closest('input, textarea, [contenteditable]')
    const onOver = (e: DragEvent) => {
      if (!intoEditable(e)) e.preventDefault()
    }
    const onDrop = async (e: DragEvent) => {
      if (!intoEditable(e)) e.preventDefault()
      if (!hasFiles(e)) return
      depth = 0
      setDragging(false)

      // if dropped onto a page, note where (image stamps land under the cursor)
      let dropAt: { page: string; x: number; y: number } | undefined
      const el = (document.elementsFromPoint(e.clientX, e.clientY) as HTMLElement[])
        .find((n) => n.dataset?.pageId)
      if (el) {
        const r = el.getBoundingClientRect()
        const zoom = useStore.getState().zoom
        dropAt = { page: el.dataset.pageId!, x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom }
      }

      const files: { name: string; bytes: Uint8Array }[] = []
      for (const f of Array.from(e.dataTransfer?.files ?? [])) {
        files.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })
      }
      if (files.length) await openIncoming(files, dropAt)
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  // Warn before the window unloads (refresh, close, accidental navigation) while
  // any document has unsaved edits — the whole session is in memory. Web build
  // only: in Electron the native window close is the main process's to own, and a
  // renderer beforeunload prompt would fight it.
  // Desktop: the main process owns the guard, so keep it told how many documents
  // are dirty. Without this ⌘W / ⌘Q / ⌘R end the session with no prompt at all.
  useEffect(() => {
    const native = window.reshapedpdfNative
    if (!native?.setDirtyCount) return
    const push = (s: { docs: Record<string, { dirty: boolean }> }) =>
      native.setDirtyCount!(Object.values(s.docs).filter((d) => d.dirty).length)
    push(useStore.getState())
    return useStore.subscribe(push)
  }, [])

  useEffect(() => {
    if (window.reshapedpdfNative) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (Object.values(useStore.getState().docs).some((d) => d.dirty)) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  return dragging
}

/* ---------------- native shell (Electron menu + OS file opens) ---------------- */

function useNativeShell(): void {
  useEffect(() => {
    const native = window.reshapedpdfNative
    if (!native) return

    native.onMenu?.((id) => {
      const s = useStore.getState()
      const typing = document.activeElement?.closest?.('input, textarea, [contenteditable]')
      switch (id) {
        case 'open': void openFilePicker(); break
        case 'export': if (activeDoc()) s.openModal({ type: 'export' }); break
        case 'print': if (activeDoc()) void printActive(); break
        // A native-menu Undo bypasses the renderer's modal guard (a DOM veil can't
        // block the OS menu bar). Mutating the doc mid-export makes the written bytes
        // stale and markSaved then clears dirty against the changed model — a false
        // 'Saved'. Block document undo/redo only while a MODAL is open (the export
        // modal stays open through the whole export/save await, which is the case
        // that matters); do NOT gate on `busy`, since peel sets busy yet stays fully
        // interactive (its veil is suppressed) and undo legitimately works there.
        // Field-level undo (a focused input) is safe and still works.
        case 'undo': if (typing) document.execCommand('undo'); else if (!s.modal) s.undo(); break
        case 'redo': if (typing) document.execCommand('redo'); else if (!s.modal) s.redo(); break
        case 'zoom-in': s.setZoom(s.zoom * 1.2); break
        case 'zoom-out': s.setZoom(s.zoom / 1.2); break
        case 'fit-width': s.setFit('width'); break
        case 'zoom-100': s.setZoom(1); break
        case 'theme': s.setTheme(s.theme === 'dark' ? 'light' : 'dark'); break
        case 'shortcuts': s.openModal({ type: 'shortcuts' }); break
        case 'ai': s.openModal({ type: 'ai' }); break
      }
    })

    native.onOpenFile?.((f) => {
      void openIncoming([{ name: f.name, bytes: new Uint8Array(f.bytes) }])
    })
  }, [])
}

/* ---------------- debug / automation hooks ---------------- */

function useFontPreload(): void {
  useEffect(() => {
    for (const id of FONT_IDS) {
      void document.fonts.load(`400 16px ${FONTS[id].stack}`)
      void document.fonts.load(`700 16px ${FONTS[id].stack}`)
    }
  }, [])
}

/**
 * Whether this build should expose its innards.
 *
 * The hooks below hand out the whole document model, mutation included, which is
 * exactly what a test harness needs and exactly what a shipped application
 * should not leave lying on `window`. On during development, and in a packaged
 * build only when it was started with --enable-automation.
 */
const AUTOMATION =
  import.meta.env.DEV ||
  (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('automation'))

function useDebugHooks(): void {
  useEffect(() => {
    if (!AUTOMATION) return
    window.__reshapedpdf = {
      openSample: () => void openSample(),
      openBase64: (b64: string, name: string) => {
        const bin = atob(b64)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        return useStore.getState().openPdfBytes(name, bytes)
      },
      exportActive: async (opts?: { flattenForms?: boolean; optimize?: boolean; trueRedact?: boolean }) => {
        const d = activeDoc()
        if (!d) return null
        const bytes = await exportDoc(d, { flattenForms: false, optimize: true, trueRedact: true, ...opts })
        let bin = ''
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        return { size: bytes.length, b64: btoa(bin) }
      },
      state: () => useStore.getState(),
      blendPatch: (canvas: HTMLCanvasElement, r: { x: number; y: number; w: number; h: number }, pageW: number) =>
        makeBlendedPatch(canvas, r, pageW),
      detectInkBands: (canvas: HTMLCanvasElement, r: { x: number; y: number; w: number; h: number }, pageW: number) =>
        detectInkBands(canvas, r, pageW),
      brushPatch: (canvas: HTMLCanvasElement, strokes: [number, number][][], radius: number, pageW: number) =>
        makeBrushPatch(canvas, strokes, radius, pageW),
      samplingCanvas: (idx: number) => {
        const d = activeDoc()
        return d ? getSamplingCanvas(d.pages[idx]) : null
      },
      blend: (ids: string[]) => blendObjects(ids),
      recloneText: (id: string, minCoverage = 0.7) => cloneTextLook(id, { minCoverage, silent: true }),
      bgWithout: async (pageIdx: number, rects: { x: number; y: number; w: number; h: number }[]) => {
        const d = activeDoc()
        return d ? renderPageWithoutText(d.pages[pageIdx], rects) : null
      },
      pageSize: (pageIdx: number) => {
        const d = activeDoc()
        return d ? pageViewSize(d.pages[pageIdx]) : null
      },
      identifyFace: async (pageIdx: number, band: { x: number; y: number; w: number; h: number }, text: string, hintSize: number, inkHex?: string, scale?: number) => {
        const d = activeDoc()
        if (!d) return null
        await ensureMatchFaces()
        const cv = scale
          ? await renderPageWithoutText(d.pages[pageIdx], [], scale)
          : await getSamplingCanvas(d.pages[pageIdx])
        return identifyFace(cv, band, text, pageViewSize(d.pages[pageIdx]).w, hintSize, inkHex)
      },
      fontAt: (pageIdx: number, x: number, y: number) => {
        const d = activeDoc()
        return d ? runFontInfo(d.pages[pageIdx], x, y) : null
      },
      peelElements: async (pageIdx: number) => {
        const d = activeDoc()
        if (!d) return null
        const fn = peelers.get(d.pages[pageIdx].id)
        return fn ? await fn() : null
      },
      peelPage: (pageIdx: number, maxBlocks?: number) => {
        const d = activeDoc()
        return d ? peelPage(d.pages[pageIdx], maxBlocks ? { maxBlocks } : undefined) : null
      },
      searchActive: async (query: string) => {
        const d = activeDoc()
        if (!d) return null
        invalidateSearchCache()
        const m = await searchDoc(d, query)
        return m.map((x) => ({ page: x.page, pageIndex: x.pageIndex, rects: x.rects, snippet: x.snippet }))
      },
      wrapLines: (text: string, font: string, size: number, bold: boolean, maxW: number, tracking = 0) =>
        wrapLines(text, font as never, size, bold, maxW, false, undefined, tracking),
      detectAlign: (spans: { x: number; y: number; w: number; h: number }[], rect: { x: number; y: number; w: number; h: number }) =>
        detectAlign(spans, rect),
      canFastPath: () => {
        const d = activeDoc()
        return d ? canUseFastPath(d, { flattenForms: false, optimize: true, trueRedact: false }) : null
      },
      placeImage: (src: string, at?: { page: string; x: number; y: number }) => placeImageOnPage(src, at),
      mergeBytes: async (b64: string) => {
        const bin = atob(b64)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        const loaded = await loadPdfSource(bytes)
        const s = useStore.getState()
        const d = activeDoc()
        if (!d) return null
        s.insertPagesFromSource(loaded, d.currentPage, loaded.initialValues)
        return loaded.pageRefs.map((p) => p.id)
      },
      walkPage: async (pageIdx: number) => {
        const d = activeDoc()
        if (!d) return null
        const ref = d.pages[pageIdx]
        const doc = await getLibDoc(ref.srcId)
        return walkPageContent(doc, doc.getPage(ref.srcIndex)).elements.map(
          ({ kind, userBox, z, axisAligned, depth, formPath, detail }) => ({
            kind, userBox, z, axisAligned, depth, formPath,
            // enough of the detail to tell a vectorisable path from a picture,
            // without shipping the whole path geometry across the wire
            detail: detail.kind === 'path'
              ? { kind: detail.kind, painted: detail.painted, subpaths: detail.subpaths, dLen: (detail.d ?? '').length }
              : { kind: detail.kind },
          }),
        )
      },
      liftAt: async (pageIdx: number, x: number, y: number, descend = 0) => {
        const d = activeDoc()
        if (!d) return null
        const ref = d.pages[pageIdx]
        const doc = await getLibDoc(ref.srcId)
        const hits = layersAt(walkPageContent(doc, doc.getPage(ref.srcIndex)).elements, pageGeom(ref), x, y)
        const h = hits[Math.min(descend, hits.length - 1)]
        return hits.length ? { count: hits.length, picked: h.kind, depth: h.depth, stack: hits.map((e) => `${e.kind}@${e.depth}`) } : null
      },
    } as unknown as Window['__reshapedpdf']
  }, [])
}

/* ---------------- app shell ---------------- */

export function App(): JSX.Element {
  const doc = useActiveDoc()
  const rightPanel = useStore((s) => s.rightPanel)
  const busy = useStore((s) => s.busy)
  useShortcuts()
  useNativeShell()
  useDebugHooks()
  useFontPreload()
  const dragging = useDropFiles()

  const electronMac = isElectron() && window.reshapedpdfNative?.platform === 'darwin'

  return (
    <div className={`app ${electronMac ? 'electron-mac' : ''}`}>
      <TopBar />
      {doc && <OptionsBar />}
      <div className="workspace">
        {doc && <ToolRail />}
        {doc && <Sidebar />}
        {doc ? <Viewer key={doc.id} /> : <EmptyState />}
        {doc && rightPanel && <RightPanel />}
      </div>
      {doc && <StatusBar />}
      <CommandPalette />
      <Modals />
      <UpdateBanner />
      <Toasts />
      {dragging && <div className="drop-overlay">Drop PDFs or images — ReshapedPDF takes it from here</div>}
      {/* Peel runs for a long time and MUST stay cancellable — it shows its own
          inline progress + Stop button in the AI card, so it must not raise the
          full-screen veil (which would bury that Stop button and freeze the app
          for the whole run). Every other busy state is brief and blocks safely. */}
      {busy && !(busy.startsWith('Peeling') || busy.startsWith('Finding the text')) && (
        <div className="busy-veil">
          <div className="busy-card"><span className="spark" />{busy}</div>
        </div>
      )}
    </div>
  )
}
