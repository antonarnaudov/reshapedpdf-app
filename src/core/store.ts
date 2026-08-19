import { create } from 'zustand'
import type {
  AnyObj, DocState, FontId, FormValue, MarkupMode, ModalKind, PageRef, Rect,
  SearchMatch, ShapeMode, SignatureData, Toast, ToolId,
} from './types'
import { uid } from './types'
import { rotateObj } from './geometry'
import type { PageElement } from '../pdf/contentwalk'
import { pageViewSize, dropSrcs } from '../pdf/registry'
import { loadPdfSource, PROTECTED_MESSAGE } from '../pdf/loader'
import { invalidateSearchCache } from '../pdf/textsearch'
import type { AiConfig } from '../ai/catalog'

const HISTORY_LIMIT = 80

export interface Prefs {
  markupColor: string
  inkColor: string
  inkWidth: number
  shapeStroke: string
  shapeStrokeOn: boolean
  shapeWidth: number
  shapeFill: string
  shapeFillOn: boolean
  textColor: string
  textSize: number
  font: FontId
  bold: boolean
  noteColor: string
  autoSampleWhiteout: boolean
  autoMatchText: boolean
  eraseMode: 'box' | 'brush'
  eraseBrush: number
  retouchColor: string
  retouchBrush: number
}

interface ScrollRequest {
  page: string
  rect?: Rect
  nonce: number
}

export interface AppState {
  docs: Record<string, DocState>
  docOrder: string[]
  active: string | null

  tool: ToolId
  markupMode: MarkupMode
  shapeMode: ShapeMode
  prefs: Prefs

  zoom: number
  fitMode: 'width' | 'page' | null
  panel: 'pages' | 'search' | 'comments' | null
  rightPanel: boolean
  theme: 'dark' | 'light'
  palette: boolean
  modal: ModalKind | null
  toasts: Toast[]
  busy: string | null

  searchQuery: string
  searchMatches: SearchMatch[]
  searchActive: number
  scrollRequest: ScrollRequest | null

  signatures: SignatureData[]
  editingText: string | null // object id currently being edited inline
  // the element the lift tool is previewing, tagged with its page so exactly one
  // is ever live across all mounted pages (Enter commits only the matching page)
  liftPreview: { pageId: string; rect: Rect; label: string; el: PageElement } | null
  aiConfig: AiConfig | null

  /* ------- actions ------- */
  openPdfBytes: (name: string, bytes: Uint8Array) => Promise<string | null>
  closeDoc: (id: string) => void
  setActive: (id: string) => void
  markSaved: (id: string, exportedFrom?: DocState) => void
  setDocName: (id: string, name: string) => void
  setMeta: (meta: DocState['meta']) => void

  commitNow: () => void
  addObject: (obj: AnyObj, opts?: { select?: boolean }) => void
  addObjects: (objs: AnyObj[], opts?: { selectId?: string }) => void
  updateObject: (id: string, patch: Partial<AnyObj>, opts?: { keepRedo?: boolean }) => void
  replaceObject: (obj: AnyObj) => void
  removeObjects: (ids: string[]) => void
  /** Rewind a just-created, never-edited object (an abandoned empty text box) so
   *  it leaves no phantom undo entry and doesn't mark the doc edited. */
  discardFreshObject: (id: string) => void
  duplicateSelection: () => void
  bringToFront: (ids: string[]) => void
  sendToBack: (ids: string[]) => void
  setSelection: (ids: string[]) => void
  setEditingText: (id: string | null) => void
  setLiftPreview: (p: { pageId: string; rect: Rect; label: string; el: PageElement } | null) => void

  rotatePages: (pageIds: string[], dir: 1 | -1) => void
  deletePages: (pageIds: string[]) => void
  duplicatePage: (pageId: string) => void
  movePages: (pageIds: string[], insertIndex: number) => void
  insertPagesFromSource: (
    loaded: Awaited<ReturnType<typeof loadPdfSource>>,
    afterIndex: number,
    formValues?: Record<string, FormValue>,
  ) => void
  setCurrentPage: (i: number) => void

  setFormValue: (name: string, v: FormValue) => void

  undo: () => void
  redo: () => void

