#!/usr/bin/env node
/*
 * An image a PDF cannot carry must not take the whole export down with it.
 *
 * A PDF can only embed PNG or JPEG. The exporter picked its embedder from the
 * data-URL prefix — anything that wasn't `data:image/png` was handed to
 * embedJpg — so a GIF/BMP/WebP stamp (a pasted screenshot, an uploaded
 * signature) made pdf-lib throw and the ENTIRE export and print failed, not just
 * that picture. Two defences, both checked here:
 *   1. intake re-encodes anything exotic to PNG, so it never reaches the exporter;
 *   2. the exporter skips a picture it still cannot embed rather than aborting.
 *
 *   node tests/image-format-check.mjs
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, launchApp, sleep } from './harness/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PORT = Number(process.env.CDP_PORT || 9388)

// 1x1 transparent GIF — the smallest thing a PDF genuinely cannot embed.
const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

const results = []
const rec = (id, ok, detail) => { results.push({ id, ok }); console.log(`  ${id.padEnd(30)} ${ok ? 'PASS' : 'FAIL'}  ${detail}`) }

async function main() {
  console.log('booting app…')
  const child = launchApp({ cwd: ROOT, port: PORT, userDataDir: join(HERE, '.artifacts', 'imgfmt-profile') })
  const cdp = await connect({ port: PORT })
  await sleep(1500)
  let placed, raw
  try {
    await cdp.run('window.__reshapedpdf.openSample()')
    await sleep(1000)

    // 1. through the real intake path: the stored object must be PNG by then
    placed = await cdp.run(`(async () => {
      const S = window.__reshapedpdf, st = S.state
      const d = st().docs[st().active]
      await S.placeImage(${JSON.stringify(GIF)}, { page: d.pages[0].id, x: 60, y: 60 })
      await new Promise(r => setTimeout(r, 400))
      const doc = st().docs[st().active]
      const img = Object.values(doc.objects).find(o => o.kind === 'image')
      const out = await S.exportActive()
      return { hasImage: !!img, prefix: img ? img.src.slice(0, 20) : '', size: out ? out.size : 0 }
    })()`)

    // 2. defence in depth: an object holding raw GIF bytes must not abort the export
    raw = await cdp.run(`(async () => {
      const S = window.__reshapedpdf, st = S.state
      const d = st().docs[st().active]
      st().addObject({ id: 'rawgif', page: d.pages[0].id, kind: 'image', opacity: 1,
        x: 120, y: 120, w: 40, h: 40, src: ${JSON.stringify(GIF)} }, { select: false })
      try {
        const out = await S.exportActive()
        return { ok: true, size: out ? out.size : 0 }
      } catch (e) {
        return { ok: false, err: String(e && e.message || e).slice(0, 90) }
      }
    })()`)
  } finally {
    cdp.close()
    try { child.kill('SIGKILL') } catch { /* gone */ }
  }

  rec('gif-intake-normalised-to-png', !!placed && placed.hasImage && placed.prefix.startsWith('data:image/png'),
    `stored src prefix = "${placed ? placed.prefix : 'none'}"`)
  rec('export-succeeds-after-gif', !!placed && placed.size > 1000, `export ${placed ? placed.size : 0} bytes`)
  rec('raw-gif-object-cannot-abort', !!raw && raw.ok && raw.size > 1000,
    raw && raw.ok ? `export still produced ${raw.size} bytes` : `export THREW: ${raw ? raw.err : 'no result'}`)

  const bad = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - bad}/${results.length} image-format invariants hold`)
  process.exit(bad ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(2) })
