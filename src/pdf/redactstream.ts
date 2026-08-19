import {
  PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFPage, PDFRawStream, PDFRef,
  decodePDFRawStream,
} from 'pdf-lib'
import type { Rect } from '../core/types'
import { viewRectToUser } from '../core/geometry'
import type { PageGeom } from '../core/geometry'
import {
  tokenize, mul, apply, readWidths, codes, encodeCodes, intersects, contains, replaceStreamBytes,
} from './contentwalk'
import type { Tok, M, GState, Widths } from './contentwalk'

/* ----- redaction that takes the words out and leaves the page alone ---------

   A black rectangle drawn over words that are still in the file is not
   redaction, it is a sticker: select, copy, and there they are. So the content
   under the mark has to actually go.

   The way that was achieved here was to render the whole page to an image and
   embed that. It works — the words really are gone — and it charges the entire
   page for it. Vector artwork becomes pixels. Every other word on the page stops
   being a word and becomes a picture of one: nothing selectable, nothing
   searchable, nothing copyable, and the lot pushed through JPEG on the way out.
   One small box over a phone number costs the document everything else.

   The alternative is to edit the page's own drawing instructions: keep every
   operator except the ones that paint the covered content, and write the rest
   back untouched. The page stays vector, its text stays text, and the redacted
   words are not in the file at all — not hidden, not covered, absent.

   Where that cannot be done safely — content this does not know how to remove
   overlapping a mark — it says so and the caller falls back to rasterising. It
   is better to lose a page's quality than to promise a redaction and leave the
   words in the file. */


export interface RedactResult {
  /** false when something that could not be removed overlapped a mark */
  complete: boolean
  removedRuns: number
  removedImages: number
  reason?: string
  /**
   * 'cover' mode only: what it walked away from. Cover never rasterises, so it
   * cannot report trouble through `complete` without condemning a page nobody
   * asked it to condemn — but it must not return a bare `complete: true` either,
   * which is what it used to do while leaving the covered words in the file.
   * Only the reasons that mean ink demonstrably SURVIVED are listed; the "might
   * paint under a mark" heuristics are not, or the warning would fire on every
   * document with a gradient on it and stop meaning anything.
   */
  gaps?: string[]
}

export interface RedactOpts {
  /**
   * 'redact' (the default) is the Redact tool's promise: everything under a mark
   * goes, and anything that cannot be removed safely makes the whole page fall
   * back to a raster (complete:false).
   *
   * 'cover' is for the opaque patches an EDIT has already painted over the page —
   * a retype's background fill, a rubber, a peel's or a lift's patch. Those cover
   * the print perfectly on screen and in the file, and leave the words themselves
   * sitting in the content stream: pdftotext, copy-paste, search and every
   * indexer still read the text the user believes they replaced. Painted over is
   * not removed.
   *
   * Nothing was promised there and nothing may be rasterised, so this mode only
   * removes what is PROVABLY invisible — a glyph whose box lies entirely inside
   * an opaque patch — and never reports incompleteness. Deleting only fully
   * covered ink means the rendered page cannot change: what it leaves behind is
   * still hidden behind the patch that was already hiding it. That is what keeps
   * it safe to run on every export, over patches the user drew by hand.
   */
  mode?: 'redact' | 'cover'
}

/**
 * Delete everything the marks cover from a page's own drawing instructions.
 *
 * Rects are in view space (origin top-left, y down, in the page's *displayed*
 * orientation). The content stream is authored in the page's own user space —
 * origin bottom-left of the unrotated media box, offset by the crop box origin.
 * A page can be rotated (/Rotate) or cropped, so a bare y-flip is only right for
 * rot=0, cx=cy=0; every mark is mapped through the page geometry instead, the
 * same transform the black box itself is drawn with, so the words that go are
 * exactly the words under the box.
 */
