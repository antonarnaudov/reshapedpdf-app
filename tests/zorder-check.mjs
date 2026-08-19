#!/usr/bin/env node
/*
 * The exported file must stack objects the way the screen does.
 *
 * On screen the objects live in two CSS layers, not in objOrder: the SVG layer
 * (ink, shapes, markup, erase, redact — z-index 3) always paints UNDER the HTML
 * layer (images, text, notes — z-index 4). The exporter painted in strict
 * objOrder, so the delivered file disagreed with the preview: a shape or pen
 * stroke drawn over a photo was hidden while editing but sat on top in the file,
 * and an erase over an image looked like a no-op while whiting it out on export.
 *
 * The ordering that exposes it is image FIRST, shape second: objOrder then says
 * "shape on top", the screen says "image on top", and only one of them can be
 * what the user receives. It must be the one they were looking at.
 *
 *   node tests/zorder-check.mjs
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { connect, launchApp, sleep } from './harness/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const OUT = join(HERE, '.artifacts', 'zorder')
const PORT = Number(process.env.CDP_PORT || 9390)
const DPI = 150
if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

/** RGB of one point (view pt, top-left origin) in a rendered page. */
function pixelAt(pdf, prefix, ptX, ptY) {
  execFileSync('pdftoppm', ['-r', String(DPI), '-f', '1', '-l', '1', pdf, prefix], { stdio: 'ignore' })
  const buf = readFileSync(`${prefix}-1.ppm`)
  let pos = 0
  const tok = () => { while ([32, 10, 13, 9].includes(buf[pos])) pos++; let s = ''; while (pos < buf.length && buf[pos] > 32) s += String.fromCharCode(buf[pos++]); return s }
  if (tok() !== 'P6') throw new Error('not a P6 ppm')
  const w = +tok(); tok(); tok(); pos++
  const k = DPI / 72
  const i = pos + (Math.round(ptY * k) * w + Math.round(ptX * k)) * 3
  return { r: buf[i], g: buf[i + 1], b: buf[i + 2] }
}

const results = []
const rec = (id, ok, detail) => { results.push({ id, ok }); console.log(`  ${id.padEnd(30)} ${ok ? 'PASS' : 'FAIL'}  ${detail}`) }

async function main() {
  console.log('booting app…')
  const child = launchApp({ cwd: ROOT, port: PORT, userDataDir: join(OUT, 'profile') })
  const cdp = await connect({ port: PORT })
  await sleep(1500)
  let ex
  try {
    await cdp.run('window.__reshapedpdf.openSample()')
    await sleep(1200)
    ex = await cdp.run(`(async () => {
      const S = window.__reshapedpdf, st = S.state
      const d = st().docs[st().active]
      const pid = d.pages[0].id
      // a solid GREEN image…
      const cv = document.createElement('canvas'); cv.width = 40; cv.height = 40
      const c2 = cv.getContext('2d'); c2.fillStyle = '#00c000'; c2.fillRect(0, 0, 40, 40)
      st().addObject({ id: 'zimg', page: pid, kind: 'image', opacity: 1,
        x: 100, y: 100, w: 200, h: 200, src: cv.toDataURL() }, { select: false })
      // …then a BLUE filled rect over its middle, LATER in objOrder
      st().addObject({ id: 'zshape', page: pid, kind: 'shape', opacity: 1, mode: 'rect',
        x: 150, y: 150, w: 250, h: 100, stroke: null, strokeWidth: 0, fill: '#0000ff' }, { select: false })
      const order = st().docs[st().active].objOrder
      return { order, out: await S.exportActive() }
    })()`)
  } finally {
    cdp.close()
    try { child.kill('SIGKILL') } catch { /* gone */ }
  }

  const pdf = join(OUT, 'z.pdf')
  writeFileSync(pdf, Buffer.from(ex.out.b64, 'base64'))
  const shapeLater = ex.order.indexOf('zshape') > ex.order.indexOf('zimg')
  rec('objorder-puts-shape-last', shapeLater, `objOrder=[${ex.order.join(', ')}] (the ordering that exposes the split)`)

  // (200,200) is inside both: the screen shows the IMAGE there, so the file must too
  const over = pixelAt(pdf, join(OUT, 'z'), 200, 200)
  const isGreen = over.g > 120 && over.r < 120 && over.b < 120
  const isBlue = over.b > 120 && over.r < 120 && over.g < 120
  rec('export-matches-screen-stack', isGreen,
    `overlap pixel rgb(${over.r},${over.g},${over.b}) => ${isGreen ? 'image (matches screen)' : isBlue ? 'SHAPE — export contradicts the preview' : 'neither'}`)

  // …and where the shape sticks out past the image it must still be painted —
  // the fix reorders the layers, it does not drop the lower one
  const clear = pixelAt(pdf, join(OUT, 'z'), 350, 200)
  const clearBlue = clear.b > 120 && clear.r < 120 && clear.g < 120
  rec('lower-layer-still-drawn', clearBlue,
    `shape-only pixel rgb(${clear.r},${clear.g},${clear.b}) => ${clearBlue ? 'shape drawn' : 'MISSING'}`)

  const bad = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - bad}/${results.length} z-order invariants hold`)
  process.exit(bad ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(2) })
