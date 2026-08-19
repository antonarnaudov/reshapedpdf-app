#!/usr/bin/env node
/*
 * Word-wrap honours letter tracking.
 *
 * A display name set with NEGATIVE tracking (tightened to fit) is narrower than
 * its bare glyph widths. wrapLines used to measure without the tracking term, so
 * it wrapped a run that actually fits on one line — "MERIDIAN" broke to two, and
 * because the exporter shares this same wrapLines, the export re-wrapped too. That
 * was the concrete cause of the "text edit destroys the layout" complaint.
 *
 * This drives the REAL wrapLines in the app. It self-calibrates: narrow the box
 * until the UNtracked word just wraps, then assert the same box at -3 tracking
 * still fits on one line. Font metrics never need hard-coding.
 *
 *   node tests/wrap-check.mjs
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, launchApp, sleep } from './harness/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PORT = Number(process.env.CDP_PORT || 9375)

const SCRIPT = `(() => {
  const wrap = window.__reshapedpdf.wrapLines
  const n = (maxW, track) => wrap('MERIDIAN', 'sans', 30, true, maxW, track).length
  // find the widest box (to the pt) at which the UNtracked word still fits on one
  // line, then step one pt narrower so it just wraps
  let B = 420
  while (n(B, 0) === 1 && B > 40) B -= 1
  const untracked = n(B, 0)     // >= 2: it wraps here
  const tracked = n(B, -3)      // must still be 1: -3 over 7 gaps is ~21pt narrower
  const wide = n(420, -3)       // sanity: a huge box is always one line
  return {
    ok: untracked >= 2 && tracked === 1 && wide === 1,
    detail: 'boxW=' + B + 'pt  untracked=' + untracked + ' lines  tracked=' + tracked + ' line(s)  wideBox=' + wide,
  }
})()`

async function main() {
  console.log('booting app…')
  const child = launchApp({ cwd: ROOT, port: PORT, userDataDir: join(HERE, '.artifacts', 'wrap-profile') })
  const cdp = await connect({ port: PORT })
  await sleep(1500)
  let r
  try {
    // wrapLines needs no document — but the bridge only exists once the app mounts
    await cdp.run('window.__reshapedpdf.openSample()')
    await sleep(1000)
    r = await cdp.run(SCRIPT)
  } finally {
    cdp.close()
    try { child.kill('SIGKILL') } catch { /* gone */ }
  }
  const ok = !!(r && r.ok)
  console.log(`  wrap honours tracking   ${ok ? 'PASS' : 'FAIL'}  ${r ? r.detail : 'no result'}`)
  console.log(`\n${ok ? '1/1' : '0/1'} wrap invariants hold`)
  process.exit(ok ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(2) })
