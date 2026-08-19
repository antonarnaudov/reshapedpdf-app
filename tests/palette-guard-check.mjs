#!/usr/bin/env node
/*
 * Page shortcuts must not fire against the document under an open command palette.
 *
 * The palette is a modal-like overlay that only holds focus via its input; click a
 * non-focusable part of it and focus falls to <body>, so the window keydown handler
 * sees no "typing" target and the non-mod shortcuts (Delete removing the SELECTED
 * object, letters switching tools) would run against the hidden document. This
 * drives the real window handler: select an object, open the palette, press Delete
 * from <body> — the object must survive; with the palette closed it must delete
 * (the control that proves the handler still works).
 *
 *   node tests/palette-guard-check.mjs
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, launchApp, sleep } from './harness/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PORT = Number(process.env.CDP_PORT || 9384)

const SCRIPT = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const st = () => window.__reshapedpdf.state()
  const doc = () => st().docs[st().active]
  const pid = doc().pages[0].id
  const del = () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }))

  st().addObject({ id: 'G', page: pid, opacity: 1, kind: 'text', x: 60, y: 90, w: 80, h: 20,
    text: 'keepme', color: '#111111', size: 14, font: 'sans', bold: false }, { select: false })
  st().setSelection(['G'])

  // palette OPEN: Delete from <body> must NOT reach the document
  st().setPalette(true); await sleep(80)
  del(); await sleep(120)
  const survived = !!doc().objects['G']

  // palette CLOSED: the same Delete must remove it (proves the handler still fires)
  st().setPalette(false); await sleep(40)
  st().setSelection(['G'])
  del(); await sleep(120)
  const deleted = !doc().objects['G']

  return { ok: survived && deleted, detail: 'underPalette survived=' + survived + '  closed deleted=' + deleted }
})()`

async function main() {
  console.log('booting app…')
  const child = launchApp({ cwd: ROOT, port: PORT, userDataDir: join(HERE, '.artifacts', 'palette-guard-profile') })
  const cdp = await connect({ port: PORT })
  await sleep(1500)
  let r
  try {
    await cdp.run('window.__reshapedpdf.openSample()')
    await sleep(1500)
    r = await cdp.run(SCRIPT)
  } finally {
    cdp.close()
    try { child.kill('SIGKILL') } catch { /* gone */ }
  }
  const ok = !!(r && r.ok)
  console.log(`  palette owns the keyboard   ${ok ? 'PASS' : 'FAIL'}  ${r ? r.detail : 'no result'}`)
  console.log(`\n${ok ? '1/1' : '0/1'} palette-guard invariants hold`)
  process.exit(ok ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(2) })
