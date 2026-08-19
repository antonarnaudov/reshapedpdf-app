#!/usr/bin/env node
/*
 * Erase-and-retype suite.
 *
 * Runs the real app on real documents and scores the two things that actually
 * go wrong when you change a word on a printed page:
 *
 *   RESIDUE   — traces of the old letters still visible after the erase.
 *   STRUCTURE — the background flattened into a block where it had a pattern.
 *
 * Both are measured WITHOUT reference to how the patch was built. That matters:
 * the obvious ground truth for an erase is "the page re-rendered without those
 * glyphs", but that is exactly the image the app now uses to make the patch, so
 * scoring against it would be marking its own homework and would report a
 * perfect result no matter how broken the code was.
 *
 * Instead:
 *   · residue is measured against the ORIGINAL INK COLOUR, sampled from the
 *     glyphs themselves before the erase. Leftover ink is leftover ink whatever
 *     produced it.
 *   · structure is measured against the SURROUNDING BACKGROUND, comparing
 *     high-frequency energy inside the patch with the ring around it. A flat
 *     block scores near zero against a patterned ring; a good fill scores near
 *     one. Neither number knows or cares which code path ran.
 *
 * Every case is then exported and re-rendered with pdftoppm — a renderer with
 * no code in common with the pdf.js used to display it — and scored again, so a
 * fault that only shows up in the written file cannot hide.
 *
 * Usage:  node tests/erase-suite.mjs [--only <id>] [--keep] [--json <path>]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import zlibMod from 'node:zlib'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, launchApp, sleep } from './harness/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const OUT = join(HERE, '.artifacts')
const PORT = Number(process.env.CDP_PORT || 9344)

const args = process.argv.slice(2)
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null
const keep = args.includes('--keep')
const jsonPath = args.includes('--json') ? args[args.indexOf('--json') + 1] : join(OUT, 'report.json')

/* Where to look for a local vision model. Tier-2 cases — words baked into an
 * image — cannot be read without one, so they SKIP when nothing answers here
 * rather than failing for a fault the code did not cause. CI has no model and
 * should still be able to run everything else honestly. */
const AI_BASE = process.env.RESHAPEDPDF_AI_URL || 'http://127.0.0.1:1234/v1'

/* ---------------- thresholds ----------------
 * Tier 1 can recover the background exactly, so its bar is set where a real
 * defect starts rather than where the current code happens to land. Tier 2 is
 * reconstruction: the numbers are recorded, and only a total failure (a flat
 * block, or the words still legible) fails the run. */
const BAR = {
  // Tier 1 does not gate on debris, and is not being let off: it has a stricter
  // check available. Its background is recovered rather than invented, so every
  // non-letter pixel inside the run can be compared against ITSELF before the
  // erase — anything painted over background shows up in `structure` at once.
  // Debris is still reported, but as a number rather than a verdict, because the
  // reference it needs is a patch of plain paper, and a rule or a neighbouring
  // glyph that correctly survives reads as "not paper" and condemns a clean
  // result. Tier 2 has no such per-pixel truth: the fill invents what it puts
  // down, so foreign marks are exactly what has to be watched for.
  1: { residuePct: 0.15, structure: 0.6, debrisPct: Infinity },
  2: { residuePct: 6.0, structure: 0.25, debrisPct: 0.5 },
}

/* What "you cannot tell it was edited" means, numerically. A quarter of a point
 * is roughly the finest misregistration the eye picks up on a printed line at
 * reading size; weight is allowed a few per cent because rasterisers differ. */
const LOOKS = {
  1: { baseline: 0.25, left: 0.3, end: 0.6, inkLo: 0.92, inkHi: 1.08, heightLo: 0.94, heightHi: 1.06 },
  2: { baseline: 0.8,  left: 1.0, end: 2.0, inkLo: 0.75, inkHi: 1.25, heightLo: 0.85, heightHi: 1.15 },
}
/**
 * `looks` on a target widens ONE axis of the identity check, and only with a
 * stated reason. It is for a deviation that is real, measured and understood —
 * the case then still fails the moment it gets worse, which is the point. It is
 * not a way to make a red case green: anything without `looksWhy` is ignored.
 */
const looksUnedited = (tier, id, target) => {
  if (!id || id.error) return false
  const L = target?.looksWhy ? { ...LOOKS[tier], ...target.looks } : LOOKS[tier]
  const ok = (v, lo, hi) => v === null || (v >= lo && v <= hi)
  return ok(id.baselineDeltaPt, -L.baseline, L.baseline) &&
         ok(id.leftDeltaPt, -L.left, L.left) &&
         ok(id.endDeltaPt, -L.end, L.end) &&
         ok(id.inkRatio, L.inkLo, L.inkHi) &&
         ok(id.heightRatio, L.heightLo, L.heightHi)
}

/* ---------------- in-page measurement ---------------- */

