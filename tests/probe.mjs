#!/usr/bin/env node
/* Ad-hoc probe: load a fixture and evaluate an expression against it.
 *   node tests/probe.mjs <fixture.pdf> '<expr>'
 * The expression is evaluated with the document already open. */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, launchApp, sleep } from './harness/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const [fixture, expr] = process.argv.slice(2)
const PORT = Number(process.env.CDP_PORT || 9355)

const b64 = readFileSync(join(HERE, 'fixtures', fixture)).toString('base64')
const child = launchApp({ cwd: ROOT, port: PORT, userDataDir: join(HERE, '.artifacts', 'probe-profile') })
try {
  const cdp = await connect({ port: PORT })
  await sleep(1500)
  await cdp.run(`window.__reshapedpdf.openBase64(${JSON.stringify(b64)}, ${JSON.stringify(fixture)})`)
  await sleep(2500)
  const out = await cdp.run(expr)
  console.log(JSON.stringify(out, null, 2))
  cdp.close()
} finally {
  child.kill('SIGKILL')
}
