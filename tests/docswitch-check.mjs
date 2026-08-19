#!/usr/bin/env node
/*
 * An image dropped while the active doc changes must not leak into the new doc.
 *
 * placeImageOnPage awaits the image decode (hundreds of ms for a photo) before
 * appending. If the user switches documents during that wait, appending now would
 * tag the image with a page id from the OLD doc and dirty the WRONG one — the
 * image vanishes and an untouched doc is marked edited. The guard re-checks the
 * active doc after the await. The decode always yields, so a synchronous switch
 * right after the call reproduces the race deterministically.
 *
 *   node tests/docswitch-check.mjs
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, launchApp, sleep } from './harness/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PORT = Number(process.env.CDP_PORT || 9381)

function blank(tag) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Resources << >> /Contents 4 0 R >>`,
    `<< /Length ${tag.length + 10} >>\nstream\n% ${tag}\n\nendstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const off = [0]
  for (let i = 0; i < objs.length; i++) { off.push(pdf.length); pdf += `${i + 1} 0 obj\n${objs[i]}\nendobj\n` }
  const xref = pdf.length
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (let i = 1; i <= objs.length; i++) pdf += `${String(off[i]).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1').toString('base64')
}

async function main() {
  console.log('booting app…')
  const child = launchApp({ cwd: ROOT, port: PORT, userDataDir: join(HERE, '.artifacts', 'docswitch-profile') })
  const cdp = await connect({ port: PORT })
  await sleep(1500)
  let r
  try {
    await cdp.run(`window.__reshapedpdf.openBase64(${JSON.stringify(blank('AAA'))}, 'a.pdf')`)
    await sleep(500)
    const aId = await cdp.run('window.__reshapedpdf.state().active')
    const aPage = await cdp.run('window.__reshapedpdf.state().docs[window.__reshapedpdf.state().active].pages[0].id')
    await cdp.run(`window.__reshapedpdf.openBase64(${JSON.stringify(blank('BBB'))}, 'b.pdf')`)
    await sleep(500)
    const bId = await cdp.run('window.__reshapedpdf.state().active')

    r = await cdp.run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      const S = window.__reshapedpdf, st = () => S.state()
      const cv = document.createElement('canvas'); cv.width = 20; cv.height = 20
      cv.getContext('2d').fillRect(0, 0, 20, 20)
      const src = cv.toDataURL()
      const imgCount = (id) => Object.values(st().docs[id].objects).filter(o => o.kind === 'image').length

      // RACE: start placing on A, switch to B before the decode resolves
      st().setActive(${JSON.stringify(aId)}); await sleep(40)
      const dirtyA0 = st().docs[${JSON.stringify(aId)}].dirty
      const p = S.placeImage(src, { page: ${JSON.stringify(aPage)}, x: 50, y: 50 })
      st().setActive(${JSON.stringify(bId)})               // switch DURING the await
      await p; await sleep(120)
      const raceA = imgCount(${JSON.stringify(aId)}), raceB = imgCount(${JSON.stringify(bId)})
      const dirtyB = st().docs[${JSON.stringify(bId)}].dirty

      // HAPPY PATH: place on A with no switch -> lands on A
      st().setActive(${JSON.stringify(aId)}); await sleep(40)
      await S.placeImage(src, { page: ${JSON.stringify(aPage)}, x: 60, y: 60 }); await sleep(120)
      const happyA = imgCount(${JSON.stringify(aId)})

      return {
        ok: raceA === 0 && raceB === 0 && dirtyB === false && happyA === 1,
        detail: 'race: A=' + raceA + ' B=' + raceB + ' B.dirty=' + dirtyB + '  happyPath: A=' + happyA + ' (A.dirty0=' + dirtyA0 + ')',
      }
    })()`)
  } finally {
    cdp.close()
    try { child.kill('SIGKILL') } catch { /* gone */ }
  }
  const ok = !!(r && r.ok)
  console.log(`  image respects doc-switch   ${ok ? 'PASS' : 'FAIL'}  ${r ? r.detail : 'no result'}`)
  console.log(`\n${ok ? '1/1' : '0/1'} doc-switch invariants hold`)
  process.exit(ok ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(2) })
