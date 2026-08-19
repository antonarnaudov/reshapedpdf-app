#!/usr/bin/env node
/*
 * Is "the run under the cursor" the same run when the page is turned?
 *
 *   node tests/rotated-run-check.mjs
 *
 * runFontInfo grows the clicked piece across pdf.js's arbitrary run splits, so
 * retyping a line takes the whole line rather than the fragment pdf.js happened
 * to emit. It builds sideways rects correctly and then grew them on the wrong
 * axes: neighbours were grouped by `baseline` (t[5], which on a 90/270 page
 * varies ALONG the line, not across it) and absorbed by adjacency in x (now the
 * cross axis). Both tests match every run in the column, so the "run" became the
 * entire text block.
 *
 * That is not a cosmetic misgrab. Retype removes what it takes: one click on a
 * rotated CV took 917 content spans and reprinted them as a single 6490pt line
 * in reverse reading order, and said the look was matched.
 *
 * The invariant is a comparison, not a constant: the SAME words at the SAME spot
 * must come back as a run of the same size whichever way the page is turned.
 * Rotating a page cannot change what a line is.
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { connect, launchApp, sleep } from './harness/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PORT = 9464

const b64 = readFileSync(join(ROOT, 'tests', 'fixtures', 'letter.pdf')).toString('base64')
const child = launchApp({ cwd: ROOT, port: PORT, userDataDir: '/tmp/rotrun-ud' })
const cdp = await connect({ port: PORT })
await sleep(1800)

let out
try {
  await cdp.run(`window.__reshapedpdf.openBase64(${JSON.stringify(b64)}, "letter.pdf")`)
  await sleep(3200)
  out = await cdp.run(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms))
    const S = window.__reshapedpdf, st = () => S.state()
    const pageId = () => st().docs[st().active].pages[0].id
    st().setZoom(1); await sleep(500)

    // Take several real lines upright, remembering their text.
    const upright = []
    const { w: PW, h: PH } = S.pageSize(0)
    for (let y = 60; y < PH - 80 && upright.length < 5; y += 9) {
      for (let x = 60; x < Math.min(PW - 140, 400); x += 24) {
        const f = await S.fontAt(0, x, y).catch(() => null)
        const t = f && (f.text || '').trim()
        if (t && t.length > 8 && !upright.some(u => u.text === t)) {
          upright.push({ x, y, text: t, w: +f.rect.w.toFixed(1), h: +f.rect.h.toFixed(1) })
          break
        }
      }
    }

    // Turn the page and ask for the same words again. The point that held them
    // has moved, so search for the TEXT rather than trusting a coordinate.
    st().rotatePages([pageId()], 1); await sleep(1400)
    const { w: RW, h: RH } = S.pageSize(0)
    const rotated = new Map()
    for (let y = 30; y < RH - 30 && rotated.size < upright.length; y += 8) {
      for (let x = 30; x < RW - 30; x += 16) {
        const f = await S.fontAt(0, x, y).catch(() => null)
        const t = f && (f.text || '').trim()
        if (!t || rotated.has(t)) continue
        if (upright.some(u => u.text === t)) {
          // sideways: the run's LENGTH is its height, its thickness is its width
          rotated.set(t, { len: +f.rect.h.toFixed(1), thick: +f.rect.w.toFixed(1) })
        }
      }
    }
    st().rotatePages([pageId()], -1); await sleep(800)
    return { pageUpright: { PW, PH }, pageRotated: { RW, RH },
      rows: upright.map(u => ({ text: u.text.slice(0, 30), uprightLen: u.w, uprightThick: u.h,
        rot: rotated.get(u.text) ?? null })) }
  })()`)
} finally {
  cdp.close()
  try { child.kill('SIGKILL') } catch { /* already gone */ }
}

let bad = 0, checked = 0
for (const r of out.rows) {
  checked++
  if (!r.rot) {
    // NOT a skip. A line that was there upright and cannot be found after the
    // turn has not gone anywhere — it has been absorbed into a bigger "run",
    // and its text is now a substring of a block-sized concatenation that no
    // longer matches. Reporting this as "skipped" is exactly how the first
    // version of this test passed 3/3 against the bug it was written for.
    bad++
    console.log(`  ${JSON.stringify(r.text).padEnd(34)} FAIL  gone after the turn — swallowed into a larger run`)
    continue
  }
  // A line is the same line either way: its length must match within a glyph or
  // two. Unbounded growth is the failure — the block-swallow made it many times
  // longer, never shorter.
  const ratio = r.rot.len / r.uprightLen
  const ok = ratio > 0.7 && ratio < 1.4
  if (!ok) bad++
  console.log(`  ${JSON.stringify(r.text).padEnd(34)} ${ok ? 'PASS' : 'FAIL'}  upright ${r.uprightLen}pt long -> rotated ${r.rot.len}pt (x${ratio.toFixed(2)})`)
}
if (!checked) { console.log('\nno lines were found upright at all'); process.exit(1) }
console.log(`\n${checked - bad}/${checked} rotated-run invariants hold`)
process.exit(bad ? 1 : 0)
