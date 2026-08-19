#!/usr/bin/env node
/*
 * Column alignment is inferred from the page, so a retyped figure keeps its column.
 *
 * detectAlign reads the runs above/below the one being retyped: if >=2 share its
 * RIGHT edge (and more than share the left) the run is right-aligned; if they share
 * its CENTRE it is centred. That inferred `align` is what makes a reprinted invoice
 * figure keep its column instead of growing off the left anchor. The rendering and
 * editing of `align` are covered elsewhere (objects-suite, retype-edge-check); this
 * pins the DETECTION logic itself, which nothing else touches.
 *
 *   node tests/detectalign-check.mjs
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, launchApp, sleep } from './harness/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PORT = Number(process.env.CDP_PORT || 9382)

// target run at x=200,w=60 (left 200, right 260, centre 230), on its own line.
const CASES = [
  { id: 'right-column', want: 'right',
    // 3 neighbours on other lines sharing the RIGHT edge (260), varied left edges
    spans: [[200,100,60],[180,130,80],[190,160,70],[170,190,90]] },
  { id: 'centre-column', want: 'center',
    // 3 neighbours sharing the CENTRE (230), varied widths
    spans: [[200,100,60],[210,130,40],[195,160,70],[205,190,50]] },
  { id: 'left-column-is-default', want: undefined,
    // 3 neighbours sharing the LEFT edge (200) -> no explicit align (left is default)
    spans: [[200,100,60],[200,130,40],[200,160,80],[200,190,50]] },
  { id: 'too-few-runs', want: undefined,
    // only 1 neighbour -> not enough evidence for a column
    spans: [[200,100,60],[180,130,80]] },
]

async function main() {
  console.log('booting app…')
  const child = launchApp({ cwd: ROOT, port: PORT, userDataDir: join(HERE, '.artifacts', 'detectalign-profile') })
  const cdp = await connect({ port: PORT })
  await sleep(1500)
  const results = []
  try {
    for (const c of CASES) {
      const spans = c.spans.map(([x, y, w]) => ({ x, y, w, h: 14 }))
      const rect = spans[0]
      const got = await cdp.run(`window.__reshapedpdf.detectAlign(${JSON.stringify(spans)}, ${JSON.stringify(rect)})`)
      const ok = got === c.want || (got == null && c.want === undefined)
      results.push({ id: c.id, ok })
      console.log(`  ${c.id.padEnd(24)} ${ok ? 'PASS' : 'FAIL'}  got=${JSON.stringify(got)} want=${JSON.stringify(c.want)}`)
    }
  } finally {
    cdp.close()
    try { child.kill('SIGKILL') } catch { /* gone */ }
  }
  const bad = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - bad}/${results.length} column-alignment invariants hold`)
  process.exit(bad ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(2) })
