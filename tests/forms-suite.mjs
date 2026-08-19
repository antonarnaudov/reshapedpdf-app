#!/usr/bin/env node
/*
 * Form fields survive the operations that used to drop them.
 *
 * Nothing in the suite touched interactive forms, yet two HIGH content-loss bugs
 * lived here: duplicating a form page rendered/exported the copy with NO fillable
 * fields, and a multiline field value didn't wrap on the static export path. This
 * builds a real AcroForm with pdf-lib (a single-line and a multiline text field),
 * loads it in the app, and checks the field model + the exported render.
 *
 *   node tests/forms-suite.mjs
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { connect, launchApp, sleep } from './harness/cdp.mjs'
import { PDFDocument } from 'pdf-lib'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const OUT = join(HERE, '.artifacts', 'forms')
const PORT = Number(process.env.CDP_PORT || 9376)
const DPI = 150

if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

/** A real one-page AcroForm: a single-line field 'fullName' and a multiline 'bio'. */
async function formPdf() {
  const doc = await PDFDocument.create()
  const page = doc.addPage([400, 500])
  const form = doc.getForm()
  const name = form.createTextField('fullName')
  name.setText('Anton')
  name.addToPage(page, { x: 50, y: 440, width: 200, height: 20 })
  const bio = form.createTextField('bio')
  bio.enableMultiline()
  // long enough that it MUST wrap to several lines inside a 120pt-wide box
  bio.setText('the quick brown fox jumps over the lazy dog again and again and again')
  bio.addToPage(page, { x: 50, y: 300, width: 120, height: 110 })
  const bytes = await doc.save()
  return Buffer.from(bytes).toString('base64')
}

/** A one-page form whose field is deliberately called `Text1` — the name two
 *  unrelated Acrobat forms almost always share. */
async function collidingPdf(marker, value) {
  const doc = await PDFDocument.create()
  const page = doc.addPage([400, 500])
  page.drawText(marker, { x: 50, y: 460, size: 14 })
  const f = doc.getForm().createTextField('Text1')
  f.setText(value)
  f.addToPage(page, { x: 50, y: 380, width: 200, height: 20 })
  return Buffer.from(await doc.save()).toString('base64')
}

function readPPM(path) {
  const buf = readFileSync(path)
  let pos = 0
  const tok = () => { while ([32, 10, 13, 9].includes(buf[pos])) pos++; let s = ''; while (pos < buf.length && buf[pos] > 32) s += String.fromCharCode(buf[pos++]); return s }
  if (tok() !== 'P6') throw new Error('not a P6 ppm')
  const w = +tok(), h = +tok(); tok(); pos++
  return { w, h, data: buf.subarray(pos) }
}

const results = []
const rec = (id, ok, detail) => { results.push({ id, ok }); console.log(`  ${id.padEnd(26)} ${ok ? 'PASS' : 'FAIL'}  ${detail}`) }

