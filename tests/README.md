# Erase-and-retype suite

    npm test                        # build + every check below, which is what CI runs
    npm run test:erase              # this suite alone
    npm run test:fonts              # do the bundled fonts actually draw? (needs poppler)
    node tests/erase-suite.mjs --only ruled-link --keep

The corpus is GENERATED, not collected: `tests/fixtures/make-fixtures.mjs` writes
`letter.pdf`, whose five targets are the shapes that used to break things —
`bold-blue`, `short-heading`, `ruled-link`, `on-band` and `raster-title`. It
replaced two real third-party documents, which had no business being in a
repository that was going to be published.

Tier-2 cases need a local vision model to read words that exist only as pixels.
It looks for LM Studio on :1234; point it elsewhere with `RESHAPEDPDF_AI_URL`.
With nothing reachable those cases SKIP with a note and the run still passes —
CI has no model, and should say so rather than quietly reporting green over
untested ground.

Boots the real app on real documents, erases a named run on each, and scores the
two things that actually go wrong when you change a word on a printed page.

**Residue** — traces of the old letters left behind after the erase.
**Structure** — background flattened into a block where it had a pattern.

Artifacts land in `tests/.artifacts/`: a before/after crop per case (magenta
divider between the two), `report.json` with every number, and with `--keep` the
exported PDFs and the rasters they were scored from.

## Why the metrics are shaped this way

The obvious ground truth for an erase is "the page re-rendered without those
glyphs" — but that is exactly the image the app now uses to *build* the patch, so
scoring against it would be marking its own homework and would report a perfect
result no matter how broken the code was. So neither number refers to how the
patch was made:

- **Residue** is counted against the original ink colour, sampled from the glyphs
  themselves before the erase. Leftover ink is leftover ink whatever produced it.
  The ink is identified as the *minority* of two luminance clusters, because the
  one thing reliably true of type is that it covers less of its line than the
  surface under it. ("The dark end" works right up until white lettering on a
  dark banner, where it selects the banner and calls a clean erase a 92% failure.)

- **Structure** is per-pixel and in place. The pixels inside the run that were not
  part of a letter — paper between the words, grid lines crossing behind them —
  were already background before the erase, and a correct erase leaves them
  exactly as they were. Comparing them to themselves needs no reference region,
  which matters because every candidate reference is wrong on real documents: a
  ring around the run lands on the next 50pt name, and a "text-free rectangle
  elsewhere on the page" lands on a photograph. Both score a flawless erase at
  around 0.15.

Two things are deliberately not counted as residue. A **rule** — the underline
under a link, a table border — is a drawn line, not a glyph; an erase that
removed it would be wrong, so rows running the full width of the run are
excluded. And the **outermost columns**, because a target rect comes from a word
box, which is an advance box that can graze the first glyph of whatever follows.

Every case is then exported and re-rendered with `pdftoppm` and scored again.
Poppler shares no code with the pdf.js that drew the page on screen, so a fault
that only exists in the written file — a patch at the wrong offset, a font that
fails to embed — cannot hide behind the renderer that produced it. The
replacement text is removed before exporting, so both measurements are measuring
the same thing.

## Tiers

**Tier 1** — the words are in the page's text layer. The background under them is
recoverable exactly, by re-rendering the page without those glyphs, so the bar is
set where a real defect starts (0.15% residue) rather than where the code happens
to land today. All eight tier-1 cases currently sit at 0.00%.

**Tier 2** — the words are pixels inside an image (the banner on the Rivergate
fixture). Nothing can recover what was behind them; it has to be reconstructed.
These need a vision model to read the words at all, so the suite looks for a
local LM Studio on :1234 and *skips* them with a note when there isn't one,
rather than reporting a failure the code didn't cause.

## The identity edit

The strictest check, and the one that matches what a reader notices: retype a run
with its OWN words and demand the page comes back as it was. An erase can be
flawless and the edit still obvious — type a third of a point low, a shade too
heavy, tracking that drifts so the line ends in the wrong place.

