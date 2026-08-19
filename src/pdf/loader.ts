import { PDFDocument } from 'pdf-lib'
import { pdfjs, PDFJS_DOC_PARAMS } from './setup'
import { registerSrc } from './registry'
import type { SrcEntry, SrcPageInfo } from './registry'
import type { DocMeta } from '../core/types'
import { uid } from '../core/types'
import type { FormField, FormValues, ImportedComment, PageRef, Rotation } from '../core/types'

export interface LoadedPdf {
  srcId: string
  pageRefs: PageRef[]
  fields: FormField[]
  comments: ImportedComment[]
  initialValues: FormValues
  /** the source's own Document Properties, so the app can tell "untouched" from "cleared" */
  info: DocMeta
}

/** What every path says about a file this app could never write back out. */
export const PROTECTED_MESSAGE =
  'This PDF is protected against editing, so any changes could never be saved back out. '
  + 'Open it in a viewer, re-save it without the protection, and it will open here.'

/**
 * Refuse, at the door, a document that could never be exported.
 *
 * A PDF encrypted with an owner password only — the "restrict editing" setting on
 * bank statements, payroll slips and government forms — opens and renders
 * perfectly, because pdf.js decrypts it. pdf-lib does not, so the export throws.
 * That check used to live at export time, and by then the work was done: this app
 * keeps a session in memory, so "this cannot be saved" arrived after an hour of
 * redacting, with no way to get any of it out and nothing to undo to.
 *
 * Far better to say no while it still costs nothing. Same probe, moved to where
 * the answer can still change what the user does.
 */
export async function assertUsable(bytes: Uint8Array): Promise<void> {
  let encrypted = false
  try {
    // ignoreEncryption only suppresses the throw — isEncrypted still reports the
    // trailer's /Encrypt, and that is what decides whether a save can ever work
    const probe = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })
    encrypted = probe.isEncrypted
  } catch {
    // pdf-lib could not parse it at all. That is either a genuinely broken file
    // or an encrypted-object-stream one; either way let pdf.js be the judge —
    // it gives a far better message, and plenty of files pdf-lib chokes on open
    // and export fine through the raster path.
    encrypted = false
  }
  if (encrypted) throw new Error(PROTECTED_MESSAGE)
}

/**
 * Load PDF bytes into pdf.js, register the source, and harvest pages, form
 * fields, existing values and comments — one parallel pass over the document.
 */
export async function loadPdfSource(bytes: Uint8Array): Promise<LoadedPdf> {
  await assertUsable(bytes)
  const srcId = uid()
  // pdf.js transfers the buffer to its worker, so hand it a copy and keep the original
  const proxy = await pdfjs.getDocument({ data: bytes.slice(), ...PDFJS_DOC_PARAMS }).promise

  const n = proxy.numPages
  const pageProxies = await Promise.all(
    Array.from({ length: n }, (_, i) => proxy.getPage(i + 1)),
  )
  const annotsPerPage = await Promise.all(
    pageProxies.map((p) => p.getAnnotations().catch(() => [] as unknown[])),
  )

  // The source's own Document Properties. Without these the app's meta starts
  // blank, so "untouched" and "deliberately cleared" look identical — and an
  // exporter that always writes would silently erase a title nobody asked to lose.
  const md = await proxy.getMetadata().catch(() => null)
  const inf = (md?.info ?? {}) as Record<string, unknown>
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const info = {
    title: str(inf.Title), author: str(inf.Author),
    subject: str(inf.Subject), keywords: str(inf.Keywords),
  }

  const pages: SrcPageInfo[] = []
  const pageRefs: PageRef[] = []
  const fields: FormField[] = []
  const comments: ImportedComment[] = []
  const initialValues: FormValues = {}
  const entry: SrcEntry = { id: srcId, bytes, proxy, pages, pageProxies: new Map() }

  for (let i = 0; i < n; i++) {
    const page = pageProxies[i]
    entry.pageProxies.set(i, page)
    const view = page.view // crop box [x1, y1, x2, y2]
    pages.push({
      srcRot: ((page.rotate % 360) + 360) % 360 as Rotation,
      cx: view[0],
      cy: view[1],
      uw: view[2] - view[0],
      uh: view[3] - view[1],
    })
    const ref: PageRef = { id: uid(), srcId, srcIndex: i, extraRot: 0 }
    pageRefs.push(ref)

    for (const a of annotsPerPage[i] as Record<string, unknown>[]) {
      const subtype = a.subtype as string
      if (subtype === 'Widget') {
        const f = widgetToField(a, ref.id)
        if (f) {
          fields.push(f)
          harvestValue(a, f, initialValues)
        }
      } else if (subtype === 'Text' || subtype === 'FreeText') {
        const text = (a.contentsObj as { str?: string })?.str || (a.contents as string) || ''
        if (text.trim()) {
          comments.push({
            page: ref.id,
            text: text.trim(),
            author: (a.titleObj as { str?: string })?.str || undefined,
          })
        }
      }
    }
  }

  registerSrc(entry)
  return { srcId, pageRefs, fields, comments, initialValues, info }
}

function widgetToField(a: Record<string, unknown>, pageId: string): FormField | null {
  const fieldType = a.fieldType as string
  const name = (a.fieldName as string) || ''
  const rect = a.rect as [number, number, number, number]
  if (!name || !rect) return null

  const base = {
    id: uid(),
    page: pageId,
    name,
    urect: rect,
    readOnly: Boolean(a.readOnly),
  }

  if (fieldType === 'Tx') {
    return {
      ...base,
      type: 'text',
      multiline: Boolean(a.multiLine),
      password: Boolean((a as { password?: boolean }).password),
      maxLen: typeof a.maxLen === 'number' && a.maxLen > 0 ? (a.maxLen as number) : undefined,
    }
  }
  if (fieldType === 'Btn') {
    if (a.pushButton) return null
    if (a.radioButton) {
      return { ...base, type: 'radio', radioValue: (a.buttonValue as string) ?? 'On' }
    }
    return { ...base, type: 'checkbox', exportValue: (a.exportValue as string) ?? 'On' }
  }
  if (fieldType === 'Ch') {
    const opts = ((a.options as { exportValue?: string; displayValue?: string }[]) || []).map((o) => ({
      value: o.exportValue ?? o.displayValue ?? '',
      label: o.displayValue ?? o.exportValue ?? '',
    }))
    return { ...base, type: 'choice', options: opts, combo: Boolean(a.combo) }
  }
  return null
}

/** Pull the widget's current value into the initial form-value map. */
function harvestValue(a: Record<string, unknown>, f: FormField, out: FormValues): void {
  const v = a.fieldValue
  if (f.type === 'text') {
    if (typeof v === 'string' && v) out[f.name] = v
  } else if (f.type === 'radio') {
    if (typeof v === 'string' && v === f.radioValue) out[f.name] = v
  } else if (f.type === 'checkbox') {
    if (typeof v === 'string') out[f.name] = v !== 'Off' && v !== ''
  } else if (f.type === 'choice') {
    // pdf.js returns an ARRAY for a multi-select list box with more than one option
    // selected. Keep ALL of them (the single-valued model can't hold a list, but
    // joining preserves the data instead of silently dropping every value but the
    // first). A single selection still comes back as a plain string.
    if (typeof v === 'string' && v) out[f.name] = v
    else if (Array.isArray(v)) {
      const picks = v.filter((x): x is string => typeof x === 'string' && x !== '')
      if (picks.length) out[f.name] = picks.join(', ')
    }
  }
}
