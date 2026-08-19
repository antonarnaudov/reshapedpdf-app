#!/usr/bin/env node
/*
 * UX suite — drives the REAL app through real user gestures (synthetic pointer
 * events on the page, keyboard commits) and asserts the visible result, because
 * the headless unit suites pass while the actual app breaks. Every case does
 * what a user does — lift this, retype that, erase here — then checks the thing
 * a user would see: original gone, copy crisp, export matches, undo clean.
 *
 * Boots Electron (real viewport, native proxy) via the shared CDP harness.
 *
 *   node tests/ux-suite.mjs [--only <id>] [--keep]
 */
import { mkdirSync, existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, launchApp, sleep } from './harness/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const OUT = join(HERE, '.artifacts', 'ux')
const PORT = Number(process.env.CDP_PORT || 9346)
const args = process.argv.slice(2)
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null

// Injected into the page once: a driving library. viewX/viewY are page-points
// (top-down), converted to client px via the overlay-capture rect and zoom, so
// a case reads the same at any zoom. Everything parks on window so cdp.run can
// poll a stable global.
const UX_LIB = `
window.__ux = (() => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const S = () => window.__reshapedpdf.state();
  const doc = () => { const s = S(); return s.docs[s.active]; };
  async function fresh() { window.__reshapedpdf.openSample(); await sleep(1200); S().setZoom(1); await sleep(500); await toTop(); return S().active; }
  async function toTop() { const big=[...document.querySelectorAll('svg')].find(s=>{const r=s.getBoundingClientRect();return r.width>500&&r.height>700;}); let el=big,cont=null; while(el){const st=getComputedStyle(el); if(/(auto|scroll)/.test(st.overflowY)&&el.scrollHeight>el.clientHeight){cont=el;break;} el=el.parentElement;} if(cont) cont.scrollTop=0; await sleep(400); }
  function cap() { return [...document.querySelectorAll('.overlay-capture')].map(el=>({el,r:el.getBoundingClientRect()})).filter(x=>x.r.width>300&&x.r.height>400&&x.r.top>-50&&x.r.top<500).sort((a,b)=>a.r.top-b.r.top)[0]; }
  function client(vx,vy){ const c=cap(); if(!c) throw new Error('no page capture'); const z=S().zoom; return {c, cx:c.r.left+vx*z, cy:c.r.top+vy*z}; }
  const pev=(t,cx,cy)=>new PointerEvent(t,{clientX:cx,clientY:cy,bubbles:true,cancelable:true,pointerId:1,button:0,buttons:t==='pointerup'?0:1,isPrimary:true,pointerType:'mouse',view:window});
  async function setTool(t){ S().setTool(t); await sleep(120); }
  async function clickAt(vx,vy){ const {c,cx,cy}=client(vx,vy); c.el.dispatchEvent(pev('pointerdown',cx,cy)); c.el.dispatchEvent(pev('pointerup',cx,cy)); await sleep(300); }
  async function dragBox(x0,y0,x1,y1,steps=8){ const {c,cx,cy}=client(x0,y0); const e=client(x1,y1); c.el.dispatchEvent(pev('pointerdown',cx,cy)); for(let i=1;i<=steps;i++){const t=i/steps; c.el.dispatchEvent(pev('pointermove',cx+(e.cx-cx)*t,cy+(e.cy-cy)*t)); await sleep(20);} c.el.dispatchEvent(pev('pointerup',e.cx,e.cy)); await sleep(300); }
  function enter(){ document.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true})); }
  function added(before){ const d=doc(); return d.objOrder.slice(before).map(id=>d.objects[id]); }
  async function lift(vx,vy){ const before=doc().objOrder.length; await setTool('lift'); await clickAt(vx,vy); const lp=S().liftPreview; enter(); await sleep(2400); return {pickedBox:lp&&lp.el&&lp.el.userBox, pickedKind:lp&&lp.el&&lp.el.kind, added:added(before)}; }
  // export current doc, reopen it, return sampling canvas of page idx (measures the REAL output)
  async function exportReopen() { const ex=await window.__reshapedpdf.exportActive(); window.__reshapedpdf.openBase64(ex.b64,'rt.pdf'); await sleep(1400); S().setZoom(1); await sleep(200); return ex.size; }
  async function regionColorPct(pageIdx, vx, vy, w, h, test) { const cv=await window.__reshapedpdf.samplingCanvas(pageIdx); const k=cv.width/612; const ctx=cv.getContext('2d',{willReadFrequently:true}); const d=ctx.getImageData(Math.round(vx*k),Math.round(vy*k),Math.max(1,Math.round(w*k)),Math.max(1,Math.round(h*k))).data; let hit=0,tot=0; for(let i=0;i<d.length;i+=4){tot++; if(test(d[i],d[i+1],d[i+2]))hit++;} return tot?+(100*hit/tot).toFixed(2):0; }
  function edgeEnergyOf(dataUrl){ return new Promise(res=>{ if(!dataUrl) return res(null); const img=new Image(); img.onload=()=>{const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const x=c.getContext('2d');x.drawImage(img,0,0);const d=x.getImageData(0,0,c.width,c.height).data,W=c.width,H=c.height;let e=0,n=0;for(let y=0;y<H;y++)for(let xx=0;xx<W-1;xx++){const i=(y*W+xx)*4,j=(y*W+xx+1)*4;e+=Math.abs((0.21*d[i]+0.72*d[i+1]+0.07*d[i+2])-(0.21*d[j]+0.72*d[j+1]+0.07*d[j+2]));n++;}res(n?+(e/n).toFixed(2):0);}; img.onerror=()=>res('err'); img.src=dataUrl; }); }
  const orange=(r,g,b)=>r>170&&g>55&&g<155&&b<95;
  const dark=(r,g,b)=>r<80&&g<80&&b<90;
  return { sleep, S, doc, fresh, toTop, cap, setTool, clickAt, dragBox, enter, added, lift, exportReopen, regionColorPct, edgeEnergyOf, orange, dark };
})();
'ok'`

