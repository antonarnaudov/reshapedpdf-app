#!/usr/bin/env node
/*
 * Scrubbing Document Properties must actually scrub them.
 *
 * The fast path loads with updateMetadata:false, so the source's /Metadata XMP
 * packet survived verbatim — a user who cleared Title and Author still shipped
 * dc:title "Secret Internal Draft" and dc:creator to every XMP-aware reader while
 * the visible Properties looked clean. And truthiness guards meant an emptied
 * field kept the source /Info value, so clearing one was impossible in the first
 * place. doc.meta is now seeded from the file's own /Info on open, so "blank"
 * genuinely means "the user emptied it" and the export can write it through.
 *
 *   node tests/metadata-check.mjs
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { connect, launchApp, sleep } from './harness/cdp.mjs'
import { PDFDocument, PDFName } from 'pdf-lib'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const OUT = join(HERE, '.artifacts', 'metadata')
const PORT = Number(process.env.CDP_PORT || 9394)
if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const TITLE = 'SecretInternalDraft'
const AUTHOR = 'JaneWhistleblower'

/** A file carrying the secrets in BOTH /Info and an XMP packet, as real files do. */
async function fixture() {
  const doc = await PDFDocument.create()
  doc.addPage([300, 300]).drawText('body', { x: 40, y: 200, size: 12 })
  doc.setTitle(TITLE)
  doc.setAuthor(AUTHOR)
  const xmp = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${TITLE}</rdf:li></rdf:Alt></dc:title>
<dc:creator><rdf:Seq><rdf:li>${AUTHOR}</rdf:li></rdf:Seq></dc:creator>
</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`
  const ref = doc.context.register(doc.context.stream(xmp, { Type: 'Metadata', Subtype: 'XML' }))
  doc.catalog.set(PDFName.of('Metadata'), ref)
  return Buffer.from(await doc.save()).toString('base64')
}

/** the whole file, every flate stream inflated (the XMP packet may be compressed) */
function searchable(path) {
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
const present = (blob, w) => blob.includes(w) || blob.toLowerCase().includes(Buffer.from(w, 'latin1').toString('hex'))

const results = []
const rec = (id, ok, detail) => { results.push({ id, ok }); console.log(`  ${id.padEnd(30)} ${ok ? 'PASS' : 'FAIL'}  ${detail}`) }

async function main() {
  console.log('booting app…')
  const child = launchApp({ cwd: ROOT, port: PORT, userDataDir: join(OUT, 'profile') })
  const cdp = await connect({ port: PORT })
  await sleep(1600)
  let r
  try {
    await cdp.run(`window.__reshapedpdf.openBase64(${JSON.stringify(await fixture())}, 'meta.pdf')`)
    await sleep(1200)
    r = await cdp.run(`(async () => {
      const S = window.__reshapedpdf, st = S.state
      const seeded = { ...st().docs[st().active].meta }          // must show the FILE's properties
      st().setMeta({ title: '', author: '', subject: '', keywords: '' })   // scrub
      return { seeded, out: await S.exportActive() }
    })()`)
  } finally {
    cdp.close()
    try { child.kill('SIGKILL') } catch { /* gone */ }
  }

  rec('properties-seeded-from-file', r.seeded.title === TITLE && r.seeded.author === AUTHOR,
    `dialog would show title="${r.seeded.title}" author="${r.seeded.author}" (blank means "cleared" cannot be told from "untouched")`)

  const pdf = join(OUT, 'scrubbed.pdf')
  writeFileSync(pdf, Buffer.from(r.out.b64, 'base64'))
  const blob = searchable(pdf)
  rec('cleared-title-really-gone', !present(blob, TITLE), `"${TITLE}" ${present(blob, TITLE) ? 'STILL IN FILE' : 'gone'}`)
  rec('cleared-author-really-gone', !present(blob, AUTHOR), `"${AUTHOR}" ${present(blob, AUTHOR) ? 'STILL IN FILE' : 'gone'}`)
  rec('page-content-untouched', present(blob, 'body'), `page text still present = ${present(blob, 'body')}`)

  const bad = results.filter((x) => !x.ok).length
  console.log(`\n${results.length - bad}/${results.length} metadata invariants hold`)
  process.exit(bad ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(2) })
