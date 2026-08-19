#!/usr/bin/env node
/*
 * Space must still press the button you have focused, and the pan hold must let go.
 *
 * The viewer claims Space for hold-to-pan. It only excluded text inputs, so with a
 * document open Space was swallowed and preventDefault'd for every button, link,
 * checkbox and summary in the app — a keyboard user could not activate anything.
 * And because the hold was released only by keyup, losing the window while Space
 * was held (⌘Tab, a dialog, clicking another app) meant the keyup was delivered
 * elsewhere and never arrived: the hold latched ON for the rest of the session and
 * every tool silently behaved like the hand.
 *
 *   node tests/space-key-check.mjs
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, launchApp, sleep } from './harness/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PORT = Number(process.env.CDP_PORT || 9392)

const results = []
const rec = (id, ok, detail) => { results.push({ id, ok }); console.log(`  ${id.padEnd(30)} ${ok ? 'PASS' : 'FAIL'}  ${detail}`) }

async function main() {
  console.log('booting app…')
  const child = launchApp({ cwd: ROOT, port: PORT, userDataDir: join(HERE, '.artifacts', 'spacekey-profile') })
  const cdp = await connect({ port: PORT })
  await sleep(1600)
  let r
  try {
    await cdp.run('window.__reshapedpdf.openSample()')
    await sleep(1400)
    r = await cdp.run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      const scroller = () => document.querySelector('.viewer-scroll')
      const panning = () => !!scroller()?.classList.contains('panning')
      const space = (target) => {
        const e = new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true })
        target.dispatchEvent(e)
        return e.defaultPrevented
      }

      // 1. Space over the page still pans (the feature must survive the fix)
      const preventedOnPage = space(document.body)
      await sleep(120)
      const panOnPage = panning()

      // 2. losing the window releases the hold — otherwise it latches forever
      window.dispatchEvent(new Event('blur'))
      await sleep(150)
      const panAfterBlur = panning()

      // 3. Space on a focused BUTTON must reach the button, not the viewer
      const btn = [...document.querySelectorAll('button')].find(b => b.offsetParent !== null)
      if (!btn) return { err: 'no visible button to focus' }
      btn.focus()
      const preventedOnButton = space(btn)
      await sleep(120)
      const panFromButton = panning()
      window.dispatchEvent(new Event('blur'))

      return { preventedOnPage, panOnPage, panAfterBlur, preventedOnButton, panFromButton, btn: btn.textContent?.trim().slice(0, 18) || btn.className.slice(0, 18) }
    })()`)
  } finally {
    cdp.close()
    try { child.kill('SIGKILL') } catch { /* gone */ }
  }

  if (r?.err) {
    rec('space-key-behaviour', false, r.err)
  } else {
    rec('space-still-pans-over-page', r.preventedOnPage === true && r.panOnPage === true,
      `prevented=${r.preventedOnPage} panning=${r.panOnPage} (the hold must still work)`)
    rec('pan-hold-releases-on-blur', r.panAfterBlur === false,
      `still panning after losing focus = ${r.panAfterBlur} (must be false, or it latches for the session)`)
    rec('space-reaches-focused-button', r.preventedOnButton === false && r.panFromButton === false,
      `on <button "${r.btn}"> prevented=${r.preventedOnButton} panning=${r.panFromButton} (both must be false)`)
  }

  const bad = results.filter((x) => !x.ok).length
  console.log(`\n${results.length - bad}/${results.length} space-key invariants hold`)
  process.exit(bad ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(2) })
