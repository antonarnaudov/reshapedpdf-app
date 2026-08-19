#!/usr/bin/env node
/*
 * Undo / redo / dirty-flag regression suite.
 *
 * The history logic is subtle and was the source of a HIGH silent-data-loss bug
 * (an add landing dirty=false after a save, discarded on close) plus a string of
 * follow-on regressions the adversarial reviews kept catching — yet it had NO
 * test. Each case below drives the real store (window.__reshapedpdf.state()) in
 * the running app through a specific sequence and asserts the exact invariant
 * that broke. A fresh blank doc is opened per case so state never leaks between.
 *
 *   node tests/history-suite.mjs
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, launchApp, sleep } from './harness/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PORT = Number(process.env.CDP_PORT || 9371)

/** One-page blank A4 as base64, hand-built so the suite needs no fixture. */
function blankA4() {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << >> /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
  ]
  let pdf = '%PDF-1.4\n'
  const off = [0]
  for (let i = 0; i < objs.length; i++) { off.push(pdf.length); pdf += `${i + 1} 0 obj\n${objs[i]}\nendobj\n` }
  const xref = pdf.length
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (let i = 1; i <= objs.length; i++) pdf += `${String(off[i]).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1').toString('base64')
}

// Runs inside the app: `body` is a function body with `s` (getState), `doc`
// (active doc getter), and `addText` (drop a text object, returns its id) in
// scope; it returns { ok, detail }.
const CASE = (body) => `(() => {
  const S = window.__reshapedpdf
  const s = S.state
  const doc = () => s().docs[s().active]
  let n = 0
  const addText = () => {
    const id = 'h' + (++n)
    s().addObject({ id, page: doc().pages[0].id, kind: 'text', opacity: 1, x: 40, y: 40 + n * 24,
      w: 80, h: 20, text: 'x' + n, color: '#000000', size: 14, font: 'sans', bold: false }, { select: false })
    return id
  }
  ${body}
})()`

const CASES = [
  { id: 'clean-on-open', why: 'a freshly opened doc is not dirty and has no history',
    body: `const d = doc(); return { ok: d.dirty === false && d.undo.length === 0 && d.redo.length === 0,
      detail: 'dirty=' + d.dirty + ' undo=' + d.undo.length } ` },

  { id: 'add-undo-redo', why: 'add dirties; undo returns to clean; redo re-dirties',
    body: `addText();
      const afterAdd = doc().dirty;
      s().undo();
      const afterUndo = doc();
      s().redo();
      const afterRedo = doc();
      return { ok: afterAdd === true && afterUndo.dirty === false && afterUndo.objOrder.length === 0
                 && afterRedo.dirty === true && afterRedo.objOrder.length === 1,
        detail: 'add=' + afterAdd + ' undoDirty=' + afterUndo.dirty + ' undoObjs=' + afterUndo.objOrder.length
              + ' redoDirty=' + afterRedo.dirty } ` },

  { id: 'save-then-add-stays-dirty', why: 'THE data-loss bug: an add after save+checkpoint must dirty the doc',
    body: `const a = addText();
      s().markSaved(s().active);           // now Saved, undo-top === live
      s().commitNow();                     // a grip/slider press: pure checkpoint
      addText();                           // a real edit
      const d = doc();
      return { ok: d.dirty === true && d.objOrder.length === 2,
        detail: 'dirty=' + d.dirty + ' objs=' + d.objOrder.length + ' (must be dirty=true)' } ` },

  { id: 'phantom-checkpoint-not-dirty', why: 'a grip/slider press with no drag leaves the doc clean',
    body: `s().markSaved(s().active);
      s().commitNow();                     // pressed, never dragged
      const d = doc();
      return { ok: d.dirty === false, detail: 'dirty=' + d.dirty + ' (must stay false)' } ` },

  { id: 'checkpoint-after-undo-keeps-redo', why: 'a bare checkpoint after an undo must not wipe the redo stack',
    body: `addText();
      s().undo();                          // redo now holds the add
      const beforeRedo = doc().redo.length;
      s().commitNow();                     // grip press, no change
      const afterRedo = doc().redo.length;
      return { ok: beforeRedo > 0 && afterRedo === beforeRedo,
        detail: 'redoBefore=' + beforeRedo + ' redoAfter=' + afterRedo } ` },

  { id: 'discard-fresh-object', why: 'abandoning a never-typed box rewinds cleanly (no phantom entry, not dirty)',
    body: `const id = addText();
      s().discardFreshObject(id);
      const d = doc();
      return { ok: d.dirty === false && d.objOrder.length === 0 && d.undo.length === 0,
        detail: 'dirty=' + d.dirty + ' objs=' + d.objOrder.length + ' undo=' + d.undo.length } ` },

  { id: 'undo-to-original-clears-dirty', why: 'undoing every edit clears the Edited flag',
    body: `addText(); addText(); addText();
      s().undo(); s().undo(); s().undo();
      const d = doc();
      return { ok: d.dirty === false && d.objOrder.length === 0,
        detail: 'dirty=' + d.dirty + ' objs=' + d.objOrder.length } ` },

  { id: 'movepages-noop-not-dirty', why: 'a page drop onto its own position must not dirty the doc (withCommit always dirties)',
    body: `s().duplicatePage(doc().pages[0].id)           // 2 pages, dirty
      s().markSaved(s().active)                            // clean baseline
      const ids = [doc().pages[0].id]
      s().movePages(ids, 0)                                // drop page 0 at index 0 — no change
      const d1 = doc()
      s().movePages(ids, 1)                                // still the same order (nothing before it moves)
      const d2 = doc()
      // a REAL move DOES dirty (control): send page 0 to the end
      s().movePages([d2.pages[0].id], 2)
      const d3 = doc()
      return { ok: d1.dirty === false && d2.dirty === false && d3.dirty === true,
        detail: 'noopA=' + d1.dirty + ' noopB=' + d2.dirty + ' realMove=' + d3.dirty } ` },

  { id: 'meta-edit-survives-undo', why: 'Document Properties are unexported content: an undo must not re-derive "saved" while meta still holds a change',
    body: `s().setMeta({ ...doc().meta, title: 'Quarterly Report' })
      const afterMeta = doc().dirty
      addText()
      s().undo()                                   // rewinds the text, NOT the title
      const d = doc()
      return { ok: afterMeta === true && d.dirty === true && d.meta.title === 'Quarterly Report',
        detail: 'dirtyAfterSetMeta=' + afterMeta + ' dirtyAfterUndo=' + d.dirty + ' title="' + d.meta.title + '"' } ` },

  { id: 'markSaved-uses-exported-content', why: 'an edit that lands while the Save dialog is open is NOT in the file, so the doc must stay Edited',
    body: `const a = addText()
      const exportedFrom = doc()                   // what the export was built from
      s().updateObject(a, { opacity: 0.5 })        // lands while the dialog is open
      s().markSaved(s().active, exportedFrom)
      const stillDirty = doc().dirty
      // and the ordinary case still clears the flag
      s().markSaved(s().active, doc())
      return { ok: stillDirty === true && doc().dirty === false,
        detail: 'dirtyAfterMidExportEdit=' + stillDirty + ' dirtyWhenBaselineMatches=' + doc().dirty } ` },

  { id: 'discard-fresh-after-undo-keeps-redo', why: 'abandoning a never-typed box must leave no trace — including not eating a redo',
    body: `addText()
      s().undo()                                   // redo now holds that add
      const r0 = doc().redo.length
      const id = addText()                         // placeholder box: withCommit clears redo
      s().discardFreshObject(id)                   // ...abandoned, so give it back
      const d = doc()
      return { ok: r0 === 1 && d.redo.length === r0 && d.undo.length === 0 && d.dirty === false,
        detail: 'redoBefore=' + r0 + ' redoAfter=' + d.redo.length + ' undo=' + d.undo.length + ' dirty=' + d.dirty } ` },

  { id: 'keepRedo-preserves-redo', why: 'an async auto-match/blend touch-up must NOT wipe redo; a real edit still does',
    body: `const a = addText();
      addText();                                              // B
      s().undo();                                             // B -> redo
      const r0 = doc().redo.length;                           // 1
      s().updateObject(a, { opacity: 0.9 }, { keepRedo: true });  // cosmetic async touch-up
      const r1 = doc().redo.length;                           // must still be 1
      s().updateObject(a, { opacity: 0.8 });                  // a genuine user edit
      const r2 = doc().redo.length;                           // now 0
      return { ok: r0 === 1 && r1 === 1 && r2 === 0,
        detail: 'redoAfterUndo=' + r0 + ' afterKeepRedo=' + r1 + ' afterPlainEdit=' + r2 } ` },
]

async function main() {
  console.log('booting app…')
  const child = launchApp({ cwd: ROOT, port: PORT, userDataDir: join(HERE, '.artifacts', 'history-profile') })
  const cdp = await connect({ port: PORT })
  await sleep(1500)
  const results = []
  try {
    for (const c of CASES) {
      await cdp.run(`window.__reshapedpdf.openBase64(${JSON.stringify(blankA4())}, 'blank.pdf')`)
      await sleep(600)
      let r
      try { r = await cdp.run(CASE(c.body)) } catch (e) { r = { ok: false, detail: 'ERR ' + String(e.message || e).slice(0, 80) } }
      const ok = !!(r && r.ok)
      results.push({ ...c, ok, detail: r ? r.detail : 'no result' })
      console.log(`  ${c.id.padEnd(34)} ${ok ? 'PASS' : 'FAIL'}  ${r ? r.detail : ''}`)
    }
  } finally {
    cdp.close()
    try { child.kill('SIGKILL') } catch { /* gone */ }
  }
  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} history invariants hold`)
  process.exit(bad.length ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(2) })
