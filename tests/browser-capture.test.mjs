import test from 'node:test';
import assert from 'node:assert/strict';
import { captureHiddenPage } from '../desktop/browser-capture.mjs';

const image = { isEmpty: () => false, getSize: () => ({ width: 1280, height: 900 }) };
const fake = fn => { let calls = 0; return { isDestroyed: () => false, capturePage: (...args) => { calls++; return fn(calls, args); }, get calls() { return calls; } }; };

test('hidden capture retries a transient Viz failure without changing hidden capture options', async () => {
  const contents = fake((call, args) => { assert.deepEqual(args, [undefined, { stayHidden: true }]); if (call === 1) throw new Error('UnknownVizError'); return image; });
  const result = await captureHiddenPage(contents, { retryDelays: [0, 0] }); assert.equal(result.image, image); assert.equal(result.retries, 1); assert.equal(contents.calls, 2);
});
test('empty frames and readiness errors have a finite three-attempt budget', async () => {
  const contents = fake(call => { if (call === 1) return { isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) }; if (call === 2) throw new Error('Current display surface not available for capture'); return image; });
  assert.equal((await captureHiddenPage(contents, { retryDelays: [0, 0] })).retries, 2);
  const broken = fake(() => { throw new Error('UnknownVizError'); }); await assert.rejects(captureHiddenPage(broken, { retryDelays: [0, 0] }), { code: 'BROWSER_CAPTURE_UNAVAILABLE' }); assert.equal(broken.calls, 3);
});
test('unrelated failures and stale-page validation are never retried', async () => {
  const original = new Error('Renderer process crashed.'), contents = fake(() => { throw original; }); await assert.rejects(captureHiddenPage(contents), error => error === original); assert.equal(contents.calls, 1);
  let navigated = false; const changed = fake(() => { navigated = true; throw new Error('UnknownVizError'); }); await assert.rejects(captureHiddenPage(changed, { assertCurrent: () => { if (navigated) throw new Error('Take a fresh snapshot.'); } }), /fresh snapshot/); assert.equal(changed.calls, 1);
});
test('cancellation during capture or retry wait stops promptly without another attempt', async () => {
  const controller = new AbortController(), pending = fake(() => new Promise(() => {})), captured = captureHiddenPage(pending, { signal: controller.signal }); controller.abort(); await assert.rejects(captured, { name: 'AbortError', code: 'ABORT_ERR' }); assert.equal(pending.calls, 1);
  const waiting = new AbortController(), transient = fake(() => { setTimeout(() => waiting.abort(), 5); throw new Error('UnknownVizError'); }); await assert.rejects(captureHiddenPage(transient, { signal: waiting.signal }), { name: 'AbortError' }); assert.equal(transient.calls, 1);
});
test('a closed page cannot capture and a hung renderer respects the overall deadline', async () => {
  const contents = fake(() => image); contents.isDestroyed = () => true; await assert.rejects(captureHiddenPage(contents), { code: 'BROWSER_CLOSED' }); assert.equal(contents.calls, 0);
  const hung = fake(() => new Promise(() => {})), start = Date.now(); await assert.rejects(captureHiddenPage(hung, { timeoutMs: 25 }), { code: 'BROWSER_CAPTURE_TIMEOUT' }); assert.equal(hung.calls, 1); assert.ok(Date.now() - start < 1000);
});


