#!/usr/bin/env node
/*
 * A base-14 retype must be set in Helvetica's METRICS, whatever this machine
 * calls Helvetica.
 *
 *   node tests/stdstack-check.mjs
 *
 * A PDF that names Helvetica does not carry it; the reader supplies one. So the
 * editor has to supply one too, and if the screen's is a different width from
 * the one the reader will use, the edit is set to a line length the exported
 * file will not reproduce.
 *
 * The old stack led with the system name and trusted CSS to fall through to the
 * bundled twin when it was absent. On macOS that is right. On Linux it is not,
 * and not because the fallback failed — because fontconfig does not report a
 * missing family, it substitutes one, so `Helvetica` "matched" DejaVu Sans and
 * the twin behind it was never reached. That is not a hypothetical: it is what
 * made the erase suite's panel-light case come back 1.84pt off its baseline with
 * 71% of the ink on the CI runner while passing on every machine here.
 *
 * So this asserts the property that actually matters, on whatever platform it is
 * run: the family a base-14 run is drawn in measures the same as the metric twin
 * the exporter will use. It is a real check on macOS (where it must choose the
 * system face) and on Linux (where it must refuse it) without either needing to
 * know which one it is on.
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, launchApp, sleep } from './harness/cdp.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 9489

const child = launchApp({ cwd: ROOT, port: PORT, userDataDir: '/tmp/stdstack-ud' })
const cdp = await connect({ port: PORT })
await sleep(1800)

const PROBE = `(async () => {
  const S = window.__reshapedpdf
  await document.fonts.ready
  const c = document.createElement('canvas').getContext('2d')
  const T = 'Hamburgefonstiv 0123456789 THE quick brown fox; jumps—over? {[(#@&%)]}'
  const w = (fam) => { c.font = "40px " + fam; return c.measureText(T).width }
  const out = []
  for (const [std, twin] of [['Helvetica', 'Arimo'], ['Times-Roman', 'Tinos'], ['Courier', 'Cousine']]) {
    const stack = S.stdStack(std)
    out.push({ std, twin, stack, chosen: w(stack), twinW: w("'" + twin + "'"),
               twinLoaded: document.fonts.check("40px '" + twin + "'") })
  }
  return out
})()`

let rows
try {
  await cdp.run(`window.__reshapedpdf.openSample()`)
  await sleep(2500)
  rows = await cdp.run(PROBE)
} finally {
  cdp.close()
  try { child.kill('SIGKILL') } catch { /* already gone */ }
}

let bad = 0, skipped = 0
for (const r of rows) {
  if (!r.twinLoaded) {
    /* A missing twin is not a neutral "cannot test here". It is the one state in
       which a base-14 retype is GUARANTEED to be set in the wrong metrics: with
       the webfont absent, stdFontStack's document.fonts.check guard returns the
       old system-first stack unconditionally and forever. So this counts as a
       failure, not a skip — and the packaging regressions that stripped assets
       out of the bundle twice already are exactly how it would arise. */
    skipped++
    console.log(`  ${r.std.padEnd(12)} FAIL  the bundled ${r.twin} is not loaded — nothing can be verified, and`)
    console.log(`  ${''.padEnd(12)}       in this state every base-14 edit silently uses the system face`)
    continue
  }
  const drift = Math.abs(r.chosen - r.twinW) / r.twinW
  const lead = (r.stack || '').split(',')[0].trim()
  if (drift < 0.005) {
    console.log(`  ${r.std.padEnd(12)} ok    drawn in ${lead} — within ${(drift * 100).toFixed(2)}% of ${r.twin}`)
  } else {
    bad++
    console.log(`  ${r.std.padEnd(12)} FAIL  drawn in ${lead}, which is ${(drift * 100).toFixed(1)}% off ${r.twin}'s metrics` +
                ` — an edit set here will not reproduce in the exported file`)
  }
}
console.log(`\n${rows.length - bad - skipped} of ${rows.length} base-14 faces set in the right metrics` +
            (skipped ? ` · ${skipped} unverifiable (bundled twin missing)` : ''))
process.exit(bad + skipped ? 1 : 0)
