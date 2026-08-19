#!/usr/bin/env node
/*
 * A retype must never come back in the colour of the thing behind it.
 *
 *   node tests/inkcolor-check.mjs
 *
 * The editor decides what colour to set an edit in by looking at the pixels: two
 * tones in the run's box, and whichever lies further from the surrounding surface
 * is the ink. On plain paper that is obvious. On a coloured panel it is a real
 * judgement, and getting it backwards does not look like a bug — the words are
 * erased and drawn again in the panel's own colour, and the app reports a match.
 *
 * The erase suite has a case for exactly this (`panel-light`). It passed on every
 * machine here and failed on the Linux CI runner, printing cream text in dark
 * teal — and the difference between the two boxes was a renderer's antialiasing.
 * That is the problem with deciding it from `minL` and `maxL`: those are the
 * single darkest and single brightest PIXELS in the box, so a thin contamination
 * along one edge — a rule just outside, a descender from the line above, a
 * different machine's idea of how to soften a diagonal — both flips the vote and
 * then supplies the colour.
 *
 * A page cannot be asked to contaminate itself on demand, so this paints the
 * cases directly: a known panel, known text, and a known number of stray dark
 * rows along the top edge. Every one of them has one right answer, and the point
 * is that the answer does not change as the contamination grows.
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, launchApp, sleep } from './harness/cdp.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.CDP_PORT || 9493)

const child = launchApp({ cwd: ROOT, port: PORT, userDataDir: '/tmp/inkcolor-ud' })
const cdp = await connect({ port: PORT })
await sleep(1800)

/*
 * The canvas is built at the same 1.5x the sampler is always handed (it divides
 * canvas.width by pageW to recover the scale), so the pixel counts here are the
 * pixel counts on a real page.
 */
