#!/usr/bin/env node
/*
 * Editing printed text: is the edit ACCURATE, and is the original gone?
 *
 * This is the thing the editor is sold on, and it had no direct coverage — the
 * suites around it checked that a retype produced *something* vector-shaped, not
 * that the words you typed are the words in the file and that nothing of the
 * printed original survives underneath them.
 *
 * Per run, three questions:
 *   1. EDITABLE       — retyping a printed run hands back a real text object
 *                       (not a bitmap of it), carrying the run's actual words.
 *   2. ACCURATE       — retype it to something else, and the exported file
 *                       contains the new string, with ONE FEWER occurrence of the
 *                       old word than the untouched file had.
 *   3. NO DEBRIS      — delete what the retype produced and the run's band is
 *                       bare: none of the printed glyphs are still down there.
 *
 * Case 2 counts rather than asking "is the word absent", because the word is
 * usually somewhere else on the page as well — "Ironworks" is in the banner this
 * edits AND in the footer it doesn't touch — and demanding zero would fail on a
 * perfect edit. Counting against the pristine export names exactly the property
 * that matters: the run you replaced is gone, and nothing else moved.
 *
 * Several runs are exercised, not one, because "text is editable everywhere" is
 * the claim — a heading on a dark banner and body text on paper take different
 * paths through the background patching.
 *
 * The editor is committed with ESCAPE rather than blur: both run the same
 * commit(), but blur() is a no-op on an element that never held focus, and it
 * never does when the window isn't frontmost — which is the normal state here.
 *
 * This is the suite that caught the leak it now guards. Retype used to be visually
 * destructive but not textually destructive: the patch covered the printed run
 * (no-debris measured 0.0%) while the ORIGINAL GLYPHS STAYED IN THE CONTENT
 * STREAM, so pdftotext on an edited header returned both "REPLACEDHEADINGXQ" and
 * "IRONWORKS SUPPLY CO.". Painted over is not removed — the redaction leak wearing
 * a different hat, in the feature this editor is sold on. The fix records the run's
 * own content-stream spans on the patch (WhiteoutObj.removedSpans) and the exporter
 * takes them out of the page's program.
 *
 *   node tests/text-edit-check.mjs
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { connect, launchApp, sleep } from './harness/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const OUT = join(HERE, '.artifacts', 'text-edit')
const PORT = Number(process.env.CDP_PORT || 9396)
const DPI = 150
if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

// Runs to exercise: a word to find, and what to retype it to. "Ironworks" sits in
// white on the dark banner; "Anvil" is black body text on paper.
const RUNS = [
  { find: 'Ironworks', replacement: 'REPLACEDHEADINGXQ' },
  { find: 'Anvil', replacement: 'REPLACEDBODYWQ' },
]

// The rubber case: a word on the line the box swallows whole, and a word on the
// line below it — which the box comes close to but does not cover, so it must
// survive untouched.
const RUB = { find: 'Vitosha', neighbour: 'Sofia' }

// The brush case: a thin diagonal sweep whose BOUNDING BOX takes in three lines
// of the address block. Only the stroke itself covers anything, so every one of
// these words must still be in the file afterwards.
const BRUSH = { find: 'Vitosha', survivors: ['Arnaud', 'Vitosha', 'Bulgaria'] }

/** ink (non-paper, non-banner) fraction of a page-space rect in the export */
function bandStats(pdf, prefix, rect) {
  execFileSync('pdftoppm', ['-r', String(DPI), '-f', '1', '-l', '1', pdf, prefix], { stdio: 'ignore' })
  const buf = readFileSync(`${prefix}-1.ppm`)
  let pos = 0
  const tok = () => { while ([32, 10, 13, 9].includes(buf[pos])) pos++; let s = ''; while (pos < buf.length && buf[pos] > 32) s += String.fromCharCode(buf[pos++]); return s }
  if (tok() !== 'P6') throw new Error('not a P6 ppm')
  const w = +tok(); tok(); tok(); pos++
  const k = DPI / 72
  // Count how many pixels differ from the band's OWN dominant colour. That works
  // whether the run sits on white paper or on a dark banner, so one metric covers
  // both kinds of run without hard-coding which is "ink".
  const px = []
  for (let y = Math.round(rect.y * k); y < Math.round((rect.y + rect.h) * k); y++) {
    for (let x = Math.round(rect.x * k); x < Math.round((rect.x + rect.w) * k); x++) {
      const i = pos + (y * w + x) * 3
      px.push([buf[i], buf[i + 1], buf[i + 2]])
    }
  }
  if (!px.length) return 1
  const key = (p) => `${p[0] >> 4},${p[1] >> 4},${p[2] >> 4}`
  const counts = new Map()
  for (const p of px) counts.set(key(p), (counts.get(key(p)) || 0) + 1)
  let domKey = '', domN = 0
  for (const [k2, n] of counts) if (n > domN) { domN = n; domKey = k2 }
  const off = px.filter((p) => key(p) !== domKey).length
  return off / px.length
}

