export type ToolId =
  | 'select'
  | 'markup'
  | 'ink'
  | 'text'
  | 'note'
  | 'shape'
  | 'image'
  | 'signature'
  | 'retype'
  | 'reshape'
  | 'whiteout'
  | 'retouch'
  | 'redact'
  | 'lift'
  | 'clean'

export type MarkupMode = 'highlight' | 'underline' | 'strike'
export type ShapeMode = 'rect' | 'ellipse' | 'line' | 'arrow'
export type FontId = 'sans' | 'serif' | 'mono' | 'geo' | 'humanist' | 'condensed' | 'rounded' | 'slab' | 'grotesk'
export type Rotation = 0 | 90 | 180 | 270

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/* ---------- annotation objects (coords in page view-space at zoom 1, origin top-left) ---------- */

interface BaseObj {
  id: string
  page: string // PageRef id
  opacity: number
}

export interface MarkupObj extends BaseObj {
  kind: 'markup'
  mode: MarkupMode
  rects: Rect[]
  color: string
}

export interface InkObj extends BaseObj {
  kind: 'ink'
  points: [number, number][]
  color: string
  width: number
}

export interface ShapeObj extends BaseObj {
  kind: 'shape'
  mode: ShapeMode
  // rect/ellipse: x,y top-left with positive w,h.  line/arrow: p1=(x,y), p2=(x+w,y+h); w/h may be negative
  x: number
  y: number
  w: number
  h: number
  stroke: string | null // null = no border (rect/ellipse only; lines always stroke)
  strokeWidth: number
  fill: string | null
}

/**
 * A path lifted off the page as REAL VECTORS — a logo, a curve, an icon, a
 * chart's plot line — rather than a picture of one.
 *
 * `d` is SVG in the object's own local space, with (0,0) at the object's
 * top-left corner, so moving or resizing the object is a transform on the box
 * and never a rewrite of the geometry. It stays crisp at any zoom, exports as
 * drawing instructions rather than pixels, and its fill and stroke can be
 * changed after the fact — which a raster of the same shape can never offer.
 */
export interface VectorObj extends BaseObj {
  kind: 'vector'
  x: number
  y: number
  w: number
  h: number
  /** the path in LOCAL space: 0..srcW by 0..srcH */
  d: string
  /** the space `d` was authored in, so scaling is a ratio and not a re-parse */
  srcW: number
  srcH: number
  fill: string | null
  stroke: string | null
  strokeWidth: number
  evenOdd?: boolean
}

export interface TextObj extends BaseObj {
  kind: 'text'
  x: number
  y: number
  w: number
  h: number
  text: string
  color: string
  size: number
  font: FontId
  bold: boolean
  /**
   * The print's slant, kept off the font name so an edited retype doesn't snap
   * upright. Screen and export both render it (a base-14 italic face when the
   * run was standard, a synthesised oblique raster otherwise) so they match.
   */
  italic?: boolean
  /** Fixed box width (page units): text word-wraps to it. Absent = auto-grow. */
  boxW?: number
  /**
   * Horizontal alignment. Absent/'left' anchors the box's LEFT edge (the default,
   * and how every non-retyped box behaves). 'right' keeps the right edge fixed and
   * 'center' the centre when the text is edited — so a retyped right-aligned
   * invoice figure or centred heading keeps its column instead of growing off the
   * left anchor. Also lays out each wrapped line within boxW on screen and export.
   */
  align?: 'left' | 'center' | 'right'
  /** Extra per-letter spacing (view px) so a matched edit reproduces the print's width. */
  tracking?: number
  /**
   * The print's actual base-14 font name (e.g. "Helvetica-Bold") when the retyped
   * text was lifted off a standard-font run. The exporter references this exact
   * font so the edit is pixel-identical in any PDF viewer; the screen uses the
   * palette twin. Absent = render/embed the palette FontId.
   */
  stdFont?: string
  /**
   * The family pdf.js loaded the print's OWN embedded face under. When present
   * the screen and the exported file both set the text in the real typeface the
   * document was printed with, so there is nothing to "match" — it simply is the
   * same font. Absent = fall back to the palette FontId.
   */
  pdfFont?: string
  /**
   * The space advance of that face, in ems. Needed because the face itself
   * almost certainly has no space glyph to measure — see pdfFont.
   */
  pdfSpace?: number
  /**
   * This text WAS the page's print, lifted by retype — and the print it came
   * from has been removed and covered by its own patch. So there is nothing
   * underneath it to match against any more, and re-blending it measures the
   * patch instead of type.
   */
  fromPrint?: boolean
  /**
   * A face carried only for MATCHING (see identifyFace) — the file basename in
   * public/fonts, e.g. "urbanist". Set when the words had to be read off an
   * image and the closest face was one of those rather than a palette entry.
   */
  matchFace?: string
  /** numeric weight for a matchFace (400/500/600/700) */
  matchWeight?: number
  /**
   * Pixel-identical rendering composed from the document's own glyphs
   * (a transparent PNG data URL). When present the renderer/exporter draw
   * this instead of font text; editing the string clears it.
   */
  glyphSrc?: string
  glyphW?: number
  glyphH?: number
  /**
   * Content rotation in view-space (clockwise), set when the PAGE this text sits
   * on is rotated. The box (x,y,w,h) stays the axis-aligned bounds; this says the
   * words are drawn turned by 0/90/180/270 inside it, so a rotated page keeps its
   * annotations reading with the content instead of leaving them flat in a
   * swapped box. Absent = upright.
   */
  rot?: Rotation
}