  setTool: (t: ToolId) => void
  setMarkupMode: (m: MarkupMode) => void
  setShapeMode: (m: ShapeMode) => void
  setPref: <K extends keyof Prefs>(k: K, v: Prefs[K]) => void
  setZoom: (z: number) => void
  setFit: (m: 'width' | 'page' | null) => void
  setPanel: (p: AppState['panel']) => void
  toggleRightPanel: () => void
  setTheme: (t: 'dark' | 'light') => void
  setPalette: (b: boolean) => void
  openModal: (m: ModalKind) => void
  closeModal: () => void
  toast: (text: string, type?: Toast['type']) => void
  dismissToast: (id: number) => void
  setBusy: (label: string | null) => void

  setSearchQuery: (q: string) => void
  setSearchResults: (m: SearchMatch[]) => void
  setSearchActive: (i: number) => void
  requestScroll: (page: string, rect?: Rect) => void

  addSignature: (s: SignatureData) => void
  removeSignature: (index: number) => void
  setAiConfig: (cfg: AiConfig | null) => void
}

/* ---------- helpers ---------- */

let toastSeq = 1
// Coalesce consecutive keystrokes in ONE field into one undo step — but only
// while it's genuinely the same field, in the same doc, with nothing else
// committed in between (undo length unchanged). A bare field name leaked across
// documents and welded a field edit onto an unrelated edit made between two
// keystrokes.
let lastForm: { docId: string; name: string; undoLen: number } | null = null

const snapOf = (d: DocState) => ({
  pages: d.pages,
  objects: d.objects,
  objOrder: d.objOrder,
  formValues: d.formValues,
  fields: d.fields,
  // Document Properties are unexported content too. Left out of the snapshot, any
  // path that re-derives dirty from the clean baseline (undo, redo,
  // discardFreshObject) forced dirty:false while doc.meta still held a change — one
  // undo made the app claim Saved and closing the tab dropped the properties with
  // no prompt. setMeta now takes a checkpoint so undo can restore them properly.
  meta: d.meta,
})

type Snap = ReturnType<typeof snapOf>
/** Two snapshots hold the SAME content — every mutation makes fresh references,
 *  so reference equality of the five slices is exact and O(1). */
const sameMeta = (a: DocState['meta'], b: DocState['meta']): boolean =>
  a === b || (!!a && !!b && (Object.keys(a) as (keyof DocState['meta'])[]).length === Object.keys(b).length
    && (Object.keys(a) as (keyof DocState['meta'])[]).every((k) => a[k] === b[k]))

const sameSnap = (a: Snap, b: Snap): boolean =>
  a.pages === b.pages && a.objects === b.objects && a.objOrder === b.objOrder &&
  a.formValues === b.formValues && a.fields === b.fields &&
  // meta by VALUE, not reference: the properties modal builds a fresh object on
  // every keystroke, so reference equality would report every doc as changed
  sameMeta(a.meta, b.meta)

/** The last saved/opened content per doc id, so undoing back to it clears the
 *  "Edited" flag instead of leaving a phantom unsaved-changes prompt. */
const cleanSnaps = new Map<string, Snap>()

/* The redo stack the most recent withCommit threw away, tagged with the doc and the
 * undo depth it happened at. discardFreshObject can hand it back when it rewinds
 * that very checkpoint: dropping an abandoned, never-typed text box should leave no
 * trace, and losing a redo the user could still have wanted is a trace. */
let redoStash: { docId: string; undoLen: number; redo: Snap[] } | null = null

/**
 * A patch that has been moved, resized or made see-through no longer stands in
 * for the print it was cut to replace, so it must stop taking that print out of
 * the exported file.
 *
 * removedSpans says "these drawing operators are mine to delete on export",
 * which is only true while the patch is still sitting over them, opaque. Drag it
 * aside and the page shows its original ink again — but the export would still
 * delete it, leaving a hole nobody asked for and nothing on screen to explain
 * it. Cheaper and safer to forget the claim: the words come back, which is
 * exactly what the user is now looking at.
 */
function stripStaleSpans(prev: AnyObj, next: AnyObj): AnyObj {
  if (next.kind !== 'whiteout' || !next.removedSpans?.length) return next
  const p = prev as typeof next
  const moved = p.x !== next.x || p.y !== next.y || p.w !== next.w || p.h !== next.h
  const seeThrough = next.opacity < 0.99
  if (!moved && !seeThrough) return next
  const { removedSpans: _dropped, ...rest } = next
  return rest as AnyObj
}

