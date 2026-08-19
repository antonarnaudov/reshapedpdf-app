#!/usr/bin/env node
/*
 * Do the bundled fonts actually draw?
 *
 * Embedding a font can fail in two ways and only one of them is loud. A corrupt
 * file thrown at pdf-lib with subsetting OFF raises immediately. With subsetting
 * ON — which is what the exporter does, to keep files small — the same file
 * sails through, produces a PDF, and quietly draws almost nothing: a fifteen
 * character line comes out as three letters, and a word made only of dotted i's
 * comes out as blank paper. No error anywhere.
 *
 * So it is not enough to ask whether embedding threw. Draw a known string, put
 * the result through a renderer, and measure how much ink arrived against what
 * the font's own metrics say it should be.
 *
 *   node tests/font-check.mjs
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const DIR = join(ROOT, 'public/fonts')
const TMP = join(HERE, '.artifacts', 'fontcheck')

const SAMPLE = 'Hamburgefonstiv 123'
const SIZE = 24
const DPI = 150

// Without poppler there is no renderer, so there is no ink to measure — and
// this check IS the ink measurement. The pdftoppm failure used to land in the
// same catch as an embedding failure, where only the subset=false result is
// ever looked at, so every font came back "ok" and the suite printed 72/72
// while rendering nothing at all. Refuse to run instead: a check that cannot
// fail is worse than a check that is missing, because it gets believed.
try {
  execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' })
} catch {
  console.error('pdftoppm not found — install poppler (brew install poppler,')
  console.error('apt-get install poppler-utils). This check renders the PDFs it')
  console.error('makes and measures the ink; without a renderer it proves nothing.')
  process.exit(1)
}

if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

const files = readdirSync(DIR).filter((f) => f.endsWith('.ttf')).sort()
const rows = []

for (const f of files) {
  const bytes = readFileSync(join(DIR, f))
  const row = { file: f, embeds: {}, inkPt: null, expectPt: null, verdict: 'ok' }

  for (const subset of [true, false]) {
    try {
      const doc = await PDFDocument.create()
      doc.registerFontkit(fontkit)
      const font = await doc.embedFont(bytes, { subset })
      const page = doc.addPage([400, 80])
      page.drawText(SAMPLE, { x: 20, y: 30, size: SIZE, font })
      const out = await doc.save()
      row.embeds[subset] = 'ok'
      if (subset) {
        row.expectPt = font.widthOfTextAtSize(SAMPLE, SIZE)
        const pdf = join(TMP, `${f}.pdf`)
        writeFileSync(pdf, out)
        execFileSync('pdftoppm', ['-r', String(DPI), '-f', '1', '-l', '1', pdf, join(TMP, f)], { stdio: 'ignore' })
        const ppm = readFileSync(join(TMP, `${f}-1.ppm`))
        // P6 header
        let pos = 0
        const tok = () => {
          while (ppm[pos] === 32 || ppm[pos] === 10 || ppm[pos] === 13 || ppm[pos] === 9) pos++
          let s = ''
          while (ppm[pos] > 32) s += String.fromCharCode(ppm[pos++])
          return s
        }
        tok()
        const W = +tok(), H = +tok()
        tok()
        pos++
        let minX = W, maxX = -1
        for (let y = 0; y < H; y++)
          for (let x = 0; x < W; x++) {
            const i = pos + (y * W + x) * 3
            if (ppm[i] < 120 && ppm[i + 1] < 120 && ppm[i + 2] < 120) {
              if (x < minX) minX = x
              if (x > maxX) maxX = x
            }
          }
        row.inkPt = maxX < 0 ? 0 : ((maxX - minX) / DPI) * 72
      }
    } catch (e) {
      row.embeds[subset] = String(e.message || e).slice(0, 60)
    }
  }

  // the drawn line should span roughly what the metrics promise; a font that
  // dropped most of its glyphs falls far short of it
  if (row.inkPt !== null && row.expectPt) {
    const ratio = row.inkPt / row.expectPt
    row.ratio = +ratio.toFixed(2)
    if (ratio < 0.75) row.verdict = row.inkPt === 0 ? 'DRAWS NOTHING' : 'DROPS GLYPHS'
  }
  if (row.embeds[false] !== 'ok') row.verdict = row.verdict === 'ok' ? 'CORRUPT (subset hides it)' : row.verdict
  rows.push(row)
}

let bad = 0
for (const r of rows) {
  if (r.verdict === 'ok') continue
  bad++
  console.log(`${r.file.padEnd(26)} ${String(r.verdict).padEnd(26)} ink ${String(r.inkPt?.toFixed(1)).padStart(6)}pt of ${r.expectPt?.toFixed(1)}pt expected`)
  if (r.embeds[false] !== 'ok') console.log(`${''.padEnd(26)} unsubsetted embed: ${r.embeds[false]}`)
}
console.log(`\n${files.length - bad}/${files.length} bundled fonts draw correctly`)
rmSync(TMP, { recursive: true, force: true })
process.exit(bad ? 1 : 0)
