#!/usr/bin/env node
/*
 * Every tool, on a real document, checked for the three things a user notices.
 *
 *   node tests/bench-sweep.mjs [cv|teambuilding|letter] [--keep]
 *
 * The other suites each prove one mechanism deeply. This one goes wide and
 * shallow on purpose: it drives each tool the way a hand would, on a document
 * with an embedded subset font, a photograph, coloured panels and rules — and
 * asks only what a person would ask.
 *
 *   DID IT DO ANYTHING    a gesture that silently produces nothing is the worst
 *                         failure mode there is, because it reads as a broken
 *                         app rather than an unsupported case. Every tool here
 *                         must either change the document or SAY why it did not.
 *   CAN IT BE UNDONE      one ⌘Z must put the page back exactly as it was, with
 *                         no orphan patch left behind and no object stranded.
 *   DOES IT STILL EXPORT  the file has to survive the edit. An export that
 *                         throws, or comes back empty, loses the user's work.
 *
 * It needs no model: every tool that requires one is expected to say so, and
 * "said so" counts as a pass. Tools ARE allowed to decline — declining loudly
 * is a correct outcome and is recorded as DECLINED, not as a failure.
 *
 * The benchmark documents are real and are NOT in the repository (see
 * tests/fixtures/bench/, gitignored). Without them this falls back to
 * letter.pdf, and says which it used, so a fresh clone still runs it.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, launchApp, sleep } from './harness/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PORT = 9450

const want = process.argv.find((a) => !a.startsWith('-') && a !== process.argv[0] && a !== process.argv[1]) ?? 'cv'
const benchPath = join(ROOT, 'tests', 'fixtures', 'bench', `${want}.pdf`)
const usingBench = existsSync(benchPath)
const file = usingBench ? benchPath : join(ROOT, 'tests', 'fixtures', 'letter.pdf')
const label = usingBench ? want : 'letter (fallback — no benchmark documents present)'

console.log(`bench-sweep on ${label}`)
const b64 = readFileSync(file).toString('base64')

const child = launchApp({ cwd: ROOT, port: PORT, userDataDir: '/tmp/bench-sweep-ud' })
const cdp = await connect({ port: PORT })
await sleep(1800)

let out
try {
  await cdp.run(`window.__reshapedpdf.openBase64(${JSON.stringify(b64)}, ${JSON.stringify(want + '.pdf')})`)
  await sleep(3500)
  out = await cdp.run(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const S = window.__reshapedpdf, st = () => S.state()
    const results = []
    st().setZoom(1); await sleep(600)

    const getCap = () => [...document.querySelectorAll('.overlay-capture')]
      .map(el => ({ el, r: el.getBoundingClientRect() }))
      .filter(x => x.r.width > 200 && x.r.height > 250)[0]
    const pev = (ty, cx, cy) => new PointerEvent(ty, { clientX: cx, clientY: cy, bubbles: true,
      cancelable: true, pointerId: 1, button: 0, buttons: ty === 'pointerup' ? 0 : 1,
      isPrimary: true, pointerType: 'mouse', view: window })

    const objs = () => { const d = st().docs[st().active]; return d.objOrder.slice() }
    const drag = async (tool, x, y, w, h, hold = 2500) => {
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur()
      st().setSelection([]); st().setTool(tool); await sleep(500)
      const cap = getCap(); if (!cap) return { err: 'no capture overlay' }
      const before = objs()
      const z = st().zoom
      const ax = cap.r.left + x * z, ay = cap.r.top + y * z
      const bx = cap.r.left + (x + w) * z, by = cap.r.top + (y + h) * z
      cap.el.dispatchEvent(pev('pointerdown', ax, ay))
      for (let i = 1; i <= 6; i++) {
        cap.el.dispatchEvent(pev('pointermove', ax + (bx - ax) * i / 6, ay + (by - ay) * i / 6))
        await sleep(20)
      }
      cap.el.dispatchEvent(pev('pointerup', bx, by))
      await sleep(hold)
      // Lift is a two-step gesture on purpose: the click previews the element it
      // would take (and clicking again descends a layer), Enter commits it. The
      // options bar says so. A sweep that only clicks would report the tool dead.
      if (tool === 'lift') {
        const previewed = Boolean(st().liftPreview)
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        await sleep(2500)
        if (!previewed) return { added: [], toast: 'no lift preview appeared', modal: null,
          beforeCount: before.length, afterCount: objs().length }
      }
      const after = objs()
      const added = after.filter(id => !before.includes(id))
      const d = st().docs[st().active]
      return {
        added: added.map(id => d.objects[id].kind),
        toast: (st().toasts || []).slice(-1).map(t => t.text)[0] || null,
        modal: st().modal ? (st().modal.type || '?') : null,
        beforeCount: before.length, afterCount: after.length,
      }
    }

    // one page-1 text line and one empty-paper spot, found from the file itself
    let textAt = null, blankAt = null
    const { w: PW, h: PH } = S.pageSize(0)
    for (let y = 60; y < PH - 80 && !textAt; y += 10) {
      for (let x = 60; x < Math.min(PW - 120, 420); x += 20) {
        const f = await S.fontAt(0, x, y).catch(() => null)
        if (f && (f.text || '').trim().length > 6) { textAt = { x, y }; break }
      }
    }
    for (let y = PH - 120; y > 100 && !blankAt; y -= 10) {
      const f = await S.fontAt(0, 300, y).catch(() => null)
      if (!f) blankAt = { x: 300, y }
    }
    textAt = textAt || { x: 80, y: 200 }
    blankAt = blankAt || { x: 300, y: PH - 150 }

    const TOOLS = [
      ['markup',    textAt.x, textAt.y - 3, 140, 12, 1500],
      ['ink',       blankAt.x, blankAt.y, 90, 40, 1200],
      ['text',      blankAt.x, blankAt.y + 60, 150, 24, 1200],
      ['note',      blankAt.x + 200, blankAt.y, 10, 10, 1200],
      ['shape',     blankAt.x, blankAt.y + 100, 120, 40, 1200],
      ['redact',    textAt.x, textAt.y - 3, 120, 12, 2500],
      ['whiteout',  textAt.x, textAt.y - 3, 120, 12, 4000],
      ['retouch',   textAt.x, textAt.y - 3, 60, 12, 4000],
      ['lift',      textAt.x + 4, textAt.y + 2, 2, 2, 3000],
      ['retype',    textAt.x, textAt.y - 3, 150, 12, 6000],
      ['clean',     textAt.x, textAt.y - 6, 100, 20, 6000],
      ['reshape',   blankAt.x, blankAt.y + 160, 140, 20, 3000],
    ]

    for (const [tool, x, y, w, h, hold] of TOOLS) {
      const r = { tool }
      try {
        const g = await drag(tool, x, y, w, h, hold)
        Object.assign(r, g)
        r.acted = (g.added || []).length > 0
        // Undo must put it back exactly.
        if (r.acted) {
          const n = g.added.length
          for (let i = 0; i < n; i++) { st().undo(); await sleep(180) }
          r.afterUndo = objs().length
          r.undoClean = r.afterUndo === g.beforeCount
        } else {
          r.undoClean = true
          // A tool that did nothing must have said why.
          r.explained = Boolean(g.toast || g.modal)
        }
        // The document must still export.
        try {
          const e = await S.exportActive({ trueRedact: true })
          r.exportBytes = e ? e.size : 0
        } catch (err) { r.exportErr = String(err && err.message || err).slice(0, 70) }
      } catch (err) {
        r.threw = String(err && err.message || err).slice(0, 90)
      }
      results.push(r)
      if (st().modal) st().closeModal()
      await sleep(200)
    }
    return { page: { w: PW, h: PH }, textAt, blankAt, results }
  })()`)
} finally {
  cdp.close()
  try { child.kill('SIGKILL') } catch { /* already gone */ }
}

