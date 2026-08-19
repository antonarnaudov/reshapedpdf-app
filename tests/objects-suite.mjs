#!/usr/bin/env node
/*
 * Every kind of object, drawn and exported.
 *
 * The erase suite covers one path in depth. This one covers the rest in breadth,
 * because they share code with it — the ink sampler, the baseline constant, the
 * exporter's text placement, the bundled fonts — and a change made for the retype
 * lands on all of them. The default text face shipped broken for a long time and
 * nothing noticed, which is what happens when the only tested path is the
 * interesting one.
 *
 * Each case places one object on a blank page, exports, renders the result with
 * poppler, and asks the simplest questions that can fail:
 *
 *   · did anything arrive at all
 *   · is it where it was put, to within a point
 *   · is it the size it was given
 *   · for text, does the whole string come out — not a third of it
 *
 * A blank page is used on purpose. Placing a probe over existing content and
 * differencing the render sounds cleverer and hides exactly the fault being
 * hunted: letters that land on the document's own dark text vanish into it, and
 * a line drawing three of its fifteen characters looks fine.
 *
 *   node tests/objects-suite.mjs [--keep]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, launchApp, sleep } from './harness/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const OUT = join(HERE, '.artifacts', 'objects')
const PORT = Number(process.env.CDP_PORT || 9366)
const keep = process.argv.includes('--keep')
const DPI = 150

if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

/* Placed well clear of each other on an A4 blank so one case cannot be mistaken
 * for its neighbour, and away from the margins so nothing is clipped. */
const CASES = [
  {
    id: 'text-sans', kind: 'text', why: 'the DEFAULT face — this is what shipped drawing a third of its glyphs',
    obj: { x: 60, y: 80, w: 220, h: 20, text: 'Alignment probe 123', color: '#000000', size: 14, font: 'sans', bold: false },
    expect: { minWidthPt: 90, at: [60, 80] },
  },
  {
    id: 'text-serif', kind: 'text', why: 'a second face, to tell "fonts are broken" from "text is broken"',
    obj: { x: 60, y: 120, w: 220, h: 20, text: 'Alignment probe 123', color: '#000000', size: 14, font: 'serif', bold: false },
    expect: { minWidthPt: 90, at: [60, 120] },
  },
  {
    id: 'text-bold-colour', kind: 'text', why: 'weight and colour survive the trip',
    obj: { x: 60, y: 160, w: 220, h: 20, text: 'Bold coloured', color: '#c0392b', size: 16, font: 'geo', bold: true },
    expect: { minWidthPt: 70, at: [60, 160], colour: [192, 57, 43] },
  },
  {
    id: 'text-cyrillic', kind: 'text',
    why: 'Cyrillic has no place in the base-14 encodings, so a Latin-only export drops it silently — the run has to come back as a raster, not as nothing',
    obj: { x: 60, y: 200, w: 240, h: 20, text: 'Проба на кирилица', color: '#000000', size: 14, font: 'sans', bold: false },
    expect: { minWidthPt: 70, at: [60, 200] },
  },
  {
    id: 'text-right-align', kind: 'text', why: 'right-aligned text (invoice figures) must sit at the box RIGHT edge, not the left anchor',
    // a fixed 200pt box at x=60 → its right edge is 260; a short right-aligned
    // line must end there, with its left edge pushed well right of 60
    obj: { x: 60, y: 240, w: 200, h: 20, boxW: 200, align: 'right', text: 'Total 42', color: '#000000', size: 14, font: 'sans', bold: false },
    expect: { rightEdgePt: 260, minLeftPt: 150 },
  },
  {
    id: 'text-rot90', kind: 'text', why: 'a rotated-page text annotation must render TURNED, not flat in a swapped box',
    // rot:90 in a tall narrow box — a working rotation lays "HELLO" down the box
    // (ink taller than wide); a broken one draws it horizontal and overflows
    obj: { x: 300, y: 300, w: 22, h: 90, rot: 90, text: 'HELLO', color: '#000000', size: 15, font: 'sans', bold: false },
    expect: { tallerThanWide: true, within: [300, 300, 22, 90] },
  },
  {
    id: 'shape-rect', kind: 'shape', why: 'stroked geometry',
    obj: { x: 60, y: 250, w: 120, h: 50, shape: 'rect', color: '#1a7f37', fill: null, width: 2 },
    expect: { at: [60, 250], sizePt: [120, 50] },
  },
  {
    id: 'shape-filled', kind: 'shape', why: 'fill as well as stroke',
    obj: { x: 220, y: 250, w: 120, h: 50, shape: 'rect', color: '#1a1a8f', fill: '#dfe6ef', width: 2 },
    expect: { at: [220, 250], sizePt: [120, 50] },
  },
  {
    id: 'ink-stroke', kind: 'ink', why: 'freehand path',
    obj: { x: 60, y: 320, w: 160, h: 40, points: [[60, 330], [110, 355], [160, 325], [210, 350]], color: '#8e44ad', width: 3 },
    expect: { at: [60, 320], loose: true },
  },
  {
    id: 'whiteout-flat', kind: 'whiteout', why: 'the erase primitive, with no raster patch',
    obj: { x: 60, y: 380, w: 140, h: 24, color: '#ffcc00' },
    expect: { at: [60, 380], sizePt: [140, 24] },
  },
  {
    id: 'redact-box', kind: 'redact', why: 'redaction must be opaque, and must not be a light grey suggestion',
    obj: { x: 230, y: 380, w: 140, h: 24, color: '#000000' },
    expect: { at: [230, 380], sizePt: [140, 24], colour: [0, 0, 0] },
  },
  {
    id: 'markup-highlight', kind: 'markup', why: 'highlight over a band — the field is `mode`; `style` silently draws a strikethrough instead',
    obj: { x: 60, y: 430, w: 200, h: 16, mode: 'highlight', color: '#ffe066', rects: [{ x: 60, y: 430, w: 200, h: 16 }] },
    expect: { at: [60, 430], sizePt: [200, 16] },
  },
  {
    id: 'markup-underline', kind: 'markup', why: 'the other markup modes draw a rule, not a band',
    obj: { x: 60, y: 470, w: 200, h: 16, mode: 'underline', color: '#c0392b', rects: [{ x: 60, y: 470, w: 200, h: 16 }] },
    expect: { at: [60, 484], loose: true },
  },
  {
    id: 'note-annotation', kind: 'note', why: 'sticky notes leave the object model and become real PDF annotations',
    obj: { x: 300, y: 470, w: 24, h: 24, text: 'A note', color: '#f1c40f' },
    expect: { at: [300, 470], loose: true },
  },
]

