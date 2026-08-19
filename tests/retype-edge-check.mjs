#!/usr/bin/env node
/*
 * An auto-grow right/centre-aligned run holds its aligned edge when edited.
 *
 * A retyped invoice figure is right-aligned and auto-grow (no fixed box): its
 * RIGHT edge is the anchor, not its left. Editing the text to something longer
 * must push x LEFT so the right edge stays put — otherwise the figure grows
 * rightward out of its column. The anchoring lives in the TextEditor commit
 * handler and only runs on the real editor's blur, so this drives the actual
 * textarea (React value setter + input + blur), never updateObject (which
 * bypasses it).
 *
 *   node tests/retype-edge-check.mjs
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, launchApp, sleep } from './harness/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PORT = Number(process.env.CDP_PORT || 9377)

// x=300,w=60 -> the right edge the run must hold is 360, whatever it grows to.
const SCRIPT = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const st = () => window.__reshapedpdf.state()
  const doc = () => st().docs[st().active]
  const pid = doc().pages[0].id
  const R0 = 360

  st().addObject({ id: 'T', page: pid, opacity: 1, kind: 'text', x: 300, y: 120, w: 60, h: 24,
    text: 'Total 42', color: '#111111', align: 'right', font: 'sans', size: 16, bold: false }, { select: false })

  const editTo = async (text) => {
    st().setEditingText('T')
    // The editor only mounts inside a RENDERED page overlay, and how long that
    // takes depends on machine load — a fixed wait made this suite flaky (it would
    // silently do nothing and report the object's untouched start geometry). Poll.
    // NB: :not(.ff-text) — the sample's FORM FIELDS also render textareas inside the
    // page, so a bare querySelector('textarea') can grab a field instead of the
    // editor. It then types into the wrong element, reports success, and the case
    // fails with the object's untouched start geometry.
    let ta = null
    for (let i = 0; i < 60 && !ta; i++) { await sleep(100); ta = document.querySelector('textarea:not(.ff-text)') }
    if (!ta) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, text)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(60)
    // Commit with ESCAPE, not blur. The editor commits on both, but blur() is a
    // no-op on an element that never had focus — and it never does when the window
    // isn't frontmost, which is the normal state for a headless run. That made this
    // suite hang or silently report the object's untouched start geometry depending
    // on the machine. Escape goes through the same commit() and needs no focus.
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))
    await sleep(300)
    return true
  }

  // normalise: commit the same text so w becomes the true measured width
  const ok1 = await editTo('Total 42')
  const a = doc().objects['T']; const edge1 = a.x + a.w
  // now grow it a lot — the RIGHT edge must stay, x must move left
  const ok2 = await editTo('Total 99999999')
  const b = doc().objects['T']; const edge2 = b.x + b.w

  return {
    ok: ok1 && ok2 && Math.abs(edge1 - R0) < 3 && Math.abs(edge2 - R0) < 3 && b.x < a.x - 5 && b.w > a.w + 5,
    detail: 'text="' + doc().objects['T'].text + '" editorMounted=' + ok1 + '/' + ok2 + ' edgeShort=' + edge1.toFixed(1) + ' edgeLong=' + edge2.toFixed(1) + ' (anchor ' + R0 + ')'
      + '  xShort=' + a.x.toFixed(1) + ' xLong=' + b.x.toFixed(1) + '  wShort=' + a.w.toFixed(1) + ' wLong=' + b.w.toFixed(1),
  }
})()`

async function main() {
  console.log('booting app…')
  const child = launchApp({ cwd: ROOT, port: PORT, userDataDir: join(HERE, '.artifacts', 'retype-edge-profile') })
  const cdp = await connect({ port: PORT })
  await sleep(1500)
  let r
  try {
    // the editor textarea only mounts inside a RENDERED page's overlay, so use the
    // sample (known to render) and let it settle — a blank never lays a page out
    await cdp.run('window.__reshapedpdf.openSample()')
    await sleep(1800)
    await cdp.run('window.__reshapedpdf.state().setZoom(1)')
    await sleep(400)
    r = await cdp.run(SCRIPT)
  } finally {
    cdp.close()
    try { child.kill('SIGKILL') } catch { /* gone */ }
  }
  const ok = !!(r && r.ok)
  console.log(`  right-align holds edge   ${ok ? 'PASS' : 'FAIL'}  ${r ? r.detail : 'no result'}`)
  console.log(`\n${ok ? '1/1' : '0/1'} retype-edge invariants hold`)
  process.exit(ok ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(2) })
