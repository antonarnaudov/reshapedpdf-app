import fontkit from '@pdf-lib/fontkit'

/* ----- the document's own typefaces ---------------------------------------

   A PDF carries the fonts it was set in. pdf.js has to install them to draw the
   page at all, so by the time we can see a run on screen its real typeface is
   already loaded in the browser under a generated family name — and the raw
   font program is in hand too.

   That makes "matching the font" the wrong problem. There is nothing to match:
   use the face the document was printed with, for the screen and for the
   exported file both. What follows is just the bookkeeping — the bytes are kept
   here, out of the undo history, keyed by the family the edit refers to. */

interface CmapFont {
  hasGlyphForCodePoint(cp: number): boolean
  unitsPerEm?: number
  glyphForCodePoint?(cp: number): { advanceWidth?: number } | null
}

const programs = new Map<string, { bytes: Uint8Array; mimetype?: string }>()
const parsed = new Map<string, CmapFont | null>()

/** Remember the font program behind a pdf.js family, for the exporter. */
export function rememberEmbeddedFont(family: string, bytes: Uint8Array, mimetype?: string): void {
  if (!family || !bytes?.length) return
  if (!programs.has(family)) programs.set(family, { bytes, mimetype })
}

/**
 * The width of a space in this face, in ems, straight out of the font program.
 *
 * WHY THIS EXISTS, and it is worth the detail because the symptom looked like
 * something else entirely: when a run is re-set in the document's own face, the
 * exporter draws the visible glyphs with that face but advances the pen across
 * SPACES by `pdfSpace` — a space set in a stand-in is invisible, so only how far
 * it moves the pen matters. That number came from the PDF's /Widths array at
 * index 32, which is the space only for a simple font. On a composite font
 * index 32 is glyph 32, an arbitrary glyph, so the value was rejected and a flat
 * 0.25 em stood in.
 *
 * 0.25 is wrong for almost every real face — Helvetica and Arimo are both 0.278
 * — and the error is per space, so it accumulates across the line. Measured on
 * the corpus: six spaces at 11pt, 6 x 11 x (0.278 - 0.25) = 1.85pt, against a
 * measured end drift of 1.92pt. That drift had been recorded as an unexplained
 * deviation; this is what it was.
 *
 * The program is already parsed here for faceCovers, so ask it.
 */
export function spaceEmOfFace(family: string | undefined): number | null {
  if (!family) return null
  const bytes = programs.get(family)?.bytes
  if (!bytes) return null
  try {
    let font = parsed.get(family)
    if (font === undefined) {
      const kit = fontkit as unknown as { create(b: Uint8Array): unknown }
      font = (kit.create(bytes) ?? null) as CmapFont | null
      parsed.set(family, font)
    }
    if (!font || typeof font.glyphForCodePoint !== 'function') return null
    // A SUBSET usually has no space glyph at all — PDFs put the gaps between
    // words in as position offsets rather than drawing one — and fontkit answers
    // for a missing code point with .notdef, whose advance is the em box or
    // worse. Taking that as the space width made the line 6.7pt too wide at
    // 34pt, which is far worse than the 0.25 default it replaced. Ask whether
    // the glyph is really there first.
    if (!font.hasGlyphForCodePoint(32)) return null
    const upem = font.unitsPerEm || 1000
    const adv = font.glyphForCodePoint(32)?.advanceWidth
    if (typeof adv !== 'number' || adv <= 0) return null
    const em = adv / upem
    return em > 0.02 && em < 2 ? em : null
  } catch {
    return null
  }
}

/**
 * The space width this RUN was actually set with, in ems, derived from the page.
 *
 * A subset almost never contains a space glyph, so the face cannot be asked (see
 * spaceEmOfFace) and a flat 0.25 em stood in — wrong for nearly every real face,
 * and wrong once per space, so it accumulates along the line.
 *
 * But the page knows. The run's printed width is measured, its text is known,
 * and every non-space glyph in it IS in the subset by definition — the document
 * drew them. So subtract what those glyphs advance and divide the remainder by
 * the number of spaces. The one number that cannot be looked up is the one the
 * page has already told us.
 *
 * Returns null when the sum is implausible, which happens when the run was
 * letter-spaced or the measured box is not the run's ink; the caller then keeps
 * whatever it had.
 */
