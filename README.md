# ReshapedPDF

[![tests](https://github.com/antonarnaudov/reshapedpdf-app/actions/workflows/test.yml/badge.svg)](https://github.com/antonarnaudov/reshapedpdf-app/actions/workflows/test.yml)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-1f7a4d)](LICENSE)
[![downloads](https://img.shields.io/github/downloads/antonarnaudov/reshapedpdf-app/total?color=ff5c1f)](https://github.com/antonarnaudov/reshapedpdf-app/releases)

**Every PDF is just material. Reshape it — edits that look like they were printed that way.**

ReshapedPDF is a free, private, cross-platform PDF editor built as a local-first web core wrapped
in Electron. The same code runs as a desktop app on macOS / Windows / Linux **and** in any
modern browser on any device. There are no servers, no accounts and no telemetry: the only
thing that ever leaves your machine is the crop of a page you hand to an AI model, and only
if you connected one that is not local. (One exception, and it carries no document data:
opening the Ollama setup panel fetches the public list of vision models from ollama.com so it
can show you what to install. It is cached for a day and the panel says where it came from.) AI blending is strictly
bring-your-own-model: a local Ollama, LM Studio, any OpenAI-compatible endpoint, or (soon)
the hosted ReshapedPDF Cloud gateway.

Dark "night workbench" UI, one molten-ember accent, print-shop details (registration-cross
selection handles, a light-table canvas, an ember that cools when you save).

## Run it

```bash
npm install

npm run dev            # web app on http://localhost:5173  (works fully in the browser)
npm run desktop        # desktop app (Vite dev server + Electron shell)
npm run desktop:prod   # build, then run Electron against the production bundle
npm run package        # installable artifacts via electron-builder (dmg/zip, nsis, AppImage/deb)
```

## What works today

| Area | Details |
| --- | --- |
| **View** | pdf.js rendering, continuous scroll, thumbnails, zoom to cursor (⌘+wheel), fit width/page, space-drag & middle-click pan, light/dark bench |
| **Annotate** | Text-selection highlight / underline / strike (with a floating popover), freehand pen, sticky notes, rectangles / ellipses / lines / arrows (Shift constrains), image stamps, opacity/color/width properties, z-order |
| **Edit** | Text boxes in **nine real embedded fonts** (Sans/Serif/Mono metric twins + Geometric/Humanist/Condensed/Rounded/Slab/Grotesk). Text within WinAnsi is embedded as real, selectable type; anything beyond it — Cyrillic, Greek, CJK — is drawn through the crisp 3× raster fallback, so it looks right but is not selectable, size, bold, color, per-letter tracking, drag / resize via registration handles, arrow-key nudge, full undo/redo |
| **Retype in place** | The AI edit tool over printed text lifts it into an editable object that stays **pixel-identical** — the line's own pixels. Change the words and the result is **recomposed from the document's own letterforms** (letters harvested from the page; anything absent falls back to a cap-height-and-width-matched embedded font). Fix a typo, swap a name or date; no one can tell |
| **Magic eraser** | The Erase tool's **brush** mode paints anything away — a stamp, a watermark, handwriting, text on a gradient — and reconstructs the background underneath (colored bands, gradients, scan grain) by local inpainting. Not a white box. Box mode for rectangular patches |
| **Notes** | Sticky notes export as **real PDF `/Text` annotations** (visible in Acrobat/Preview); comments in opened PDFs are imported into the Comments panel |
| **Forms** | AcroForm detection & fill: text, multiline, checkbox, radio, dropdown. Values export into the **live, still-interactive form** (fast path) or as flattened text; optional flatten-forms toggle |
| **Pages** | Reorder (drag thumbnails), rotate (objects rotate along), delete, duplicate, insert blank, **merge another PDF**, extract range to a new file, multi-select with Shift/⌘, context menu |
| **Redact** | Cosmetic black boxes in-app; on export, **true redaction** removes the covered content from the page’s own drawing program (falling back to rasterising a page only when something on it cannot be removed safely) so covered content is permanently removed (verified: text is no longer extractable) |
| **Search** | Full-text across the document with per-hit snippets, jump-to-hit, on-page flash highlights |
| **Sign** | Draw (smoothed strokes), type, or upload; auto-trimmed transparent PNGs; reusable signature library (localStorage) |
| **Files** | Open via dialog, drag-drop, or double-click from Finder/Explorer (packaged app); images (PNG/JPEG) become stamps or a fresh PDF; multi-document tabs with unsaved-close protection; document properties (title/author/subject/keywords) |
| **Export** | Vector-faithful flattening on any page rotation (transform-matrix frame), unicode text via crisp 3× raster fallback (Cyrillic tested), optional page-number stamping, size optimization, native save dialog in Electron / download in browser |
| **AI edit (R)** | One context-smart gesture: drag over **printed text** → lift & retype it (recomposed from the page's own letters); over **text you added** → blend it into the print's size/ink/typeface; over **empty paper** → new text in the surrounding style. Your vision model transcribes and classifies the face; ink color & size come from the pixels. Verified end-to-end with a local `qwen2.5vl:3b` via Ollama (lifted a dark-banner header pixel-identically, changed IRONWORKS→IRONCLAD, recomposed from the page). Provider gallery in-app; config stays in localStorage |
| **AI clean (C)** | Draw around a logo, a stamp, a photo — the model works out where the object ends, and the engine removes those drawing operators, so what appears underneath is the document's own background rather than invented pixels. On a scan (nothing to remove) it falls back to rebuilding the texture. |
| **Removal is real** | Retype, the box eraser, lift, peel and AI clean take the covered content OUT of the page's drawing program on export — `pdftotext`, copy-paste and any indexer see what the reader sees, not what used to be there. The one exception is content drawn inside a form XObject that **two kept pages share**: editing it would take the ink off the page nobody marked, so it is covered rather than removed and the export says so in a warning. Tick **true redaction** when removal has to be unconditional — that path rasterises rather than leave anything behind. |
| **Print** | ⌘P exports and hands the result to the system viewer (temp file in Electron, tab in browser) |
| **Power** | ⌘K command palette, full keyboard shortcut map (`?`), PgUp/PgDn page nav, per-document scroll memory, live annotated thumbnails, status-bar page jump & zoom, error boundary, sample document generator |

## Architecture

```
src/
  core/      types, geometry (view ↔ PDF user-space incl. rotations), zustand store
             with snapshot undo/redo, command registry, canvas text measurement
  pdf/       pdf.js setup/loader/renderer, registry of sources (bytes + proxies),
             pdf-lib exporter (two paths), full-text search, sample generator
  components/ App shell, viewer, page view, objects layer (tools), form layer,
             panels, palette, modals
electron/    main + preload: context-isolated, native dialogs, application menu
             (clipboard roles + app shortcuts), single-instance lock, OS file-open
             events, privileged reshapedpdf:// protocol serving the bundle (file:// blocks
             module workers and font fetches in packaged apps)
build/       app icon (512px, converted per-platform by electron-builder)
```

**Offscreen rendering note:** paper-color sampling and true-redact rasterization render
with pdf.js `intent: 'print'` — display-intent renders are chunked through
`requestAnimationFrame`, which browsers throttle to zero in background tabs; an export
must never hang because the user switched tabs.

**Why this stack:** pdf.js is the battle-tested renderer that runs everywhere; pdf-lib
(MIT) can create and modify PDFs in the browser with no native dependencies — the right
licensing base for a paid product (MuPDF is AGPL/commercial and stays on the roadmap for
true text reflow).

**The exporter** picks between two paths:
- *Fast path* (same source, same page order): edits the original file in place —
  interactive forms, links and outlines survive; your fill-ins become real field values.
- *Compose path* (merge / reorder / duplicate / true-redact): rebuilds page-by-page;
  widgets are stripped and form values are drawn as static content.

All drawing goes through one transform-matrix trick (`pushOperators(cm)`) so every
annotation kind exports identically at 0/90/180/270° page rotation.

## The website

The landing page lives in its own repository — [reshapedpdf-site](https://github.com/antonarnaudov/reshapedpdf-site).
It is static HTML with no build step, and `./scripts/sync-app.sh` there copies this
repo's `dist/` in so the browser editor is served at `/app`. It was split out so a
copy change never rebuilds 18k lines of TypeScript, and so a failed compile here
can never stop the site deploying.

## Cutting a release

```bash
npm test                 # the full suite: unit harnesses + real-app CDP suites
npm run package          # installers into release/ (dmg + zip, nsis, AppImage/deb)
```

Tagging (`git tag v0.1.0 && git push origin v0.1.0`) runs the same build in CI and
opens a **draft release** with the installers attached.

### Signing — do this before anyone else installs it

An unsigned build is not merely "untrusted": since macOS Sequoia, Gatekeeper gives a
downloaded unsigned app **no right-click → Open escape hatch**. The user gets
"ReshapedPDF is damaged and can't be opened" and has to dig through System Settings →
Privacy & Security to run software they paid for. Windows SmartScreen shows its own
warning. The build is configured for signing and notarisation; it needs credentials,
which live in the environment and never in the repo:

| Variable | What it is |
| --- | --- |
| `CSC_LINK` | base64 (or path) of the Developer ID Application `.p12` |
| `CSC_KEY_PASSWORD` | that certificate's password |
| `APPLE_ID` | the Apple ID that owns the Developer Program membership |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password from appleid.apple.com |
| `APPLE_TEAM_ID` | the 10-character team id |

With those set, `npm run package` signs, hardens and notarises with no further
changes — `hardenedRuntime`, `entitlements` (`build/entitlements.mac.plist`) and
`notarize` are already on. Without them electron-builder skips signing and says so,
which is what happens on a clean checkout. Windows needs its own code-signing
certificate (`CSC_LINK`/`CSC_KEY_PASSWORD` again, or an EV token).

Verify before publishing: `codesign --verify --deep --strict --verbose=2 release/mac-arm64/ReshapedPDF.app`
and `spctl -a -vvv -t install release/mac-arm64/ReshapedPDF.app`.

## Honest limitations (a.k.a. the roadmap)

- **Editing printed text** works without any model when the page has a text layer:
  the run is recomposed from the page's own glyphs, and its drawing operators are
  removed from the content stream, so the words leave the file and not just the
  page. Words that only exist as pixels (a scan, a poster) need a connected vision
  model to be read first. Distinctive display faces outside the nine palette fonts
  are matched by the closest — cloned letters are exact, font-filled ones are close.
- **OCR** for whole scanned documents is the AI peel (a connected model); there is no
  offline OCR yet (tesseract-wasm planned). The pixel eraser and pixel-based retype
  already work on scans without one.
- **Encryption** — a PDF that is encrypted, including the common "restrict editing"
  owner password, is refused when you open it rather than at export, because it could
  never be written back out (pdf-lib limitation; qpdf-wasm planned). Re-save it
  without the protection and it opens fine.
- **A session lives in memory.** There is no project file: quitting without exporting
  loses the edits, and the app warns before it lets that happen.
- Sticky-note annotations carry no appearance stream, so icons show in Acrobat/Preview
  but not in ReshapedPDF's own re-render (contents are preserved and re-imported).
- Signed/certified PDFs: signatures are invalidated by editing (inherent to the format).
- **The retouch pen and the brush eraser paint pixels only** — what they cover stays in
  the file, because a stroke's bounding box says nothing about what it actually hid.
  The box eraser, retype, lift, peel and AI clean all remove what they cover, and
  Redact removes everything under the mark.

## Product model

- **The editor is free and MIT-licensed** (see [LICENSE](LICENSE) and [docs/OPEN_SOURCE.md](docs/OPEN_SOURCE.md));
  donations may follow once there is somewhere to put them; there is no tip jar yet.
- **AI blending is bring-your-own-model** (already shipped): local Ollama / LM Studio for
  free & private, or any OpenAI-compatible API key.
- **ReshapedPDF Cloud** (the paid product, wiring later via the Vercel AI Gateway): our tuned
  blending models behind one toggle — subscriptions and day passes. The `reshapedpdf-cloud`
  preset is already scaffolded in `src/ai/catalog.ts`; it's just another OpenAI-compatible
  endpoint to the app.
- Shipped in the local tier already: content-aware erase (backgrounds rebuilt, not flat
  patches), retype-in-place recomposed from the document's own letters, nine embedded fonts.
- Roadmap for the AI tier: translate-in-place, auto form-field detection on flat/scanned PDFs,
  OCR, image blend-in for complex backgrounds, entity-wide redaction sweep. See
  [docs/PAIN_POINTS.md](docs/PAIN_POINTS.md) for the researched priorities.

---
Built with pdf.js (Apache-2.0), pdf-lib (MIT), React, Zustand, Vite, Electron and Lucide icons,
on top of 21 open typefaces. Every dependency and every face, with its licence, is listed in
[THIRD-PARTY.md](THIRD-PARTY.md) and [public/fonts/LICENSES.md](public/fonts/LICENSES.md).
