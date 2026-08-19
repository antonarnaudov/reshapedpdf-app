#!/usr/bin/env node
/*
 * Does a lift preview survive a change to the page it was measured on?
 *
 *   node tests/lift-geometry-check.mjs
 *
 * The lift preview is a rectangle in ONE page geometry, and the Enter that
 * commits it runs the whole lift — element box, true-background render, patch
 * placement, span removal — against the PageRef the preview was taken from.
 *
 * It used to outlive a rotation. The dashed ghost stayed where it was drawn
 * while the page turned underneath it, still labelled "Enter to lift", and Enter
 * then wrote the result into the new page using the old coordinates: a bitmap of
 * un-rotated pixels stamped onto clean paper, and — because the patch carries
 * removedSpans — the real heading DELETED from the exported content stream. Not
 * a misplaced object: the words were gone from the file.
 *
 * setActive and setTool had always cleared it. rotate, delete, reorder, undo and
 * redo had not, and each of those changes the geometry just as completely.
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { connect, launchApp, sleep } from './harness/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PORT = 9455

const b64 = readFileSync(join(ROOT, 'tests', 'fixtures', 'letter.pdf')).toString('base64')
const child = launchApp({ cwd: ROOT, port: PORT, userDataDir: '/tmp/lift-geom-ud' })
const cdp = await connect({ port: PORT })
await sleep(1800)

let out
try {
  await cdp.run(`window.__reshapedpdf.openBase64(${JSON.stringify(b64)}, "letter.pdf")`)
  await sleep(3200)
  out = await cdp.run(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const S = window.__reshapedpdf, st = () => S.state()
    const results = []
    const pageId = () => st().docs[st().active].pages[0].id

    // Put a preview up on page 1, the way a click does.
    const arm = async () => {
      st().setSelection([]); st().setTool('lift'); await sleep(500)
      const cap = [...document.querySelectorAll('.overlay-capture')]
        .map(el => ({ el, r: el.getBoundingClientRect() }))
        .filter(x => x.r.width > 200 && x.r.height > 250)[0]
      if (!cap) return null
      // find a printed line to aim at
      const { w: PW, h: PH } = S.pageSize(0)
      let at = null
      for (let y = 60; y < PH - 80 && !at; y += 8) {
        for (let x = 60; x < Math.min(PW - 120, 400); x += 20) {
          const f = await S.fontAt(0, x, y).catch(() => null)
          if (f && (f.text || '').trim().length > 5) { at = { x, y }; break }
        }
      }
      if (!at) return null
      const z = st().zoom
      const cx = cap.r.left + at.x * z, cy = cap.r.top + at.y * z
      const pev = (ty) => new PointerEvent(ty, { clientX: cx, clientY: cy, bubbles: true,
        cancelable: true, pointerId: 1, button: 0, buttons: ty === 'pointerup' ? 0 : 1,
        isPrimary: true, pointerType: 'mouse', view: window })
      cap.el.dispatchEvent(pev('pointerdown'))
      cap.el.dispatchEvent(pev('pointerup'))
      await sleep(1500)
      return st().liftPreview ? { at } : null
    }

    for (const [name, act] of [
      ['rotate',      async () => { st().rotatePages([pageId()], 1); await sleep(900) }],
      ['move',        async () => { st().movePages([pageId()], 1); await sleep(900) }],
      ['undo',        async () => { st().rotatePages([pageId()], 1); await sleep(600); st().undo(); await sleep(800) }],
    ]) {
      const armed = await arm()
      if (!armed) { results.push({ name, skipped: 'no preview could be armed' }); continue }
      const before = JSON.stringify(st().liftPreview.rect)
      await act()
      const after = st().liftPreview
      results.push({ name, before, cleared: after === null,
        stale: after ? JSON.stringify(after.rect) : null })
      st().setTool('select'); await sleep(300)
    }
    return results
  })()`)
} finally {
  cdp.close()
  try { child.kill('SIGKILL') } catch { /* already gone */ }
}

let bad = 0
for (const r of out) {
  if (r.skipped) { console.log(`  ${r.name.padEnd(11)} SKIP  ${r.skipped}`); continue }
  const ok = r.cleared
  if (!ok) bad++
  console.log(`  ${r.name.padEnd(11)} ${ok ? 'PASS' : 'FAIL'}  preview ${r.before} -> ${ok ? 'cleared' : 'STILL ' + r.stale}`)
}
console.log(`\n${out.length - bad}/${out.length} lift-geometry invariants hold`)
process.exit(bad ? 1 : 0)