const results = []
const rec = (id, ok, detail) => { results.push({ id, ok }); console.log(`  ${id.padEnd(34)} ${ok ? 'PASS' : 'FAIL'}  ${detail}`) }

async function main() {
  console.log('booting app…')
  const child = launchApp({ cwd: ROOT, port: PORT, userDataDir: join(OUT, 'profile') })
  const cdp = await connect({ port: PORT })
  await sleep(1600)
  const out = []
  let rub = null, brush = null, moved = null
  try {
    for (const run of RUNS) {
      await cdp.run('window.__reshapedpdf.openSample()')
      await sleep(1700)
      await cdp.run('window.__reshapedpdf.state().setZoom(1)')
      await sleep(500)
      const r = await cdp.run(`(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        const S = window.__reshapedpdf, st = () => S.state()
        const hits = await S.searchActive(${JSON.stringify(run.find)})
        if (!hits.length) return { err: 'word not found on the page' }
        const t = hits[0].rects[0]
        // the untouched file, to count this word's occurrences against
        const pristine = await S.exportActive()

        // drive the REAL retype gesture over that run
        st().setTool('retype'); await sleep(400)
        const cap = [...document.querySelectorAll('.overlay-capture')]
          .map(el => ({ el, r: el.getBoundingClientRect() }))
          .filter(x => x.r.width > 200 && x.r.height > 250)[0]
        if (!cap) return { err: 'no capture overlay' }
        const pev = (ty, cx, cy) => new PointerEvent(ty, { clientX: cx, clientY: cy, bubbles: true,
          cancelable: true, pointerId: 1, button: 0, buttons: ty === 'pointerup' ? 0 : 1, isPrimary: true,
          pointerType: 'mouse', view: window })
        const z = st().zoom
        const before = new Set(Object.keys(st().docs[st().active].objects))
        const ax = cap.r.left + (t.x - 2) * z, ay = cap.r.top + (t.y - 2) * z
        const bx = cap.r.left + (t.x + t.w + 2) * z, by = cap.r.top + (t.y + t.h + 2) * z
        cap.el.dispatchEvent(pev('pointerdown', ax, ay))
        for (let i = 1; i <= 6; i++) { cap.el.dispatchEvent(pev('pointermove', ax + (bx - ax) * i / 6, ay + (by - ay) * i / 6)); await sleep(20) }
        cap.el.dispatchEvent(pev('pointerup', bx, by))
        await sleep(2600)

        const d0 = st().docs[st().active]
        const added = d0.objOrder.filter(id => !before.has(id)).map(id => d0.objects[id])
        const textObj = added.find(o => o.kind === 'text')
        if (!textObj) return { err: 'retype produced no text object; added [' + added.map(o => o.kind).join(',') + ']' }
        const readBack = textObj.text

        // 2. EDIT it through the real editor and commit with Escape
        st().setEditingText(textObj.id)
        let ta = null
        for (let i = 0; i < 60 && !ta; i++) { await sleep(100); ta = document.querySelector('textarea:not(.ff-text)') }
        if (!ta) return { err: 'editor never mounted' }
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
        setter.call(ta, ${JSON.stringify(run.replacement)})
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        await sleep(80)
        ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))
        await sleep(400)
        st().setTool('select'); await sleep(200)
        const edited = st().docs[st().active].objects[textObj.id]
        const withEdit = await S.exportActive()

        // 3. now delete what retype produced — anything of the ORIGINAL still
        //    showing in that band is debris the retype failed to remove
        st().removeObjects([textObj.id]); await sleep(300)
        const stripped = await S.exportActive()
        return { readBack, editedText: edited && edited.text, isImage: added.some(o => o.kind === 'image'),
          kinds: added.map(o => o.kind), band: { x: t.x - 4, y: t.y - 4, w: t.w + 8, h: t.h + 8 },
          pristine, withEdit, stripped }
      })()`)
      out.push({ run, r })
    }

    // The rubber: the dumb, no-model eraser. It fills a box with the background
    // and that is the whole tool — so the words it covers must leave the file
    // too, or "erased" means "still there, painted over" and a copy-paste hands
    // them straight back.
    //
    // The box here swallows a whole line of the address block. The pair of cases
    // pins the rule it is erased by: what the box CONTAINS goes, what it merely
    // comes near stays. The line below sits a few points under the box's edge and
    // must be untouched — deleting a line the user can still see would be far
    // worse than the leak this closes.
    await cdp.run('window.__reshapedpdf.openSample()')
    await sleep(1700)
    await cdp.run('window.__reshapedpdf.state().setZoom(1)')
    await sleep(500)
    rub = await cdp.run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      const S = window.__reshapedpdf, st = () => S.state()
      const hits = await S.searchActive(${JSON.stringify(RUB.find)})
      if (!hits.length) return { err: 'word not found on the page' }
      const t = hits[0].rects[0]
      const pristine = await S.exportActive()
      st().setPref('eraseMode', 'box')   // the drag-a-box rubber, not the brush
      st().setTool('whiteout'); await sleep(400)
      const cap = [...document.querySelectorAll('.overlay-capture')]
        .map(el => ({ el, r: el.getBoundingClientRect() }))
        .filter(x => x.r.width > 200 && x.r.height > 250)[0]
      if (!cap) return { err: 'no capture overlay' }
      const pev = (ty, cx, cy) => new PointerEvent(ty, { clientX: cx, clientY: cy, bubbles: true,
        cancelable: true, pointerId: 1, button: 0, buttons: ty === 'pointerup' ? 0 : 1, isPrimary: true,
        pointerType: 'mouse', view: window })
      const z = st().zoom
      const before = new Set(Object.keys(st().docs[st().active].objects))
      // wide enough to take in the whole line the word sits on, and 4pt of slack
      // above and below — which brings the box NEAR the next line without
      // covering it
      const ax = cap.r.left + (t.x - 40) * z, ay = cap.r.top + (t.y - 4) * z
      const bx = cap.r.left + (t.x + t.w + 60) * z, by = cap.r.top + (t.y + t.h + 4) * z
      cap.el.dispatchEvent(pev('pointerdown', ax, ay))
      for (let i = 1; i <= 6; i++) { cap.el.dispatchEvent(pev('pointermove', ax + (bx - ax) * i / 6, ay + (by - ay) * i / 6)); await sleep(20) }
      cap.el.dispatchEvent(pev('pointerup', bx, by))
      await sleep(2200)
      const d = st().docs[st().active]
      const added = d.objOrder.filter(id => !before.has(id)).map(id => d.objects[id])
      if (!added.some(o => o.kind === 'whiteout')) return { err: 'the rubber added no patch; added [' + added.map(o => o.kind).join(',') + ']' }
      return { pristine, erased: await S.exportActive() }
    })()`)
    // The retouch pen and the brush eraser paint a STROKE, and the patch they
    // leave is a bounding box with the stroke's own alpha inside it. One diagonal
    // sweep paints maybe a fifth of that box — so the box proves nothing about
    // the words it happens to enclose, and the export must not treat it as if it
    // did. (It did: a single sweep across an address block deleted every line of
    // it from the file while the app went on showing them.)
    //
    // Driven with the retouch pen rather than the brush eraser: same patch shape,
    // same `shaped` flag, but it rasterises the stroke directly instead of
    // rebuilding the background underneath, so the case costs a second rather
    // than a page render.
    await cdp.run('window.__reshapedpdf.openSample()')
    await sleep(1700)
    await cdp.run('window.__reshapedpdf.state().setZoom(1)')
    await sleep(500)
    brush = await cdp.run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      const S = window.__reshapedpdf, st = () => S.state()
      const hits = await S.searchActive(${JSON.stringify(BRUSH.find)})
      if (!hits.length) return { err: 'word not found on the page' }
      const t = hits[0].rects[0]
      const pristine = await S.exportActive()
      st().setTool('retouch'); await sleep(400)
      const cap = [...document.querySelectorAll('.overlay-capture')]
        .map(el => ({ el, r: el.getBoundingClientRect() }))
        .filter(x => x.r.width > 200 && x.r.height > 250)[0]
      if (!cap) return { err: 'no capture overlay' }
      const pev = (ty, cx, cy) => new PointerEvent(ty, { clientX: cx, clientY: cy, bubbles: true,
        cancelable: true, pointerId: 1, button: 0, buttons: ty === 'pointerup' ? 0 : 1, isPrimary: true,
        pointerType: 'mouse', view: window })
      const z = st().zoom
      // a thin diagonal sweep whose BOUNDING BOX spans three lines of the address
      const ax = cap.r.left + (t.x - 30) * z, ay = cap.r.top + (t.y - 14) * z
      const bx = cap.r.left + (t.x + 60) * z, by = cap.r.top + (t.y + 26) * z
      cap.el.dispatchEvent(pev('pointerdown', ax, ay))
      for (let i = 1; i <= 10; i++) { cap.el.dispatchEvent(pev('pointermove', ax + (bx - ax) * i / 10, ay + (by - ay) * i / 10)); await sleep(20) }
      cap.el.dispatchEvent(pev('pointerup', bx, by))
      for (let i = 0; i < 40 && st().busy; i++) await sleep(200)
      await sleep(400)
      const d = st().docs[st().active]
      const patch = d.objOrder.map(id => d.objects[id]).filter(o => o.kind === 'whiteout').pop()
      if (!patch) return { err: 'the pen left no patch' }
      return { pristine, after: await S.exportActive(), shaped: !!patch.shaped, box: { w: patch.w, h: patch.h } }
    })()`)

    // A patch dragged aside no longer stands in for anything: the print it was
    // cut to replace is back on screen, so it has to be back in the file too.
    await cdp.run('window.__reshapedpdf.openSample()')
    await sleep(1700)
    await cdp.run('window.__reshapedpdf.state().setZoom(1)')
    await sleep(500)
    moved = await cdp.run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      const S = window.__reshapedpdf, st = () => S.state()
      const hits = await S.searchActive(${JSON.stringify(RUB.find)})
      if (!hits.length) return { err: 'word not found on the page' }
      const t = hits[0].rects[0]
      const pristine = await S.exportActive()
      st().setPref('eraseMode', 'box')
      st().setTool('whiteout'); await sleep(400)
      const cap = [...document.querySelectorAll('.overlay-capture')]
        .map(el => ({ el, r: el.getBoundingClientRect() }))
        .filter(x => x.r.width > 200 && x.r.height > 250)[0]
      if (!cap) return { err: 'no capture overlay' }
      const pev = (ty, cx, cy) => new PointerEvent(ty, { clientX: cx, clientY: cy, bubbles: true,
        cancelable: true, pointerId: 1, button: 0, buttons: ty === 'pointerup' ? 0 : 1, isPrimary: true,
        pointerType: 'mouse', view: window })
      const z = st().zoom
      const ax = cap.r.left + (t.x - 40) * z, ay = cap.r.top + (t.y - 4) * z
      const bx = cap.r.left + (t.x + t.w + 60) * z, by = cap.r.top + (t.y + t.h + 4) * z
      cap.el.dispatchEvent(pev('pointerdown', ax, ay))
      for (let i = 1; i <= 6; i++) { cap.el.dispatchEvent(pev('pointermove', ax + (bx - ax) * i / 6, ay + (by - ay) * i / 6)); await sleep(20) }
      cap.el.dispatchEvent(pev('pointerup', bx, by))
      await sleep(2200)
      const d = st().docs[st().active]
      const patch = d.objOrder.map(id => d.objects[id]).filter(o => o.kind === 'whiteout').pop()
      if (!patch) return { err: 'the rubber added no patch' }
      const hadSpans = (patch.removedSpans || []).length
      // now drag it a long way down the page, the way a user would to reuse it
      st().replaceObject({ ...patch, y: patch.y + 300 })
      await sleep(300)
      const after = st().docs[st().active].objects[patch.id]
      return { pristine, hadSpans, stillHasSpans: (after.removedSpans || []).length, moved: await S.exportActive() }
    })()`)
  } finally {
    cdp.close()
    try { child.kill('SIGKILL') } catch { /* gone */ }
  }

  const textOf = (p) => { try { return execFileSync('pdftotext', [p, '-'], { encoding: 'utf8' }) } catch { return '' } }
  const occurrences = (hay, needle) => hay.toLowerCase().split(needle.toLowerCase()).length - 1

  for (const { run, r } of out) {
    const tag = run.find.toLowerCase()
    if (r.err) { rec(`${tag}:retype-editable`, false, r.err); continue }

    // 1. editable, and it read the printed words back
    rec(`${tag}:retype-editable`, !r.isImage && typeof r.readBack === 'string' && r.readBack.length > 0,
      `added [${r.kinds.join(', ')}] read back "${r.readBack}" (a bitmap retype would add an image)`)

    // 2. the edit is what lands in the file — the new words are in it, and the
    //    run that was replaced is out of it (the SAME word elsewhere on the page
    //    must survive untouched, hence a count rather than "is it absent")
    const p0 = join(OUT, `${tag}-pristine.pdf`)
    const p1 = join(OUT, `${tag}-edited.pdf`)
    writeFileSync(p0, Buffer.from(r.pristine.b64, 'base64'))
    writeFileSync(p1, Buffer.from(r.withEdit.b64, 'base64'))
    const txt = textOf(p1)
    const was = occurrences(textOf(p0), run.find)
    const now = occurrences(txt, run.find)
    rec(`${tag}:edit-is-accurate`, txt.includes(run.replacement) && was > 0 && now === was - 1,
      `export has "${run.replacement}"=${txt.includes(run.replacement)}; "${run.find}" went ${was} → ${now} (want ${was - 1}: the retyped run gone, the rest of the page untouched)`)

    // 3. nothing of the printed original left behind
    const p2 = join(OUT, `${tag}-stripped.pdf`)
    writeFileSync(p2, Buffer.from(r.stripped.b64, 'base64'))
    const off = bandStats(p2, join(OUT, `${tag}-stripped`), r.band)
    rec(`${tag}:no-debris`, off < 0.06,
      `${(off * 100).toFixed(1)}% of the band differs from its own background after removing the retype (want <6%)`)
  }

  // the rubber: erased means erased, and only what the box actually covered
  if (!rub || rub.err) {
    rec('rubber:erases-from-the-file', false, (rub && rub.err) || 'no result')
  } else {
    const q0 = join(OUT, 'rubber-pristine.pdf')
    const q1 = join(OUT, 'rubber-erased.pdf')
    writeFileSync(q0, Buffer.from(rub.pristine.b64, 'base64'))
    writeFileSync(q1, Buffer.from(rub.erased.b64, 'base64'))
    const t0 = textOf(q0), t1 = textOf(q1)
    const wasW = occurrences(t0, RUB.find), nowW = occurrences(t1, RUB.find)
    const wasN = occurrences(t0, RUB.neighbour), nowN = occurrences(t1, RUB.neighbour)
    rec('rubber:erases-from-the-file', wasW > 0 && nowW === wasW - 1,
      `"${RUB.find}" went ${wasW} → ${nowW} (want ${wasW - 1}: covered by the rubber, so gone from the file too)`)
    rec('rubber:spares-the-neighbour', wasN > 0 && nowN === wasN,
      `"${RUB.neighbour}" — on the line just below the box — went ${wasN} → ${nowN} (want ${wasN}: near the rubber is not under it)`)
  }

  // the brush's bounding box is not a claim about what it covered
  if (!brush || brush.err) rec('brush:box-is-not-a-cover', false, (brush && brush.err) || 'no result')
  else {
    const b0 = join(OUT, 'brush-before.pdf'), b1 = join(OUT, 'brush-after.pdf')
    writeFileSync(b0, Buffer.from(brush.pristine.b64, 'base64'))
    writeFileSync(b1, Buffer.from(brush.after.b64, 'base64'))
    const t0 = textOf(b0), t1 = textOf(b1)
    const lost = BRUSH.survivors.filter((w) => occurrences(t1, w) < occurrences(t0, w))
    rec('brush:box-is-not-a-cover', brush.shaped && lost.length === 0,
      `patch marked shaped=${brush.shaped}, box ${brush.box ? Math.round(brush.box.w) + 'x' + Math.round(brush.box.h) : '?'}pt; words lost from the file: [${lost.join(', ') || 'none'}] (want none — a stroke is not a rectangle)`)
  }

  // a patch dragged away gives the print back
  if (!moved || moved.err) rec('moved-patch:gives-the-print-back', false, (moved && moved.err) || 'no result')
  else {
    const m0 = join(OUT, 'moved-before.pdf'), m1 = join(OUT, 'moved-after.pdf')
    writeFileSync(m0, Buffer.from(moved.pristine.b64, 'base64'))
    writeFileSync(m1, Buffer.from(moved.moved.b64, 'base64'))
    const was = occurrences(textOf(m0), RUB.find), now = occurrences(textOf(m1), RUB.find)
    rec('moved-patch:gives-the-print-back', moved.hadSpans > 0 && moved.stillHasSpans === 0 && now === was,
      `the patch claimed ${moved.hadSpans} span(s), kept ${moved.stillHasSpans} after being dragged 300pt away; "${RUB.find}" ${was} → ${now} (want ${was}: nothing is covering it any more)`)
  }

  const bad = results.filter((x) => !x.ok).length
  console.log(`\n${results.length - bad}/${results.length} text-edit invariants hold`)
  process.exit(bad ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(2) })