async function main() {
  const b64 = await formPdf()
  console.log('booting app…')
  const child = launchApp({ cwd: ROOT, port: PORT, userDataDir: join(OUT, 'profile') })
  const cdp = await connect({ port: PORT })
  await sleep(1500)
  try {
    await cdp.run(`window.__reshapedpdf.openBase64(${JSON.stringify(b64)}, 'form.pdf')`)
    await sleep(1200)

    // sanity: the loader parsed both fields onto page 0
    const s0 = await cdp.run(`(() => {
      const d = window.__reshapedpdf.state().docs[window.__reshapedpdf.state().active]
      const p0 = d.pages[0].id
      return { count: d.fields.length, onP0: d.fields.filter(f => f.page === p0).length, names: d.fields.map(f => f.name).sort() }
    })()`)
    rec('fields-loaded', s0 && s0.count === 2 && s0.onP0 === 2 && s0.names.join(',') === 'bio,fullName',
      `count=${s0 && s0.count} onPage0=${s0 && s0.onP0} names=[${s0 && s0.names}]`)

    // [6] duplicatePage must CLONE the page's form fields onto the new page
    const dup = await cdp.run(`(() => {
      const st = window.__reshapedpdf.state
      const d0 = st().docs[st().active]
      const p0 = d0.pages[0].id
      st().duplicatePage(p0)
      const d = st().docs[st().active]
      const clone = d.pages[1].id
      const cf = d.fields.filter(f => f.page === clone)
      return { pages: d.pages.length, cloneFields: cf.length, cloneNames: cf.map(f => f.name).sort(), totalFields: d.fields.length }
    })()`)
    rec('dup-clones-fields', dup && dup.pages === 2 && dup.cloneFields === 2 && dup.cloneNames.join(',') === 'bio,fullName' && dup.totalFields === 4,
      `pages=${dup && dup.pages} cloneFields=${dup && dup.cloneFields} names=[${dup && dup.cloneNames}] total=${dup && dup.totalFields}`)

    // [6b] MERGING must not overwrite values the user already typed. formValues is
    // one flat name-keyed map and the incoming file's values were spread LAST, so
    // any shared field name (Text1, Name, Date — guaranteed between two forms)
    // replaced what was in the open document, and both widgets then shared the one
    // surviving entry, so the export wrote the wrong value on both pages.
    await cdp.run(`window.__reshapedpdf.openBase64(${JSON.stringify(await collidingPdf('PAGEAAA', 'Alice'))}, 'a.pdf')`)
    await sleep(800)
    const merged = await cdp.run(`(async () => {
      const S = window.__reshapedpdf, st = S.state
      await S.mergeBytes(${JSON.stringify(await collidingPdf('PAGEBBB', 'Bob'))})
      await new Promise(r => setTimeout(r, 400))
      const d = st().docs[st().active]
      const vals = d.fields.map(f => d.formValues[f.name])
      return { pages: d.pages.length, names: d.fields.map(f => f.name), vals,
        exportNames: d.fields.map(f => f.exportName ?? f.name), out: await S.exportActive() }
    })()`)
    const mPdf = join(OUT, 'merged.pdf')
    writeFileSync(mPdf, Buffer.from(merged.out.b64, 'base64'))
    const pageText = (n) => { try { return execFileSync('pdftotext', ['-f', String(n), '-l', String(n), mPdf, '-'], { encoding: 'utf8' }) } catch { return '' } }
    const t1 = pageText(1), t2 = pageText(2)
    rec('merge-keeps-both-values',
      merged.vals.includes('Alice') && merged.vals.includes('Bob') && new Set(merged.names).size === 2,
      `names=[${merged.names}] values=[${merged.vals}] (both must survive)`)
    rec('merge-values-on-right-page',
      t1.includes('PAGEAAA') && t1.includes('Alice') && t2.includes('PAGEBBB') && t2.includes('Bob'),
      `p1=[${t1.includes('PAGEAAA') ? 'A' : '?'}/${t1.includes('Alice') ? 'Alice' : 'MISSING'}] p2=[${t2.includes('PAGEBBB') ? 'B' : '?'}/${t2.includes('Bob') ? 'Bob' : 'MISSING'}]`)
    rec('merge-keeps-source-field-name',
      merged.exportNames.filter((n) => n === 'Text1').length === 2,
      `exportNames=[${merged.exportNames}] (the FILE must still call both Text1)`)

    // [7] a multiline field value must WRAP on the static/compose export path:
    // rasterize the exported page and count distinct ink rows inside the 'bio' box
    // — the fix draws it wrapped via wrapLines+boxW, the bug drew one clipped line.
    // The static path only runs when canUseFastPath is false, so duplicate the page
    // first (a repeated srcIndex forces compose) — then measure page 0, unchanged.
    await cdp.run(`window.__reshapedpdf.openBase64(${JSON.stringify(b64)}, 'form2.pdf')`)
    await sleep(800)
    await cdp.run(`(() => { const st = window.__reshapedpdf.state; st().duplicatePage(st().docs[st().active].pages[0].id) })()`)
    const ex = await cdp.run('window.__reshapedpdf.exportActive()')
    const pdf = join(OUT, 'form.pdf')
    writeFileSync(pdf, Buffer.from(ex.b64, 'base64'))
    execFileSync('pdftoppm', ['-r', String(DPI), '-f', '1', '-l', '1', pdf, join(OUT, 'form')], { stdio: 'ignore' })
    const ppm = readPPM(join(OUT, 'form-1.ppm'))
    const k = DPI / 72
    // the 'bio' box is at pdf-user y in [300,410], x in [50,170]; in the raster
    // (top-down) that's rows [ (500-410)*k .. (500-300)*k ] = [90k..200k]
    const x0 = Math.round(50 * k), x1 = Math.round(170 * k)
    const y0 = Math.round(90 * k), y1 = Math.round(200 * k)
    const rowHasInk = []
    for (let y = y0; y < y1; y++) {
      let ink = 0
      for (let x = x0; x < x1; x++) {
        const i = (y * ppm.w + x) * 3
        if (ppm.data[i] < 140 && ppm.data[i + 1] < 140 && ppm.data[i + 2] < 140) ink++
      }
      rowHasInk.push(ink > 1)
    }
    // count runs of inked rows = number of text lines
    let lines = 0
    for (let i = 0; i < rowHasInk.length; i++) if (rowHasInk[i] && !rowHasInk[i - 1]) lines++
    rec('multiline-wraps-on-export', lines >= 3, `distinct ink rows in bio box = ${lines} (want >=3)`)
  } finally {
    cdp.close()
    try { child.kill('SIGKILL') } catch { /* gone */ }
  }
  const bad = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - bad}/${results.length} form invariants hold`)
  process.exit(bad ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(2) })