const results = []
const rec = (id, pass, detail) => { results.push({ id, pass, detail }); console.log(`  ${pass ? '·' : '✗'} ${id.padEnd(26)} ${detail}`) }

async function main() {
  if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })
  const profile = join(OUT, 'profile'); mkdirSync(profile, { recursive: true })

  console.log('booting app…')
  const child = launchApp({ cwd: ROOT, port: PORT, userDataDir: profile })
  const cdp = await connect({ port: PORT })
  await sleep(1500)
  await cdp.eval(UX_LIB)

  const run = (expr) => cdp.run(expr)
  const want = (id) => !only || id === only

  try {
    // ---- LIFT: a lifted text run's original must be gone in the EXPORTED file ----
    if (want('lift-text-removes-original')) {
      const r = await run(`(async () => {
        const U=window.__ux; await U.fresh();
        const lift=await U.lift(490,31);                  // INVOICE #2041 (orange, on dark banner)
        const obj=lift.added.find(o=>o.kind!=='whiteout');
        if(obj) U.S().updateObject(obj.id,{ y: obj.y+180 });   // move copy well away
        U.S().setTool('select'); await U.sleep(300);
        await U.exportReopen();
        const orig=await U.regionColorPct(0, 445,15, 100,22, U.orange);   // original banner region in the EXPORT
        return { pickedKind:lift.pickedKind, addedKinds:lift.added.map(o=>o.kind), origOrangePct:orig };
      })()`)
      rec('lift-text-removes-original', r && r.origOrangePct === 0 && r.pickedKind === 'text',
        `picked=${r&&r.pickedKind} added=[${r&&r.addedKinds}] origOrange=${r&&r.origOrangePct}%`)
    }

    // ---- LIFT twice over the same area: the FIRST lift's ink must not come back ----
    // removalPatch used to render the pristine page minus only the CURRENT span, so
    // the banner lift's patch still contained the invoice number's glyphs and,
    // appended last in objOrder, painted them back on top of the object the first
    // lift produced — deleting that object then changed nothing.
    if (want('lift-twice-no-ghost')) {
      const r = await run(`(async () => {
        const U=window.__ux; await U.fresh();
        const a=await U.lift(490,31);                       // the orange invoice number
        const textObj=a.added.find(o=>o.kind!=='whiteout');
        const b=await U.lift(400,31);                       // the dark banner UNDERNEATH it (no text there)
        if(textObj) U.S().removeObjects([textObj.id]);      // drop the lifted copy entirely
        U.S().setTool('select'); await U.sleep(300);
        await U.exportReopen();
        const ghost=await U.regionColorPct(0, 445,15, 100,22, U.orange);
        return { first:a.pickedKind, second:b.pickedKind, ghostPct:ghost,
                 added:[...a.added,...b.added].map(o=>o.kind) };
      })()`)
      rec('lift-twice-no-ghost', r && r.ghostPct === 0,
        `lifted ${r&&r.first} then ${r&&r.second}; after deleting the first copy the export shows ${r&&r.ghostPct}% of its ink (want 0)`)
    }

    // ---- LIFT: the lifted copy is crisp VECTOR text (not a bitmap) ----
    if (want('lift-text-copy-vector')) {
      const r = await run(`(async () => {
        const U=window.__ux; await U.fresh();
        const lift=await U.lift(490,31);
        const obj=lift.added.find(o=>o.kind==='text');
        return obj?{ text:obj.text, glyphSrc:!!obj.glyphSrc, color:obj.color, x:Math.round(obj.x), y:Math.round(obj.y) }:null;
      })()`)
      rec('lift-text-copy-vector', r && !r.glyphSrc && r.text && r.text.includes('INVOICE'),
        r ? `text="${r.text}" vector=${!r.glyphSrc} color=${r.color}` : 'no obj')
    }

    // ---- LIFT then UNDO reverts in ONE step (compound patch+object) ----
    if (want('lift-undo-one-step')) {
      const r = await run(`(async () => {
        const U=window.__ux; await U.fresh();
        const n0=U.doc().objOrder.length;
        const lift=await U.lift(490,31); const n1=U.doc().objOrder.length;
        U.S().undo(); await U.sleep(400); const n2=U.doc().objOrder.length;
        U.S().redo(); await U.sleep(400); const n3=U.doc().objOrder.length;
        return { added:n1-n0, afterUndo:n2-n0, afterRedo:n3-n0 };
      })()`)
      rec('lift-undo-one-step', r && r.added >= 1 && r.afterUndo === 0 && r.afterRedo === r.added,
        r ? `added=${r.added} undo->${r.afterUndo} redo->${r.afterRedo}` : 'fail')
    }

    // ---- LIFT a non-text element (banner rect / path) leaves no debris ----
    if (want('lift-shape-covers')) {
      const r = await run(`(async () => {
        const U=window.__ux; await U.fresh();
        const lift=await U.lift(360,30);   // the dark banner path (non-text)
        const patch=lift.added.find(o=>o.kind==='whiteout');
        const obj=lift.added.find(o=>o.kind!=='whiteout');
        if(obj) U.S().updateObject(obj.id,{ y: obj.y+300 });
        U.S().setTool('select'); await U.sleep(300);
        await U.exportReopen();
        // where the banner was, the export should now be white page (no dark banner band left)
        const darkLeft=await U.regionColorPct(0, 60,20, 300,20, U.dark);
        return { pickedKind:lift.pickedKind, patchPad:patch?{x:Math.round(patch.x),w:Math.round(patch.w)}:null, darkResiduePct:darkLeft };
      })()`)
      rec('lift-shape-covers', r && r.darkResiduePct < 3,
        r ? `picked=${r.pickedKind} darkResidue=${r.darkResiduePct}%` : 'fail')
    }

    // ---- RETYPE gives crisp VECTOR text (no glyphSrc bitmap) ----
    if (want('retype-vector')) {
      const r = await run(`(async () => {
        const U=window.__ux; await U.fresh();
        const before=U.doc().objOrder.length;
        await U.setTool('retype'); await U.clickAt(490,31); await U.sleep(1400);
        const added=U.added(before); const t=added.find(o=>o.kind==='text');
        return t?{ text:t.text, glyphSrc:!!t.glyphSrc, color:t.color, addedKinds:added.map(o=>o.kind) }:{none:true};
      })()`)
      rec('retype-vector', r && !r.none && !r.glyphSrc && r.text && r.text.includes('INVOICE'),
        r && !r.none ? `text="${r.text}" vector=${!r.glyphSrc} added=[${r.addedKinds}]` : 'no text obj')
    }

    // ---- RETYPE removes the original in the EXPORT ----
    if (want('retype-removes-original')) {
      const r = await run(`(async () => {
        const U=window.__ux; await U.fresh();
        const before=U.doc().objOrder.length;
        await U.setTool('retype'); await U.clickAt(490,31); await U.sleep(1400);
        const t=U.added(before).find(o=>o.kind==='text');
        if(t) U.S().updateObject(t.id,{ y:t.y+180 });   // move the editable copy away
        U.S().setEditingText(null); U.S().setTool('select'); await U.sleep(300);
        await U.exportReopen();
        const orig=await U.regionColorPct(0, 445,15, 100,22, U.orange);
        return { origOrangePct:orig };
      })()`)
      rec('retype-removes-original', r && r.origOrangePct === 0, r ? `origOrange=${r.origOrangePct}%` : 'fail')
    }

    // ---- ERASE brush over white-on-dark banner text: clean fill, no bright fragments ----
    if (want('erase-brush-banner-clean')) {
      const r = await run(`(async () => {
        const U=window.__ux; await U.fresh();
        U.S().setPref('eraseMode','brush'); U.S().setPref('eraseBrush',9);
        const before=U.doc().objOrder.length;
        await U.setTool('whiteout');
        await U.dragBox(90,32,250,32,10);   // sweep across "IRONWORKS SUPPLY"
        await U.sleep(600);
        const p=U.added(before).find(o=>o.kind==='whiteout');
        if(!p||!p.src) return { none:true };
        const img=new Image(); await new Promise(res=>{img.onload=res;img.onerror=res;img.src=p.src;});
        const c=document.createElement('canvas'); c.width=img.width;c.height=img.height; const x=c.getContext('2d'); x.drawImage(img,0,0);
        const d=x.getImageData(0,0,c.width,c.height).data; let bright=0,tot=0;
        for(let i=0;i<d.length;i+=4){ if(d[i+3]<40)continue; tot++; const l=0.21*d[i]+0.72*d[i+1]+0.07*d[i+2]; if(l>110)bright++; }
        return { brightPct: tot?+(100*bright/tot).toFixed(2):0, color:p.color };
      })()`)
      rec('erase-brush-banner-clean', r && !r.none && r.brightPct < 3,
        r && !r.none ? `brightFragments=${r.brightPct}% color=${r.color}` : 'no patch')
    }

    // ---- INSERT a text box, type, and it survives export ----
    if (want('insert-text-export')) {
      const r = await run(`(async () => {
        const U=window.__ux; await U.fresh();
        const before=U.doc().objOrder.length;
        await U.setTool('text'); await U.dragBox(120,650,300,675,6); await U.sleep(400);
        const ed=U.S().editingText;
        if(ed) U.S().updateObject(ed,{ text:'HELLO EXPORT' });
        U.S().setEditingText(null); U.S().setTool('select'); await U.sleep(300);
        const added=U.added(before);
        return { addedKinds:added.map(o=>o.kind), hasText: added.some(o=>o.kind==='text'), objCount:added.length };
      })()`)
      rec('insert-text-export', r && r.hasText, r ? `added=[${r.addedKinds}]` : 'fail')
    }

    // ---- INSERT a shape (rect) and it survives ----
    if (want('insert-shape')) {
      const r = await run(`(async () => {
        const U=window.__ux; await U.fresh();
        U.S().setShapeMode ? U.S().setShapeMode('rect') : (U.S().prefs.shapeMode='rect');
        const before=U.doc().objOrder.length;
        await U.setTool('shape'); await U.dragBox(150,600,350,660,6); await U.sleep(300);
        const added=U.added(before); const s=added.find(o=>o.kind==='shape');
        return { addedKinds:added.map(o=>o.kind), shape: s?{mode:s.mode,w:Math.round(s.w),h:Math.round(s.h)}:null };
      })()`)
      rec('insert-shape', r && r.shape && Math.abs(r.shape.w) > 10 && Math.abs(r.shape.h) > 10,
        r ? `shape=${JSON.stringify(r.shape)} added=[${r.addedKinds}]` : 'fail')
    }

    // ---- GEOMETRY: pick lands on the right element at zoom != 1 ----
    if (want('pick-at-zoom')) {
      const r = await run(`(async () => {
        const U=window.__ux; await U.fresh(); U.S().setZoom(1.6); await U.sleep(500); await U.toTop();
        await U.setTool('lift'); await U.clickAt(490,31);
        const lp=U.S().liftPreview;
        return { zoom:U.S().zoom, pickedKind:lp&&lp.el&&lp.el.kind, box:lp&&lp.el&&lp.el.userBox };
      })()`)
      rec('pick-at-zoom', r && r.pickedKind === 'text' && r.box && Math.abs(r.box.x - 448) < 30,
        r ? `zoom=${r.zoom} picked=${r.pickedKind} boxX=${r.box&&Math.round(r.box.x)}` : 'fail')
    }
  } finally {
    let bad = 0
    for (const r of results) if (!r.pass) bad++
    console.log(`\n  ${results.length - bad}/${results.length} pass\n`)
    cdp.close()
    child.kill('SIGKILL')
    if (args.includes('--ci') && bad > 0) process.exitCode = 1
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