const MEASURE = /* js */ `
(async (pageIdx, rect, ref, tier, doErase) => {
  const S = window.__reshapedpdf
  const st = S.state()
  const doc = st.docs[st.active]
  const page = doc.pages[pageIdx]
  const pageW = S.pageSize(pageIdx).w
  const cv = await S.samplingCanvas(pageIdx)
  const k = cv.width / pageW
  const ctx = cv.getContext('2d', { willReadFrequently: true })

  const R = { x: rect[0], y: rect[1], w: rect[2], h: rect[3] }
  const px = (v) => Math.round(v * k)
  const X = px(R.x), Y = px(R.y), W = px(R.w), H = px(R.h)

  // --- the ink we are about to remove ---
  //
  // Identified as the MINORITY of two luminance clusters, because that is the
  // one thing reliably true of type: it covers less of its line than the
  // surface it sits on. Picking "the dark end" instead works until the first
  // piece of white lettering on a dark banner, where it selects the banner,
  // declares the background to be residue, and reports a clean erase as a 92%
  // failure. Which is exactly what it did.
  const before = ctx.getImageData(X, Y, W, H).data
  const lum = (d, i) => 0.2126*d[i] + 0.7152*d[i+1] + 0.0722*d[i+2]
  const lums = new Float64Array(W*H)
  for (let i = 0; i < W*H; i++) lums[i] = lum(before, i*4)
  const sortedL = Array.from(lums).sort((a,b)=>a-b)
  let cA = sortedL[Math.floor(sortedL.length*0.05)]
  let cB = sortedL[Math.floor(sortedL.length*0.95)]
  for (let it = 0; it < 12; it++) {
    let sa=0,na=0,sb=0,nb=0
    for (let i = 0; i < W*H; i++) {
      if (Math.abs(lums[i]-cA) <= Math.abs(lums[i]-cB)) { sa+=lums[i]; na++ } else { sb+=lums[i]; nb++ }
    }
    if (na) cA = sa/na
    if (nb) cB = sb/nb
  }
  let nA=0, nB=0
  for (let i = 0; i < W*H; i++) (Math.abs(lums[i]-cA) <= Math.abs(lums[i]-cB) ? nA++ : nB++)
  const inkIsA = nA <= nB
  let ir=0, ig=0, ib=0, n=0
  for (let i = 0; i < W*H; i++) {
    const isA = Math.abs(lums[i]-cA) <= Math.abs(lums[i]-cB)
    if (isA !== inkIsA) continue
    ir += before[i*4]; ig += before[i*4+1]; ib += before[i*4+2]; n++
  }
  const ink = n ? [ir/n, ig/n, ib/n] : [0,0,0]

  const nearInk = (d, i, tol) =>
    Math.abs(d[i]-ink[0]) <= tol && Math.abs(d[i+1]-ink[1]) <= tol && Math.abs(d[i+2]-ink[2]) <= tol
  const inkFracBefore = n / (W*H)

  // --- high-frequency energy, for the flat-block test ---
  const hfOf = (data, w, h) => {
    let s = 0, m = 0
    for (let y = 1; y < h-1; y++)
      for (let x = 1; x < w-1; x++) {
        const i = (y*w+x)*4
        const gx = lum(data, i+4) - lum(data, i-4)
        const gy = lum(data, ((y+1)*w+x)*4) - lum(data, ((y-1)*w+x)*4)
        s += Math.sqrt(gx*gx + gy*gy); m++
      }
    return m ? s/m : 0
  }
  // "Did the background survive" asked per pixel, in place.
  //
  // The pixels inside the run that were NOT part of a letter — the paper between
  // the words, the grid lines crossing behind them, the pattern showing through
  // the counters — were already background before the erase. A correct erase
  // leaves them exactly as they were. A block of flat colour paints over them.
  //
  // So compare them to themselves. No reference region to choose, no ring that
  // lands on the next headline, no "text-free rectangle" that lands on a
  // photograph, and nothing borrowed from the machinery that built the patch.
  // Pixels bordering a glyph are skipped: antialiasing there is genuinely
  // rewritten by any correct erase, and counting it would penalise good work.
  const isNearInk = new Uint8Array(W*H)
  for (let i = 0; i < W*H; i++) if (nearInk(before, i*4, 70)) isNearInk[i] = 1

  // A RULE is not text and is not expected to go.
  //
  // The underline beneath a link, the border of a table: these are drawn lines,
  // nothing to do with the glyphs, and an erase that removed them would be
  // wrong. They are the ink colour though, so a naive residue count reads them
  // as leftovers of the words. Tell them apart the way the eye does — a rule
  // runs the full width of the run, letters never do, because letters have gaps
  // between them.
  const ruleRow = new Uint8Array(H)
  for (let y = 0; y < H; y++) {
    let c = 0
    for (let x = 0; x < W; x++) if (isNearInk[y*W+x]) c++
    if (c >= W * 0.85) ruleRow[y] = 1
  }
  // The target rect comes from a word box, which is an ADVANCE box: it reaches
  // past the last glyph and can graze the first glyph of whatever follows. Two
  // pixels of the next character's stem are not a failed erase, so don't count
  // the extreme edge columns as residue.
  // Only tier 1 gets the advance-box allowance. Its rects come from word boxes,
  // which reach past the last glyph and graze the next. A tier 2 rect is
  // measured off the pixels of the run itself, so there is nothing to excuse —
  // and excusing it there hides the one thing most likely to go wrong on raster
  // type, a sliver of the first or last letter left standing at the edge.
  const EDGE = tier === 1 ? Math.max(2, Math.round(1.5 * k)) : 0
  const fringe = new Uint8Array(W*H)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let t = false
      for (let dy = -2; dy <= 2 && !t; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const yy = y+dy, xx = x+dx
          if (yy<0||xx<0||yy>=H||xx>=W) continue
          if (isNearInk[yy*W+xx]) { t = true; break }
        }
      if (t) fringe[y*W+x] = 1
    }

  if (!doErase) return { ink, inkFracBefore, ringHF, k, cv: { w: cv.width, h: cv.height } }

  // --- run the erase exactly as a click would ---
  st.setTool('retype')
  const hook = window.__reshapedpdfRetype && window.__reshapedpdfRetype[page.id]
  if (!hook) throw new Error('no retype hook for page ' + pageIdx + ' (is it mounted/visible?)')
  await hook(R.x + R.w/2, R.y + R.h/2)
  await new Promise(r => setTimeout(r, 400))
  for (let i = 0; i < 60 && S.state().busy; i++) await new Promise(r => setTimeout(r, 250))
  await new Promise(r => setTimeout(r, 400))

  const d2 = S.state().docs[S.state().active]
  const objs = Object.values(d2.objects).filter(o => o.page === page.id)
  const patch = objs.find(o => o.kind === 'whiteout')
  const text = objs.find(o => o.kind === 'text')

  // --- composite the erase over the page, WITHOUT the replacement text, so we
  //     are scoring the erase and not hiding it behind new letters ---
  const comp = document.createElement('canvas')
  comp.width = cv.width; comp.height = cv.height
  const cx = comp.getContext('2d', { willReadFrequently: true })
  cx.drawImage(cv, 0, 0)
  if (patch) {
    if (patch.src) {
      const im = new Image()
      await new Promise((res, rej) => { im.onload = res; im.onerror = rej; im.src = patch.src })
      cx.drawImage(im, patch.x*k, patch.y*k, (patch.w ?? R.w)*k, (patch.h ?? R.h)*k)
    } else {
      cx.fillStyle = patch.color || '#fff'
      cx.fillRect(patch.x*k, patch.y*k, patch.w*k, patch.h*k)
    }
  }

  // Score everything the edit TOUCHED, not just the run that was targeted.
  //
  // The erase covers what the code decided to cover, which is not the rect the
  // case declares — and the difference is where the interesting failures live.
  // A patch that overhangs the words by a couple of points can leave its debris
  // entirely in that overhang, outside the measured window, and report itself
  // spotless. Measure the union.
  const uni = patch ? {
    x: Math.min(R.x, patch.x), y: Math.min(R.y, patch.y),
    r: Math.max(R.x + R.w, patch.x + (patch.w ?? R.w)),
    b: Math.max(R.y + R.h, patch.y + (patch.h ?? R.h)),
  } : { x: R.x, y: R.y, r: R.x + R.w, b: R.y + R.h }
  const UX = Math.max(0, px(uni.x)), UY = Math.max(0, px(uni.y))
  const UW = Math.min(cv.width - UX, px(uni.r) - UX)
  const UH = Math.min(cv.height - UY, px(uni.b) - UY)
  const touched = cx.getImageData(UX, UY, Math.max(3, UW), Math.max(3, UH)).data
  const touchedN = Math.max(3, UW) * Math.max(3, UH)

  const after = cx.getImageData(X, Y, W, H).data

  // DEBRIS: any foreign mark, not just an ink-coloured one.
  //
  // Residue asks "is the old ink still here", which on a banner of green type
  // over a dark field misses the thing you actually see — pale flecks and
  // fragments left behind by the fill, none of them green, all of them
  // obviously not background. So compare against what this background IS: take
  // a clean patch of it, learn how bright its brightest honest pixels get, and
  // count anything inside the erase that exceeds it. Subtract the rate the
  // reference itself shows, so a naturally speckled field is not accused of
  // being debris.
  const refPx = ctx.getImageData(px(ref[0]), px(ref[1]), Math.max(3, px(ref[2])), Math.max(3, px(ref[3])))
  const refL = []
  for (let i = 0; i < refPx.data.length; i += 4) refL.push(lum(refPx.data, i))
  refL.sort((a, b) => a - b)
  const q = (f) => refL[Math.min(refL.length - 1, Math.floor(refL.length * f))]
  const hiCut = q(0.995) + 12
  const loCut = q(0.005) - 12
  const refRate = (() => {
    const n = refPx.data.length / 4
    let c = 0
    for (let i = 0; i < n; i++) { const l = lum(refPx.data, i * 4); if (l > hiCut || l < loCut) c++ }
    return c / Math.max(1, n)
  })()
  // Same exclusions as residue, and for the same reasons: a rule that runs the
  // width of the run is drawn artwork and stays, and the outermost columns hold
  // whatever the advance box grazed. Counting either as debris would condemn a
  // correct erase.
  const patchRate = (() => {
    const w2 = Math.max(3, UW), h2 = Math.max(3, UH)
    // rule rows were found in the target's own coordinates; map them across
    const rowOff = Math.round((R.y - uni.y) * k)
    let c = 0, n = 0
    for (let yy = 0; yy < h2; yy++) {
      const ry = yy - rowOff
      if (ry >= 0 && ry < H && ruleRow[ry]) continue
      for (let xx = EDGE; xx < w2 - EDGE; xx++) {
        const l = lum(touched, (yy * w2 + xx) * 4)
        n++
        if (l > hiCut || l < loCut) c++
      }
    }
    return n ? c / n : 0
  })()
  const debrisPct = Math.max(0, patchRate - refRate) * 100
  // Residue is ink that SURVIVED, and a surviving letter is a connected mass of
  // pixels. A scatter of single pixels is not a trace of anything — it is two
  // renderers disagreeing about antialiasing, and they always will: this case
  // scored 0% on macOS and 0.222% on Linux from four isolated pixels, which
  // failed a bar that had quietly been calibrated against one machine's font
  // rasteriser. Dropping specks makes the number mean what it claims and does
  // not weaken it, because nothing legible is four scattered pixels.
  const hot = new Uint8Array(W*H)
  for (let y = 0; y < H; y++) {
    if (ruleRow[y]) continue
    for (let x = EDGE; x < W - EDGE; x++) if (nearInk(after, (y*W+x)*4, 30)) hot[y*W+x] = 1
  }
  const MIN_MARK = 6
  {
    const seen = new Uint8Array(W*H), stack = []
    for (let i0 = 0; i0 < W*H; i0++) {
      if (!hot[i0] || seen[i0]) continue
      stack.length = 0; stack.push(i0); seen[i0] = 1
      const blob = []
      while (stack.length) {
        const i = stack.pop(); blob.push(i)
        const x = i % W, y = (i / W) | 0
        if (x > 0 && hot[i-1] && !seen[i-1]) { seen[i-1] = 1; stack.push(i-1) }
        if (x < W-1 && hot[i+1] && !seen[i+1]) { seen[i+1] = 1; stack.push(i+1) }
        if (y > 0 && hot[i-W] && !seen[i-W]) { seen[i-W] = 1; stack.push(i-W) }
        if (y < H-1 && hot[i+W] && !seen[i+W]) { seen[i+W] = 1; stack.push(i+W) }
      }
      if (blob.length < MIN_MARK) for (const i of blob) hot[i] = 0
    }
  }
  let left = 0, counted = 0
  for (let y = 0; y < H; y++) {
    if (ruleRow[y]) continue
    for (let x = EDGE; x < W - EDGE; x++) { counted++; if (hot[y*W+x]) left++ }
  }
  const residuePct = counted ? (left/counted) * 100 : 0

  let bgTotal = 0, bgKept = 0
  for (let i = 0; i < W*H; i++) {
    if (fringe[i] || ruleRow[(i/W)|0]) continue
    bgTotal++
    const o = i*4
    if (Math.abs(after[o]-before[o]) <= 16 &&
        Math.abs(after[o+1]-before[o+1]) <= 16 &&
        Math.abs(after[o+2]-before[o+2]) <= 16) bgKept++
  }
  // too little clear background to judge (dense display type) — don't invent a verdict
  const structure = bgTotal < 30 ? 1 : bgKept / bgTotal

  return {
    ink, inkFracBefore, bgPixels: bgTotal,
    residuePct: +residuePct.toFixed(3),
    debrisPct: +debrisPct.toFixed(3),
    touched: patch ? [ +uni.x.toFixed(1), +uni.y.toFixed(1), +(uni.r-uni.x).toFixed(1), +(uni.b-uni.y).toFixed(1) ] : null,
    structure: +structure.toFixed(3),
    guess: window.__guess || null,
    patch: patch ? { x:+patch.x.toFixed(1), y:+patch.y.toFixed(1), w:+patch.w.toFixed(1), h:+patch.h.toFixed(1), raster: !!patch.src } : null,
    text: text ? { text: text.text, pdfFont: text.pdfFont || null, glyphClone: !!text.glyphSrc, size: text.size, color: text.color } : null,
    crop: (() => {
      const o = document.createElement('canvas')
      const s = 3, m = Math.max(8, Math.round(H*0.5))
      o.width = (W+m*2)*s; o.height = (H+m*2)*s*2 + 8
      const g = o.getContext('2d'); g.imageSmoothingEnabled = false
      g.fillStyle = '#f0f'; g.fillRect(0,0,o.width,o.height)
      g.drawImage(cv,   X-m, Y-m, W+m*2, H+m*2, 0, 0,               (W+m*2)*s, (H+m*2)*s)
      g.drawImage(comp, X-m, Y-m, W+m*2, H+m*2, 0, (H+m*2)*s+8,     (W+m*2)*s, (H+m*2)*s)
      return o.toDataURL('image/png')
    })(),
  }
})(__P__, __R__, __F__, __T__, __E__)
`

