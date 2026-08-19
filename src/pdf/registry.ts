import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { PDFDocument } from 'pdf-lib'
import type { PageGeom } from '../core/geometry'
import type { PageRef, Rotation } from '../core/types'

/**
 * Heavy, non-serializable PDF state lives here, outside the zustand store:
 * raw bytes (for pdf-lib export) and pdf.js document proxies (for rendering).
 */

export interface SrcPageInfo {
  srcRot: Rotation // the page's own /Rotate
  cx: number
  cy: number
  uw: number
  uh: number
}

export interface SrcEntry {
  id: string
  bytes: Uint8Array
  proxy: PDFDocumentProxy
  pages: SrcPageInfo[]
  pageProxies: Map<number, PDFPageProxy>
}

const srcs = new Map<string, SrcEntry>()

export const registerSrc = (entry: SrcEntry): void => void srcs.set(entry.id, entry)
export const getSrc = (id: string): SrcEntry => {
  const e = srcs.get(id)
  if (!e) throw new Error(`unknown pdf source ${id}`)
  return e
}
export const dropSrcs = (ids: string[]): void => {
  for (const id of ids) {
    const e = srcs.get(id)
    if (e) {
      e.proxy.destroy().catch(() => undefined)
      srcs.delete(id)
    }
    libDocs.delete(id)
  }
}

const libDocs = new Map<string, Promise<PDFDocument>>()

/**
 * A read-only pdf-lib document for a source, cached per srcId, for reading a
 * page's content stream at pick time (the layer walk). The registry otherwise
 * holds only raw bytes and a pdf.js proxy; pdf-lib docs are made on demand by
 * the exporter and thrown away. NEVER mutate or context.assign this one — it is
 * shared across picks and is not the exporter's output document.
 */
export function getLibDoc(srcId: string): Promise<PDFDocument> {
  let p = libDocs.get(srcId)
  if (!p) {
    p = PDFDocument.load(getSrc(srcId).bytes, { ignoreEncryption: true, updateMetadata: false })
    libDocs.set(srcId, p)
  }
  return p
}

export async function getPageProxy(ref: PageRef): Promise<PDFPageProxy> {
  const src = getSrc(ref.srcId)
  let p = src.pageProxies.get(ref.srcIndex)
  if (!p) {
    p = await src.proxy.getPage(ref.srcIndex + 1)
    src.pageProxies.set(ref.srcIndex, p)
  }
  return p
}

export const totalRotation = (ref: PageRef): Rotation => {
  const src = getSrc(ref.srcId).pages[ref.srcIndex]
  return (((src.srcRot + ref.extraRot) % 360) + 360) % 360 as Rotation
}

export const pageGeom = (ref: PageRef): PageGeom => {
  const info = getSrc(ref.srcId).pages[ref.srcIndex]
  return { cx: info.cx, cy: info.cy, uw: info.uw, uh: info.uh, rot: totalRotation(ref) }
}

/** view-space dimensions at zoom 1 for the page as currently displayed */
export const pageViewSize = (ref: PageRef): { w: number; h: number } => {
  const g = pageGeom(ref)
  return g.rot % 180 === 90 ? { w: g.uh, h: g.uw } : { w: g.uw, h: g.uh }
}
