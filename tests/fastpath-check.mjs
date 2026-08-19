#!/usr/bin/env node
/*
 * A merge that is later undone/deleted must not permanently flatten the form.
 *
 * canUseFastPath decides whether an export keeps the page as-is (fast path,
 * interactive AcroForm preserved) or recomposes it (static, form flattened). A
 * merge appends a srcId that delete/undo never prunes from doc.srcIds — so the
 * decision MUST count the sources the LIVE pages reference, not doc.srcIds, or a
 * doc that is single-source again stays stuck on the compose path and silently
 * flattens its form. This drives the real merge/delete/export.
 *
 *   node tests/fastpath-check.mjs
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { inflateSync } from 'node:zlib'
import { connect, launchApp, sleep } from './harness/cdp.mjs'
import { PDFDocument } from 'pdf-lib'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PORT = Number(process.env.CDP_PORT || 9380)

async function formPdf() {
  const doc = await PDFDocument.create()
  const page = doc.addPage([400, 500])
  const f = doc.getForm().createTextField('fullName')
  f.setText('Anton')
  f.addToPage(page, { x: 50, y: 440, width: 200, height: 20 })
  return Buffer.from(await doc.save()).toString('base64')
}
async function plainPdf() {
  const doc = await PDFDocument.create()
  doc.addPage([400, 500]).drawText('second source', { x: 40, y: 240, size: 12 })
  return Buffer.from(await doc.save()).toString('base64')
}
/** 3 pages, each with its own word and its own filled field, for the delete case. */
async function threePager() {
  const doc = await PDFDocument.create()
  const form = doc.getForm()
  const words = ['ORIGONE', 'ORIGTWO', 'ORIGTHREE']
  for (let i = 0; i < 3; i++) {
    const p = doc.addPage([400, 500])
    p.drawText(words[i], { x: 60, y: 400, size: 20 })
    const f = form.createTextField(`fld${i}`)
    f.setText(`VAL${i}`)
    f.addToPage(p, { x: 60, y: 200, width: 160, height: 20 })
  }
  return Buffer.from(await doc.save()).toString('base64')
}

const results = []
const rec = (id, ok, detail) => { results.push({ id, ok }); console.log(`  ${id.padEnd(26)} ${ok ? 'PASS' : 'FAIL'}  ${detail}`) }