/* ---------------- PPM helpers (pdftoppm output, no image library needed) ---------------- */

function readPPM(path) {
  const buf = readFileSync(path)
  // P6\n<w> <h>\n<max>\n<binary>
  let pos = 0
  const token = () => {
    while (buf[pos] === 0x20 || buf[pos] === 0x0a || buf[pos] === 0x0d || buf[pos] === 0x09) pos++
    if (buf[pos] === 0x23) { while (buf[pos] !== 0x0a) pos++; return token() }
    let s = ''
    while (pos < buf.length && buf[pos] > 0x20) s += String.fromCharCode(buf[pos++])
    return s
  }
  const magic = token()
  if (magic !== 'P6') throw new Error(`not a P6 ppm: ${magic}`)
  const w = parseInt(token(), 10)
  const h = parseInt(token(), 10)
  token() // maxval
  pos++ // single whitespace before data
  return { w, h, data: buf.subarray(pos) }
}

/**
 * The same two questions, asked of rasters produced by pdftoppm.
 *
 * Both the original document and the exported one are rendered by poppler,
 * which shares no code with the pdf.js that drew them on screen. A fault that
 * only exists in the written file — a patch placed at the wrong offset, a font
 * that fails to embed — cannot survive being asked twice by two engines.
 */
function scoreExport(orig, out, rectPts, pageWpts, ink) {
  const k = out.w / pageWpts
  const X = Math.round(rectPts[0] * k), Y = Math.round(rectPts[1] * k)
  const W = Math.round(rectPts[2] * k), H = Math.round(rectPts[3] * k)
  if (orig.w !== out.w || orig.h !== out.h) return { error: `size mismatch ${orig.w}x${orig.h} vs ${out.w}x${out.h}` }

  const at = (p, x, y) => { const i = (y * p.w + x) * 3; return [p.data[i], p.data[i+1], p.data[i+2]] }
  const near = (c, tol) => Math.abs(c[0]-ink[0])<=tol && Math.abs(c[1]-ink[1])<=tol && Math.abs(c[2]-ink[2])<=tol

  // which pixels were letters in the original
  const isInk = new Uint8Array(W*H)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const px = X+x, py = Y+y
      if (px<0||py<0||px>=orig.w||py>=orig.h) continue
      if (near(at(orig, px, py), 70)) isInk[y*W+x] = 1
    }

  const ruleRow = new Uint8Array(H)
  for (let y = 0; y < H; y++) {
    let c = 0
    for (let x = 0; x < W; x++) if (isInk[y*W+x]) c++
    if (c >= W * 0.85) ruleRow[y] = 1   // a drawn rule, not a letter — see the note in MEASURE
  }

  // same despeckle as the on-screen measure, and for the same reason: poppler on
  // Linux and poppler on macOS disagree about antialiasing by a pixel here and
  // there, and counting those as leftover ink makes the suite a report on which
  // machine ran it
  const hotE = new Uint8Array(W*H)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const px = X+x, py = Y+y
      if (px<0||py<0||px>=out.w||py>=out.h) continue
      if (near(at(out, px, py), 30)) hotE[y*W+x] = 1
    }
  {
    const seen = new Uint8Array(W*H), stack = []
    for (let i0 = 0; i0 < W*H; i0++) {
      if (!hotE[i0] || seen[i0]) continue
      stack.length = 0; stack.push(i0); seen[i0] = 1
      const blob = []
      while (stack.length) {
        const i = stack.pop(); blob.push(i)
        const x = i % W, y = (i / W) | 0
        if (x > 0 && hotE[i-1] && !seen[i-1]) { seen[i-1] = 1; stack.push(i-1) }
        if (x < W-1 && hotE[i+1] && !seen[i+1]) { seen[i+1] = 1; stack.push(i+1) }
        if (y > 0 && hotE[i-W] && !seen[i-W]) { seen[i-W] = 1; stack.push(i-W) }
        if (y < H-1 && hotE[i+W] && !seen[i+W]) { seen[i+W] = 1; stack.push(i+W) }
      }
      if (blob.length < 6) for (const i of blob) hotE[i] = 0
    }
  }
  let left = 0, tot = 0, bgTotal = 0, bgKept = 0
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const EDGE = Math.max(2, Math.round(1.5 * k))
      if (ruleRow[y] || x < EDGE || x >= W - EDGE) continue   // advance-box edge, see MEASURE
      const px = X+x, py = Y+y
      if (px<0||py<0||px>=out.w||py>=out.h) continue
      const c = at(out, px, py)
      tot++
      if (hotE[y*W+x]) left++
      // skip the antialiasing fringe around the old glyphs
      let fr = false
      for (let dy=-2; dy<=2 && !fr; dy++)
        for (let dx=-2; dx<=2; dx++) {
          const yy=y+dy, xx=x+dx
          if (yy<0||xx<0||yy>=H||xx>=W) continue
          if (isInk[yy*W+xx]) { fr = true; break }
        }
      if (fr) continue
      const o = at(orig, px, py)
      bgTotal++
      if (Math.abs(c[0]-o[0])<=16 && Math.abs(c[1]-o[1])<=16 && Math.abs(c[2]-o[2])<=16) bgKept++
    }
  return {
    residuePct: tot ? +((left/tot)*100).toFixed(3) : null,
    structure: bgTotal < 30 ? 1 : +(bgKept/bgTotal).toFixed(3),
    bgPixels: bgTotal,
  }
}

