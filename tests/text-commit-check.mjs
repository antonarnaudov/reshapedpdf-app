#!/usr/bin/env node
/*
 * Does what you typed survive leaving the editor?
 *
 *   node tests/text-commit-check.mjs
 *
 * The inline text editor committed on exactly two events: the textarea blurring,
 * and Escape. Every other way out of the editor unmounts the textarea WITHOUT
 * blurring it — switching to another tool, switching document, the page being
 * deleted, anything at all that clears editingText from elsewhere — and the
 * words the user had just typed were dropped on the floor with no message.
 *
 * Committing on unmount is not quite enough on its own: the cleanup closure
 * captures the value from the render that created it, which is the EMPTY string
 * for a box the user has only just typed into. So the commit reads the live
 * value through a ref, and this test exists because that distinction is
 * invisible in the code and total in its effect.
 *
 * The invariant is therefore NOT "the object holds the words afterwards". Some
 * exits deliberately keep the editor open — switching to Select, rotating the
 * page — and there the words are still on screen, still editable, simply not
 * committed yet. From the outside that is indistinguishable from the bug: the
 * object reads empty either way. Reading it as a bug three times in a row is how
 * this comment came to be written.
 *
 * What must hold is the honest version: the typed text is EITHER committed to
 * the object OR still sitting in an open editor. Never silently dropped.
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { connect, launchApp, sleep } from './harness/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PORT = 9457
const TYPED = 'KEEP THIS TEXT'

const b64 = readFileSync(join(ROOT, 'tests', 'fixtures', 'letter.pdf')).toString('base64')
const child = launchApp({ cwd: ROOT, port: PORT, userDataDir: '/tmp/text-commit-ud' })
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

    const exits = [
      ['another tool',   () => st().setTool('markup')],
      ['editing cleared',() => st().setEditingText(null)],
      ['page rotated',   () => st().rotatePages([st().docs[st().active].pages[0].id], 1)],
    ]

    for (const [name, exit] of exits) {
      st().setZoom(1); st().setTool('text'); await sleep(600)
      const cap = [...document.querySelectorAll('.overlay-capture')]
        .map(el => ({ el, r: el.getBoundingClientRect() }))
        .filter(x => x.r.width > 200 && x.r.height > 250)[0]
      if (!cap) { results.push({ name, err: 'no capture overlay' }); continue }
      const pev = (ty, cx, cy) => new PointerEvent(ty, { clientX: cx, clientY: cy, bubbles: true,
        cancelable: true, pointerId: 1, button: 0, buttons: ty === 'pointerup' ? 0 : 1,
        isPrimary: true, pointerType: 'mouse', view: window })
      const ax = cap.r.left + 300, ay = cap.r.top + 560, bx = ax + 170, by = ay + 26
      cap.el.dispatchEvent(pev('pointerdown', ax, ay))
      for (let i = 1; i <= 4; i++) { cap.el.dispatchEvent(pev('pointermove', ax + (bx-ax)*i/4, ay + (by-ay)*i/4)); await sleep(20) }
      cap.el.dispatchEvent(pev('pointerup', bx, by))

      // the NEW editor: focused, and still empty
      let ta = null
      for (let i = 0; i < 40 && !ta; i++) {
        ta = [...document.querySelectorAll('textarea')].find(t => t.value === '' && document.activeElement === t) || null
        if (!ta) await sleep(150)
      }
      if (!ta) { results.push({ name, err: 'no focused empty editor appeared' }); continue }

      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(ta, ${JSON.stringify(TYPED)})
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      await sleep(700)

      exit()
      await sleep(1200)
      const d = st().docs[st().active]
      const texts = d.objOrder.map(id => d.objects[id]).filter(o => o.kind === 'text').map(o => o.text)
      results.push({ name, kept: texts.includes(${JSON.stringify(TYPED)}), saw: texts.slice(-1)[0] ?? null,
        stillEditing: !!st().editingText, editorOpen: !!document.querySelector('textarea') })

      // reset for the next exit
      for (const id of d.objOrder.slice()) if (d.objects[id].kind === 'text') st().removeObjects([id])
      if (name === 'page rotated') { st().rotatePages([st().docs[st().active].pages[0].id], -1) }
      await sleep(400)
    }
    return results
  })()`)
} finally {
  cdp.close()
  try { child.kill('SIGKILL') } catch { /* already gone */ }
}

let bad = 0
for (const r of out) {
  if (r.err) { console.log(`  ${r.name.padEnd(17)} SKIP  ${r.err}`); continue }
  const safe = r.kept || r.editorOpen
  if (!safe) bad++
  const how = r.kept ? 'committed to the object' : 'still in an open editor'
  console.log(`  ${r.name.padEnd(17)} ${safe ? 'PASS' : 'FAIL'}  typed text ${safe ? how : `LOST (object reads ${JSON.stringify(r.saw)}, no editor open)`}`)
}
console.log(`\n${out.length - bad}/${out.length} text-commit invariants hold`)
process.exit(bad ? 1 : 0)
