#!/usr/bin/env node
/*
 * Take a whole page apart into the things it is made of.
 *
 *   node tests/peel-elements-check.mjs [cv|teambuilding|letter]
 *
 * Lift takes one element at a time, which is right when you know what you want.
 * This takes everything the page draws — runs, paths, pictures — and hands them
 * back as editable objects over the background they sat on. No model is
 * involved and nothing is inferred: it is the page's own drawing program, read
 * and re-laid.
 *
 * What must hold:
 *   IT TAKES THE PAGE APART   several objects, not one, and of more than one
 *                             kind on a page that has more than one kind.
 *   VECTORS STAY VECTORS      a path comes back as a vector object, not a
 *                             picture of one — the whole point of doing this
 *                             from the drawing program rather than the pixels.
 *   ONE UNDO                  a single press puts the page back. Taking a page
 *                             apart and not being able to take it back would be
 *                             worse than not offering it.
 *   IT STILL EXPORTS          the file survives, and is not empty.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, launchApp, sleep } from './harness/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PORT = 9485

const want = process.argv[2] ?? 'letter'
const bench = join(ROOT, 'tests', 'fixtures', 'bench', `${want}.pdf`)
const file = existsSync(bench) ? bench : join(ROOT, 'tests', 'fixtures', 'letter.pdf')
const label = existsSync(bench) ? want : 'letter'
console.log(`peel-elements on ${label}`)

const b64 = readFileSync(file).toString('base64')
const child = launchApp({ cwd: ROOT, port: PORT, userDataDir: '/tmp/peelel-ud' })
const cdp = await connect({ port: PORT })
await sleep(1800)

let r
try {
  await cdp.run(`window.__reshapedpdf.openBase64(${JSON.stringify(b64)}, ${JSON.stringify(want + '.pdf')})`)
  await sleep(3200)
  r = await cdp.run(`(async () => {
    const sleep = (ms) => new Promise(res => setTimeout(res, ms))
    const S = window.__reshapedpdf, st = () => S.state()
    st().setZoom(1); await sleep(600)
    const d0 = st().docs[st().active]
    const before = d0.objOrder.length
    const res = await S.peelElements(0)
    await sleep(800)
    const d = st().docs[st().active]
    const added = d.objOrder.slice(before).map(id => d.objects[id])
    const kinds = {}
    for (const o of added) kinds[o.kind] = (kinds[o.kind] ?? 0) + 1
    let exportBytes = 0, exportErr = null
    try { const e = await S.exportActive({ trueRedact: false }); exportBytes = e ? e.size : 0 }
    catch (err) { exportErr = String(err && err.message || err).slice(0, 60) }
    // one press must put it back
    st().undo(); await sleep(900)
    const afterUndo = st().docs[st().active].objOrder.length
    return { res, before, added: added.length, kinds, exportBytes, exportErr, afterUndo }
  })()`)
} finally {
  cdp.close()
  try { child.kill('SIGKILL') } catch { /* already gone */ }
}

const kinds = r.kinds ?? {}
const checks = [
  ['takes it apart', (r.added ?? 0) >= 4, `${r.added} objects: ${JSON.stringify(kinds)}`],
  ['more than one kind', Object.keys(kinds).filter(k => k !== 'whiteout').length >= 2,
    Object.keys(kinds).join('+') || 'none'],
  ['vectors stay vectors', (kinds.vector ?? 0) >= 1, `${kinds.vector ?? 0} vector object(s)`],
  ['one undo puts it back', r.afterUndo === r.before, `${r.afterUndo} objects after undo (started at ${r.before})`],
  ['still exports', r.exportBytes > 0 && !r.exportErr, r.exportErr ?? `${r.exportBytes} bytes`],
]
let bad = 0
for (const [name, ok, detail] of checks) {
  if (!ok) bad++
  console.log(`  ${name.padEnd(23)} ${ok ? 'PASS' : 'FAIL'}  ${detail}`)
}
console.log(`\n${checks.length - bad}/${checks.length} peel-elements invariants hold on ${label}`)
process.exit(bad ? 1 : 0)
