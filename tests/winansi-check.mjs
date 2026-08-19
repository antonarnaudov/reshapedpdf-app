#!/usr/bin/env node
/*
 * isWinAnsi is a PROMISE to the exporter: "this string can be drawn as vector
 * text". It picks the vector path, and the drawing has already begun by the time
 * pdf-lib would throw — which is how a single unencodable character produced the
 * export double-print. So the predicate must agree with the encoder that actually
 * runs, not with an approximation of the WinAnsi range.
 *
 * This cross-validates it against pdf-lib's real StandardFonts encoder: for every
 * string, isWinAnsi(s) must IMPLY that encodeText(s) does not throw. The reverse
 * is allowed — being conservative only costs a rasterised (still sharp) run.
 *
 * The soft hyphen is the opposite trap: it encodes fine, so a naive check says
 * yes, but WinAnsi paints it as a real hyphen while the editor shows nothing.
 *
 *   node tests/winansi-check.mjs
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, existsSync, rmSync } from 'node:fs'
import { build } from 'esbuild'
import { PDFDocument, StandardFonts } from 'pdf-lib'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const TMP = join(HERE, '.artifacts', 'winansi')
if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

const out = join(TMP, 'measure.mjs')
await build({
  entryPoints: [join(ROOT, 'src/core/measure.ts')], outfile: out, bundle: true, format: 'esm',
  platform: 'node', logLevel: 'silent',
})
const { isWinAnsi } = await import('file://' + out)

const doc = await PDFDocument.create()
const font = await doc.embedFont(StandardFonts.Helvetica)
const encodes = (s) => { try { font.encodeText(s); return true } catch { return false } }
// The exporter never hands a whole block to the encoder: the vector path splits on
// \n (wrapLines, or a bare split when the box is auto-width) and draws line by
// line. So the contract isWinAnsi has to satisfy is per LINE — which is exactly why
// a newline is allowed in the predicate but a TAB, sitting *inside* a line, is not.
const canEncode = (s) => s.split('\n').every(encodes)

const CASES = [
  ['plain ascii', 'Total 42'],
  ['latin-1 accents', 'café naïve Ünicode'],
  ['winansi high glyphs', '€ — “quoted” … ‰'],
  ['tab', 'col\tcol'],
  ['carriage return', 'a\rb'],
  ['newline', 'line\nline'],
  ['DEL control', 'ab'],
  ['C1 control', 'ab'],
  ['soft hyphen', 'super­califragilistic'],
  ['emoji', 'ship it 🚀'],
  ['CJK', '請求書'],
  ['nbsp', 'a b'],
]

const results = []
const rec = (id, ok, detail) => { results.push({ id, ok }); console.log(`  ${id.padEnd(30)} ${ok ? 'PASS' : 'FAIL'}  ${detail}`) }

for (const [label, s] of CASES) {
  const claims = isWinAnsi(s)
  const really = canEncode(s)
  // the contract: claiming vector-safe must never outrun what the encoder accepts
  rec(`promise-holds: ${label}`, !claims || really,
    `isWinAnsi=${claims} encodeText=${really ? 'ok' : 'THROWS'}${!claims && really ? ' (conservative, fine)' : ''}`)
}

// The soft hyphen must be refused even though the encoder accepts it: WinAnsi
// draws it, the editor doesn't, and the file must match what the user sees.
rec('soft-hyphen-refused', isWinAnsi('a­b') === false,
  `isWinAnsi("a\\u00ADb")=${isWinAnsi('a­b')} while encodeText=${encodes('a­b') ? 'ok' : 'throws'} (must still be refused)`)
// ...and ordinary text must still take the sharp vector path.
rec('plain-text-still-vector', isWinAnsi('Invoice #2041 — Total 1,457.00') === true, 'ordinary text stays vector')

const bad = results.filter((r) => !r.ok).length
console.log(`\n${results.length - bad}/${results.length} WinAnsi invariants hold`)
process.exit(bad ? 1 : 0)