export interface NoteObj extends BaseObj {
  kind: 'note'
  x: number
  y: number
  text: string
  color: string
}

export interface ImageObj extends BaseObj {
  kind: 'image'
  x: number
  y: number
  w: number
  h: number
  src: string // data URL (png or jpeg)
  isSignature?: boolean
  /** Content rotation (clockwise), set when the page is rotated. See TextObj.rot:
   *  the box stays the axis-aligned bounds; the bitmap is drawn turned inside it,
   *  so a rotated page doesn't distort or mis-orient the stamp. Absent = upright. */
  rot?: Rotation
}

export interface WhiteoutObj extends BaseObj {
  kind: 'whiteout'
  x: number
  y: number
  w: number
  h: number
  color: string // sampled from the page background (fallback / flat backgrounds)
  /** Edge-blended gradient patch (PNG data URL) for multicolour backgrounds. */
  src?: string
  /**
   * True when the PNG's own alpha is the shape and x/y/w/h is merely its bounding
   * box — a brush sweep, a retouch stroke. Everything else fills its rectangle.
   *
   * It matters because the export removes print it can prove is hidden, and for a
   * shaped patch the rectangle proves nothing: a single diagonal sweep paints
   * maybe a fifth of its own bounding box, and treating that box as solid would
   * delete every word inside the loop while the app still showed them.
   */
  shaped?: boolean
  /**
   * This patch is a stroke the user PAINTED, in a colour they picked — not a
   * piece of the page reconstructed from its surroundings. Both carry a `src`,
   * so nothing else distinguishes them, and the selection bar described one as
   * the other.
   */
  painted?: boolean
  /**
   * The content-stream spans this patch stands in for: the drawing operators
   * whose ink it covers, recorded by the tool that made it (a lift removes one
   * element; a retype replaces every run under the words it reprints).
   *
   * Two things need them. A later lift on the same page must re-render the
   * background with every span already removed — otherwise its patch carries the
   * earlier element's ink and paints it back over the object that lift produced.
   * And the EXPORT must take them out of the page's own program, or the file
   * still carries the words the patch is covering: painted over is not removed.
   */
  removedSpans?: { span: [number, number]; replacement?: string; formPath?: string[] }[]
  /** Content rotation (clockwise), set when the page is rotated — only meaningful
   *  for a `src` patch (a flat colour rect is rotation-invariant). See TextObj.rot. */
  rot?: Rotation
}

export interface RedactObj extends BaseObj {
  kind: 'redact'
  x: number
  y: number
  w: number
  h: number
}

export type AnyObj =
  | MarkupObj
  | InkObj
  | ShapeObj
  | VectorObj
  | TextObj
  | NoteObj
  | ImageObj
  | WhiteoutObj
  | RedactObj

export const NOTE_SIZE = 26

/* ---------- pages ---------- */

export interface PageRef {
  id: string
  srcId: string
  srcIndex: number // 0-based index in the source document
  extraRot: Rotation // user-applied rotation on top of the source page's own /Rotate
}

/* ---------- forms ---------- */

export type FieldType = 'text' | 'checkbox' | 'radio' | 'choice'

export interface FormField {
  id: string
  page: string // PageRef id
  name: string // fully qualified field name, unique within THIS document
  /**
   * The field's name in its own source PDF, kept only when a merge forced this
   * field to be renamed to avoid colliding with one already open. `name` is the
   * app's key (into formValues); this is what the written file must be told.
   */
  exportName?: string
  type: FieldType
  urect: [number, number, number, number] // PDF user-space rect [x1,y1,x2,y2]
  multiline?: boolean
  password?: boolean
  maxLen?: number
  readOnly?: boolean
  options?: { value: string; label: string }[]
  combo?: boolean
  exportValue?: string // checkbox "on" value
  radioValue?: string // this widget's own value within its radio group
}

