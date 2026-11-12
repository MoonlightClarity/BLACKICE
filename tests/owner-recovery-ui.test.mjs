import test from 'node:test';
test('real Settings navigation mounts recovery and native review sends only exact identity once',async t=>{
  const {planningDOM}=await import('./fixture-planning-dom.mjs');
  const {createSettingsWorkspace}=await import('../public/next/workspaces/settings.mjs');
  const f=planningDOM(t),calls=[],nativeCalls=[];let saved=row(),resolveReview;
  const previous=globalThis.relayDesktop;
  globalThis.relayDesktop={reviewRetainedEffect:ref=>{nativeCalls.push(ref);return new Promise(resolve=>{resolveReview=resolve;});},cancelRetainedEffect:async ref=>{nativeCalls.push(ref);saved={...saved,state:'cancelled'};return saved;}};
  t.after(()=>{globalThis.relayDesktop=previous;});
  const info={models:[],execution:{activeCount:0}},runtime={providerIdleTimeoutMs:300000};
  const api=async(route,method='GET')=>{
    calls.push({route,method});
    if(route==='/api/status')return info;
    if(route==='/api/runtime/settings')return runtime;
    if(route==='/api/execution/settings')return {maxConcurrentRuns:null};
    if(route==='/api/owner-recovery')return view(saved);
    throw Error('Unexpected '+route);
  };
  const ui=createSettingsWorkspace({mount:f.mount,api,getStatus:()=>info,events:{subscribe:()=>()=>{}}});
  t.after(()=>ui.destroy());ui.enter();
  const until=async fn=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setImmediate(r));}throw Error('UI did not settle');};
  await f.click('#next-settings-section-recovery');
  await until(()=>f.$('[data-owner-recovery="review"]'));
  assert.equal(f.$('#next-settings-recovery').hidden,false);
  const first=f.click('[data-owner-recovery="review"]');
  await until(()=>nativeCalls.length===1);
  await f.click('[data-owner-recovery="review"]');
  assert.deepEqual(nativeCalls,[{requestId:'review-1',revision:1}]);
  saved={...saved,state:'approved'};resolveReview(saved);await first;
  await until(()=>!f.$('[data-owner-recovery="review"]'));
  assert.match(f.mount.textContent,/approval is not proof of success/i);
  await f.click('#next-settings-section-general');
  assert.equal(f.$('#next-settings-recovery').hidden,true);
  assert.equal(calls.every(x=>x.method==='GET'),true,'The UI never approves via HTTP.');
});