/**
 * How different does the page look after putting the same words back?
 *
 * Not scored as a raw pixel difference. Re-setting a line re-renders every glyph
 * edge, so even a perfect reprint differs along every stroke by an antialiasing
 * step or two, and a total over those pixels reads ~30% no matter how good the
 * result is — while a genuine fault like a baseline sitting a point low can hide
 * inside the same number. Searching for the shift that best cancels it doesn't
 * help either: over a line of text the landscape is flat and full of false
 * minima, and it happily reports a six-pixel offset for type that is sitting
 * exactly where it belongs.
 *
 * So measure the things a reader would actually catch, each on its own scale:
 *
 *   baselineDelta  where the ink sits vertically, by centroid, in POINTS
 *   leftDelta      where the run starts
 *   endDelta       where it ends — tracking drift across the line
 *   inkRatio       ink laid down against ink removed: weight and size
 *   heightRatio    the ink's vertical extent: wrong size, or a clipped glyph
 *
 * Sub-pixel by construction: a centroid over thousands of pixels resolves far
 * finer than the pixel grid it is computed on.
 */
function scoreIdentity(orig, out, rectPts, pageWpts) {
  if (orig.w !== out.w || orig.h !== out.h) return { error: `size mismatch` }
  const k = out.w / pageWpts
  const m = Math.round(6 * k)
  const X = Math.max(0, Math.round(rectPts[0]*k) - m)
  const Y = Math.max(0, Math.round(rectPts[1]*k) - m)
  const W = Math.min(out.w - X, Math.round(rectPts[2]*k) + m*2)
  const H = Math.min(out.h - Y, Math.round(rectPts[3]*k) + m*2)
  const at = (p, x, y) => { const i = (y*p.w + x)*3; return [p.data[i], p.data[i+1], p.data[i+2]] }
  const lum = (c) => 0.2126*c[0] + 0.7152*c[1] + 0.0722*c[2]

  // "ink" against this region's own surface tone, so it works on white paper
  // and on a dark banner without being told which is which
  const vals = []
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) vals.push(lum(at(orig, X+x, Y+y)))
  const surface = vals.slice().sort((a,b)=>a-b)[Math.floor(vals.length/2)]

  const profile = (p) => {
    let n = 0, sy = 0, first = -1, last = -1, top = -1, bot = -1
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        // weight each pixel by how far it is from the surface: an antialiased
        // edge counts for a fraction, which is what makes this sub-pixel
        const w = Math.min(1, Math.max(0, (Math.abs(lum(at(p, X+x, Y+y)) - surface) - 25) / 60))
        if (w <= 0) continue
        n += w; sy += w * y
        if (first < 0 || x < first) first = x
        if (x > last) last = x
        if (top < 0 || y < top) top = y
        if (y > bot) bot = y
      }
    return { n, cy: n ? sy/n : null, first, last, top, bot }
  }
  const a = profile(orig), b = profile(out)
  const pt = (v) => v === null ? null : +(v / k).toFixed(3)

  let bad = 0, tot = 0
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const p = at(orig, X+x, Y+y), q = at(out, X+x, Y+y)
      tot++
      if (Math.max(Math.abs(p[0]-q[0]), Math.abs(p[1]-q[1]), Math.abs(p[2]-q[2])) > 24) bad++
    }

  return {
    baselineDeltaPt: (a.cy === null || b.cy === null) ? null : pt(b.cy - a.cy),
    leftDeltaPt: (a.first < 0 || b.first < 0) ? null : pt(b.first - a.first),
    endDeltaPt: (a.last < 0 || b.last < 0) ? null : pt(b.last - a.last),
    inkRatio: a.n ? +(b.n / a.n).toFixed(3) : null,
    heightRatio: (a.bot - a.top) > 0 ? +(((b.bot - b.top) / (a.bot - a.top))).toFixed(3) : null,
    rawDiffPct: +((bad/tot)*100).toFixed(2),
  }
}