test('native capture crosses an isolated rendering boundary before every frame copy', async()=>{
 const order=[],contents=fake((call)=>{order.push('copy'+call);if(call===1)throw Error('UnknownVizError');return image});
 contents.executeJavaScriptInIsolatedWorld=async(world,scripts)=>{order.push('frame');assert.equal(world,1001);assert.match(scripts[0].code,/requestAnimationFrame\(\(\)=>requestAnimationFrame/);return true};
 const result=await captureHiddenPage(contents,{retryDelays:[0,0]});
 assert.equal(result.retries,1);assert.deepEqual(order,['frame','copy1','frame','copy2']);
});
test('native render synchronization respects identity, cancellation, and the overall deadline',async()=>{
 const changed=fake(()=>image);let retired=false;
 changed.executeJavaScriptInIsolatedWorld=async()=>{retired=true;return true};
 await assert.rejects(captureHiddenPage(changed,{assertCurrent:()=>{if(retired)throw Error('Changed native document')}}),/Changed native document/);assert.equal(changed.calls,0);
 const hung=fake(()=>image);hung.executeJavaScriptInIsolatedWorld=()=>new Promise(()=>{});
 await assert.rejects(captureHiddenPage(hung,{timeoutMs:25}),{code:'BROWSER_CAPTURE_TIMEOUT'});assert.equal(hung.calls,0);
 const cancelled=fake(()=>image),controller=new AbortController();
 cancelled.executeJavaScriptInIsolatedWorld=()=>new Promise(()=>{});
 const pending=captureHiddenPage(cancelled,{signal:controller.signal});controller.abort();
 await assert.rejects(pending,{name:'AbortError'});assert.equal(cancelled.calls,0);
 const invalid=fake(()=>image);invalid.executeJavaScriptInIsolatedWorld=async()=>false;
 await assert.rejects(captureHiddenPage(invalid),{code:'BROWSER_CAPTURE_RENDER_UNAVAILABLE'});assert.equal(invalid.calls,0);
});

test('parked native views refuse an old bitmap if Chromium does not advance a render frame',async()=>{
 let frames=0;const contents=fake(()=>image);
 contents.isOffscreen=()=>false;
 contents.executeJavaScriptInIsolatedWorld=()=>{frames++;return new Promise(()=>{});};
 const started=Date.now();
 await assert.rejects(captureHiddenPage(contents,{timeoutMs:80,retryDelays:[0,0]}),error=>
   error.code==='BROWSER_CAPTURE_TIMEOUT'&&error.captureStage==='render-boundary');
 assert.equal(contents.calls,0);assert.equal(frames,1);
 assert.ok(Date.now()-started<1000);
});

test('parked native views require fresh compositor boundaries on every capture retry',async()=>{
 const order=[],contents=fake(call=>{order.push('copy'+call);if(call===1)throw Error('UnknownVizError');return image;});
 contents.isOffscreen=()=>false;
 contents.executeJavaScriptInIsolatedWorld=async()=>{order.push('frame');return true;};
 const result=await captureHiddenPage(contents,{timeoutMs:800,retryDelays:[0,0]});
 assert.equal(result.image,image);assert.equal(result.retries,1);
 assert.deepEqual(order,['frame','copy1','frame','copy2']);
});

test('true offscreen rendering retains its frame freshness boundary',async()=>{
 const order=[],contents=fake(()=>{order.push("bitmap");return image;});
 contents.isOffscreen=()=>true;
 contents.executeJavaScriptInIsolatedWorld=async()=>{order.push("render-boundary");return true;};
 await captureHiddenPage(contents,{timeoutMs:1000});
 assert.deepEqual(order,["render-boundary","bitmap"]);
});

test('parked capture requests compositor frames before waiting for a fresh boundary',async()=>{
 const order=[];let demanded=false;
 const contents=fake(()=>{order.push('copy');assert.equal(demanded,true);return image;});
 contents.isOffscreen=()=>false;
 contents.beginFrameSubscription=callback=>{assert.equal(typeof callback,'function');order.push('begin');demanded=true;};
 contents.endFrameSubscription=()=>{order.push('end');demanded=false;};
 contents.executeJavaScriptInIsolatedWorld=()=>{order.push('frame');return demanded?Promise.resolve(true):new Promise(()=>{});};
 assert.equal((await captureHiddenPage(contents,{timeoutMs:100})).image,image);
 assert.deepEqual(order,['begin','frame','copy','end']);assert.equal(demanded,false);
});

test('overlapping captures share compositor demand and one cancellation cannot end the remaining capture',async()=>{
 let begins=0,ends=0;const boundaries=[];
 const contents=fake(()=>image);
 contents.isOffscreen=()=>false;
 contents.beginFrameSubscription=()=>{begins++;};
 contents.endFrameSubscription=()=>{ends++;};
 contents.executeJavaScriptInIsolatedWorld=()=>new Promise(resolve=>boundaries.push(resolve));
 const controller=new AbortController();
 const first=captureHiddenPage(contents,{signal:controller.signal,timeoutMs:500});
 const second=captureHiddenPage(contents,{timeoutMs:500});
 assert.equal(begins,1);assert.equal(boundaries.length,2);
 controller.abort();await assert.rejects(first,{name:'AbortError'});
 assert.equal(ends,0);
 boundaries[0](true);boundaries[1](true);
 assert.equal((await second).image,image);
 assert.equal(contents.calls,1);assert.equal(ends,1);
});

test('render timeout releases compositor demand while preserving its failure stage',async()=>{
 let ends=0;const contents=fake(()=>image);
 contents.isOffscreen=()=>false;contents.beginFrameSubscription=()=>{};
 contents.endFrameSubscription=()=>{ends++;};
 contents.executeJavaScriptInIsolatedWorld=()=>new Promise(()=>{});
 await assert.rejects(captureHiddenPage(contents,{timeoutMs:30}),error=>error.code==='BROWSER_CAPTURE_TIMEOUT'&&error.captureStage==='render-boundary');
 assert.equal(ends,1);assert.equal(contents.calls,0);
});

test('bitmap timeout releases compositor demand while preserving its failure stage',async()=>{
 let ends=0;const contents=fake(()=>new Promise(()=>{}));
 contents.isOffscreen=()=>false;contents.beginFrameSubscription=()=>{};
 contents.endFrameSubscription=()=>{ends++;};
 contents.executeJavaScriptInIsolatedWorld=async()=>true;
 await assert.rejects(captureHiddenPage(contents,{timeoutMs:30}),error=>error.code==='BROWSER_CAPTURE_TIMEOUT'&&error.captureStage==='bitmap-copy');
 assert.equal(ends,1);assert.equal(contents.calls,1);
});

test('document replacement releases compositor demand before any bitmap copy',async()=>{
 let ends=0,changed=false;const contents=fake(()=>image);
 contents.isOffscreen=()=>false;contents.beginFrameSubscription=()=>{};
 contents.endFrameSubscription=()=>{ends++;};
 contents.executeJavaScriptInIsolatedWorld=async()=>{changed=true;return true;};
 await assert.rejects(captureHiddenPage(contents,{assertCurrent:()=>{if(changed)throw Error('document replaced');}}),/document replaced/);
 assert.equal(ends,1);assert.equal(contents.calls,0);
});

test('offscreen painting does not acquire a native presentation subscription',async()=>{
 const contents=fake(()=>image);contents.isOffscreen=()=>true;
 contents.beginFrameSubscription=()=>{throw Error('Offscreen capture must use its existing paint surface');};
 contents.endFrameSubscription=()=>{throw Error('No native subscription was acquired');};
 contents.executeJavaScriptInIsolatedWorld=async()=>true;
 assert.equal((await captureHiddenPage(contents)).image,image);
});
