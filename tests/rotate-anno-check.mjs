#!/usr/bin/env node
/*
 * Rotating a page turns its text/image annotations WITH the page.
 *
 * rotateObj swaps a text/image/textured-whiteout box (w<->h) AND records a content
 * rotation (obj.rot); the exporter's beginContentRotation must then draw the
 * content turned inside that box, or a rotated image comes out squashed sideways
 * and rotated text lies flat (both HIGH — the page looks wrong after a rotate +
 * save). A solid rect can't reveal a missing content-turn, so this places a
 * left-red / right-blue image: after a 90° clockwise page rotation the left edge
 * becomes the top, so red must end up on TOP of the image region in the exported,
 * reopened, rasterized page. It also asserts the box swap + rot the renderer relies on.
 *
 *   node tests/rotate-anno-check.mjs
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, launchApp, sleep } from './harness/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PORT = Number(process.env.CDP_PORT || 9374)

/** Blank 600x800 one-page PDF (portrait), base64. */
function blank() {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << >> /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
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

const SCRIPT = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const S = window.__reshapedpdf
  const st = () => S.state()
  const doc = () => st().docs[st().active]
  const pid = doc().pages[0].id

  // 40x30 image: LEFT half red, RIGHT half blue (an orientation the box can't carry)
  const cv = document.createElement('canvas'); cv.width = 40; cv.height = 30
  const cx = cv.getContext('2d')
  cx.fillStyle = '#ff0000'; cx.fillRect(0, 0, 20, 30)
  cx.fillStyle = '#0000ff'; cx.fillRect(20, 0, 20, 30)
  const src = cv.toDataURL('image/png')

  st().addObject({ id: 'img', page: pid, opacity: 1, kind: 'image', x: 50, y: 60, w: 40, h: 30, src }, { select: false })
  // a text object too — assert its box swaps + content-turn is recorded (renderer relies on it)
  st().addObject({ id: 'txt', page: pid, opacity: 1, kind: 'text', x: 200, y: 400, w: 120, h: 24,
    text: 'SIDEWAYS', color: '#000000', size: 18, font: 'sans', bold: false }, { select: false })
  // a TEXTURED erase/lift patch (whiteout with a src bitmap) must turn too, not
  // stretch sideways — same left-red/right-blue probe, placed clear of the image
  st().addObject({ id: 'wo', page: pid, opacity: 1, kind: 'whiteout', x: 50, y: 200, w: 40, h: 30, color: '#ffffff', src }, { select: false })

  st().rotatePages([pid], 1)   // 90° clockwise
  const io = doc().objects['img']
  const to = doc().objects['txt']
  const wo = doc().objects['wo']
  const box = { x: io.x, y: io.y, w: io.w, h: io.h, rot: io.rot }
  const wbox = { x: wo.x, y: wo.y, w: wo.w, h: wo.h, rot: wo.rot }
  const geomOK = box.w === 30 && box.h === 40 && box.rot === 90
    && to.w === 24 && to.h === 120 && to.rot === 90   // 120x24 -> 24x120, turned
    && wbox.w === 30 && wbox.h === 40 && wbox.rot === 90   // textured whiteout swaps + turns

  // bake it: export -> reopen -> rasterize the rotated page
  const ex = await S.exportActive()
  S.openBase64(ex.b64, 'rot.pdf'); await sleep(1500)
  const ps = S.pageSize(0)
  const canvas = await S.samplingCanvas(0)
  const k = canvas.width / ps.w
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const avg = (px, py, pw, ph) => {
    const d = ctx.getImageData(Math.round(px*k), Math.round(py*k), Math.max(1,Math.round(pw*k)), Math.max(1,Math.round(ph*k))).data
    let r=0,g=0,b=0,n=0; for (let i=0;i<d.length;i+=4){ r+=d[i]; g+=d[i+1]; b+=d[i+2]; n++ }
    return { r: Math.round(r/n), g: Math.round(g/n), b: Math.round(b/n) }
  }
  // image region after 90°CW is (710,50,30,40): TOP half must be red, BOTTOM half blue
  const top = avg(box.x, box.y, box.w, box.h/2)
  const bot = avg(box.x, box.y + box.h/2, box.w, box.h/2)
  const redOnTop = top.r > top.b + 40 && bot.b > bot.r + 40
  // textured whiteout region: same TOP-red / BOTTOM-blue after the turn
  const wtop = avg(wbox.x, wbox.y, wbox.w, wbox.h/2)
  const wbot = avg(wbox.x, wbox.y + wbox.h/2, wbox.w, wbox.h/2)
  const woRedOnTop = wtop.r > wtop.b + 40 && wbot.b > wbot.r + 40
  // portraitDims: the reopened rotated page is landscape (was 600x800 -> 800x600)
  const rotated = ps.w > ps.h

  return {
    ok: geomOK && redOnTop && woRedOnTop && rotated,
    detail: 'geom=' + geomOK + ' box=' + JSON.stringify(box) + ' rotatedPage=' + rotated
      + ' imgRedOnTop=' + redOnTop + ' whiteoutRedOnTop=' + woRedOnTop
      + ' img(top/bot)=' + top.r + ',' + top.g + ',' + top.b + '/' + bot.r + ',' + bot.g + ',' + bot.b
      + ' wo(top/bot)=' + wtop.r + ',' + wtop.g + ',' + wtop.b + '/' + wbot.r + ',' + wbot.g + ',' + wbot.b,
  }
})()`

async function main() {
  console.log('booting app…')
  const child = launchApp({ cwd: ROOT, port: PORT, userDataDir: join(HERE, '.artifacts', 'rotate-anno-profile') })
  const cdp = await connect({ port: PORT })
  await sleep(1500)
  let r
  try {
    await cdp.run(`window.__reshapedpdf.openBase64(${JSON.stringify(blank())}, 'blank.pdf')`)
    await sleep(700)
    r = await cdp.run(SCRIPT)
  } finally {
    cdp.close()
    try { child.kill('SIGKILL') } catch { /* gone */ }
  }
  const ok = !!(r && r.ok)
  console.log(`  rotate keeps annotations   ${ok ? 'PASS' : 'FAIL'}`)
  console.log(`    ${r ? r.detail : 'no result'}`)
  console.log(`\n${ok ? '1/1' : '0/1'} rotation-annotation invariants hold`)
  process.exit(ok ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(2) })