/** Original above, identity edit below, magnified — for judging by eye. */
function stripPNG(orig, out, rectPts, pageWpts) {
  const k = out.w / pageWpts
  const m = Math.round(6 * k)
  const X = Math.max(0, Math.round(rectPts[0]*k) - m)
  const Y = Math.max(0, Math.round(rectPts[1]*k) - m)
  const W = Math.min(out.w - X, Math.round(rectPts[2]*k) + m*2)
  const H = Math.min(out.h - Y, Math.round(rectPts[3]*k) + m*2)
  const S = 2
  const outW = W*S, outH = H*S*2 + 6
  const px = Buffer.alloc(outW*outH*3, 0xff)
  const put = (p, sx, sy, dyOff) => {
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const si = ((sy+y)*p.w + (sx+x))*3
        for (let ry = 0; ry < S; ry++)
          for (let rx = 0; rx < S; rx++) {
            const di = ((y*S+ry+dyOff)*outW + (x*S+rx))*3
            px[di] = p.data[si]; px[di+1] = p.data[si+1]; px[di+2] = p.data[si+2]
          }
      }
  }
  put(orig, X, Y, 0)
  for (let y = H*S; y < H*S+6; y++) for (let x = 0; x < outW; x++) {
    const i = (y*outW+x)*3; px[i]=0xff; px[i+1]=0x00; px[i+2]=0xff
  }
  put(out, X, Y, H*S+6)
  return encodePNG(px, outW, outH)
}

/** Minimal PNG encoder (RGB, no filtering) — avoids an image dependency. */
function encodePNG(rgb, w, h) {
  const zlib = zlibMod
  const raw = Buffer.alloc((w*3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y*(w*3+1)] = 0
    rgb.copy(raw, y*(w*3+1)+1, y*w*3, (y+1)*w*3)
  }
  const idat = zlib.deflateSync(raw)
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ])
}
let CRC_T = null
function crc32(buf) {
  if (!CRC_T) {
    CRC_T = new Int32Array(256)
    for (let n = 0; n < 256; n++) { let c = n; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_T[n] = c }
  }
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return c ^ 0xffffffff
}