async function main() {
  const [form, plain] = [await formPdf(), await plainPdf()]
  console.log('booting app…')
  const child = launchApp({ cwd: ROOT, port: PORT, userDataDir: join(HERE, '.artifacts', 'fastpath-profile') })
  const cdp = await connect({ port: PORT })
  await sleep(1500)
  try {
    await cdp.run(`window.__reshapedpdf.openBase64(${JSON.stringify(form)}, 'form.pdf')`)
    await sleep(900)

    const r = await cdp.run(`(async () => {
      const S = window.__reshapedpdf, st = () => S.state()
      const single = S.canFastPath()                         // single source -> fast
      const merged = await S.mergeBytes(${JSON.stringify(plain)})
      await new Promise(r => setTimeout(r, 300))
      const twoSource = S.canFastPath()                      // 2 live sources -> compose
      st().deletePages(merged)                               // back to 1 live source; doc.srcIds still holds 2
      await new Promise(r => setTimeout(r, 300))
      const backToOne = S.canFastPath()                      // the fix: reads LIVE pages -> fast again
      const srcIdsLen = st().docs[st().active].srcIds.length // proves srcIds is stale (2), not pruned
      return { single, twoSource, backToOne, srcIdsLen, pages: st().docs[st().active].pages.length }
    })()`)
    rec('fastpath-tracks-live-sources',
      r && r.single === true && r.twoSource === false && r.backToOne === true,
      `single=${r && r.single} merged=${r && r.twoSource} afterDelete=${r && r.backToOne} (srcIds still ${r && r.srcIdsLen})`)

    // end-to-end: after merge+delete, the exported form must still be INTERACTIVE
    // (fast path keeps the AcroForm; the compose path would flatten it to 0 fields)
    const ex = await cdp.run('window.__reshapedpdf.exportActive()')
    await cdp.run(`window.__reshapedpdf.openBase64(${JSON.stringify(ex.b64)}, 'rt.pdf')`)
    await sleep(900)
    const fieldCount = await cdp.run(`(() => {
      const d = window.__reshapedpdf.state().docs[window.__reshapedpdf.state().active]
      return d.fields.length
    })()`)
    rec('export-keeps-form-interactive', fieldCount >= 1, `reopened field count = ${fieldCount} (want >=1)`)

    // Deleting a page used to break the fast export TWO ways, because pdf-lib's
    // removePage unlinks the leaf but never invalidates its page cache and never
    // frees the page's objects:
    //   1. every later getPage(i) still indexed the ORIGINAL list, so each edit
    //      landed N pages early and the first survivor's edit was dropped entirely;
    //   2. the deleted page's content stayed in the file, recoverable — "delete
    //      this page, then send it" did not actually remove it.
    await cdp.run(`window.__reshapedpdf.openBase64(${JSON.stringify(await threePager())}, 'del.pdf')`)
    await sleep(900)
    const del = await cdp.run(`(async () => {
      const S = window.__reshapedpdf, st = S.state
      st().deletePages([st().docs[st().active].pages[0].id])
      const d = st().docs[st().active]
      const mk = (id, page, text) => st().addObject({ id, page, kind: 'text', opacity: 1, x: 60, y: 60,
        w: 200, h: 24, text, color: '#ff0000', size: 16, font: 'sans', bold: false }, { select: false })
      mk('d0', d.pages[0].id, 'MARKERAAA')
      mk('d1', d.pages[1].id, 'MARKERBBB')
      return { fast: S.canFastPath(), out: await S.exportActive() }
    })()`)
    const delPath = join(HERE, '.artifacts', 'fastpath-deleted.pdf')
    writeFileSync(delPath, Buffer.from(del.out.b64, 'base64'))
    const pageText = (n) => { try { return execFileSync('pdftotext', ['-f', String(n), '-l', String(n), delPath, '-'], { encoding: 'utf8' }) } catch { return '' } }
    const t1 = pageText(1), t2 = pageText(2)
    rec('delete-keeps-edits-on-right-page',
      del.fast === true && t1.includes('MARKERAAA') && t1.includes('ORIGTWO') && t2.includes('MARKERBBB') && t2.includes('ORIGTHREE'),
      `fast=${del.fast} p1=[${t1.includes('ORIGTWO') ? 'ORIGTWO' : '?'}/${t1.includes('MARKERAAA') ? 'MARKERAAA' : 'MISSING'}] p2=[${t2.includes('ORIGTHREE') ? 'ORIGTHREE' : '?'}/${t2.includes('MARKERBBB') ? 'MARKERBBB' : 'MISSING'}]`)
    // Search the RAW bytes with every stream inflated. Not via `qpdf --qdf` (it drops
    // unreachable objects itself, hiding the leak) and not for the plain literal
    // (pdf-lib writes shown text as a hex string) — both make the check vacuous.
    const buf = readFileSync(delPath)
    const lat = buf.toString('latin1')
    let blob = lat
    for (let m, re = /stream\r?\n/g; (m = re.exec(lat)) !== null;) {
      if (lat.slice(m.index - 3, m.index) === 'end') continue
      const s = m.index + m[0].length, e = lat.indexOf('endstream', s)
      if (e < 0) continue
      try { blob += inflateSync(buf.subarray(s, e)).toString('latin1') } catch { /* not flate */ }
    }
    const present = (w) => blob.includes(w) || blob.toLowerCase().includes(Buffer.from(w, 'latin1').toString('hex'))
    rec('deleted-page-content-not-in-file', !present('ORIGONE') && present('ORIGTWO'),
      `deleted page text ${present('ORIGONE') ? 'STILL IN FILE' : 'gone'}; survivor text ${present('ORIGTWO') ? 'intact' : 'MISSING'}`)
  } finally {
    cdp.close()
    try { child.kill('SIGKILL') } catch { /* gone */ }
  }
  const bad = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - bad}/${results.length} fast-path invariants hold`)
  process.exit(bad ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(2) })