test('view presents complete action payload and read errors disable old controls',()=>{
  const r=row();r.candidate.payload={description:'The exact proposed payload'};
  const html=renderOwnerRecovery(view(r),{nativeAvailable:true,error:'Read failed'});
  assert.match(html,/The exact proposed payload/);
  assert.match(html,/data-owner-recovery="review"[^>]*disabled/);
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createOwnerRecoveryHandlers, ownerRecoveryDialog } from '../desktop/owner-recovery.mjs';
import { ownerRecoveryView, renderOwnerRecovery, mountOwnerRecovery } from '../public/owner-recovery-ui.mjs';

const row = () => ({requestId:'review-1',revision:1,state:'pending',oneUse:true,taskId:'task',runId:'run',nodeId:'worker',
  expiresAt:new Date(Date.now()+60000).toISOString(),risk:'Possible duplicate effect.',
  candidate:{tool:'browser',action:'click',target:'https://example.test/job',summary:'Submit one application',preconditions:{button:'Submit',value:'exact'}},
  claims:[{operationId:'old-op',taskId:'old-task',effectState:'UNKNOWN',rowDigest:'digest',journalDigest:'journal'}]});
function setup({trusted=true,response=1,dialog}={}){
  let current=row();const calls=[];
  const control={read:async()=>structuredClone(current),approve:async x=>{calls.push(['approve',x]);return {...current,state:'approved'};},cancel:async x=>{calls.push(['cancel',x]);return {...current,state:'cancelled'};}};
  const h=createOwnerRecoveryHandlers({trustedSender:()=>trusted,control,showMessageBox:dialog||(async()=>({response}))});
  return {h,calls,set:x=>{current=x;},control};
}
test('native review displays exact host data, cancels by default, retains uncertainty',()=>{
  const options=ownerRecoveryDialog(row());
  assert.equal(options.defaultId,0);assert.equal(options.cancelId,0);
  assert.match(options.detail,/old-op/);assert.match(options.detail,/exact/);assert.match(options.detail,/UNKNOWN/);
  for(const value of [null,{...row(),oneUse:false},{...row(),claims:[]},{...row(),risk:'x'.repeat(4001)}])
    assert.throws(()=>ownerRecoveryDialog(value));
});
test('native approve uses only identity and revision after rereading',async()=>{
  const f=setup();const result=await f.h.review({}, {requestId:'review-1',revision:1});
  assert.equal(result.state,'approved');
  assert.deepEqual(f.calls,[['approve',{requestId:'review-1',revision:1,actor:'native-owner-confirmation'}]]);
});
test('native dialog cancellation does not approve',async()=>{
  const f=setup({response:0});assert.equal((await f.h.review({}, {requestId:'review-1',revision:1})).state,'cancelled');
  assert.equal(f.calls[0][0],'cancel');
});
test('native boundary rejects wrong sender, extra arguments, payload and stale identity',async()=>{
  const bad=setup({trusted:false});await assert.rejects(bad.h.review({}, {requestId:'review-1',revision:1}),/not allowed/);
  for(const args of [[],[null],[{requestId:'review-1',revision:1,approved:true}],[{requestId:'review-1',revision:1},{}],[{requestId:'review-2',revision:1}],[{requestId:'review-1',revision:2}]]) {
    const f=setup();await assert.rejects(f.h.review({},...args));assert.equal(f.calls.length,0);
  }
});
test('pending action changing while native dialog open invalidates approval',async()=>{
  let resolve;const f=setup({dialog:()=>new Promise(r=>{resolve=r;})});
  const promise=f.h.review({}, {requestId:'review-1',revision:1});await new Promise(r=>setImmediate(r));
  f.set({...row(),revision:2});resolve({response:1});await assert.rejects(promise,/no longer pending/);assert.equal(f.calls.length,0);
});
test('repeated review cannot open two dialogs or approve twice',async()=>{
  let resolve;const f=setup({dialog:()=>new Promise(r=>{resolve=r;})});
  const first=f.h.review({}, {requestId:'review-1',revision:1});await new Promise(r=>setImmediate(r));
  await assert.rejects(f.h.review({}, {requestId:'review-1',revision:1}),/already has an open/);
  resolve({response:0});await first;assert.equal(f.calls.length,1);
});
test('native cancellation uses the exact pending revision',async()=>{
  const f=setup();assert.equal((await f.h.cancel({}, {requestId:'review-1',revision:1})).state,'cancelled');assert.equal(f.calls[0][0],'cancel');
});
test('preload exposes scoped review/cancel channels, no arbitrary invocation',async()=>{
  const calls=[];let exposed;
  vm.runInNewContext(await readFile(new URL('../desktop/preload.cjs',import.meta.url),'utf8'),{
    process:{argv:[],platform:'win32'},require:()=>({contextBridge:{exposeInMainWorld:(_n,x)=>{exposed=x;}},ipcRenderer:{invoke:(...x)=>{calls.push(x);}}})
  });
  assert.ok(Object.isFrozen(exposed));assert.equal(exposed.invoke,undefined);
  const ref={requestId:'review-1',revision:1};exposed.reviewRetainedEffect(ref);exposed.cancelRetainedEffect(ref);
  assert.deepEqual(calls,[['relay:review-retained-effect',ref],['relay:cancel-retained-effect',ref]]);
});
const view = r => ({localManagement:true,nativeConfirmationAvailable:true,requests:[r]});
test('renderer escapes host content and uses only pending unexpired native controls',()=>{
  const r=row();r.candidate.summary='<img onerror=alert(1)>';r.candidate.target='"><script>';
  const html=renderOwnerRecovery(view(r),{nativeAvailable:true});
  assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img|<script/);assert.match(html,/Review once in native dialog/);
  assert.doesNotMatch(html,/data-owner-recovery="review"[^>]*disabled/);
  for(const changed of [{...r,expiresAt:'2000-01-01'},{...r,revision:'not-revision'},{...r,oneUse:false}]){
    assert.match(renderOwnerRecovery(view(changed),{nativeAvailable:true}),/data-owner-recovery="review"[^>]*disabled/);
  }
  assert.match(renderOwnerRecovery(view(r)),/Native owner confirmation is unavailable/);
  assert.doesNotMatch(renderOwnerRecovery({localManagement:false}),/data-owner-recovery="review"/);
});
test('terminal and unknown states never offer authorization',()=>{
  for(const state of ['approved','consumed','cancelled','expired','stale','bogus']){
    assert.doesNotMatch(renderOwnerRecovery(view({...row(),state}),{nativeAvailable:true}),/data-owner-recovery="review"/);
  }
  assert.match(renderOwnerRecovery(view({...row(),state:'consumed'})),/not proof that it succeeded/);
});
test('native wiring and both settings surfaces use shared recovery component',async()=>{
  const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
  assert.match(await read('desktop/main.mjs'),/nativeOwnerRecovery: true/);
  assert.match(await read('desktop/main.mjs'),/control: harness.ownerRecovery/);
  assert.match(await read('desktop/main.mjs'),/ipcMain.handle\('relay:review-retained-effect', ownerRecoveryHandlers.review\)/);
  assert.match(await read('public/next/workspaces/settings.mjs'),/recovery:.*owner-recovery-ui/);
  assert.match(await read('public/configure-ui.mjs'),/configure-owner-recovery-mount/);
  const css=await read('public/owner-recovery.css');assert.doesNotMatch(css,/#[0-9a-f]{3,8}\b/i);assert.match(css,/var\(--next-card-background/);
});
function mountFixture(api){
  const listeners={};const mount={innerHTML:'',isConnected:true,ownerDocument:{activeElement:null,head:null},contains:()=>false,querySelectorAll:()=>[],addEventListener:(n,f)=>{listeners[n]=f;},removeEventListener:n=>{delete listeners[n];}};
  return {mount,listeners,controller:mountOwnerRecovery({mount,api,autoStart:false,intervalMs:100000})};
}
test('closed settings do not poll; opening reads without executing; leave/destroy stops updates',async()=>{
  let calls=0;const f=mountFixture(async()=>{calls++;return view(row());});
  await f.controller.refresh();assert.equal(calls,0);
  f.controller.enter();await f.controller.refresh();assert.equal(calls,1);assert.match(f.mount.innerHTML,/Submit one application/);
  f.controller.leave();await f.controller.refresh();assert.equal(calls,1);
  f.controller.destroy();assert.equal(f.mount.innerHTML,'');assert.deepEqual(f.listeners,{});
});
test('late read after leaving settings cannot update the stale view',async()=>{
  let resolve;const f=mountFixture(()=>new Promise(r=>{resolve=r;}));f.controller.enter();
  const before=f.mount.innerHTML;f.controller.leave();resolve(view(row()));await new Promise(r=>setImmediate(r));assert.equal(f.mount.innerHTML,before);f.controller.destroy();
});