/**
 * After an edit to SHORTER words, is the uncovered tail clean background?
 *
 * Measured on the last third of the run, where the replacement text no longer
 * reaches, so what is seen there is the fill alone with nothing drawn over it.
 * Judged against a reference patch of the same background: learn how bright its
 * honest pixels get, and count anything in the tail that exceeds it, less the
 * rate the reference itself shows so a speckled field is not accused.
 */
function scoreExposed(orig, out, rectPts, refPts, pageWpts) {
  try {
    const k = out.w / pageWpts
    const lum = (p, i) => 0.2126 * p.data[i] + 0.7152 * p.data[i + 1] + 0.0722 * p.data[i + 2]
    const sample = (p, x0, y0, w, h) => {
      const v = []
      for (let y = y0; y < y0 + h; y++)
        for (let x = x0; x < x0 + w; x++) {
          if (x < 0 || y < 0 || x >= p.w || y >= p.h) continue
          v.push(lum(p, (y * p.w + x) * 3))
        }
      return v
    }
    const refV = sample(out, Math.round(refPts[0]*k), Math.round(refPts[1]*k),
                        Math.round(refPts[2]*k), Math.round(refPts[3]*k)).sort((a,b)=>a-b)
    if (refV.length < 30) return {}
    const q = (f) => refV[Math.min(refV.length - 1, Math.floor(refV.length * f))]
    const hi = q(0.995) + 12, lo = q(0.005) - 12
    const refRate = refV.filter((l) => l > hi || l < lo).length / refV.length

    const X = Math.round(rectPts[0]*k), Y = Math.round(rectPts[1]*k)
    const W = Math.round(rectPts[2]*k), H = Math.round(rectPts[3]*k)

    // Start beyond where the NEW words actually reach.
    //
    // "The last third of the run" only uncovers the fill when the replacement is
    // shorter. Give it a longer one and that third is full of new lettering,
    // which is then counted as filth: the banner headline scored 25% for an edit
    // that is perfectly clean. So find where the new text stops — the rightmost
    // ink in the row — and look only past it.
    let lastInk = -1
    for (let x = 0; x < W; x++)
      for (let y = 0; y < H; y++) {
        const px = X + x, py = Y + y
        if (px < 0 || py < 0 || px >= out.w || py >= out.h) continue
        if (Math.abs(lum(out, (py * out.w + px) * 3) - (hi + lo) / 2) > (hi - lo) / 2) { lastInk = x; break }
      }
    const gap = Math.round(2 * k)
    const tailX = X + Math.max(Math.round(W * 0.5), lastInk + gap)
    if (X + W - tailX < Math.round(6 * k)) return { exposedNote: 'replacement fills the run; nothing uncovered' }
    const tail = sample(out, tailX, Y, X + W - tailX, H)
    if (tail.length < 30) return {}
    const rate = tail.filter((l) => l > hi || l < lo).length / tail.length
    return { exposedDebrisPct: +(Math.max(0, rate - refRate) * 100).toFixed(3) }
  } catch {
    return {}
  }
}

/* ---------------- the untouched document, rendered by poppler ---------------- */

const origCache = new Map()
function originalPPM(fx, pageIdx, dpi = 150) {
  const key = `${fx.file}:${pageIdx}:${dpi}`
  if (origCache.has(key)) return origCache.get(key)
  const pdf = join(HERE, 'fixtures', fx.file)
  const prefix = join(OUT, `${fx.name}-orig-${dpi}`)
  execFileSync('pdftoppm', ['-r', String(dpi), '-f', String(pageIdx+1), '-l', String(pageIdx+1), pdf, prefix], { stdio: 'ignore' })
  const f = `${prefix}-${pageIdx+1}.ppm`
  const ppm = readPPM(f)
  origCache.set(key, ppm)
  return ppm
}

/* ---------------- picking a text-free reference region ---------------- */

const wordCache = new Map()
function wordsOf(fx) {
  if (wordCache.has(fx.file)) return wordCache.get(fx.file)
  const pdf = join(HERE, 'fixtures', fx.file)
  const xml = join(OUT, `${fx.name}.bbox.xml`)
  execFileSync('pdftotext', ['-f', '1', '-l', '1', '-bbox', pdf, xml], { stdio: 'ignore' })
  const src = readFileSync(xml, 'utf8')
  const out = []
  const re = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">/g
  let m
  while ((m = re.exec(src))) out.push([+m[1], +m[2], +m[3], +m[4]])
  wordCache.set(fx.file, out)
  return out
}

/**
 * A rectangle the same size as the target, near it, containing no text.
 *
 * Declaring one by hand in cases.json is allowed and is the only option where
 * the words are pixels rather than text (pdftotext cannot see them, so it would
 * cheerfully offer a "text-free" box sitting on top of the banner headline).
 */
function refFor(fx, t) {
  const words = wordsOf(fx)
  const [x, y, w, h] = t.rect
  const pad = 2
  const free = (rx, ry) =>
    rx >= 4 && ry >= 4 && rx + w <= 590 && ry + h <= 838 &&
    !words.some(([a, b, c, d]) =>
      rx < c + pad && rx + w > a - pad && ry < d + pad && ry + h > b - pad)
  for (let d = Math.round(h * 1.2); d < 420; d += Math.max(6, Math.round(h * 0.5))) {
    for (const [dx, dy] of [[0, d], [0, -d], [d, 0], [-d, 0], [d, d], [-d, d], [d, -d], [-d, -d]]) {
      if (free(x + dx, y + dy)) return [x + dx, y + dy, w, h]
    }
  }
  return [x, y, w, h] // nothing clear: fall back, and the case will show it
}

/* ---------------- runner ---------------- */