It is deliberately NOT scored as a pixel difference. Re-setting a line re-renders
every glyph edge, so even a perfect reprint differs along every stroke by an
antialiasing step, and a total over those pixels reads ~30% however good the
result is — while a genuine fault like a baseline sitting a point low hides
inside the same number. Searching for the shift that best cancels the difference
is no better: over a line of text that landscape is flat and full of false
minima, and it reported a six-pixel offset for type sitting exactly where it
belonged. So each way an edit shows itself is measured on its own scale, in
points: `baselineDelta`, `leftDelta`, `endDelta`, `inkRatio`, `heightRatio`.
`LOOKS` in the suite defines what "you cannot tell" means numerically — a quarter
point of misregistration, a few per cent of weight.

Comparison renders at 300dpi, because at 150 a single pixel is 0.48pt and a
quarter-point bar would sit below the measurement's own resolution.

## Debris

Residue asks "is the old ink still here", which on a banner of green type over a
dark field misses what you actually see — pale flecks left behind by the fill,
none of them green, all of them obviously not background. Debris catches those:
take a clean patch of the same background, learn how bright its brightest honest
pixels get, and count anything inside the erase that exceeds it, minus the rate
the reference itself shows so a naturally speckled field is not accused.

The reference must be **immediately beside** the run, on its own rows. The
particle field on the Rivergate banner thins from right to left, so a reference
taken from the dense side sets a bar the sparse side clears however much debris
is left behind. This is not hypothetical: a real regression — the fill importing
fragments of the headline into the subtitle's gap — passed the suite because the
reference sat on the dense drift. Moving it beside the run turned the same
measurement from 0% into 2.5%, and it now fails as it should.

It is scored over the union of the target rect and the patch the code actually
produced — a patch that overhangs the words by a couple of points can leave all
its debris in that overhang, outside the declared rect, and report itself
spotless.

Tier 1 does not gate on it, and is not being let off: its background is
recovered rather than invented, so `structure` compares every non-letter pixel
against itself before the erase, which is stricter. Debris there needs a
reference patch of plain paper, and a rule or neighbouring glyph that correctly
survives reads as "not paper" and condemns a clean result.

## Editing, not just erasing

Every check above scores the ERASE, with the replacement text removed. That
cannot see a fault the new words cover, and one hid there: an identity retype
puts the same words back over the evidence, so a patch full of imported
fragments scored green. `editTo` on a case replaces the words with SHORTER ones,
exports, and scores the strip past where the new text reaches — the fill, on
show, with nothing drawn over it. `editTo` may also be longer (the banner
headline swaps in characters the original never had, to prove the face was
identified and not the letters copied); the strip is measured from the new text's
actual ink, so that case is not penalised for filling its own line.

A test that cannot fail is worth nothing, so both were checked by reintroducing
the bug they were written for and confirming the suite goes red.

## All ten pass

Nothing is being let off. The two that failed longest were fixed at the cause:

`loz-banner-green` reprinted 1.4pt low because the baseline was taken from the
matched typeface, and a fit lands by aligning ink boxes whose tops are the cap
line — so any error in the winning face's cap height moved the line by that
much. It made two requirements fight: the face that seated the line correctly set
it 40% too heavy, the one with the right weight sat it low. The baseline is now
measured from the ink itself (`baselineFromInk`) and owes nothing to the match:
letters sit on the baseline, nearly all stop there, so the middle of the marks'
endings is the line, with the descenders outvoted.

`loz-dress-code` was a fault in this file rather than in the app. Its rect came
from the pdftotext word box, which is an ADVANCE box: it reached to 149.6 while
the words end at 145.92 and the colon after them begins at 147.36. The test was
therefore asserting that a correct erase should remove a colon, and failed on the
four pixels of that colon's two dots. The rect is now measured from the ink, and
still covers the whole of "Dress Code", so it catches under-erasing exactly as
before — it is tighter, not more forgiving.

No threshold was moved for either. A bar adjusted to whatever the code currently
does is not a bar.

## Adding a case

Add to `cases.json`. Get coordinates from `pdftotext -bbox <pdf> -` and take the
word box; for raster type, measure off a render (`pdftoppm -r 150`) and divide by
2.083 to get points. Set `tier: 2` and declare `ref` by hand there — pdftotext
cannot see raster words, so it will cheerfully offer a "text-free" reference
sitting on top of the headline.
