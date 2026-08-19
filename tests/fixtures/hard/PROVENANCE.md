# Hard fixtures

Three small PDFs the two real fixtures do not cover: a rotated page, a page
whose crop box does not start at the origin, and sensitive text hidden inside a
form XObject. Each is a case where redaction used to reach the wrong place — or
nothing at all — and ship the covered words as live text. `redact-fixtures.mjs`
loads them, redacts a real word, and checks the fix by its effect against the
naive geometry the code used before it.

They are here so the test does not touch the network. Each is a committed blob
from Mozilla's pdf.js test corpus, whose files are synthetic constructions built
to exercise the renderer (no real personal or third-party content). The pdf.js
repository is Apache-2.0; these never enter the shipped product bundle.

Base URL: `https://raw.githubusercontent.com/mozilla/pdf.js/master/test/pdfs/`

| file | sha256 (first 12) | bytes | exercises |
|------|-------------------|-------|-----------|
| `hello_world_rotated.pdf` | `ab0cb700cd5e` | 1324 | `/Rotate 90` — the mark must map through the page rotation to reach the text |
| `issue7074_reduced.pdf` | `fa0680426327` | 33952 | `CropBox` origin `cy=764.741` — the mark must account for the crop offset |
| `issue15372.pdf` | `94580093a9eb` | 109219 | sensitive text ("Layer") set inside a form XObject `/Fm0` |

To refresh (and re-check the checksums against this table):

    base=https://raw.githubusercontent.com/mozilla/pdf.js/master/test/pdfs
    for f in hello_world_rotated.pdf issue7074_reduced.pdf issue15372.pdf; do
      curl -s -o "$f" "$base/$f" && shasum -a256 "$f"
    done