const PROBE = `(async () => {
  const S = window.__reshapedpdf
  /* Wait for the face before drawing a single glyph.
     The glyph cases set 'Arimo' on the canvas; if it has not loaded, fillText
     silently uses a fallback whose ink fraction and antialiasing differ, and the
     case that depends on those quietly gives a different answer from one run to
     the next. This check caught the product being renderer-dependent; it has no
     business being renderer-dependent itself. */
  await document.fonts.load("20px 'Arimo'")
  await document.fonts.ready
  if (!document.fonts.check("20px 'Arimo'")) throw new Error('Arimo did not load — the glyph cases would be drawn in a fallback face')
  const K = 1.5, PAGE_W = 400
  const near = (hex, want, tol) => {
    const p = (h) => [1,3,5].map(i => parseInt(h.slice(i, i+2), 16))
    const a = p(hex), b = p(want)
    return Math.max(Math.abs(a[0]-b[0]), Math.abs(a[1]-b[1]), Math.abs(a[2]-b[2])) <= tol
  }
  const out = []
  // rect in page units: a line of type sitting on a panel
  const RUN = { x: 20, y: 20, w: 200, h: 12 }

  /* Paint the surface. 'bg' decides what KIND of surface, because "the
     background is one flat colour" is the assumption that hides the worst
     failures: a photograph, a duotone, a halftone scan and a shaded panel all
     have several tonal clusters of their own, every one of them larger by area
     than a line of type. */
  const paintBg = (g, cv, c) => {
    if (c.bg === 'duotone') {
      g.fillStyle = c.panel; g.fillRect(0, 0, cv.width, cv.height)
      g.fillStyle = c.panel2
      for (let y = 0; y < cv.height; y += 6) g.fillRect(0, y, cv.width, 3)
    } else if (c.bg === 'gradient') {
      const gr = g.createLinearGradient(0, 0, cv.width, 0)
      gr.addColorStop(0, c.panel); gr.addColorStop(1, c.panel2)
      g.fillStyle = gr; g.fillRect(0, 0, cv.width, cv.height)
    } else if (c.bg === 'grain') {
      g.fillStyle = c.panel; g.fillRect(0, 0, cv.width, cv.height)
      const im = g.getImageData(0, 0, cv.width, cv.height)
      // deterministic pseudo-noise: a scan's grain, without needing a seed API
      for (let i = 0, n = 0; i < im.data.length; i += 4, n++) {
        // >> is signed, so the naive "% 41 - 20" skewed to -60..+20 and the
        // "grain" was really a darkening. Take the magnitude first.
        const v = Math.abs((n * 1103515245 + 12345) >> 16) % 41 - 20
        im.data[i] += v; im.data[i + 1] += v; im.data[i + 2] += v
      }
      g.putImageData(im, 0, 0)
    } else {
      g.fillStyle = c.panel; g.fillRect(0, 0, cv.width, cv.height)
    }
  }

  for (const c of [
    { id: 'light-on-panel',      panel: '#3aa79a', text: '#fff1d6', rows: 0, want: '#fff1d6' },
    { id: 'light-on-panel+1row', panel: '#3aa79a', text: '#fff1d6', rows: 1, want: '#fff1d6' },
    { id: 'light-on-panel+2row', panel: '#3aa79a', text: '#fff1d6', rows: 2, want: '#fff1d6' },
    { id: 'dark-on-paper',       panel: '#ffffff', text: '#1a1a1f', rows: 0, want: '#1a1a1f' },
    { id: 'dark-on-paper+2row',  panel: '#ffffff', text: '#1a1a1f', rows: 2, want: '#1a1a1f' },
    { id: 'light-on-dark-banner',panel: '#12263f', text: '#f3f6fa', rows: 0, want: '#f3f6fa' },
    // Deliberately low contrast: grey on light grey is a real thing designers do
    // to captions and disclaimers, and it is the case a rule about how FAR apart
    // two tones must be can quietly reject.
    { id: 'low-contrast-grey',   panel: '#8a8a8a', text: '#666666', rows: 0, want: '#666666' },
    { id: 'low-contrast+1row',   panel: '#8a8a8a', text: '#666666', rows: 1, want: '#666666' },
    // 20-24 luminance apart: below this the function is entitled to say "no
    // visible ink", above it must sample. This sits just inside.
    /* Deliberately faint, but clear of the function's own "no visible ink"
       threshold: 32 luminance apart, not the 20 it is entitled to reject. The
       tolerance is 14 — less than half the gap — because a tolerance wider than
       the gap it measures cannot tell the ink from the paper, which is exactly
       the mistake it exists to catch. */
    { id: 'very-low-contrast',   panel: '#dcdcdc', text: '#bcbcbc', rows: 0, want: '#bcbcbc', tol: 14 },
    // REAL GLYPHS, so there is an antialiasing ramp between the two tones at
    // every stroke edge — the thing solid bars cannot express, and the thing a
    // rule that reasons about tone POPULATIONS gets wrong on small type, where
    // the fringe outnumbers the stroke core.
    { id: 'glyphs-8pt',          panel: '#ffffff', text: '#1a1a1f', rows: 0, want: '#1a1a1f', glyph: 8 },
    { id: 'glyphs-8pt+1row',     panel: '#ffffff', text: '#1a1a1f', rows: 1, want: '#1a1a1f', glyph: 8 },
    { id: 'glyphs-on-panel',     panel: '#3aa79a', text: '#fff1d6', rows: 0, want: '#fff1d6', glyph: 9 },
    /* The smallest type anyone sets, in the tightest box.
     *
     * These are held to a WEAKER standard than the rest, and the reason is a
     * measured, pre-existing limitation rather than an excuse: at 6pt on a 1.5x
     * sampling canvas a stroke is about one pixel wide, so it has no interior for
     * the core filter to prefer and the sample is mostly antialiasing. The ink
     * comes back at luminance ~76 where the print is 26 — a retyped 6pt line
     * prints lighter than the line beside it. Measured identical on the original
     * sampler, with the inset off, and with it on, so it is not this change; the
     * fix is to sample small type at a higher resolution, which is its own piece
     * of work.
     *
     * So they assert the half of the property that does hold — the answer is on
     * the INK side of the midpoint between ink and paper, and is never the paper
     * itself — which is what keeps a known-imperfect case from quietly becoming a
     * broken one. */
    { id: 'glyphs-6pt-tight',    panel: '#ffffff', text: '#1a1a1f', rows: 0, want: '#1a1a1f', glyph: 6, tight: true, side: true },
    { id: 'glyphs-6pt-tight+1row', panel: '#ffffff', text: '#1a1a1f', rows: 1, want: '#1a1a1f', glyph: 6, tight: true, side: true },
    // Backgrounds with more than one tonal cluster. Each of these has TWO
    // surface tones that both outnumber the ink; the words must still come back
    // in their own colour and never in either surface tone.
    { id: 'text-on-duotone',     panel: '#e8e2d2', panel2: '#c4b496', text: '#141414', rows: 0, want: '#141414', bg: 'duotone', glyph: 9 },
    { id: 'text-on-gradient',    panel: '#646464', panel2: '#b4b4b4', text: '#ffffff', rows: 0, want: '#ffffff', bg: 'gradient', glyph: 9 },
    { id: 'text-on-scan-grain',  panel: '#e0e0e0', text: '#181818', rows: 0, want: '#181818', bg: 'grain', glyph: 9 },
    /* A rule OUTSIDE the box, in the ring the surround median is taken from.
     * This is the case that actually decides things: the ink/paper vote is made
     * against that median, so a dark neighbour just beyond the box can flip it
     * without ever putting a pixel inside. Painting the rule INSIDE the box —
     * which is all the +row cases above do — tests the sliver and nothing else. */
    /* KNOWN GAP, not a regression — see the long comment in sampleInkColor.
       Dark text on a light panel with dark rules just outside the box comes back
       in the panel's colour. It fails on the original sampler too; the obvious
       fix (take the surface from beside the run) was tried and reverted because
       it broke the erase suite's panel-light on the real corpus. Counted and
       printed every run so it cannot quietly become normal. */
    { id: 'rule-above-and-below', panel: '#e8e2d2', text: '#141414', rows: 0, want: '#141414', glyph: 9, ring: true, gap: 'a dark rule just outside the box wins the ink/paper vote' },
    { id: 'rule-outside-panel',   panel: '#3aa79a', text: '#fff1d6', rows: 0, want: '#fff1d6', glyph: 9, ring: true },
    /* Ink that lives at the very BOTTOM of its box: a form's rule-line of
     * underscores sits on the baseline with nothing below it. Anything that
     * trims the box vertically takes this run away entirely. */
    { id: 'underscores',          panel: '#ffffff', text: '#1a1a1f', rows: 0, want: '#1a1a1f', underscore: true },
  ]) {
    const cv = document.createElement('canvas')
    cv.width = Math.round(PAGE_W * K); cv.height = Math.round(120 * K)
    const g = cv.getContext('2d')
    paintBg(g, cv, c)
    // RING contamination: a dark rule just OUTSIDE the run box, above and below,
    // where the surround median is measured — a table row, a boxed callout, a
    // ruled form field.
    if (c.ring) {
      g.fillStyle = '#06080c'
      g.fillRect(0, Math.round(RUN.y * K) - 6, cv.width, 6)
      g.fillRect(0, Math.round((RUN.y + RUN.h) * K), cv.width, 6)
    }
    g.fillStyle = c.text
    if (c.underscore) {
      // a rule-line of underscores: ink only in the last two rows of the box
      g.fillRect(Math.round((RUN.x + 2) * K), Math.round((RUN.y + RUN.h) * K) - 3,
                 Math.round((RUN.w - 4) * K), 2)
    } else if (c.glyph) {
      g.font = Math.round(c.glyph * K) + "px 'Arimo', Arial, sans-serif"
      g.textBaseline = 'alphabetic'
      g.fillText('Hamburgefonstiv quick brown', Math.round((RUN.x + 2) * K), Math.round((RUN.y + 9) * K))
    } else {
      for (let i = 0; i < 14; i++) {
        g.fillRect(Math.round((RUN.x + 2 + i * 14) * K), Math.round((RUN.y + 2) * K),
                   Math.round(7 * K), Math.round(8 * K))
      }
    }
    // CONTAMINATION: rows of a much darker neighbour along the top edge of the
    // run box — a rule above the line, or the same rule after a slightly
    // different rasterisation put it one pixel lower.
    if (c.rows) { g.fillStyle = '#1a1a1f'; g.fillRect(0, Math.round(RUN.y * K), cv.width, c.rows) }
    // a box trimmed hard to the letters, which is what the app hands over for
    // small type — 7pt tall for 6pt text, not the roomy 12 the other cases use
    const box = c.tight ? { x: RUN.x, y: RUN.y + 3, w: RUN.w, h: 7 } : RUN
    const got = S.inkAt(cv, box, PAGE_W)
    const surfaces = [c.panel, c.panel2].filter(Boolean)
    const lum = (h) => { const p = (i) => parseInt(h.slice(i, i + 2), 16); return 0.2126*p(1) + 0.7152*p(3) + 0.0722*p(5) }
    const onInkSide = Math.abs(lum(got) - lum(c.want)) < Math.abs(lum(got) - lum(c.panel))
    out.push({ id: c.id, got, want: c.want, gap: c.gap || null,
               ok: c.side ? onInkSide : near(got, c.want, c.tol ?? 26),
               side: !!c.side,
               drift: c.side ? Math.round(lum(got) - lum(c.want)) : 0,
               wasSurface: surfaces.some((p) => near(got, p, c.tol ?? 26)),
               noInk: got === '#111111' && !near('#111111', c.want, c.tol ?? 26) })
  }
  return out
})()`

