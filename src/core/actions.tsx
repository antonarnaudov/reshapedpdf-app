import type { ComponentType } from 'react'
import {
  Circle, Command, Copy, Download, EyeOff, Eraser, FilePlus2, FileOutput, FileText, FolderOpen,
  Highlighter, ImagePlus, Keyboard, LayoutGrid, MessageSquareText, Moon, MousePointer2, MoveUpRight,
  PanelRight, PenLine, Printer, RotateCcw, RotateCw, Scissors, Search, Shapes, Signature, Sparkles,
  Square, StickyNote, Sun, Trash2, Type, Undo2, Redo2, Wand2, ZoomIn, ZoomOut, Maximize, FilePlus,
  Replace, Paintbrush, Layers,
} from 'lucide-react'
import { useStore, activeDoc } from './store'
import { openTempPdf, pickFiles } from '../native'
import { makeSamplePdf, makeBlankPdf, makePdfFromImages } from '../pdf/sample'
import { loadPdfSource } from '../pdf/loader'
import { exportDoc } from '../pdf/exporter'
import { pageViewSize } from '../pdf/registry'
import { uid } from './types'
import type { ToolId } from './types'

/* ---------------- file intake ---------------- */

export const bytesToDataUrl = (bytes: Uint8Array, mime: string): string => {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return `data:${mime};base64,${btoa(bin)}`
}

const isPdf = (f: { name: string; bytes: Uint8Array }): boolean =>
  /\.pdf$/i.test(f.name) || (f.bytes[0] === 0x25 && f.bytes[1] === 0x50 && f.bytes[2] === 0x44)

const imageMime = (f: { name: string; bytes: Uint8Array }): string | null => {
  const b = f.bytes
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
  // PDF can only carry PNG/JPEG, but the browser decodes these too and
  // loadImageNormalized re-encodes them to PNG — so accepting them is safe and
  // beats telling someone their screenshot "isn't an image".
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp'
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp'
  if (/\.png$/i.test(f.name)) return 'image/png'
  if (/\.jpe?g$/i.test(f.name)) return 'image/jpeg'
  if (/\.gif$/i.test(f.name)) return 'image/gif'
  if (/\.bmp$/i.test(f.name)) return 'image/bmp'
  if (/\.webp$/i.test(f.name)) return 'image/webp'
  return null
}

// Load an image AND normalise EXIF orientation. The on-screen <img> and canvas
// both render a phone JPEG upright (browsers apply EXIF), but pdf-lib's JPEG
// embedder ignores EXIF and would export the raw (rotated, dimension-swapped)
// pixels into the upright box — the saved file would not match the preview. Draw
// the decoded (already-corrected) image to a canvas so the orientation is BAKED
// into the pixels, and stamp THAT. Only re-encode a JPEG (PNG carries no
// orientation); a tainted/oversize canvas falls back to the raw source.
const loadImageNormalized = (src: string): Promise<{ w: number; h: number; src: string }> =>
  new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const w = img.naturalWidth, h = img.naturalHeight
      const isJpeg = src.startsWith('data:image/jpeg')
      // A PDF can only carry PNG or JPEG. Anything else (GIF, BMP, WebP) has to be
      // re-encoded here or the export throws when pdf-lib is handed bytes it cannot
      // parse — and that failure takes the WHOLE export down, not just the picture.
      const needsPng = !isJpeg && !src.startsWith('data:image/png')
      if (!isJpeg && !needsPng) return resolve({ w, h, src })
      try {
        const c = document.createElement('canvas')
        c.width = w; c.height = h
        c.getContext('2d')!.drawImage(img, 0, 0, w, h)
        resolve({ w, h, src: needsPng ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.92) })
      } catch {
        resolve({ w, h, src })
      }
    }
    img.onerror = reject
    img.src = src
  })

/** Place an image as a stamp on the current page of the active doc. */
export async function placeImageOnPage(src: string, at?: { page: string; x: number; y: number }): Promise<void> {
  const doc = activeDoc()
  if (!doc) return
  const ref = at ? doc.pages.find((p) => p.id === at.page) : doc.pages[doc.currentPage]
  if (!ref) return
  const size = await loadImageNormalized(src)
  // The active doc may have changed while the image decoded (a big photo is
  // hundreds of ms). Appending it now would tag it with a page id that doesn't
  // exist in the newly-active doc — the image vanishes and the wrong doc dirties.
  const s = useStore.getState()
  if (s.active !== doc.id) return
  const pv = pageViewSize(ref)
  const scale = Math.min(1, (pv.w * 0.42) / size.w, (pv.h * 0.42) / size.h)
  const w = size.w * scale
  const h = size.h * scale
  const x = at ? at.x - w / 2 : (pv.w - w) / 2
  const y = at ? at.y - h / 2 : (pv.h - h) / 2
  s.addObject({
    id: uid(), page: ref.id, kind: 'image', opacity: 1,
    x: Math.max(0, x), y: Math.max(0, y), w, h, src: size.src,
  })
  s.setTool('select')
}