export function redactPageContent(
  doc: PDFDocument,
  page: PDFPage,
  rects: Rect[],
  geom: PageGeom,
  opts?: RedactOpts,
): RedactResult {
  // see RedactOpts: 'cover' removes only provably invisible ink and never
  // rasterises, so every "I can't be sure" below is silently a no-op instead of
  // condemning the page to a raster fallback it was never asked for.
  const cover = opts?.mode === 'cover'
  const marks = rects.map((r) => {
    const [ax, ay, bx, by] = viewRectToUser(geom, r)
    return { x: ax, y: ay, w: bx - ax, h: by - ay }
  })
  const contents = page.node.Contents()
  if (!contents) return { complete: false, removedRuns: 0, removedImages: 0, reason: 'no content stream' }

  const refs: PDFRef[] = contents instanceof PDFArray
    ? (contents.asArray() as PDFRef[])
    : [page.node.get(PDFName.of('Contents')) as PDFRef]

  const resources = page.node.Resources()
  const fontRes = resources?.lookup(PDFName.of('Font')) as PDFDict | undefined
  const xobjRes = resources?.lookup(PDFName.of('XObject')) as PDFDict | undefined
  const widthCache = new Map<string, Widths | null>()
  const widthsFor = (name: string): Widths | null => {
    if (!widthCache.has(name)) {
      const d = fontRes?.lookup(PDFName.of(name.slice(1))) as PDFDict | undefined
      widthCache.set(name, readWidths(doc, d))
    }
    return widthCache.get(name) ?? null
  }

  let removedRuns = 0
  let removedImages = 0
  let incomplete: string | undefined
  const gaps: string[] = []
  /**
   * Something could not be removed safely. In 'redact' mode that condemns the
   * page to a raster. In 'cover' mode it is left alone — but recorded, unless
   * `soft`, so the caller can tell the user their words are still in the file.
   */
  const fail = (why: string, soft = false): void => {
    if (!cover) incomplete = incomplete || why
    else if (!soft && !gaps.includes(why)) gaps.push(why)
  }
  /**
   * Is this box's ink covered? Redaction takes out everything a mark TOUCHES —
   * a half-covered glyph is still a leak. A cover patch may only take out what it
   * CONTAINS: a glyph the patch merely clips is still visible on the page, and
   * deleting it would punch a hole in what the user is looking at.
   */
  const marked = (b: Rect): boolean => marks.some((m) => (cover ? contains(m, b) : intersects(b, m)))
  /**
   * Cover mode only: the pen position in the current text object can no longer be
   * trusted (a font with no width table, or a CMap this can't measure), so every
   * glyph box after it is a guess. Guessing is fine for a mark that rasterises on
   * doubt; here it would delete visible words. Remove nothing more until the next
   * BT resets the text matrix.
   */
  let blind = false

  // A /Contents array may be split at any token boundary and must be treated
  // as one concatenated stream: a q/cm prologue in one element positions the
  // text the next element shows, and a BT can close with an ET in a later one.
  // So state is tracked once across every element; each element is still
  // rewritten from its own token slice, so untouched streams stay byte-identical.
  // CONCATENATE the elements into one source before tokenizing. A spec-legal split
  // can fall mid-operator-group — an operand at the end of one element, its
  // operator at the start of the next — and tokenizing each element in isolation
  // silently drops the trailing operand (the tokenizer only emits a token on an
  // operator word), so the show op parses with an empty string and the covered run
  // is never seen: it ships live under the black box. Joining with whitespace makes
  // the array the single stream the spec already says it is. A redacted array page
  // is then written back as one stream (below); untouched pages are left intact.
  let combined = ''
  // Every element has to be readable, or the rewrite below cannot be written back
  // safely: it collapses the array into refs[0], so a piece we could not parse
  // would be silently DELETED along with whatever it drew. pdf-lib's own
  // PDFContentStream (what form flattening and every drawX push into) is exactly
  // such a piece — not a PDFRawStream — so on a flattened page this is not
  // hypothetical.
  let allReadable = true
  for (const ref of refs) {
    const stream = doc.context.lookup(ref)
    if (!(stream instanceof PDFRawStream)) { fail('unreadable content stream'); allReadable = false; continue }
    const raw = decodePDFRawStream(stream).decode()
    // latin1 by hand: this runs in the renderer, where Buffer does not exist,
    // and a content stream is bytes rather than text — every byte must survive
    // the round trip unchanged
    let src = ''
    for (let i = 0; i < raw.length; i += 0x8000) src += String.fromCharCode(...raw.subarray(i, i + 0x8000))
    combined += (combined ? '\n' : '') + src
  }
  const allToks = tokenize(combined)

  // First pass: decide which token indices to drop. q/Q save and restore the
  // whole graphics state — the text parameters (font, size, spacing, scale,
  // leading, rise) are part of it, not just the CTM — so saving only the matrix
  // let a size or font set inside a q…Q leak past the Q and mismeasure the next
  // run. tm/tlm are text-object state, reset by BT, so they stay out of the stack.
  const drop = new Set<number>()
  const stack: (GState & { fillWhite: boolean; strokeWhite: boolean })[] = []
  let ctm: M = [1, 0, 0, 1, 0, 0]
  let tm: M = [1, 0, 0, 1, 0, 0]
  let tlm: M = [1, 0, 0, 1, 0, 0]
  let font = ''
  let fs = 0, tc = 0, tw = 0, th = 1, tl = 0, trise = 0
  // Whether the current fill / stroke colour is paper-white. Sensitive ink is never
  // white, so NON-white paint whose footprint overlaps a mark could be the content
  // itself — outlined text / a filled logo the text handler can't touch — and forces
  // the raster fallback; a white paper fill or background is benign and kept as
  // vectors (so a plain text-on-white redaction stays text). Colour is graphics
  // state, saved/restored by q/Q. Default black (not white).
  let fillWhite = false, strokeWhite = false
  // Device-space points of the current path, tested against the marks on paint, and
  // whether it is COMPLEX (a curve, or many vertices). Outlined text / a logo is
  // complex curved paths and CAN carry readable content, so non-white complex paint
  // over a mark rasterises. A simple rectangle / line (a coloured background bar, a
  // rule) carries no readable information, so it is kept — a plain text-on-a-bar
  // redaction drops the glyphs and stays vector instead of flattening the page.
  let pathPts: [number, number][] = []
  let pathCurved = false
  // Replacements for dropped show operators: token index -> the ops that stand
  // in for it (a bare advance, plus any line move / spacing the operator carried).
  const synth = new Map<number, string>()

  for (let t = 0; t < allToks.length; t++) {
    const { op, args } = allToks[t]
    const num = (k: number) => (typeof args[k] === 'number' ? (args[k] as number) : 0)
    switch (op) {
      case 'q': stack.push({ ctm, font, fs, tc, tw, th, tl, trise, fillWhite, strokeWhite }); break
      case 'Q': {
        const s = stack.pop()
        if (s) ({ ctm, font, fs, tc, tw, th, tl, trise, fillWhite, strokeWhite } = s)
        break
      }
      case 'cm': ctm = mul([num(0), num(1), num(2), num(3), num(4), num(5)], ctm); break
      // fill/stroke colour — only "is it paper-white?" matters (see fillWhite decl)
      case 'g': fillWhite = num(0) >= 0.92; break
      case 'rg': fillWhite = num(0) >= 0.92 && num(1) >= 0.92 && num(2) >= 0.92; break
      case 'k': fillWhite = num(0) <= 0.08 && num(1) <= 0.08 && num(2) <= 0.08 && num(3) <= 0.08; break
      case 'G': strokeWhite = num(0) >= 0.92; break
      case 'RG': strokeWhite = num(0) >= 0.92 && num(1) >= 0.92 && num(2) >= 0.92; break
      case 'K': strokeWhite = num(0) <= 0.08 && num(1) <= 0.08 && num(2) <= 0.08 && num(3) <= 0.08; break
      // an unknown colour space, pattern, or separation — can't prove it white, so
      // treat as ink (safe: it rasterises if it lands over a mark)
      case 'cs': case 'sc': case 'scn': fillWhite = false; break
      case 'CS': case 'SC': case 'SCN': strokeWhite = false; break
      case 'BT': tm = [1, 0, 0, 1, 0, 0]; tlm = tm; blind = false; break
      case 'Tf': font = String(args[0] ?? ''); fs = num(1); break
      case 'Tc': tc = num(0); break
      case 'Tw': tw = num(0); break
      case 'Tz': th = num(0) / 100; break
      case 'TL': tl = num(0); break
      case 'Ts': trise = num(0); break
      case 'Tm': tm = [num(0), num(1), num(2), num(3), num(4), num(5)]; tlm = tm; break
      case 'Td': tlm = mul([1, 0, 0, 1, num(0), num(1)], tlm); tm = tlm; break
      case 'TD': tl = -num(1); tlm = mul([1, 0, 0, 1, num(0), num(1)], tlm); tm = tlm; break
      case 'T*': tlm = mul([1, 0, 0, 1, 0, -tl], tlm); tm = tlm; break
      case 'Tj': case 'TJ': case "'": case '"': {
        // aw ac string "  — the " operator sets word and character spacing for
        // the rest of the text object before it shows the string. Missing this
        // put every later glyph in the wrong place and slid the run out from
        // under its mark.
        if (op === '"') { tw = num(0); tc = num(1) }
        if (op === "'" || op === '"') { tlm = mul([1, 0, 0, 1, 0, -tl], tlm); tm = tlm }
        const w = widthsFor(font)
        // A composite font we can't measure (vertical writing, or a CMap that
        // remaps code→CID) would put every glyph box in the wrong place, so a
        // covered glyph could be judged uncovered. Don't trust it — rasterise.
        if (w && w.unsafe && marks.length) {
          fail(`composite font ${font} is not safely measurable`)
          if (cover) blind = true // its advances are wrong, so every box after it is too
        }
        // Cover mode removes nothing from this run when the pen can't be trusted
        // (blind), and nothing at zero font size either: a dropped span stands in
        // as a TJ pen move, and no TJ number can express a move at fs=0, so the
        // rest of the line would slide left — a visible change, which cover mode
        // is not allowed to make. Redaction keeps its own answer for both (it
        // rasterises the page and loses nothing).
        const noDrop = cover && (blind || fs === 0)
        const parts: (number | string)[] = op === 'TJ'
          ? ((args[0] as unknown as (number | string)[]) ?? [])
          : [String(args[args.length - 1] ?? '')]
        // walk the run, advancing the pen, and note whether any glyph lands
        // inside a mark. advLocal is the net horizontal displacement of the pen
        // in text space, which the stand-in must reproduce so nothing shifts.
        let hit = false
        let advLocal = 0
        const startTm: M = tm
        // Rebuild the run as a TJ array: uncovered glyphs stay as ink (string
        // literals), covered glyphs become bare pen moves (numbers), original
        // kerns preserved. This drops ONLY the covered word, not its neighbours.
        const round = (x: number) => String(Math.round(x * 1e6) / 1e6)
        const outParts: (string | number)[] = []
        let keep: number[] = []   // uncovered glyph codes pending flush
        let covAdv = 0            // covered advance (text space) pending flush as a move
        const flushKeep = () => { if (keep.length) { outParts.push(encodeCodes(keep, !!(w && w.twoByte))); keep = [] } }
        // A covered span stands in as a bare pen move: number n in TJ shifts the
        // pen by -n/1000·fs, so n = -covAdv·1000/fs reproduces its advance. At
        // fs=0 (valid but rare `/F1 0 Tf` invisible text) that divides by zero and
        // would emit ±Infinity into the content stream, and no TJ number can
        // express a move at zero size — so we can't rebuild the pen position. Drop
        // to rasterising the page instead: safe (the invisible text becomes a flat
        // image, nothing extractable) and exact (no advance is lost, so any visible
        // text sharing the line can't drift). Rare enough to cost nothing in practice.
        const flushCov = () => {
          if (Math.abs(covAdv) > 1e-9) {
            if (fs !== 0) outParts.push(-covAdv * 1000 / fs)
            else incomplete = incomplete || `zero-size text under a mark in ${font}`
            covAdv = 0
          }
        }
        for (const part of parts) {
          if (typeof part === 'number') {
            flushKeep(); flushCov()
            outParts.push(part) // a kern adjustment — keep it so the layout holds
            const d = (-part / 1000) * fs * th
            tm = mul([1, 0, 0, 1, d, 0], tm)
            advLocal += d
            continue
          }
          // metrics unknown: treat as covering (redact rasterises on the strength
          // of it) — and in cover mode, as unmeasurable from here on
          if (!w) { hit = true; if (cover) blind = true; break }
          for (const code of codes(part, w.twoByte)) {
            const adv = (w.get(code) / 1000) * fs + tc + (code === 32 && !w.twoByte ? tw : 0)
            // the box spans text-space y [trise, trise + fs]: text rise lifts
            // the whole glyph, so it sets the bottom AND the top. Adding it to
            // only the bottom left a superscript's real ink above the box.
            // The em-box AABB in device space, over ALL FOUR corners. A box from
            // only the two main-diagonal corners is correct when the text is
            // axis-aligned, but under a rotated or sheared text/CTM the OFF-diagonal
            // corners stick out past that diagonal, so the 2-corner box is narrower
            // than the real footprint — a mark on the ink near an off-diagonal
            // corner would miss it and the covered glyph would ship live (a leak).
            // The Do XObject path maps four corners for exactly this reason.
            const gm = mul(tm, ctm)
            // The em box measures UP from the baseline, so a descender's ink hangs
            // below it. Redaction doesn't care — it removes on overlap, and a mark
            // over the glyph overlaps either way. Cover mode does: it removes on
            // CONTAINMENT, and a tail poking out below a patch is ink still on the
            // page. Reach a quarter-em under the baseline there, so a glyph whose
            // descender escapes the patch is no longer "provably invisible".
            const yLow = cover ? trise - 0.25 * fs : trise
            const gc = [apply(gm, 0, yLow), apply(gm, adv * th, yLow), apply(gm, adv * th, trise + fs), apply(gm, 0, trise + fs)]
            const gxs = gc.map((c) => c[0]), gys = gc.map((c) => c[1])
            const gx0 = Math.min(...gxs), gx1 = Math.max(...gxs)
            const gy0 = Math.min(...gys), gy1 = Math.max(...gys)
            const glyph: Rect = { x: gx0, y: gy0, w: (gx1 - gx0) || 0.1, h: (gy1 - gy0) || 0.1 }
            if (!noDrop && marked(glyph)) { hit = true; flushKeep(); covAdv += adv }
            else { flushCov(); keep.push(code) }
            const d = adv * th
            tm = mul([1, 0, 0, 1, d, 0], tm)
            advLocal += d
          }
        }
        flushKeep(); flushCov()
        if (!w && hit) {
          // The width table is missing (a base-14 font with no /Widths), so this
          // run's horizontal EXTENT is unknowable — a line anchored at the left
          // margin can still run right into a mark near the right edge, and
          // testing only the origin (as before) misses that, shipping the covered
          // text as live characters. If the run shares a horizontal BAND with any
          // mark it might cover it and we cannot prove otherwise, so force the
          // raster fallback: the page is flattened and nothing leaks.
          // The horizontal-band test only bounds a run whose advance runs along
          // device-x (the effective matrix has no rotation/shear). A rotated or
          // sheared widthless run extends along some other direction the flat band
          // can't follow — its 1-tall strip sits at the baseline while the ink runs
          // away up the page — so a mark up the column is missed and the covered
          // text ships live. When the matrix is not axis-aligned the extent is
          // genuinely unprovable: force the raster fallback if the page has a mark.
          const sm = mul(startTm, ctm)
          if (Math.abs(sm[1]) < 1e-6 && Math.abs(sm[2]) < 1e-6) {
            const [, ay] = apply(sm, 0, trise)
            const [, by] = apply(sm, 0, trise + fs)
            const band: Rect = { x: -1e9, y: Math.min(ay, by), w: 2e9, h: Math.abs(by - ay) || 1 }
            if (marks.some((m) => intersects(band, m))) fail(`run in ${font} has no width table`)
          } else if (marks.length) {
            fail(`rotated run in ${font} has no width table`)
          }
          hit = false
        }
        if (hit) {
          // Drop only THIS show operator, and within it only the COVERED glyphs:
          // re-emit the uncovered ones as ink and stand the covered span in with
          // a bare pen move so its neighbours — and the words after the run —
          // keep their place. Carry the line move + spacing for the '  and " forms.
          drop.add(t)
          removedRuns++
          const pre = op === '"' ? `${round(num(0))} Tw ${round(num(1))} Tc T* `
            : op === "'" ? 'T* ' : ''
          const body = outParts.length
            ? `[ ${outParts.map((p) => (typeof p === 'number' ? round(p) : p)).join(' ')} ] TJ`
            : ''
          synth.set(t, (pre + body).trim())
        }
        break
      }
      case 'Do': {
        const name = String(args[0] ?? '')
        // An XObject is a stream, so its dictionary is at .dict — calling
        // .lookup straight on it threw. A form draws its /BBox (through its
        // /Matrix and the CTM), an image fills the unit square; sizing every
        // XObject as the bare unit square meant a whole-page form (BBox
        // [0 0 W H] at the origin) shrank to 1x1 and every mark missed it, so
        // the covered content shipped untouched. Four corners, not two, or a
        // rotated placement collapses one side to zero.
        const xo = xobjRes?.lookup(PDFName.of(name.slice(1)))
        const xdict = xo instanceof PDFRawStream ? xo.dict : (xo instanceof PDFDict ? xo : undefined)
        const sub = (xdict?.lookup(PDFName.of('Subtype')) as PDFName | undefined)?.asString()
        const nums = (a: PDFArray | undefined, fallback: number[]): number[] =>
          a ? a.asArray().map((v) => (doc.context.lookup(v) as PDFNumber)?.asNumber?.() ?? 0) : fallback
        let corners: [number, number][]
        if (sub === '/Form') {
          const bb = nums(xdict?.lookup(PDFName.of('BBox')) as PDFArray | undefined, [0, 0, 1, 1])
          const fm = nums(xdict?.lookup(PDFName.of('Matrix')) as PDFArray | undefined, [1, 0, 0, 1, 0, 0]) as M
          const full = mul(fm, ctm)
          corners = ([[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]]] as [number, number][])
            .map(([x, y]) => apply(full, x, y))
        } else {
          corners = ([[0, 0], [1, 0], [1, 1], [0, 1]] as [number, number][]).map(([x, y]) => apply(ctm, x, y))
        }
        const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1])
        const box: Rect = {
          x: Math.min(...xs), y: Math.min(...ys),
          w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys),
        }
        if (marks.some((m) => intersects(box, m))) {
          if (sub === '/Image') {
            // Drop the image whole ONLY if a mark fully covers it. A small mark over
            // a corner of a full-page scan must NOT delete the entire page — force
            // the raster fallback so the uncovered scan survives with the box burned
            // in, instead of shipping a blank page with complete:true.
            const fully = marks.some((m) => contains(m, box))
            if (fully) { drop.add(t); removedImages++ }
            else fail(`an image (${name}) is only partly under a mark`)
          } else fail(`a form XObject (${name}) overlaps a mark`)
        }
        break
      }
      case 'BI': fail('inline image on the page'); break
      // Path construction: accumulate device-space points so a fill/stroke over a
      // mark can be caught (outlined text and vector graphics carry no font show
      // op, so the text handler above never sees them — an unhandled leak).
      case 'm': case 'l': pathPts.push(apply(ctm, num(0), num(1))); break
      case 'c': pathCurved = true; pathPts.push(apply(ctm, num(0), num(1)), apply(ctm, num(2), num(3)), apply(ctm, num(4), num(5))); break
      case 'v': case 'y': pathCurved = true; pathPts.push(apply(ctm, num(0), num(1)), apply(ctm, num(2), num(3))); break
      case 're': {
        const rx = num(0), ry = num(1), rw = num(2), rh = num(3)
        pathPts.push(apply(ctm, rx, ry), apply(ctm, rx + rw, ry), apply(ctm, rx + rw, ry + rh), apply(ctm, rx, ry + rh))
        break
      }
      // Path painting: a path can't be sliced, so if its footprint overlaps a mark
      // force the raster fallback (the page is re-rendered with the box burned in).
      // `n` paints nothing (it ends a W clip); `h` (closepath) adds no new point.
      case 'f': case 'F': case 'f*': case 'S': case 's': case 'B': case 'B*': case 'b': case 'b*': {
        const fills = op !== 'S' && op !== 's'
        const strokes = op !== 'f' && op !== 'F' && op !== 'f*'
        // paints visible ink if the fill (or, for a stroking op, the stroke) is not
        // paper-white — then a footprint over a mark rasterises the page
        const ink = (fills && !fillWhite) || (strokes && !strokeWhite)
        // a curve or many vertices = outlined text / a logo (readable content); a
        // rectangle or a few line segments = a background bar / rule (no content)
        const complex = pathCurved || pathPts.length > 10
        if (ink && complex && pathPts.length) {
          const pxs = pathPts.map((p) => p[0]), pys = pathPts.map((p) => p[1])
          const pbox: Rect = { x: Math.min(...pxs), y: Math.min(...pys), w: Math.max(...pxs) - Math.min(...pxs), h: Math.max(...pys) - Math.min(...pys) }
          if (marks.some((m) => intersects(pbox, m))) fail('complex non-white vector paint under a mark', true)
        }
        pathPts = []; pathCurved = false
        break
      }
      case 'n': pathPts = []; pathCurved = false; break
      case 'sh': if (marks.length) fail('a shading (sh) may paint under a mark', true); break
      default: break
    }
  }

  // Second pass: rewrite the page content ONLY if a token was dropped — otherwise
  // every stream is left byte-identical (an untouched page, or one whose marks
  // covered nothing). A redacted /Contents array is serialised back as a SINGLE
  // stream, since it was tokenised as one above.
  if (drop.size > 0 && allReadable) {
    const out: string[] = []
    for (let t = 0; t < allToks.length; t++) {
      if (drop.has(t)) {
        // a dropped show operator leaves behind its stand-in (advance / line
        // move) so the rest of the run keeps its place; a dropped image leaves
        // nothing
        const r = synth.get(t)
        if (r) out.push(r)
        continue
      }
      const { op, args, raw } = allToks[t]
      // An inline image is ONE token whose whole byte run — dictionary, ID,
      // binary payload, EI — lives only in `raw`. Re-serialising it from
      // {op,args} writes the bare word `BI`, and a parser then reads every
      // operator after it as inline-image dictionary keys, hunting for an ID
      // that never comes: the rest of the page is swallowed. Redaction never hit
      // this (an inline image forced the raster fallback); cover mode has no
      // fallback, so it would have shipped the corrupt stream.
      if (raw !== undefined) { out.push(raw); continue }
      const parts = args.map((a) => {
        if (typeof a === 'number') return String(Math.round(a * 1e6) / 1e6)
        if (Array.isArray(a)) return `[${(a as unknown as (number | string)[]).map((v) => (typeof v === 'number' ? String(Math.round(v * 1e6) / 1e6) : v)).join(' ')}]`
        return a
      })
      out.push(parts.length ? `${parts.join(' ')} ${op}` : op)
    }
    const rewritten = out.join('\n')
    const bytes = new Uint8Array(rewritten.length)
    for (let i = 0; i < rewritten.length; i++) bytes[i] = rewritten.charCodeAt(i) & 0xff
    replaceStreamBytes(doc, refs[0], bytes)
    if (refs.length > 1) {
      page.node.set(PDFName.of('Contents'), refs[0])
      // …and DELETE the elements that just left the page. Unlinking them is not
      // enough: pdf-lib writes every indirect object it holds, so the original
      // pieces of the stream — with the redacted words still in them — would
      // travel in the saved file, unreferenced but perfectly readable. Same
      // orphan trap as a deleted page. Only ever reached on a private copy of
      // the page (compose), or a page proven not to share its streams (fast).
      for (let k = 1; k < refs.length; k++) doc.context.delete(refs[k])
    }
  }

  return {
    complete: !incomplete,
    removedRuns,
    removedImages,
    reason: incomplete,
    gaps: gaps.length ? gaps : undefined,
  }
}