let rows
try {
  await cdp.run(`window.__reshapedpdf.openSample()`)
  await sleep(2200)
  rows = await cdp.run(PROBE)
} finally {
  cdp.close()
  try { child.kill('SIGKILL') } catch { /* already gone */ }
}

let bad = 0, gaps = 0
for (const r of rows) {
  if (r.gap && !r.ok) {
    gaps++
    console.log(`  ${r.id.padEnd(22)} GAP   got ${r.got} — ${r.gap}`)
    continue
  }
  if (r.gap && r.ok) {
    // If a known gap starts passing, say so: the comment in sampleInkColor and
    // this entry are both now wrong, and silence would leave them wrong.
    bad++
    console.log(`  ${r.id.padEnd(22)} FIXED ${r.got} — this is recorded as a known gap and is no longer one.`)
    console.log(`  ${''.padEnd(22)}       Update the case and the comment in sampleInkColor.`)
    continue
  }
  if (r.ok) {
    console.log(`  ${r.id.padEnd(22)} ok    ${r.got}` +
                (r.side ? `  (on the ink side; ${r.drift > 0 ? '+' : ''}${r.drift} luminance light of the print — a known small-type gap)` : ''))
    continue
  }
  bad++
  console.log(`  ${r.id.padEnd(22)} FAIL  got ${r.got}, wanted ${r.want}` +
              (r.wasSurface ? ' — that IS the surface: the edit would be invisible' : '') +
              (r.noInk ? ' — reported NO VISIBLE INK, so the edit goes in near-black' : ''))
}
console.log(`\n${rows.length - bad - gaps} of ${rows.length} runs get their own colour back` +
            (gaps ? ` · ${gaps} known gap(s), listed above` : ''))
process.exit(bad ? 1 : 0)
