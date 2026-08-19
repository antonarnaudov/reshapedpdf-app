#!/usr/bin/env node
/*
 * A page the user removed must not travel in the exported file.
 *
 * Deleting pages (or extracting a subset) is a confidentiality operation: "send
 * them only this page". But a Link annotation on a page we KEEP can carry an
 * explicit destination — [<pageRef> /XYZ …], what Chrome and Word print-to-PDF
 * emit for a table of contents — into a page we removed. That reference keeps the
 * removed page alive:
 *   - on the fast path it stays reachable, so the orphan purge rightly spares it;
 *   - on the compose path copyPages deep-copies whatever a copied page references,
 *     dragging the excluded page's whole content into the output.
 * Measured before the fix: keeping ONLY the TOC page shipped 6 page objects and
 * all five "SECRETSECTION" bodies; through compose, 12 page objects.
 *
 * Both export paths are checked, because they fail for different reasons.
 *
 *   node tests/page-exclusion-check.mjs
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync, mkdirSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { connect, launchApp, sleep } from './harness/cdp.mjs'
import { PDFDocument, PDFName, StandardFonts, rgb } from 'pdf-lib'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const OUT = join(HERE, '.artifacts', 'page-exclusion')
const PORT = Number(process.env.CDP_PORT || 9389)
if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

/** A contents page whose links carry EXPLICIT destinations into five other pages. */
async function tocPdf() {
  const doc = await PDFDocument.create()
  const ctx = doc.context
  const helv = await doc.embedFont(StandardFonts.Helvetica)
  const toc = doc.addPage([400, 500])
  toc.drawText('TOCPAGE', { x: 50, y: 440, size: 18, font: helv, color: rgb(0, 0, 0) })
  const targets = []
  for (let i = 1; i <= 5; i++) {
    const p = doc.addPage([400, 500])
    p.drawText(`SECRETSECTION${i}`, { x: 50, y: 400, size: 18, font: helv, color: rgb(0, 0, 0) })
    targets.push(p.ref)
  }
  const annots = targets.map((ref, i) => ctx.register(ctx.obj({
    Type: 'Annot', Subtype: 'Link', Border: [0, 0, 0],
    Rect: [50, 380 - i * 24, 250, 400 - i * 24],
    Dest: [ref, PDFName.of('XYZ'), null, null, null],
  })))
  toc.node.set(PDFName.of('Annots'), ctx.obj(annots))
  return Buffer.from(await doc.save()).toString('base64')
}

/** Everything in the file, with every flate stream inflated (object streams too). */
function searchableBytes(path) {
  const buf = readFileSync(path)
  const lat = buf.toString('latin1')
  let blob = lat
  for (let m, re = /stream\r?\n/g; (m = re.exec(lat)) !== null;) {
    if (lat.slice(m.index - 3, m.index) === 'end') continue
    const s = m.index + m[0].length, e = lat.indexOf('endstream', s)
    if (e < 0) continue
    try { blob += inflateSync(buf.subarray(s, e)).toString('latin1') } catch { /* not flate */ }
  }
  return blob
}
// pdf-lib writes shown text as a hex string, so the plain literal alone is vacuous
const present = (blob, w) => blob.includes(w) || blob.toLowerCase().includes(Buffer.from(w, 'latin1').toString('hex'))

const results = []
const rec = (id, ok, detail) => { results.push({ id, ok }); console.log(`  ${id.padEnd(32)} ${ok ? 'PASS' : 'FAIL'}  ${detail}`) }

async function main() {
  const b64 = await tocPdf()
  console.log('booting app…')
  const child = launchApp({ cwd: ROOT, port: PORT, userDataDir: join(OUT, 'profile') })
  const cdp = await connect({ port: PORT })
  await sleep(1500)
  let fast, comp
  try {
    // fast path: single source, ascending indices
    await cdp.run(`window.__reshapedpdf.openBase64(${JSON.stringify(b64)}, 'toc.pdf')`)
    await sleep(1100)
    fast = await cdp.run(`(async () => {
      const S = window.__reshapedpdf, st = S.state
      st().deletePages(st().docs[st().active].pages.slice(1).map(p => p.id))
      await new Promise(r => setTimeout(r, 300))
      return { fast: S.canFastPath(), out: await S.exportActive() }
    })()`)

    // compose path: a repeated srcIndex (duplicate) forces it
    await cdp.run(`window.__reshapedpdf.openBase64(${JSON.stringify(b64)}, 'toc2.pdf')`)
    await sleep(1100)
    comp = await cdp.run(`(async () => {
      const S = window.__reshapedpdf, st = S.state
      st().deletePages(st().docs[st().active].pages.slice(1).map(p => p.id))
      await new Promise(r => setTimeout(r, 300))
      st().duplicatePage(st().docs[st().active].pages[0].id)
      await new Promise(r => setTimeout(r, 300))
      return { fast: S.canFastPath(), out: await S.exportActive() }
    })()`)
  } finally {
    cdp.close()
    try { child.kill('SIGKILL') } catch { /* gone */ }
  }

  for (const [id, r, wantLeaves] of [['fast', fast, 1], ['compose', comp, 2]]) {
    const p = join(OUT, `${id}.pdf`)
    writeFileSync(p, Buffer.from(r.out.b64, 'base64'))
    const blob = searchableBytes(p)
    const leaked = [1, 2, 3, 4, 5].filter((i) => present(blob, `SECRETSECTION${i}`))
    const leaves = (blob.match(/\/Type\s*\/Page[^s]/g) || []).length
    rec(`${id}-excluded-pages-not-in-file`, leaked.length === 0 && present(blob, 'TOCPAGE'),
      `path=${r.fast ? 'fast' : 'compose'} leaked=[${leaked}] tocKept=${present(blob, 'TOCPAGE')}`)
    rec(`${id}-no-orphan-page-objects`, leaves === wantLeaves, `/Type /Page leaves = ${leaves} (want ${wantLeaves})`)
  }

  const bad = results.filter((x) => !x.ok).length
  console.log(`\n${results.length - bad}/${results.length} page-exclusion invariants hold`)
  process.exit(bad ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(2) })