export function spaceEmFromRun(
  family: string | undefined, text: string, widthPt: number, sizePt: number,
): number | null {
  if (!family || !text || !(widthPt > 0) || !(sizePt > 0)) return null
  const spaces = (text.match(/ /g) ?? []).length
  if (!spaces) return null
  const bytes = programs.get(family)?.bytes
  if (!bytes) return null
  try {
    let font = parsed.get(family)
    if (font === undefined) {
      const kit = fontkit as unknown as { create(b: Uint8Array): unknown }
      font = (kit.create(bytes) ?? null) as CmapFont | null
      parsed.set(family, font)
    }
    if (!font || typeof font.glyphForCodePoint !== 'function') return null
    const upem = font.unitsPerEm || 1000
    let inkEm = 0
    for (const ch of text) {
      if (ch === ' ') continue
      const cp = ch.codePointAt(0)
      if (cp === undefined || !font.hasGlyphForCodePoint(cp)) return null
      const adv = font.glyphForCodePoint(cp)?.advanceWidth
      if (typeof adv !== 'number') return null
      inkEm += adv / upem
    }
    const em = (widthPt / sizePt - inkEm) / spaces
    return em > 0.05 && em < 1 ? em : null
  } catch {
    return null
  }
}

export function embeddedFontProgram(family: string | undefined): Uint8Array | null {
  if (!family) return null
  return programs.get(family)?.bytes ?? null
}

/**
 * Is the face actually able to set this string?
 *
 * PDFs almost always embed a SUBSET — only the glyphs the document happened to
 * use — so a face lifted off the page can set the words it was lifted from but
 * not necessarily new ones. Ask the font program itself, via its character map.
 *
 * The obvious shortcut, measuring a character against the face and against a
 * deliberately missing family and calling equal widths "not covered", does not
 * work: fallback fonts share plenty of widths by coincidence, and a Times `e`
 * measuring the same in both is not evidence of anything. Widths are a proxy;
 * the cmap is the answer.
 */
/** Does the font program carry a glyph for this code point? */
function hasGlyph(family: string, cp: number): boolean {
  const bytes = programs.get(family)?.bytes
  if (!bytes) return false
  try {
    let font = parsed.get(family)
    if (font === undefined) {
      const kit = fontkit as unknown as { create(b: Uint8Array): unknown }
      font = (kit.create(bytes) ?? null) as CmapFont | null
      parsed.set(family, font)
    }
    if (!font || typeof font.hasGlyphForCodePoint !== 'function') return false
    return font.hasGlyphForCodePoint(cp)
  } catch {
    return false
  }
}

/**
 * Can this face set this one character?
 *
 * Asked per character at export time, INCLUDING the spaces — which is the whole
 * point. A subset lifted off a page usually has no space glyph, because PDFs
 * put the gaps between words in as position offsets instead of drawing one, and
 * a face that can't set a space prints a .notdef box in every gap.
 */
export function faceCoversChar(family: string, ch: string): boolean {
  const cp = ch.codePointAt(0)
  return cp === undefined ? false : hasGlyph(family, cp)
}

/**
 * Is the face worth using for this string?
 *
 * Whitespace is deliberately not counted: the exporter sets any character this
 * face lacks in the metric twin instead, so a missing space is no reason to
 * give up the document's own type for the words themselves.
 *
 * The obvious shortcut — measure a character against the face and against a
 * deliberately missing family, and call equal widths "not covered" — does not
 * work: fallback fonts share plenty of widths by coincidence, and a Times `e`
 * measuring the same in both is not evidence of anything. Widths are a proxy;
 * the cmap is the answer.
 */
export function faceCovers(family: string, text: string): boolean {
  if (!programs.has(family)) return false
  let any = false
  for (const ch of text) {
    if (/\s/.test(ch)) continue
    any = true
    if (!faceCoversChar(family, ch)) return false
  }
  return any
}
