#!/usr/bin/env node
/*
 * Do the bookmarks survive an export?
 *
 *   node tests/outline-check.mjs
 *
 * exportCompose starts a brand-new document and copies pages into it. Nothing
 * carried /Outlines across, so every edit that forces the compose path threw
 * the whole navigation tree away without a word — and True redaction, which is
 * ticked by default in the Export sheet, forces that path on its own. Redacting
 * one line of a long report deleted every bookmark in it.
 *
 * Checked against the written bytes with pdf-lib rather than through the app,
 * because the question is what is in the FILE.
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { PDFDocument, PDFName, PDFDict, PDFArray, StandardFonts, rgb } from 'pdf-lib'
import { connect, launchApp, sleep } from './harness/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const TMP = join(HERE, '.artifacts', 'outline')
const PORT = 9465

if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

/* ---- a document with a real outline tree --------------------------------- */
const doc = await PDFDocument.create()
const font = await doc.embedFont(StandardFonts.Helvetica)
const TITLES = ['Cover', 'Summary', 'Detail', 'Appendix']
for (const [i, t] of TITLES.entries()) {
  const pg = doc.addPage([595, 842])
  pg.drawText(`${t} — page ${i + 1}`, { x: 60, y: 760, size: 22, font, color: rgb(0.1, 0.1, 0.15) })
  pg.drawText('Body copy that can be redacted.', { x: 60, y: 700, size: 12, font, color: rgb(0.2, 0.2, 0.25) })
}
const ctx = doc.context
const rootDict = ctx.obj({ Type: 'Outlines' })
const rootRef = ctx.register(rootDict)
const itemRefs = TITLES.map((t, i) => {
  const dest = ctx.obj([])
  dest.push(doc.getPage(i).ref)
  dest.push(PDFName.of('Fit'))
  const d = ctx.obj({})
  d.set(PDFName.of('Title'), ctx.obj(t))
  d.set(PDFName.of('Dest'), dest)
  d.set(PDFName.of('Parent'), rootRef)
  return ctx.register(d)
})
itemRefs.forEach((r, i) => {
  const d = ctx.lookup(r)
  if (i > 0) d.set(PDFName.of('Prev'), itemRefs[i - 1])
  if (i + 1 < itemRefs.length) d.set(PDFName.of('Next'), itemRefs[i + 1])
})
rootDict.set(PDFName.of('First'), itemRefs[0])
rootDict.set(PDFName.of('Last'), itemRefs[itemRefs.length - 1])
rootDict.set(PDFName.of('Count'), ctx.obj(itemRefs.length))
doc.catalog.set(PDFName.of('Outlines'), rootRef)
const srcPath = join(TMP, 'bookmarked.pdf')
writeFileSync(srcPath, await doc.save())

/** every bookmark title in a file, in tree order */
async function titlesIn(bytes) {
  const d = await PDFDocument.load(bytes)
  const root = d.context.lookup(d.catalog.get(PDFName.of('Outlines')))
  if (!(root instanceof PDFDict)) return []
  const out = []
  let cur = root.get(PDFName.of('First'))
  let guard = 0
  while (cur && guard++ < 100) {
    const item = d.context.lookup(cur)
    if (!(item instanceof PDFDict)) break
    const t = item.get(PDFName.of('Title'))
    out.push(String(t?.decodeText?.() ?? t?.asString?.() ?? '').replace(/^\(|\)$/g, ''))
    const dst = d.context.lookup(item.get(PDFName.of('Dest')))
    if (!(dst instanceof PDFArray) || dst.size() === 0) out[out.length - 1] += ' (no destination!)'
    cur = item.get(PDFName.of('Next'))
  }
  return out
}

const b64 = readFileSync(srcPath).toString('base64')
const child = launchApp({ cwd: ROOT, port: PORT, userDataDir: '/tmp/outline-ud' })
const cdp = await connect({ port: PORT })
await sleep(1800)

let res
try {
  await cdp.run(`window.__reshapedpdf.openBase64(${JSON.stringify(b64)}, "bookmarked.pdf")`)
  await sleep(3000)
  res = await cdp.run(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const S = window.__reshapedpdf, st = () => S.state()
    const out = {}
    // plain export (fast path) — the control
    out.plain = (await S.exportActive({ trueRedact: false })).b64
    // now redact a line on page 1, which forces the compose path
    st().setZoom(1); st().setTool('redact'); await sleep(600)
    const cap = [...document.querySelectorAll('.overlay-capture')]
      .map(el => ({ el, r: el.getBoundingClientRect() }))
      .filter(x => x.r.width > 200 && x.r.height > 250)[0]
    if (cap) {
      const pev = (ty, cx, cy) => new PointerEvent(ty, { clientX: cx, clientY: cy, bubbles: true,
        cancelable: true, pointerId: 1, button: 0, buttons: ty === 'pointerup' ? 0 : 1,
        isPrimary: true, pointerType: 'mouse', view: window })
      const ax = cap.r.left + 60, ay = cap.r.top + 136, bx = ax + 200, by = ay + 16
      cap.el.dispatchEvent(pev('pointerdown', ax, ay))
      for (let i = 1; i <= 5; i++) { cap.el.dispatchEvent(pev('pointermove', ax + (bx-ax)*i/5, ay + (by-ay)*i/5)); await sleep(20) }
      cap.el.dispatchEvent(pev('pointerup', bx, by))
      await sleep(1800)
    }
    out.redacted = (await S.exportActive({ trueRedact: true })).b64
    out.fastPath = S.canFastPath ? S.canFastPath() : null
    return out
  })()`)
} finally {
  cdp.close()
  try { child.kill('SIGKILL') } catch { /* already gone */ }
}

const src = await titlesIn(readFileSync(srcPath))
const plain = await titlesIn(Buffer.from(res.plain, 'base64'))
const redacted = await titlesIn(Buffer.from(res.redacted, 'base64'))

const rows = [
  ['source', src],
  ['plain export', plain],
  ['true redaction (compose path)', redacted],
]
let bad = 0
for (const [name, got] of rows) {
  const ok = got.length === TITLES.length && got.every((t, i) => t === TITLES[i])
  if (name !== 'source' && !ok) bad++
  console.log(`  ${name.padEnd(31)} ${ok ? 'PASS' : (name === 'source' ? 'SETUP' : 'FAIL')}  ${got.length} bookmark(s): ${JSON.stringify(got)}`)
}
console.log(`\n${rows.length - 1 - bad}/${rows.length - 1} outline invariants hold`)
process.exit(bad ? 1 : 0)