const withCommit = (d: DocState): DocState => {
  const snap = snapOf(d)
  const top = d.undo[d.undo.length - 1]
  // Dedup only the history PUSH: an identical snapshot leaves a dead undo entry
  // (a grip/slider pressed but never dragged pushed one via commitNow). But every
  // withCommit caller mutates content immediately after this, so the doc IS
  // changing — always mark it dirty and clear redo, even when the pre-mutation
  // snapshot happens to match the last checkpoint. Returning `d` unchanged here
  // (the old behaviour) let an add/delete land with dirty=false when a prior
  // commitNow had already checkpointed the identical state, silently discarding
  // the edit on close.
  const undo = top && sameSnap(top, snap)
    ? d.undo
    : [...d.undo.slice(-HISTORY_LIMIT + 1), snap]
  redoStash = d.redo.length ? { docId: d.id, undoLen: undo.length, redo: d.redo } : null
  return {
    ...d,
    undo,
    redo: [],
    dirty: true,
  }
}

const loadSignatures = (): SignatureData[] => {
  try {
    return JSON.parse(localStorage.getItem('reshapedpdf.signatures') || '[]') as SignatureData[]
  } catch {
    return []
  }
}
const persistSignatures = (s: SignatureData[]) => {
  try {
    localStorage.setItem('reshapedpdf.signatures', JSON.stringify(s))
  } catch { /* quota */ }
}

const loadAiConfig = (): AiConfig | null => {
  try {
    const raw = localStorage.getItem('reshapedpdf.ai')
    return raw ? (JSON.parse(raw) as AiConfig) : null
  } catch {
    return null
  }
}