const MAKE = (c) => `(() => {
  const S = window.__reshapedpdf, st = S.state()
  const page = st.docs[st.active].pages[0]
  st.addObject({ id: ${JSON.stringify(c.id)}, page: page.id, kind: ${JSON.stringify(c.kind)}, opacity: 1, ...${JSON.stringify(c.obj)} })
  return 1
})()`

/** A one-page blank A4, as base64. Hand-built so the suite needs no fixture. */
function blankA4() {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << >> /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (let i = 0; i < objs.length; i++) {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`
  }
  const xref = pdf.length
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (let i = 1; i <= objs.length; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1').toString('base64')
}

function readPPM(path) {
  const buf = readFileSync(path)
  let pos = 0
  const tok = () => {
    while (buf[pos] === 32 || buf[pos] === 10 || buf[pos] === 13 || buf[pos] === 9) pos++
    let s = ''
    while (pos < buf.length && buf[pos] > 32) s += String.fromCharCode(buf[pos++])
    return s
  }
  if (tok() !== 'P6') throw new Error('not a P6 ppm')
  const w = +tok(), h = +tok()
  tok()
  pos++
  return { w, h, data: buf.subarray(pos) }
}

async function main() {
  console.log('booting app…')
  const child = launchApp({ cwd: ROOT, port: PORT, userDataDir: join(OUT, 'profile') })
  const cdp = await connect({ port: PORT })
  await sleep(1500)

  const results = []
  try {
    // A genuinely blank A4, built here rather than borrowed. The app's sample
    // document has artwork on it, and against that every measurement below
    // reports the page itself rather than the object placed on it.
    await cdp.run(`window.__reshapedpdf.openBase64(${JSON.stringify(blankA4())}, 'blank.pdf')`)
    await sleep(2000)

    for (const c of CASES) {
      process.stdout.write(`  ${c.id.padEnd(18)} `)
      try {
        await cdp.run(MAKE(c))
      } catch (e) {
        console.log(`ERROR placing: ${String(e.message || e).slice(0, 60)}`)
        results.push({ ...c, ok: false, note: 'place failed' })
        continue
      }
      await sleep(250)
      const ex = await cdp.run('window.__reshapedpdf.exportActive()')
      const pdf = join(OUT, `${c.id}.pdf`)
      writeFileSync(pdf, Buffer.from(ex.b64, 'base64'))
      execFileSync('pdftoppm', ['-r', String(DPI), '-f', '1', '-l', '1', pdf, join(OUT, c.id)], { stdio: 'ignore' })
      const ppm = readPPM(join(OUT, `${c.id}-1.ppm`))
      const k = DPI / 72

      // anything that is not blank paper
      let x0 = ppm.w, y0 = ppm.h, x1 = -1, y1 = -1, n = 0
      let sr = 0, sg = 0, sb = 0
      for (let y = 0; y < ppm.h; y++)
        for (let x = 0; x < ppm.w; x++) {
          const i = (y * ppm.w + x) * 3
          const r = ppm.data[i], g = ppm.data[i + 1], b = ppm.data[i + 2]
          if (r > 236 && g > 236 && b > 236) continue
          n++
          sr += r; sg += g; sb += b
          if (x < x0) x0 = x
          if (x > x1) x1 = x
          if (y < y0) y0 = y
          if (y > y1) y1 = y
        }

      const found = n > 20
      const box = found ? { x: x0 / k, y: y0 / k, w: (x1 - x0) / k, h: (y1 - y0) / k } : null
      const mean = n ? [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)] : null
      const e = c.expect
      const problems = []
      if (!found) problems.push('nothing drawn')
      else {
        const tol = e.loose ? 6 : 3
        if (e.at && Math.abs(box.x - e.at[0]) > tol) problems.push(`x off by ${(box.x - e.at[0]).toFixed(1)}pt`)
        if (e.at && Math.abs(box.y - e.at[1]) > tol + 4) problems.push(`y off by ${(box.y - e.at[1]).toFixed(1)}pt`)
        if (e.minWidthPt && box.w < e.minWidthPt) problems.push(`only ${box.w.toFixed(1)}pt wide, expected >=${e.minWidthPt}`)
        // right/centre alignment: the ink's right edge lands at the box edge and
        // its left edge is pushed off the left anchor
        if (e.rightEdgePt && Math.abs((box.x + box.w) - e.rightEdgePt) > 5) problems.push(`right edge ${(box.x + box.w).toFixed(1)} vs ${e.rightEdgePt}`)
        if (e.minLeftPt && box.x < e.minLeftPt) problems.push(`left edge ${box.x.toFixed(1)} not pushed right (>=${e.minLeftPt})`)
        // rotated content: ink turned to be taller than wide, and sitting inside
        // the (axis-aligned) box rather than overflowing it
        if (e.tallerThanWide && box.h <= box.w) problems.push(`ink ${box.w.toFixed(1)}x${box.h.toFixed(1)} not taller than wide (rotation not applied)`)
        if (e.within) {
          const [wx, wy, ww, wh] = e.within
          if (box.x < wx - 4 || box.y < wy - 4 || box.x + box.w > wx + ww + 4 || box.y + box.h > wy + wh + 4) {
            problems.push(`ink ${box.x.toFixed(0)},${box.y.toFixed(0)} ${box.w.toFixed(0)}x${box.h.toFixed(0)} outside box ${e.within}`)
          }
        }
        if (e.sizePt) {
          if (Math.abs(box.w - e.sizePt[0]) > 4) problems.push(`width ${box.w.toFixed(1)} vs ${e.sizePt[0]}`)
          if (Math.abs(box.h - e.sizePt[1]) > 4) problems.push(`height ${box.h.toFixed(1)} vs ${e.sizePt[1]}`)
        }
        if (e.colour && mean) {
          const d = Math.max(...e.colour.map((v, i) => Math.abs(v - mean[i])))
          if (d > 70) problems.push(`colour ${mean} vs ${e.colour}`)
        }
      }

      const ok = problems.length === 0
      results.push({ ...c, ok, box, mean, problems })
      console.log(ok
        ? `ok    at ${box.x.toFixed(1)},${box.y.toFixed(1)}  ${box.w.toFixed(1)}x${box.h.toFixed(1)}pt`
        : `FAIL  ${problems.join('; ')}`)

      await cdp.run(`(() => { window.__reshapedpdf.state().removeObjects([${JSON.stringify(c.id)}]); return 1 })()`)
      if (!keep) {
        rmSync(pdf, { force: true })
        rmSync(join(OUT, `${c.id}-1.ppm`), { force: true })
      }
    }
  } finally {
    cdp.close()
    try { child.kill('SIGKILL') } catch { /* gone */ }
  }

  const bad = results.filter((r) => !r.ok)
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(results, null, 2))
  console.log(`\n${results.length - bad.length}/${results.length} object kinds export correctly`)
  process.exit(bad.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(2) })
