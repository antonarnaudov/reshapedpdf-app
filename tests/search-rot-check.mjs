#!/usr/bin/env node
/*
 * Rotated-search geometry, proven against rasterized ground truth.
 *
 * The search redaction-cover filter (src/pdf/textsearch.ts) must place a text
 * run's rect over the ACTUAL glyph ink at every page rotation, or a redaction
 * drawn on the visible words fails to hide them in Find (a privacy leak) and the
 * highlight/line-snap land on empty paper. This geometry burned five iterations
 * with per-rotation special-casing; the general runAABB (footprint from the
 * run's own advance/ascender directions) is meant to end that.
 *
 * For each of /Rotate 0,90,180,270 this builds a one-page PDF with a text run,
 * loads it with the same pdf.js the app uses, computes the run rect EXACTLY as
 * pageText does (replicated below — keep in sync), rasterizes the page to find
 * the real ink bbox, and asserts the computed rect covers a majority of the ink
 * (the same >=0.5 area test coveredMajority uses to decide a redaction hides it).
 *
 *   node tests/search-rot-check.mjs
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
const { createCanvas } = await import('@napi-rs/canvas')

/* ---- the geometry under test: kept identical to src/pdf/textsearch.ts ---- */
function runAABB(ox, oy, ax, ay, ux, uy, len, asc, desc) {
  const xs = [ox + ux * asc, ox + ax * len + ux * asc, ox - ux * desc, ox + ax * len - ux * desc]
  const ys = [oy + uy * asc, oy + ay * len + uy * asc, oy - uy * desc, oy + ay * len - uy * desc]
  const minX = Math.min(...xs), maxX = Math.max(...xs)
  const minY = Math.min(...ys), maxY = Math.max(...ys)
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) }
}
function spanRect(vpTransform, item) {
  const t = pdfjs.Util.transform(vpTransform, item.transform)
  const len = item.width // vp.scale is 1 here
  const al = Math.hypot(t[0], t[1]) || 1
  const ul = Math.hypot(t[2], t[3]) || 1
  return runAABB(t[4], t[5], t[0] / al, t[1] / al, t[2] / ul, t[3] / ul, len, ul, ul * 0.15)
}

/** One-page 600x800 PDF, /Rotate `rot`, showing `text` at (px,py) in `fs`pt Helvetica. */
function makePdf(rot, text, px, py, fs) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Rotate ${rot} ` +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length 60 >>\nstream\nBT /F1 ${fs} Tf ${px} ${py} Td (${text}) Tj ET\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const off = [0]
  for (let i = 0; i < objs.length; i++) { off.push(pdf.length); pdf += `${i + 1} 0 obj\n${objs[i]}\nendobj\n` }
  const xref = pdf.length
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (let i = 1; i <= objs.length; i++) pdf += `${String(off[i]).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new Uint8Array(Buffer.from(pdf, 'latin1'))
}

function inkBBox(ctx, w, h) {
  const data = ctx.getImageData(0, 0, w, h).data
  let x0 = w, y0 = h, x1 = -1, y1 = -1
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4
    if (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}
const overlapFrac = (a, b) => {
  const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  return (ox * oy) / Math.max(1, a.w * a.h)
}

const fontUrl = join(ROOT, 'node_modules/pdfjs-dist/standard_fonts/')
let failures = 0
console.log('rotated search geometry')
console.log('------------------------------------------------------------')
for (const rot of [0, 90, 180, 270]) {
  const data = makePdf(rot, 'HELLOWORLD', 100, 700, 24)
  const doc = await pdfjs.getDocument({ data, standardFontDataUrl: fontUrl, isEvalSupported: false }).promise
  const page = await doc.getPage(1)
  const vp = page.getViewport({ scale: 1, rotation: rot })
  const tc = await page.getTextContent()
  const item = tc.items.find((it) => 'str' in it && it.str.trim())
  const rect = spanRect(vp.transform, item)

  const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height))
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvasContext: ctx, viewport: vp }).promise
  const ink = inkBBox(ctx, canvas.width, canvas.height)
  await doc.destroy()

  // A redaction the user draws over the visible ink must overlap a MAJORITY of
  // the computed rect (else coveredMajority won't hide it → leak).
  const frac = ink ? overlapFrac(rect, ink) : 0
  const ok = ink && frac >= 0.5
  if (!ok) failures++
  const f = (r) => r ? `${r.x.toFixed(0)},${r.y.toFixed(0)} ${r.w.toFixed(0)}x${r.h.toFixed(0)}` : 'none'
  console.log(`  rot ${String(rot).padStart(3)}  rect ${f(rect).padEnd(20)} ink ${f(ink).padEnd(20)} cover ${(frac * 100).toFixed(0)}%  ${ok ? 'PASS' : 'FAIL'}`)
}
console.log('------------------------------------------------------------')
console.log(`${4 - failures}/4 rotations place the search rect over the ink`)
process.exit(failures ? 1 : 0)