/** Route incoming files: PDFs open as documents; images become stamps (doc open) or a new doc. */
export async function openIncoming(
  files: { name: string; bytes: Uint8Array }[],
  dropAt?: { page: string; x: number; y: number },
): Promise<void> {
  const s = useStore.getState()
  const pdfs = files.filter(isPdf)
  const images = files.filter((f) => !isPdf(f) && imageMime(f))
  // Anything that is neither. Dropping a .docx or a .zip used to do absolutely
  // nothing — no message, no flicker — which reads as a broken drop target rather
  // than an unsupported file, and the user tries again and again.
  const rejected = files.filter((f) => !isPdf(f) && !imageMime(f))
  if (rejected.length) {
    const names = rejected.slice(0, 2).map((f) => `“${f.name}”`).join(', ')
    s.toast(
      `${names}${rejected.length > 2 ? ` and ${rejected.length - 2} more` : ''} — ReshapedPDF opens PDFs and images (PNG, JPEG, GIF, BMP, WebP).`,
      'warn',
    )
  }
  for (const f of pdfs) await s.openPdfBytes(f.name, f.bytes)
  if (images.length === 0) return

  if (activeDoc() && pdfs.length === 0) {
    let placed = 0
    for (const img of images) {
      // A corrupt/mislabeled image throws in the data-URL/decode path; don't let
      // one bad file abort the batch or surface as an unhandled rejection.
      try { await placeImageOnPage(bytesToDataUrl(img.bytes, imageMime(img)!), dropAt); placed++ } catch { /* skip */ }
    }
    if (placed) s.toast(`${placed > 1 ? placed + ' images' : 'Image'} placed${placed < images.length ? `, ${images.length - placed} skipped` : ''} — drag to position`, 'ok')
    else s.toast('That image could not be placed (corrupt or unsupported)', 'error')
  } else {
    s.setBusy('Building PDF from images…')
    try {
      const bytes = await makePdfFromImages(images.map((i) => ({ bytes: i.bytes, type: imageMime(i)! })))
      await s.openPdfBytes(images[0].name.replace(/\.(png|jpe?g)$/i, ''), bytes)
    } catch (err) {
      s.toast(`Could not open image${images.length > 1 ? 's' : ''}: ${err instanceof Error ? err.message : 'corrupt or unsupported'}`, 'error')
    } finally {
      s.setBusy(null)
    }
  }
}

export async function openFilePicker(): Promise<void> {
  const files = await pickFiles()
  if (files.length) await openIncoming(files)
}

export async function openSample(): Promise<void> {
  const s = useStore.getState()
  s.setBusy('Forging the sample…')
  try {
    const bytes = await makeSamplePdf()
    await s.openPdfBytes('ReshapedPDF sample', bytes)
  } finally {
    s.setBusy(null)
  }
}

export async function newBlankDoc(): Promise<void> {
  const bytes = await makeBlankPdf()
  await useStore.getState().openPdfBytes('Untitled', bytes)
}

export async function insertPdfAfterCurrent(): Promise<void> {
  const s = useStore.getState()
  const doc = activeDoc()
  if (!doc) return
  const files = await pickFiles()
  const pdf = files.find(isPdf)
  if (!pdf) return
  s.setBusy('Merging…')
  try {
    const loaded = await loadPdfSource(pdf.bytes)
    s.insertPagesFromSource(loaded, doc.currentPage, loaded.initialValues)
    s.toast(`Merged ${loaded.pageRefs.length} page${loaded.pageRefs.length > 1 ? 's' : ''} from “${pdf.name}”`, 'ok')
  } catch {
    s.toast(`Could not merge “${pdf.name}”`, 'error')
  } finally {
    s.setBusy(null)
  }
}

/** Export the active document and hand it to the system viewer for printing. */
export async function printActive(): Promise<void> {
  const s = useStore.getState()
  const doc = activeDoc()
  if (!doc) return
  s.setBusy('Preparing to print…')
  try {
    const bytes = await exportDoc(doc, { flattenForms: false, optimize: true, trueRedact: true })
    await openTempPdf(`${doc.name}.pdf`, bytes)
  } catch (err) {
    s.toast('Print failed: ' + (err instanceof Error ? err.message : String(err)), 'error')
  } finally {
    s.setBusy(null)
  }
}