const initialTheme = (): 'dark' | 'light' => {
  const saved = localStorage.getItem('reshapedpdf.theme')
  if (saved === 'light' || saved === 'dark') return saved
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export const useStore = create<AppState>()((set, get) => {
  /** apply fn to the active doc (immutably) */
  const mutActive = (fn: (d: DocState) => DocState) =>
    set((s) => {
      if (!s.active) return s
      const d = s.docs[s.active]
      if (!d) return s
      return { docs: { ...s.docs, [s.active]: fn(d) } }
    })

  /**
   * mutActive, for changes that move the page out from under the user.
   *
   * The lift preview is a rectangle measured in ONE page geometry. Rotate the
   * page, delete one before it, reorder, or undo any of those, and it describes
   * nothing — but it used to survive all of them: the dashed ghost stayed where
   * it was drawn while the page turned underneath it, still inviting Enter.
   * Enter then ran the entire lift in the OLD geometry and wrote the result onto
   * the new page, which deleted the real heading from the content stream and
   * stamped a rectangle of un-rotated pixels onto clean paper. Not a cosmetic
   * bug: the words were gone from the exported file.
   *
   * setActive and setTool already clear it. These have exactly the same claim.
   */
  const mutActiveGeom = (fn: (d: DocState) => DocState) =>
    set((s) => {
      if (!s.active) return s
      const d = s.docs[s.active]
      if (!d) return s
      return { docs: { ...s.docs, [s.active]: fn(d) }, liftPreview: null }
    })

  return {
    docs: {},
    docOrder: [],
    active: null,

    tool: 'select',
    markupMode: 'highlight',
    shapeMode: 'rect',
    prefs: {
      markupColor: '#FFDE5C',
      inkColor: '#2456D6',
      inkWidth: 2.5,
      shapeStroke: '#D6382E',
      shapeStrokeOn: true,
      shapeWidth: 2,
      shapeFill: '#FFE066',
      shapeFillOn: false,
      textColor: '#17171B',
      textSize: 14,
      font: 'sans',
      bold: false,
      noteColor: '#FFB454',
      autoSampleWhiteout: true,
      autoMatchText: true,
      eraseMode: 'brush',
      eraseBrush: 12,
      retouchColor: '#FFFFFF',
      retouchBrush: 6,
    },

    zoom: 1,
    fitMode: 'width',
    panel: 'pages',
    rightPanel: true,
    theme: initialTheme(),
    palette: false,
    modal: null,
    toasts: [],
    busy: null,

    searchQuery: '',
    searchMatches: [],
    searchActive: -1,
    scrollRequest: null,

    signatures: loadSignatures(),
    editingText: null,
    liftPreview: null,
    aiConfig: loadAiConfig(),

    /* ---------- documents ---------- */

    openPdfBytes: async (name, bytes) => {
      const { toast, setBusy } = get()
      setBusy('Opening document…')
      try {
        const loaded = await loadPdfSource(bytes)
        const formValues = loaded.initialValues
        const id = uid()
        const doc: DocState = {
          id,
          name: name.replace(/\.pdf$/i, ''),
          srcIds: [loaded.srcId],
          pages: loaded.pageRefs,
          objects: {},
          objOrder: [],
          fields: loaded.fields,
          formValues,
          comments: loaded.comments,
          selection: [],
          currentPage: 0,
          dirty: false,
          // seeded from the file's own /Info so the Properties dialog shows what is
          // actually in the document, and so an exported blank means "cleared"
          meta: loaded.info ?? { title: '', author: '', subject: '', keywords: '' },
          undo: [],
          redo: [],
        }
        cleanSnaps.set(id, snapOf(doc))
        set((s) => ({
          docs: { ...s.docs, [id]: doc },
          docOrder: [...s.docOrder, id],
          active: id,
        }))
        if (loaded.fields.length > 0) {
          toast(`${loaded.fields.length} form field${loaded.fields.length > 1 ? 's' : ''} detected — click any field to fill it`, 'info')
        }
        return id
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        toast(
          // assertUsable already phrases the protected-file case for a human, and
          // pdf.js's own password error needs its own words
          msg === PROTECTED_MESSAGE ? msg
            : /password/i.test(msg) ? 'This PDF needs a password to open — ReshapedPDF cannot unlock it'
              : `Could not open “${name}”: ${msg}`,
          'error',
        )
        return null
      } finally {
        setBusy(null)
      }
    },

    closeDoc: (id) =>
      set((s) => {
        const doc = s.docs[id]
        if (!doc) return s
        cleanSnaps.delete(id)
        dropSrcs(doc.srcIds)
        invalidateSearchCache()
        const docs = { ...s.docs }
        delete docs[id]
        const docOrder = s.docOrder.filter((d) => d !== id)
        const active = s.active === id ? docOrder[docOrder.length - 1] ?? null : s.active
        return { docs, docOrder, active }
      }),

    setActive: (id) => set({ active: id, liftPreview: null }),
    markSaved: (id, exportedFrom) =>
      set((s) => {
        const d = s.docs[id]
        if (!d) return s
        // The baseline is what was actually WRITTEN, not whatever the doc looks like
        // now. Export snapshots the doc, then awaits the native Save dialog; any
        // fire-and-forget pipeline landing in that window (a blend, a print-match, a
        // peel) is absent from the file. Re-reading the live doc here declared those
        // edits saved and they were then dropped on close without a prompt.
        const base = snapOf(exportedFrom ?? d)
        cleanSnaps.set(id, base)
        return { docs: { ...s.docs, [id]: { ...d, dirty: !sameSnap(snapOf(d), base) } } }
      }),
    setDocName: (id, name) =>
      set((s) => (s.docs[id] ? { docs: { ...s.docs, [id]: { ...s.docs[id], name } } } : s)),
    // through withCommit so the change is undoable — snapOf now carries meta, and
    // without a checkpoint an undo would restore a stale one and wipe the properties
    // Opening Document properties to READ them and clicking Save used to mark an
    // untouched document as Edited, forever, and push an undo entry identical to
    // the state it came from — so Undo lit up and did nothing. withCommit sets
    // dirty unconditionally, and the modal's Save calls this unconditionally.
    // Nothing changed is not an edit.
    setMeta: (meta) => mutActive((d) => (sameMeta(d.meta, meta) ? d : { ...withCommit(d), meta })),

    /* ---------- objects ---------- */

    // A pure checkpoint taken BEFORE a gesture (a drag, a slider sweep) so the
    // change that follows is one undoable step. It must NOT mark the doc dirty —
    // the mutation that follows does that. So a grip or slider merely pressed and
    // released leaves neither a dead undo entry (dedup) nor a false "Edited"
    // state, and a real drag is still checkpointed and made dirty by its updates.
    commitNow: () =>
      mutActive((d) => {
        const snap = snapOf(d)
        const top = d.undo[d.undo.length - 1]
        if (top && sameSnap(top, snap)) return d
        // A checkpoint is not itself an edit, so it must NOT clear the redo stack —
        // a grip/slider pressed (and released) after an Undo would otherwise wipe
        // the redo with no change made. The edit that follows (updateObject /
        // an atomic op) clears redo; a checkpoint never followed by one leaves it.
        return { ...d, undo: [...d.undo.slice(-HISTORY_LIMIT + 1), snap] }
      }),

    addObject: (obj, opts) =>
      mutActive((d) => ({
        ...withCommit(d),
        objects: { ...d.objects, [obj.id]: obj },
        objOrder: [...d.objOrder, obj.id],
        selection: opts?.select === false ? d.selection : [obj.id],
      })),

    // add several objects as ONE undoable step (e.g. a retype's patch + text)
    addObjects: (objs, opts) =>
      mutActive((d) => {
        const objects = { ...d.objects }
        for (const o of objs) objects[o.id] = o
        return {
          ...withCommit(d),
          objects,
          objOrder: [...d.objOrder, ...objs.map((o) => o.id)],
          selection: opts?.selectId ? [opts.selectId] : d.selection,
        }
      }),

    updateObject: (id, patch, opts) =>
      mutActive((d) => {
        const prev = d.objects[id]
        if (!prev) return d
        // A real edit invalidates the redo stack (redo-clearing moved here from
        // commitNow so a bare checkpoint no longer wipes it). But an ASYNC cosmetic
        // touch-up — auto-match / blend-refine landing seconds after the user's
        // edit — must pass keepRedo, or a background callback silently wipes the
        // redo the user is mid-navigating after an unrelated undo.
        return {
          ...d,
          objects: { ...d.objects, [id]: stripStaleSpans(prev, { ...prev, ...patch } as AnyObj) },
          dirty: true,
          ...(opts?.keepRedo ? {} : { redo: [] }),
        }
      }),

    // dragging and resizing come through HERE, not updateObject — so this is the
    // path that must forget a patch's removal claim when it stops covering what
    // it was cut for (see stripStaleSpans)
    replaceObject: (obj) =>
      mutActive((d) => ({
        ...d,
        objects: { ...d.objects, [obj.id]: stripStaleSpans(d.objects[obj.id] ?? obj, obj) },
        dirty: true, redo: [],
      })),

    removeObjects: (ids) =>
      mutActive((d) => {
        const setIds = new Set(ids)
        const objects = { ...d.objects }
        ids.forEach((i) => delete objects[i])
        return {
          ...withCommit(d),
          objects,
          objOrder: d.objOrder.filter((i) => !setIds.has(i)),
          selection: d.selection.filter((i) => !setIds.has(i)),
        }
      }),

    discardFreshObject: (id) =>
      mutActive((d) => {
        const top = d.undo[d.undo.length - 1]
        // Rewind cleanly ONLY when this object's creation checkpoint is still the
        // top — i.e. the pre-add snapshot doesn't contain it and nothing has been
        // committed since. Restoring that snapshot (references intact) leaves the
        // doc byte-identical to before the box was dropped, so the dirty flag
        // recomputes correctly and no phantom undo entry survives.
        if (top && !top.objects[id] && d.objects[id]) {
          const restored = { ...d, ...top, undo: d.undo.slice(0, -1) }
          const clean = cleanSnaps.get(d.id)
          // give back the redo the placeholder's own creation discarded, but only if
          // this is still that exact checkpoint — otherwise it belongs to something else
          const redo = redoStash && redoStash.docId === d.id && redoStash.undoLen === d.undo.length
            ? redoStash.redo : d.redo
          redoStash = null
          return { ...restored, redo, selection: [], dirty: clean ? !sameSnap(snapOf(restored), clean) : true }
        }
        // Something committed after creation — fall back to a normal removal.
        const objects = { ...d.objects }
        delete objects[id]
        return {
          ...withCommit(d),
          objects,
          objOrder: d.objOrder.filter((i) => i !== id),
          selection: d.selection.filter((i) => i !== id),
        }
      }),

    duplicateSelection: () =>
      mutActive((d) => {
        if (d.selection.length === 0) return d
        const clones: AnyObj[] = []
        for (const id of d.selection) {
          const o = d.objects[id]
          if (!o) continue
          const clone = { ...o, id: uid() } as AnyObj
          if ('x' in clone) { clone.x += 14; clone.y += 14 }
          else if (clone.kind === 'ink') clone.points = clone.points.map(([x, y]) => [x + 14, y + 14] as [number, number])
          else if (clone.kind === 'markup') clone.rects = clone.rects.map((r) => ({ ...r, x: r.x + 14, y: r.y + 14 }))
          clones.push(clone)
        }
        const objects = { ...d.objects }
        clones.forEach((c) => (objects[c.id] = c))
        return {
          ...withCommit(d),
          objects,
          objOrder: [...d.objOrder, ...clones.map((c) => c.id)],
          selection: clones.map((c) => c.id),
        }
      }),

    bringToFront: (ids) =>
      mutActive((d) => {
        const setIds = new Set(ids)
        return { ...withCommit(d), objOrder: [...d.objOrder.filter((i) => !setIds.has(i)), ...ids] }
      }),
    sendToBack: (ids) =>
      mutActive((d) => {
        const setIds = new Set(ids)
        return { ...withCommit(d), objOrder: [...ids, ...d.objOrder.filter((i) => !setIds.has(i))] }
      }),

    setSelection: (ids) => mutActive((d) => ({ ...d, selection: ids })),
    setEditingText: (id) => set({ editingText: id }),
    setLiftPreview: (p) => set({ liftPreview: p }),

    /* ---------- pages ---------- */

    rotatePages: (pageIds, dir) =>
      mutActiveGeom((d) => {
        // A rotated page's text-geometry cache (span rects) is now stale — the
        // markup line-snap and AI-blend read it, and the Sidebar's invalidate
        // effect only runs while the search panel is mounted. Clear it here.
        invalidateSearchCache()
        const target = new Set(pageIds)
        const dimsBefore = new Map(d.pages.filter((p) => target.has(p.id)).map((p) => [p.id, pageViewSize(p)]))
        const pages = d.pages.map((p) =>
          target.has(p.id)
            ? { ...p, extraRot: ((((p.extraRot + dir * 90) % 360) + 360) % 360) as PageRef['extraRot'] }
            : p,
        )
        const objects: Record<string, AnyObj> = {}
        for (const [id, o] of Object.entries(d.objects)) {
          objects[id] = target.has(o.page) ? rotateObj(o, dir === 1, dimsBefore.get(o.page)!) : o
        }
        return { ...withCommit(d), pages, objects }
      }),

    deletePages: (pageIds) =>
      mutActiveGeom((d) => {
        if (pageIds.length >= d.pages.length) {
          get().toast('A document needs at least one page', 'warn')
          return d
        }
        const target = new Set(pageIds)
        const pages = d.pages.filter((p) => !target.has(p.id))
        const objects: Record<string, AnyObj> = {}
        for (const [id, o] of Object.entries(d.objects)) if (!target.has(o.page)) objects[id] = o
        return {
          ...withCommit(d),
          pages,
          objects,
          objOrder: d.objOrder.filter((i) => objects[i]),
          fields: d.fields.filter((f) => !target.has(f.page)),
          selection: d.selection.filter((i) => objects[i]),
          currentPage: Math.min(d.currentPage, pages.length - 1),
        }
      }),

    duplicatePage: (pageId) =>
      mutActive((d) => {
        const idx = d.pages.findIndex((p) => p.id === pageId)
        if (idx < 0) return d
        const src = d.pages[idx]
        const clone: PageRef = { ...src, id: uid() }
        const pages = [...d.pages.slice(0, idx + 1), clone, ...d.pages.slice(idx + 1)]
        const objects = { ...d.objects }
        const newIds: string[] = []
        for (const id of d.objOrder) {
          const o = d.objects[id]
          if (o?.page === pageId) {
            const c = { ...o, id: uid(), page: clone.id } as AnyObj
            objects[c.id] = c
            newIds.push(c.id)
          }
        }
        // Form fields are keyed by page id too — clone them for the new page, or a
        // duplicated form page renders and exports with NO fillable fields (blank
        // where the original is filled). The clones keep their name, so they share
        // the value with the original (a widget shown twice), as PDF fields with a
        // shared name do. Fields ARE in the undo snapshot, so this reverts cleanly.
        // Comments are deliberately NOT cloned: they're outside snapOf, so cloning
        // them would orphan one imported comment per duplicate+undo cycle.
        const fields = [...d.fields, ...d.fields.filter((f) => f.page === pageId).map((f) => ({ ...f, id: uid(), page: clone.id }))]
        return { ...withCommit(d), pages, objects, objOrder: [...d.objOrder, ...newIds], fields }
      }),

    movePages: (pageIds, insertIndex) =>
      mutActiveGeom((d) => {
        const target = new Set(pageIds)
        const moving = d.pages.filter((p) => target.has(p.id))
        if (moving.length === 0) return d
        const rest = d.pages.filter((p) => !target.has(p.id))
        const before = d.pages.slice(0, insertIndex).filter((p) => !target.has(p.id)).length
        const pages = [...rest.slice(0, before), ...moving, ...rest.slice(before)]
        // A drop onto the page's own edge produces the same order — don't commit or
        // dirty the doc for a no-op reorder (withCommit always sets dirty:true).
        if (pages.length === d.pages.length && pages.every((p, i) => p === d.pages[i])) return d
        return { ...withCommit(d), pages }
      }),

    insertPagesFromSource: (loaded, afterIndex, formValues) =>
      mutActive((d) => {
        const pages = [...d.pages]
        pages.splice(afterIndex + 1, 0, ...loaded.pageRefs)
        // Two forms routinely use the same field names (Text1, Name, Date…), and
        // formValues is ONE flat name-keyed map. Spreading the incoming values last
        // therefore replaced whatever the user had already typed, and both widgets
        // then shared the single surviving entry — so the export wrote the wrong
        // value on both pages. Give each COLLIDING incoming name a free alias, per
        // distinct name so radio/checkbox groups stay grouped, and remember the
        // original so the written file still gets the field's real name.
        const taken = new Set(d.fields.map((f) => f.name))
        const alias = new Map<string, string>()
        const seenIncoming = new Set<string>()
        for (const f of loaded.fields) {
          if (seenIncoming.has(f.name)) continue // another widget of a field already handled
          seenIncoming.add(f.name)
          if (!taken.has(f.name)) { taken.add(f.name); continue }
          let n = 2
          while (taken.has(`${f.name}#${n}`)) n++
          alias.set(f.name, `${f.name}#${n}`)
          taken.add(`${f.name}#${n}`)
        }
        const incoming = loaded.fields.map((f) => {
          const a = alias.get(f.name)
          return a ? { ...f, name: a, exportName: f.exportName ?? f.name } : f
        })
        const incomingValues: Record<string, FormValue> = {}
        for (const [k, v] of Object.entries(formValues ?? {})) incomingValues[alias.get(k) ?? k] = v
        return {
          ...withCommit(d),
          pages,
          srcIds: [...d.srcIds, loaded.srcId],
          fields: [...d.fields, ...incoming],
          formValues: { ...d.formValues, ...incomingValues },
          comments: [...d.comments, ...loaded.comments],
        }
      }),

    setCurrentPage: (i) => mutActive((d) => (d.currentPage === i ? d : { ...d, currentPage: i })),

    /* ---------- forms ---------- */

    setFormValue: (name, v) =>
      mutActive((d) => {
        const active = get().active
        const coalesce = !!lastForm && lastForm.docId === active && lastForm.name === name && lastForm.undoLen === d.undo.length
        const base = coalesce ? d : withCommit(d)
        lastForm = { docId: active ?? '', name, undoLen: base.undo.length }
        return { ...base, formValues: { ...d.formValues, [name]: v }, dirty: true }
      }),

    /* ---------- history ---------- */

    undo: () =>
      mutActiveGeom((d) => {
        // Skip any phantom entries that match the live state (a grip/slider
        // pressed but never dragged), so Undo always lands on a real change.
        const cur = snapOf(d)
        let stack = d.undo
        while (stack.length && sameSnap(stack[stack.length - 1], cur)) stack = stack.slice(0, -1)
        const snap = stack[stack.length - 1]
        if (!snap) return d
        lastForm = null
        // Restoring a snapshot can change a page's rotation (undo of a rotate), and
        // the text-span cache is keyed by page id, not rotation — so the line-snap
        // markup and AI-blend would read the geometry from before the undo. Only
        // rotatePages invalidated it directly; do the same when history moves pages.
        invalidateSearchCache()
        const clean = cleanSnaps.get(d.id)
        return {
          ...d,
          ...snap,
          undo: stack.slice(0, -1),
          redo: [...d.redo, cur],
          selection: [],
          // undoing back to the opened/saved content is NOT a pending edit
          dirty: clean ? !sameSnap(snap, clean) : true,
        }
      }),

    redo: () =>
      mutActiveGeom((d) => {
        const snap = d.redo[d.redo.length - 1]
        if (!snap) return d
        lastForm = null
        invalidateSearchCache() // a redone rotate changes page geometry — see undo
        const clean = cleanSnaps.get(d.id)
        return {
          ...d,
          ...snap,
          redo: d.redo.slice(0, -1),
          undo: [...d.undo, snapOf(d)],
          selection: [],
          // redoing may land back on the saved content too (redo of an undo)
          dirty: clean ? !sameSnap(snap, clean) : true,
        }
      }),

    /* ---------- ui ---------- */

    setTool: (t) => {
      set({ tool: t })
      if (t !== 'select') get().setEditingText(null)
      if (t !== 'lift') set({ liftPreview: null })
    },
    setMarkupMode: (m) => set({ markupMode: m }),
    setShapeMode: (m) => set({ shapeMode: m }),
    setPref: (k, v) => set((s) => ({ prefs: { ...s.prefs, [k]: v } })),

    setZoom: (z) => set({ zoom: Math.min(8, Math.max(0.1, z)), fitMode: null }),
    setFit: (m) => set({ fitMode: m }),
    setPanel: (p) => set((s) => ({ panel: s.panel === p ? null : p })),
    toggleRightPanel: () => set((s) => ({ rightPanel: !s.rightPanel })),
    setTheme: (t) => {
      localStorage.setItem('reshapedpdf.theme', t)
      document.documentElement.dataset.theme = t
      set({ theme: t })
    },
    setPalette: (b) => set({ palette: b }),
    openModal: (m) => set({ modal: m }),
    closeModal: () => set({ modal: null }),

    toast: (text, type = 'info') => {
      const id = toastSeq++
      set((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, type }] }))
      window.setTimeout(() => get().dismissToast(id), 4600)
    },
    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
    setBusy: (label) => set({ busy: label }),

    /* ---------- search ---------- */

    setSearchQuery: (q) => set({ searchQuery: q }),
    setSearchResults: (m) => set({ searchMatches: m, searchActive: m.length ? 0 : -1 }),
    setSearchActive: (i) => {
      const m = get().searchMatches[i]
      set({ searchActive: i })
      if (m) get().requestScroll(m.page, m.rects[0])
    },
    requestScroll: (page, rect) =>
      set((s) => ({ scrollRequest: { page, rect, nonce: (s.scrollRequest?.nonce ?? 0) + 1 } })),

    /* ---------- signatures ---------- */

    addSignature: (sig) =>
      set((s) => {
        const signatures = [sig, ...s.signatures].slice(0, 12)
        persistSignatures(signatures)
        return { signatures }
      }),
    removeSignature: (index) =>
      set((s) => {
        const signatures = s.signatures.filter((_, i) => i !== index)
        persistSignatures(signatures)
        return { signatures }
      }),

    setAiConfig: (cfg) => {
      try {
        if (cfg) localStorage.setItem('reshapedpdf.ai', JSON.stringify(cfg))
        else localStorage.removeItem('reshapedpdf.ai')
      } catch { /* quota */ }
      set({ aiConfig: cfg })
    },
  }
})

/* ---------- convenience selectors ---------- */

export const useActiveDoc = (): DocState | null =>
  useStore((s) => (s.active ? s.docs[s.active] ?? null : null))

export const activeDoc = (): DocState | null => {
  const s = useStore.getState()
  return s.active ? s.docs[s.active] ?? null : null
}