export type FormValue = string | boolean
export type FormValues = Record<string, FormValue>

/* ---------- comments imported from existing PDFs ---------- */

export interface ImportedComment {
  page: string
  text: string
  author?: string
}

/* ---------- documents ---------- */

export interface HistorySnap {
  pages: PageRef[]
  objects: Record<string, AnyObj>
  objOrder: string[]
  formValues: FormValues
  fields: FormField[]
  /** Document Properties are unexported content, so they belong in history too —
   *  otherwise an undo re-derives "saved" while doc.meta still holds a change. */
  meta: DocMeta
}

export interface DocMeta {
  title: string
  author: string
  subject: string
  keywords: string
}

export interface DocState {
  id: string
  name: string
  srcIds: string[]
  pages: PageRef[]
  objects: Record<string, AnyObj>
  objOrder: string[] // z-order, back to front
  fields: FormField[]
  formValues: FormValues
  comments: ImportedComment[]
  selection: string[]
  currentPage: number // 0-based index into pages
  dirty: boolean
  meta: DocMeta
  undo: HistorySnap[]
  redo: HistorySnap[]
}

/* ---------- misc ---------- */

export interface SignatureData {
  src: string // trimmed transparent PNG data URL
  w: number
  h: number
}

export interface Toast {
  id: number
  text: string
  type: 'info' | 'ok' | 'warn' | 'error'
}

export type ModalKind =
  | { type: 'export' }
  | { type: 'extract' }
  | { type: 'signature'; placeAt?: { page: string; x: number; y: number } }
  | { type: 'metadata' }
  | { type: 'shortcuts' }
  | { type: 'ai' }
  | { type: 'confirm-close'; docId: string }

export interface SearchMatch {
  page: string // PageRef id
  pageIndex: number
  rects: Rect[]
  snippet: string
}

export interface ExportOptions {
  flattenForms: boolean
  optimize: boolean
  trueRedact: boolean // rasterize pages that contain redactions so content is truly removed
  pageNumbers?: boolean // stamp "n / total" in the footer of every page
}

export interface FontDef {
  label: string
  stack: string
  /** basename under /fonts — <file>-400.ttf / <file>-700.ttf */
  file: string
}

/** The blending palette: metric twins of the PDF classics plus the common display voices. */
export const FONTS: Record<FontId, FontDef> = {
  sans: { label: 'Sans', stack: "'Arimo', 'Helvetica Neue', Arial, sans-serif", file: 'arimo' },
  serif: { label: 'Serif', stack: "'Tinos', 'Times New Roman', Times, serif", file: 'tinos' },
  mono: { label: 'Mono', stack: "'Cousine', 'Courier New', Courier, monospace", file: 'cousine' },
  geo: { label: 'Geometric', stack: "'Poppins', 'Century Gothic', sans-serif", file: 'poppins' },
  humanist: { label: 'Humanist', stack: "'Lato', 'Segoe UI', sans-serif", file: 'lato' },
  condensed: { label: 'Condensed', stack: "'Oswald', 'Arial Narrow', sans-serif", file: 'oswald' },
  rounded: { label: 'Rounded', stack: "'Nunito', 'Trebuchet MS', sans-serif", file: 'nunito' },
  slab: { label: 'Slab', stack: "'Roboto Slab', Rockwell, serif", file: 'robotoslab' },
  grotesk: { label: 'Grotesk', stack: "'Archivo', 'Franklin Gothic Medium', sans-serif", file: 'archivo' },
}

export const FONT_IDS = Object.keys(FONTS) as FontId[]

/**
 * CSS font-family for a retype that was lifted off a base-14 font — leads with
 * the real system font (present on macOS/most OSes) so the on-screen text
 * matches the print, falling back to the bundled metric twin.
 */
export function stdFontStack(stdFont: string): string | undefined {
  const n = stdFont.toLowerCase()
  if (n.startsWith('courier')) return "'Courier New', Courier, 'Cousine', monospace"
  if (n.startsWith('times')) return "'Times New Roman', Times, 'Tinos', serif"
  if (n.startsWith('helvetica')) return "Helvetica, 'Helvetica Neue', Arial, 'Arimo', sans-serif"
  return undefined
}

export const FONT_STACKS: Record<FontId, string> = Object.fromEntries(
  Object.entries(FONTS).map(([k, v]) => [k, v.stack]),
) as Record<FontId, string>

export const uid = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().slice(0, 13)
    : Math.random().toString(36).slice(2, 12)