/* ---------------- command registry ---------------- */

export interface Action {
  id: string
  title: string
  group: string
  icon?: ComponentType<{ size?: number | string }>
  kbd?: string
  when?: () => boolean
  run: () => void | Promise<void>
}

const S = () => useStore.getState()
const hasDoc = () => Boolean(activeDoc())
const currentPageId = () => {
  const d = activeDoc()
  return d ? d.pages[d.currentPage]?.id : undefined
}

// group: undefined = insert/annotate (the default top block); 'edit' = change the
// page itself, all local; 'ai' = needs a connected model. assist marks a local
// tool that CAN reach for a model in one case (retype reads scanned text) but
// works without one — so the overlap is shown, not hidden behind the AI banner.
export const TOOL_ACTIONS: {
  id: ToolId; title: string; kbd: string; icon: Action['icon']; group?: 'edit' | 'ai'; assist?: boolean
}[] = [
  // ---- insert & annotate (all local) ----
  { id: 'select', title: 'Select & move', kbd: 'V', icon: MousePointer2 },
  { id: 'markup', title: 'Highlight text', kbd: 'H', icon: Highlighter },
  { id: 'ink', title: 'Draw freehand', kbd: 'P', icon: PenLine },
  { id: 'text', title: 'Add text', kbd: 'T', icon: Type },
  { id: 'note', title: 'Sticky note', kbd: 'N', icon: StickyNote },
  { id: 'shape', title: 'Shapes & arrows', kbd: 'S', icon: Shapes },
  { id: 'image', title: 'Place image', kbd: 'I', icon: ImagePlus },
  { id: 'signature', title: 'Sign', kbd: 'E', icon: Signature },
  // ---- edit the page (local; retype reaches for a model only to read scans) ----
  { id: 'retype', title: 'Retype — click printed text to change the words (stays looking identical). Digital text works offline; a scan asks for a model once', kbd: 'G', icon: Replace, group: 'edit', assist: true },
  { id: 'whiteout', title: 'Erase — brush or box anything away, the background is rebuilt underneath', kbd: 'W', icon: Eraser, group: 'edit' },
  { id: 'retouch', title: 'Retouch — a manual clone brush to fix stray pixels by hand', kbd: 'B', icon: Paintbrush, group: 'edit' },
  { id: 'redact', title: 'Redact — permanently remove content on export', kbd: 'X', icon: EyeOff, group: 'edit' },
  { id: 'lift', title: 'Lift — click any element to pull it out as an editable object', kbd: 'L', icon: Layers, group: 'edit' },
  // ---- AI (needs a connected vision model) ----
  { id: 'reshape', title: 'AI blend — drag over added text/images to fit them into the print, or over empty space for new matching text (needs a model)', kbd: 'R', icon: Wand2, group: 'ai' },
  { id: 'clean', title: 'AI clean — draw around anything (a logo, a stamp, a photo) and it comes off the page, the real background underneath it intact (needs a model)', kbd: 'C', icon: Sparkles, group: 'ai' },
]

/** single-letter shortcut -> tool, derived from the rail so the two cannot drift */
export const TOOL_KEYS: Record<string, ToolId> = Object.fromEntries(
  TOOL_ACTIONS.filter((t) => /^[A-Za-z]$/.test(t.kbd)).map((t) => [t.kbd.toLowerCase(), t.id]),
)

