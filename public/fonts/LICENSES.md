# Bundled font licenses

ReshapedPDF embeds these open fonts for print-matching and export. All are free to
bundle and redistribute, including embedding into exported PDFs.

| File | Family | License |
| --- | --- | --- |
| arimo-*.ttf | Arimo (metric-compatible with Arial) | Apache License 2.0 |
| tinos-*.ttf | Tinos (metric-compatible with Times New Roman) | Apache License 2.0 |
| cousine-*.ttf | Cousine (metric-compatible with Courier New) | Apache License 2.0 |
| poppins-*.ttf | Poppins | SIL Open Font License 1.1 |
| lato-*.ttf | Lato | SIL Open Font License 1.1 |
| oswald-*.ttf | Oswald | SIL Open Font License 1.1 |
| nunito-*.ttf | Nunito | SIL Open Font License 1.1 |
| robotoslab-*.ttf | Roboto Slab | Apache License 2.0 |
| archivo-*.ttf | Archivo | SIL Open Font License 1.1 |

The licences themselves ship beside the fonts, because a link is not a licence:
both the OFL and Apache-2.0 require the terms to travel with what they cover.

- [`OFL-1.1.txt`](./OFL-1.1.txt) — SIL Open Font License 1.1
- [`APACHE-2.0.txt`](./APACHE-2.0.txt) — Apache License 2.0

Each family keeps its own copyright line in its `name` table, which is the other
thing both licences ask for.

## Three families are renamed, because the licence says so

Lato, Raleway and Quicksand each declare a **Reserved Font Name** and, as
published, present it as their own family name. OFL clause 3 forbids a *Modified
Version* from doing that — and these files are modified, being pyftsubset output
(see below). So their primary names are rewritten:

| upstream | shipped as |
| --- | --- |
| Lato | RSP Humanist |
| Raleway | RSP Display |
| Quicksand | RSP Rounded |

Only the primary names change (family, full, PostScript, typographic family).
The copyright, licence and designer records are untouched, which is clause 1.
The outlines are untouched, so the type is the same type; it simply is not
entitled to the name any more.

`node scripts/rename-modified-fonts.mjs --check` fails if any bundled file ever
presents a reserved name again, and `npm test` runs it.

Arimo/Tinos/Cousine are Google's Croscore metric substitutes for the Microsoft
core fonts, chosen so a matched edit reproduces the original line width. The
remaining six cover the geometric, humanist, condensed, rounded, slab and
grotesque voices the AI face classifier can pick.

## Faces carried for matching, not for the picker

These are never offered in the font menu. They exist so that type which only
survives as pixels can be recognised — rendered, compared against the printed
line, and the closest one used to re-set the words. All are SIL Open Font
License 1.1, from Google Fonts, and redistribution with the app is permitted:

Montserrat, Raleway, Work Sans, DM Sans, Inter, Manrope, Rubik, Figtree,
Outfit, Plus Jakarta Sans, Quicksand, Urbanist.

## Why these files are subsets

Arimo, Cousine and Inter as published tripped the font parser pdf-lib bundles.
With subsetting off it raised outright; with subsetting on — which is what the
exporter does — it silently produced a PDF that drew almost nothing: fifteen
characters came out as three, and a word of dotted i's came out as blank paper,
with no error anywhere. Arimo is the default face for a new text box, so that was
every text box a user typed.

Re-writing the tables with fonttools fixes it. The files here are therefore
pyftsubset output covering Latin, Latin Extended, Greek, Cyrillic, punctuation,
currency, arrows and maths — which also happens to cut them by two thirds. The
subsetting is not what fixes anything; rewriting is. Coverage was kept wide
deliberately.

`npm run test:fonts` embeds every bundled file, draws a line with it, renders the
result and measures the ink against the font's own metrics. Checking only whether
embedding threw would have missed this entirely.