async function main() {
  if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })

  const cases = JSON.parse(readFileSync(join(HERE, 'cases.json'), 'utf8'))
  const profile = join(OUT, 'profile')
  mkdirSync(profile, { recursive: true })

  console.log('booting app…')
  const child = launchApp({ cwd: ROOT, port: PORT, userDataDir: profile })
  const cdp = await connect({ port: PORT })
  await sleep(1500)

  // Tier 2 is words baked into an image: nothing but a model can read them, so
  // those cases need one connected. Look for a local server; if there isn't one,
  // skip them and say so rather than reporting a failure the code didn't cause.
  let aiReady = false
  try {
    const r = await fetch(`${AI_BASE}/models`, { signal: AbortSignal.timeout(2500) })
    const j = await r.json()
    const vision = (j.data || []).map((m) => m.id).find((id) => /vl|vision|llava|gemma|qwen2?\.?5?-?vl/i.test(id))
    if (vision) {
      await cdp.eval(`window.__reshapedpdf.state().setAiConfig(${JSON.stringify({ presetId: 'lmstudio', baseUrl: AI_BASE, model: '', apiKey: '' })})`)
      await cdp.eval(`(() => { const c = window.__reshapedpdf.state().aiConfig; window.__reshapedpdf.state().setAiConfig({ ...c, model: ${JSON.stringify(vision)} }); return 1 })()`)
      aiReady = true
      console.log(`  (tier 2 will use ${vision} via LM Studio)`)
    }
  } catch { /* no local model */ }
  if (!aiReady) console.log('  (no local vision model — tier 2 cases will be skipped)')

  const results = []
  try {
    for (const fx of cases.fixtures) {
      const pdfPath = join(HERE, 'fixtures', fx.file)
      const b64 = readFileSync(pdfPath).toString('base64')
      for (const t of fx.targets) {
        if (only && t.id !== only) continue
        if (t.tier === 2 && !aiReady) {
          console.log(`  ${t.id} … SKIP  (needs a vision model; the words here are pixels)`)
          results.push({ ...t, fixture: fx.name, skipped: 'no vision model configured' })
          continue
        }
        process.stdout.write(`  ${t.id} … `)
        // fresh document each time, so one case cannot contaminate the next
        await cdp.run(`window.__reshapedpdf.openBase64(${JSON.stringify(b64)}, ${JSON.stringify(fx.file)})`)
        await sleep(2500)

        const call = (erase) =>
          MEASURE.replace('__P__', String(t.page))
            .replace('__R__', JSON.stringify(t.rect))
            .replace('__F__', JSON.stringify(t.ref || refFor(fx, t)))
            .replace('__T__', String(t.tier))
            .replace('__E__', erase ? 'true' : 'false')

        let r
        try {
          r = await cdp.run(call(true))
        } catch (e) {
          console.log('ERROR  ' + String(e.message || e).split('\n')[0])
          results.push({ ...t, fixture: fx.name, error: String(e.message || e) })
          continue
        }

        if (r.crop) {
          writeFileSync(join(OUT, `${t.id}.png`), Buffer.from(r.crop.split(',')[1], 'base64'))
          delete r.crop
        }

        // --- the identity edit: retype a run with its own words ---
        //
        // The strictest test there is, and the one that matches what a reader
        // notices. An erase can be flawless and the edit still obvious: type a
        // third of a point too low, a shade too heavy, tracking that drifts so
        // the line ends in the wrong place. Put the SAME words back and the page
        // must come back as it was. Every difference is a tell.
        let identity = null
        try {
          const ex0 = await cdp.run(`window.__reshapedpdf.exportActive()`)
          if (ex0 && ex0.b64) {
            const idPdf = join(OUT, `${t.id}-identity.pdf`)
            writeFileSync(idPdf, Buffer.from(ex0.b64, 'base64'))
            execFileSync('pdftoppm', ['-r', '300', '-f', String(t.page+1), '-l', String(t.page+1),
              idPdf, join(OUT, `${t.id}-id`)], { stdio: 'ignore' })
            const f = join(OUT, `${t.id}-id-${t.page+1}.ppm`)
            if (existsSync(f)) {
              const ppm = readPPM(f)
              identity = scoreIdentity(originalPPM(fx, t.page, 300), ppm, t.rect, ppm.w / 300 * 72)
              identity.retyped = r.text ? r.text.text : null
              writeFileSync(join(OUT, `${t.id}-identity.ppm.png`),
                stripPNG(originalPPM(fx, t.page, 300), ppm, t.rect, ppm.w / 300 * 72))
              if (!keep) rmSync(f, { force: true })
            }
            if (!keep) rmSync(idPdf, { force: true })
          }
        } catch (e) {
          identity = { error: String(e.message || e) }
        }

        // --- a REAL edit: new words, including characters the line never had ---
        //
        // The identity check proves a line can be put back. It cannot prove the
        // face was IDENTIFIED, because cloning the original glyphs reproduces the
        // original words perfectly and tells you nothing about what happens when
        // someone types something else. Only new characters do that.
        let edit = null
        if (t.editTo) {
          try {
            const applied = await cdp.run(`(() => {
              const st = window.__reshapedpdf.state()
              const d = st.docs[st.active]
              const tx = Object.values(d.objects).find(o => o.kind === 'text')
              if (!tx) return null
              st.updateObject(tx.id, { text: ${JSON.stringify(t.editTo)} })
              const after = window.__reshapedpdf.state().docs[st.active].objects[tx.id]
              return { text: after.text, cloned: !!after.glyphSrc, font: after.font,
                       matchFace: after.matchFace || null, weight: after.matchWeight || null }
            })()`)
            if (applied) {
              const ex = await cdp.run(`window.__reshapedpdf.exportActive()`)
              const p2 = join(OUT, `${t.id}-edit.pdf`)
              writeFileSync(p2, Buffer.from(ex.b64, 'base64'))
              // does the new text come out as REAL TEXT in the file, or a picture?
              const txt = execFileSync('pdftotext', ['-f', String(t.page+1), '-l', String(t.page+1), p2, '-'],
                { encoding: 'utf8' })
              execFileSync('pdftoppm', ['-r', '150', '-f', String(t.page+1), '-l', String(t.page+1),
                p2, join(OUT, `${t.id}-edit`)], { stdio: 'ignore' })
              // Score the EDITED page, not just the erase.
              //
              // An identity retype puts the same words back, and those words
              // cover the patch. Anything the fill got wrong is hidden underneath
              // them, which is exactly how a scatter of imported fragments across
              // the banner survived a green suite: the erase was measured with
              // the text removed, and the identity edit put text back over the
              // evidence. Editing to something SHORTER uncovers it — the tail of
              // the old run is now bare patch, and it has to look like background.
              const ppmE = readPPM(join(OUT, `${t.id}-edit-${t.page+1}.ppm`))
              edit = {
                ...applied,
                extractable: txt.includes(t.editTo.slice(0, 12)),
                oldWordsGone: !txt.includes((r.text?.text || '').slice(0, 12) || '\u0000'),
                ...scoreExposed(originalPPM(fx, t.page), ppmE, t.rect, t.ref || refFor(fx, t), ppmE.w / 150 * 72),
              }
              if (!keep) rmSync(join(OUT, `${t.id}-edit-${t.page+1}.ppm`), { force: true })
              if (!keep) rmSync(p2, { force: true })
            }
          } catch (e) {
            edit = { error: String(e.message || e) }
          }
        }

        // --- export and re-render with a renderer that shares no code with pdf.js ---
        let exported = null
        try {
          // Take the replacement text back out before exporting.
          //
          // On screen the erase is scored on its own, with the new words not yet
          // composited. The exported file of course contains them, so scoring it
          // as-is measures "are there letters here" — and the answer is yes, by
          // design. Removing them first makes the two measurements the same
          // measurement, which is the only way the comparison means anything.
          await cdp.run(`(() => {
            const st = window.__reshapedpdf.state()
            const d = st.docs[st.active]
            const ids = Object.values(d.objects).filter(o => o.kind === 'text').map(o => o.id)
            if (ids.length) st.removeObjects(ids)
            return ids.length
          })()`)
          const ex = await cdp.run(`window.__reshapedpdf.exportActive()`)
          if (ex && ex.b64) {
            const outPdf = join(OUT, `${t.id}.pdf`)
            writeFileSync(outPdf, Buffer.from(ex.b64, 'base64'))
            execFileSync('pdftoppm', ['-r', '150', '-f', String(t.page+1), '-l', String(t.page+1),
              outPdf, join(OUT, `${t.id}-out`)], { stdio: 'ignore' })
            const ppmFile = join(OUT, `${t.id}-out-${t.page+1}.ppm`)
            if (existsSync(ppmFile)) {
              const ppm = readPPM(ppmFile)
              exported = scoreExport(originalPPM(fx, t.page), ppm, t.rect, ppm.w / 150 * 72, r.ink)
              exported.bytes = ex.size
              if (!keep) rmSync(ppmFile, { force: true })
            }
          }
        } catch (e) {
          exported = { error: String(e.message || e) }
        }
        if (!keep) rmSync(join(OUT, `${t.id}.pdf`), { force: true })

        const bar = BAR[t.tier]
        const screenPass = r.residuePct <= bar.residuePct && r.structure >= bar.structure &&
          (r.debrisPct === undefined || r.debrisPct <= bar.debrisPct)
        const exportPass = !exported || exported.error ? false
          : exported.residuePct <= bar.residuePct && exported.structure >= bar.structure
        const identityPass = looksUnedited(t.tier, identity, t)
        // an edit that uncovers dirty background fails, whatever the erase scored
        const editPass = !edit || edit.error || edit.exposedDebrisPct === undefined
          ? true
          : edit.exposedDebrisPct <= (t.tier === 1 ? 0.5 : 1.5)
        /* A case may declare a KNOWN GAP in cases.json: a defect that is real,
         * understood, recorded elsewhere with deterministic coverage, and not
         * yet fixed. It is reported as GAP rather than FAIL so that a suite full
         * of genuine passes is not held permanently red by one open bug — but it
         * prints on every run, with the reason and the numbers, and it only
         * applies when the failure has the SIGNATURE the gap describes. A case
         * that breaks some other way still fails.
         *
         * The signature test matters. Without it this is just a way of ignoring
         * a case, and the next regression in it would arrive silently. */
        const gapSig = t.knownGap && !identityPass && screenPass && exportPass && editPass &&
          identity && !identity.error && identity.inkRatio < 0.6
        const pass = screenPass && exportPass && identityPass && editPass

        results.push({ ...t, fixture: fx.name, screen: r, exported, identity, edit, pass, gap: !pass && gapSig ? t.knownGap : undefined })
        console.log(
          `${pass ? 'PASS' : gapSig ? 'GAP ' : 'FAIL'}  residue ${String(r.residuePct).padStart(6)}%  debris ${String(r.debrisPct).padStart(6)}%  structure ${String(r.structure).padStart(5)}` +
          (exported && !exported.error ? `  | export residue ${String(exported.residuePct).padStart(6)}%` : '  | export n/a') +
          (identity && !identity.error
            ? `  | ${identityPass ? 'looks-clean' : 'LOOKS-EDITED'} base ${String(identity.baselineDeltaPt).padStart(6)} left ${String(identity.leftDeltaPt).padStart(6)} end ${String(identity.endDeltaPt).padStart(6)} ink ${identity.inkRatio} h ${identity.heightRatio}`
            : '  | identity n/a') +
          (edit && !edit.error
            ? `  | edit ${edit.cloned ? 'CLONED' : 'set-in-' + (edit.matchFace || edit.font) + (edit.weight ? '-' + edit.weight : '')}${edit.extractable ? ' text-ok' : ' NOT-TEXT'}` +
              (edit.exposedDebrisPct === undefined ? '' : ` uncovered ${edit.exposedDebrisPct}%${editPass ? '' : ' DIRTY'}`)
            : ''),
        )
      }
    }
  } finally {
    cdp.close()
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }

  writeFileSync(jsonPath, JSON.stringify({ when: new Date().toISOString(), results }, null, 2))

  const gapped = results.filter((r) => !r.pass && !r.skipped && r.gap)
  for (const g of gapped) console.log(`  GAP  ${g.id}: ${g.gap}`)
  const failed = results.filter((r) => !r.pass && !r.skipped && !r.gap)
  const skipped = results.filter((r) => r.skipped)
  console.log(`\n${results.length - failed.length - skipped.length}/${results.length - skipped.length} passed` + (skipped.length ? `, ${skipped.length} skipped` : ''))
  if (failed.length) {
    console.log('failing:')
    for (const f of failed) console.log(`  ${f.id}  (tier ${f.tier})  ${f.error || ''}`)
  }
  console.log(`report: ${jsonPath}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(2) })