export const ACTIONS: Action[] = [
  /* file */
  { id: 'open', title: 'Open PDF or images…', group: 'File', icon: FolderOpen, kbd: '⌘O', run: openFilePicker },
  { id: 'sample', title: 'Open the sample document', group: 'File', icon: FileText, run: openSample },
  { id: 'new-blank', title: 'New blank document', group: 'File', icon: FilePlus2, run: newBlankDoc },
  { id: 'export', title: 'Export PDF…', group: 'File', icon: Download, kbd: '⌘S', when: hasDoc, run: () => S().openModal({ type: 'export' }) },
  { id: 'extract', title: 'Extract pages…', group: 'File', icon: Scissors, when: hasDoc, run: () => S().openModal({ type: 'extract' }) },
  { id: 'merge', title: 'Insert PDF after current page…', group: 'File', icon: FilePlus, when: hasDoc, run: insertPdfAfterCurrent },
  { id: 'metadata', title: 'Document properties…', group: 'File', icon: FileOutput, when: hasDoc, run: () => S().openModal({ type: 'metadata' }) },
  { id: 'print', title: 'Print (opens system viewer)…', group: 'File', icon: Printer, kbd: '⌘P', when: hasDoc, run: printActive },

  /* edit */
  { id: 'undo', title: 'Undo', group: 'Edit', icon: Undo2, kbd: '⌘Z', when: hasDoc, run: () => S().undo() },
  { id: 'redo', title: 'Redo', group: 'Edit', icon: Redo2, kbd: '⇧⌘Z', when: hasDoc, run: () => S().redo() },
  { id: 'duplicate', title: 'Duplicate selection', group: 'Edit', icon: Copy, kbd: '⌘D', when: () => (activeDoc()?.selection.length ?? 0) > 0, run: () => S().duplicateSelection() },
  { id: 'delete-sel', title: 'Delete selection', group: 'Edit', icon: Trash2, kbd: '⌫', when: () => (activeDoc()?.selection.length ?? 0) > 0, run: () => { const d = activeDoc(); if (d) S().removeObjects(d.selection) } },

  /* pages */
  { id: 'rotate-cw', title: 'Rotate page clockwise', group: 'Page', icon: RotateCw, when: hasDoc, run: () => { const p = currentPageId(); if (p) S().rotatePages([p], 1) } },
  { id: 'rotate-ccw', title: 'Rotate page counter-clockwise', group: 'Page', icon: RotateCcw, when: hasDoc, run: () => { const p = currentPageId(); if (p) S().rotatePages([p], -1) } },
  { id: 'dup-page', title: 'Duplicate page', group: 'Page', icon: Copy, when: hasDoc, run: () => { const p = currentPageId(); if (p) S().duplicatePage(p) } },
  { id: 'del-page', title: 'Delete page', group: 'Page', icon: Trash2, when: hasDoc, run: () => { const p = currentPageId(); if (p) S().deletePages([p]) } },

  /* view */
  { id: 'zoom-in', title: 'Zoom in', group: 'View', icon: ZoomIn, kbd: '⌘+', when: hasDoc, run: () => S().setZoom(S().zoom * 1.2) },
  { id: 'zoom-out', title: 'Zoom out', group: 'View', icon: ZoomOut, kbd: '⌘−', when: hasDoc, run: () => S().setZoom(S().zoom / 1.2) },
  { id: 'zoom-100', title: 'Actual size (100%)', group: 'View', icon: Square, kbd: '⌘1', when: hasDoc, run: () => { S().setZoom(1) } },
  { id: 'fit-width', title: 'Fit width', group: 'View', icon: Maximize, kbd: '⌘0', when: hasDoc, run: () => S().setFit('width') },
  { id: 'fit-page', title: 'Fit page', group: 'View', icon: LayoutGrid, when: hasDoc, run: () => S().setFit('page') },
  { id: 'panel-pages', title: 'Toggle pages panel', group: 'View', icon: LayoutGrid, run: () => S().setPanel('pages') },
  { id: 'panel-search', title: 'Search in document', group: 'View', icon: Search, kbd: '⌘F', when: hasDoc, run: () => { const s = S(); if (s.panel !== 'search') s.setPanel('search') } },
  { id: 'panel-comments', title: 'Toggle comments panel', group: 'View', icon: MessageSquareText, run: () => S().setPanel('comments') },
  { id: 'panel-right', title: 'Toggle properties panel', group: 'View', icon: PanelRight, run: () => S().toggleRightPanel() },
  { id: 'theme', title: 'Switch light / dark bench', group: 'View', icon: Moon, run: () => S().setTheme(S().theme === 'dark' ? 'light' : 'dark') },
  { id: 'shortcuts', title: 'Keyboard shortcuts', group: 'Help', icon: Keyboard, kbd: '?', run: () => S().openModal({ type: 'shortcuts' }) },
  { id: 'ai', title: 'AI blending — connect a model…', group: 'Help', icon: Sparkles, run: () => S().openModal({ type: 'ai' }) },
]

export const paletteActions = (): Action[] => {
  const tools: Action[] = TOOL_ACTIONS.map((t) => ({
    id: `tool-${t.id}`,
    title: t.title,
    group: 'Tools',
    icon: t.icon,
    kbd: t.kbd,
    when: hasDoc,
    run: () => useStore.getState().setTool(t.id),
  }))
  return [...ACTIONS.filter((a) => !a.when || a.when()), ...tools.filter((a) => !a.when || a.when())]
}

// referenced icons that only appear in JSX-less contexts
void Circle; void Command; void MoveUpRight; void Sun; void PenLine
