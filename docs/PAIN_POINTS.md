# PDF Editor Pain Points (web research, 2026-07)

Ranked by frequency x severity across HN, Reddit, Adobe Community, review sites.
Format per item: pain / why current tools fail / evidence / ReshapedPDF angle.

## 1. Editing text in place changes the font or the look
- Pain: touch one word and it no longer matches the rest of the document.
- Why tools fail: PDFs embed subsetted fonts (only glyphs actually used); editors can't type new characters in the original font, so Acrobat silently substitutes and warns the font "is not available or can't be used in editing."
- Evidence: Adobe Community https://community.adobe.com/t5/acrobat-discussions/font-not-available-or-can-t-be-used-in-editing/td-p/8213800 ; HN: "PDFs commonly only include the glyphs from the font that are actually used" https://news.ycombinator.com/item?id=43881724 ; HN OP: FOSS-edited docs "look distinct, in a bad way, from the original document" https://news.ycombinator.com/item?id=37995726
- ReshapedPDF: local font identification from glyph outlines + synthesize missing glyphs from the embedded subset so edits are pixel-faithful.

## 2. One edit reflows and damages the rest of the page
- Pain: editing a line makes other text shift, drop 2mm, vanish, or turn to gibberish on save.
- Why: PDF has no paragraphs, only glyphs at coordinates; Acrobat guesses text blocks and re-lays them out wrong. Adobe's own stance: Acrobat "is not a word processing application."
- Evidence: "Editing in Acrobat moves or deletes text" https://community.adobe.com/t5/acrobat-discussions/editing-in-acrobat-moves-or-deletes-text-functionality-problems/td-p/14481626 ; "text changes to gibberish" after save https://community.adobe.com/t5/acrobat-discussions/when-i-edit-a-pdf-and-save-it-the-text-changes-to-gibberish-and-i-don-t-know-why-can-you-help/m-p/12341450 ; "text shifts when editing pdf" https://community.adobe.com/t5/acrobat/text-shifts-when-editing-pdf/m-p/10091615
- ReshapedPDF: constrain re-layout to the touched block's bounding box + pixel-diff preview so nothing changes silently.

## 3. Scanned PDFs: editing destroys the scanned look
- Pain: changing one word on a scan force-OCRs the page, swaps in fake fonts, rasterizes logos — the output screams "edited."
- Why: Acrobat's Edit converts the scan to synthetic text in an approximated font; auto-OCR fires even when you only wanted to add a header. OCR fonts are fake subsets you can't reuse.
- Evidence: auto-OCR called "damaging," "rasterizes logos" https://acrobat.uservoice.com/forums/590923-acrobat-for-windows-and-mac/suggestions/18499213-how-to-turn-off-automatic-ocr-when-editing-a-scann ; "Acrobat Pro OCR ends up with different fonts" https://community.adobe.com/t5/acrobat-discussions/acrobat-pro-ocr-ends-up-with-different-fonts-to-system-fonts/td-p/14888411
- ReshapedPDF: edit-on-pixels — inpaint the old word, render the replacement matched to the scan's font, ink weight and noise; never touch the rest of the page.

## 4. No seamless eraser: removing marks leaves white scars
- Pain: deleting a stamp, watermark or handwriting leaves a white box over lined paper, shading, or underlying print.
- Why: every mainstream "erase/whiteout" tool is literally white paint (Smallpdf tells users to draw white rectangles); the only inpainting-style removers are paid upload-your-document web services.
- Evidence: https://smallpdf.com/blog/pdf-white-out ; eraser-as-white-brush https://pdferaser.net/how-to-remove-the-handwriting-from-a-scanned-pdf-file.html ; paid cloud AI remover https://removehandwriting.com/
- ReshapedPDF: local inpainting (LaMa-class model) that reconstructs background lines/texture beneath removed content — offline, free.

## 5. Flat (non-AcroForm) forms are misery to fill
- Pain: a form with no fields means manually dropping and aligning a text box for every blank.
- Why: Acrobat's auto field detection only works on specific design cues, skips combo boxes/lists, and community verdict is "if it works you're lucky; if it doesn't, you do it yourself." Free tools mostly have no detection at all.
- Evidence: "Acrobat Pro DC won't detect fields" https://community.adobe.com/t5/acrobat-discussions/acrobat-pro-dc-won-t-detect-fields/td-p/9906840 ; Adobe's own constraints doc https://helpx.adobe.com/sign/authoring/automatic-field-detection-authoring.html
- ReshapedPDF: vision-model field detection (labels, underlines, checkboxes — works on scans too) → one-click fillable overlay with correct alignment and tab order.

## 6. "Redaction" that doesn't redact
- Pain: black boxes that still contain the text; copy-paste reveals everything.
- Why: annotation rectangles hide pixels but leave the text layer intact — even the DOJ shipped this failure in the Epstein files release (Dec 2025), echoing Manafort.
- Evidence: https://www.thetechsavvylawyer.page/blog/2025/12/25/how-to-redact-pdf-documents-properly-and-recover-data-from-failed-redactions-a-guide-for-lawyers-after-the-doj-epstein-files-release-leak ; https://allaboutpdf.com/blog/2025/12/23/epstein-files-redaction-fail
- ReshapedPDF: true content-stream deletion + auto-verification (re-extract under boxes) + AI sweep that finds the same entity everywhere, including metadata and OCR layer.

## 7. Online tools = upload risk + freemium traps
- Pain: uploading sensitive docs to strangers, then hitting Smallpdf's 2 tasks/day, Sejda's 3/hour, iLovePDF's ads and watermarks mid-task.
- Why: the freemium model is designed so you "feel the friction ... pushing you to upgrade"; even "free" PDFgear sends files to servers for its AI features.
- Evidence: https://www.aservus.com/blog/ilovepdf-alternative/ ; https://fixmypdf.in/blog/free-ilovepdf-alternatives ; PDFgear server-side AI processing https://www.pdnob.com/pdf-editor/pdfgear-review.html
- ReshapedPDF: local-first + BYOM is the direct answer — say it loudly: no upload, no limits, your own model.

## 8. No free/OSS tool does real text editing at all
- Pain: the most-starred OSS PDF app (Stirling) can't edit text in place; users ask for it and resent gating.
- Why: seamless editing is hard (items 1-2), so OSS ships split/merge/annotate instead; HN: "no viable open source alternative" even to Mac Preview.
- Evidence: https://github.com/Stirling-Tools/Stirling-PDF/discussions/5040 ; https://news.ycombinator.com/item?id=37995726
- ReshapedPDF: shipping items 1-3 free and local leapfrogs the entire OSS field.

## 9. Copied/extracted text is garbage (blocks every AI feature)
- Pain: copy-paste yields hard line breaks, missing spaces, or wrong characters entirely.
- Why: subsetted fonts remap codepoints ("'A' may stand for '#'"); space characters often don't exist in the stream at all.
- Evidence: https://news.ycombinator.com/item?id=24108950 ; Adobe reflow thread — the space "is not there at all" https://community.adobe.com/t5/acrobat/line-breaks-in-reflow-mode/m-p/8691133
- ReshapedPDF: BYOM re-segmentation pass — local LLM reconstructs words/paragraphs from glyph geometry before any copy, search, or AI operation.

## Build-priority note
Highest wow-per-effort tonight: #4 (inpaint eraser) and #5 (form field detection) — pure vision problems, no content-stream surgery. #1-#3 are the long-term moat; #6 and #7 are cheap trust-builders to market immediately.
