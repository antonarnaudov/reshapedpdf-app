#!/usr/bin/env node
/*
 * Run a SHARD of the suite.
 *
 *   node scripts/run-suites.mjs <index> <total>     # e.g. 1 3
 *   node scripts/run-suites.mjs --list
 *
 * `npm test` runs everything in one sequence, which is right on a laptop and
 * hopeless on a CI runner: thirty-four of the forty checks boot a real Electron
 * app, and end to end that overran a 45-minute job every time — so the badge on
 * the public repo had never once gone green, on a suite that passes locally.
 *
 * The list is DERIVED from the `test` script rather than written out again here.
 * A second copy would drift the first time somebody adds a suite and forgets,
 * and the failure mode is silent: a check that exists, passes locally, and is
 * never run by CI again.
 */
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))
const chain = pkg.scripts.test.split('&&').map((s) => s.trim().replace(/^npm run /, ''))

// Everything that is not a suite — the build and the static checks — runs in
// EVERY shard. They are seconds each, and a shard that skipped the build would
// have nothing to drive.
const prelude = chain.filter((n) => !n.startsWith('test:'))
const suites = chain.filter((n) => n.startsWith('test:'))

if (process.argv.includes('--list')) {
  console.log(`prelude: ${prelude.join(', ')}`)
  console.log(`suites (${suites.length}):`)
  for (const [i, s] of suites.entries()) console.log(`  ${String(i + 1).padStart(2)} ${s}`)
  process.exit(0)
}

const index = Number(process.argv[2] || 1)
const total = Number(process.argv[3] || 1)
if (!Number.isInteger(index) || !Number.isInteger(total) || index < 1 || total < 1 || index > total) {
  console.error('usage: run-suites.mjs <index> <total>   (1-based)')
  process.exit(2)
}

// Round-robin rather than contiguous blocks: the slow suites cluster together
// (ux, erase, sweep and the fidelity checks are all near the end), and a
// contiguous split would hand one shard all of them.
const mine = suites.filter((_, i) => i % total === index - 1)

console.log(`shard ${index}/${total} — ${prelude.length} prelude step(s) then ${mine.length} suite(s)`)
const started = Date.now()

const run = (step) => {
  const t0 = Date.now()
  process.stdout.write(`\n=== ${step} ===\n`)
  try {
    execSync(`npm run ${step}`, { cwd: ROOT, stdio: 'inherit' })
    console.log(`  (${step} took ${Math.round((Date.now() - t0) / 1000)}s)`)
    return true
  } catch {
    console.error(`\n\u2717 ${step} FAILED after ${Math.round((Date.now() - t0) / 1000)}s`)
    return false
  }
}

// The prelude is different: nothing downstream can mean anything if the build
// or the typecheck failed, so that one does stop the shard.
for (const step of prelude) if (!run(step)) process.exit(1)

/* The suites do NOT stop each other.
 *
 * The first sharded run died on test:erase three suites in, and the five behind
 * it never ran — so what we learned from a twelve-minute job was one failure and
 * five unknowns, and the next push would have found the next one the same way,
 * one round trip at a time. These suites are independent; there is no reason a
 * fault in one should cost us the answer from another. Run them all, report
 * every failure together, and fail the shard at the end. */
const failed = []
for (const step of mine) if (!run(step)) failed.push(step)

const mins = Math.round((Date.now() - started) / 60000)
if (failed.length) {
  console.error(`\nshard ${index}/${total}: ${failed.length} of ${mine.length} suite(s) failed in ${mins} min`)
  for (const f of failed) console.error(`  \u2717 ${f}`)
  process.exit(1)
}
console.log(`\nshard ${index}/${total} green in ${mins} min`)
