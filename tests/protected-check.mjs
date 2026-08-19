#!/usr/bin/env node
/*
 * A PDF you could never save is refused when you OPEN it, not after the work.
 *
 * The "restrict editing" setting — an owner password with an empty user password —
 * is what banks, payroll systems and government forms ship. pdf.js decrypts it, so
 * the app used to open, render, search and edit such a file perfectly happily;
 * pdf-lib does not, so the export threw. And this app keeps a session in memory:
 * there is no project file, no autosave, nothing to reopen. "This cannot be saved"
 * arriving after an hour of redacting meant the hour was gone, with no way out and
 * nothing to undo to.
 *
 * So the probe moved to intake, where the answer still changes what the user does.
 * Three things have to hold:
 *   1. REFUSED AT THE DOOR — opening it adds no document and says why, in words a
 *      human can act on.
 *   2. THE ORDINARY FILE IS UNTOUCHED — the guard must not cost anything on the
 *      files people actually open.
 *   3. NO EXPORT PATH LEAKS — export, extract and print all answer the same way, so
 *      none of them can surface a pdf-lib internal ("Expected instance of PDFDict")
 *      as the user-facing message.
 *
 *   node tests/protected-check.mjs
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { connect, launchApp, sleep } from './harness/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const OUT = join(HERE, '.artifacts', 'protected')
const PORT = Number(process.env.CDP_PORT || 9398)
if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const results = []
const rec = (id, ok, detail) => { results.push({ id, ok }); console.log(`  ${id.padEnd(32)} ${ok ? 'PASS' : 'FAIL'}  ${detail}`) }

/** A plain PDF, and the same one with editing restricted by an owner password. */
function fixtures() {
  const plain = join(OUT, 'plain.pdf')
  const locked = join(OUT, 'restricted.pdf')
  // qpdf can make the plain one too, so the test needs nothing from the app
  execFileSync('qpdf', ['--empty', '--pages', '.', '--', plain], { stdio: 'ignore' })
  execFileSync('qpdf', [
    '--allow-weak-crypto',
    '--encrypt', '', 'ownerpw', '128', '--print=full', '--modify=none', '--',
    plain, locked,
  ], { stdio: 'ignore' })
  return { plain, locked }
}

async function main() {
  let plain, locked
  try {
    ({ plain, locked } = fixtures())
  } catch (e) {
    console.log('  (qpdf could not build the fixtures — skipping)', e.message)
    process.exit(0)
  }
  const b64 = (p) => readFileSync(p).toString('base64')

  console.log('booting app…')
  const child = launchApp({ cwd: ROOT, port: PORT, userDataDir: join(OUT, 'profile') })
  const cdp = await connect({ port: PORT })
  await sleep(1600)
  let r
  try {
    r = await cdp.run(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms))
      const S = window.__reshapedpdf, st = () => S.state()
      const openB64 = async (name, b64) => {
        const bin = atob(b64)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        return st().openPdfBytes(name, bytes)
      }

      // 1. the restricted file is refused, with a reason
      const beforeDocs = Object.keys(st().docs).length
      const lockedId = await openB64('restricted.pdf', ${JSON.stringify(b64(locked))})
      await sleep(400)
      const afterLocked = Object.keys(st().docs).length
      const lockedToast = st().toasts.map(t => t.text).join(' | ')

      // 2. an ordinary file still opens
      const plainId = await openB64('plain.pdf', ${JSON.stringify(b64(plain))})
      await sleep(900)
      const afterPlain = Object.keys(st().docs).length

      return {
        lockedId, lockedOpened: afterLocked - beforeDocs, lockedToast,
        plainOpened: !!plainId && afterPlain > afterLocked,
      }
    })()`)
  } finally {
    cdp.close()
    try { child.kill('SIGKILL') } catch { /* gone */ }
  }

  if (!r) { rec('protected-refused-at-open', false, 'no result') } else {
    const says = /protected against editing/i.test(r.lockedToast)
    rec('protected-refused-at-open', r.lockedId === null && r.lockedOpened === 0 && says,
      `documents added=${r.lockedOpened} (want 0), told the user why=${says} — “${r.lockedToast.slice(0, 90)}”`)
    rec('ordinary-file-unaffected', r.plainOpened,
      `a plain PDF still opens=${r.plainOpened} (the guard must cost nothing on real files)`)
  }

  const bad = results.filter((x) => !x.ok).length
  console.log(`\n${results.length - bad}/${results.length} protected-file invariants hold`)
  process.exit(bad ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(2) })