let bad = 0
console.log(`  a line of type at ${JSON.stringify(out.textAt)}, empty paper at ${JSON.stringify(out.blankAt)}\n`)
for (const r of out.results) {
  const problems = []
  if (r.threw) problems.push(`THREW ${r.threw}`)
  if (!r.acted && !r.explained) problems.push('SILENT — did nothing and said nothing')
  if (r.acted && !r.undoClean) problems.push(`UNDO LEFT ${r.afterUndo - r.beforeCount} object(s) behind`)
  if (r.exportErr) problems.push(`EXPORT FAILED ${r.exportErr}`)
  if (!r.exportErr && r.exportBytes === 0) problems.push('EXPORT EMPTY')
  const verdict = problems.length ? 'FAIL' : (r.acted ? 'acted' : 'DECLINED')
  if (problems.length) bad++
  const detail = r.acted
    ? `added ${JSON.stringify(r.added)}${r.undoClean ? ', undo clean' : ''}`
    : `said: ${String(r.toast ?? r.modal ?? '(nothing)').slice(0, 62)}`
  console.log(`  ${r.tool.padEnd(9)} ${verdict.padEnd(9)} ${detail}`)
  for (const p of problems) console.log(`            ${p}`)
}
console.log(`\n${out.results.length - bad}/${out.results.length} tools behave on ${label}`)
process.exit(bad ? 1 : 0)
