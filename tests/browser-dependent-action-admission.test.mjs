import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserWorkspace,createBrowserToolHandler} from '../lib/browser.mjs';
import {projectBrowserReferenceDiagnostic} from '../lib/browser-reference-diagnostic.mjs';
import {TaskExternalContextStore} from '../lib/task-external-context.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject}};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const invoke=(tabId,action,extra={})=>({name:'relay_browser',arguments:{browser:'relay',tabId,action,...extra}});
const taskOwner={taskId:'test-task',runId:'test-run',nodeId:'agent'};
function fixture(t, perform){
 const calls=[];
 const driver={
  status:()=>({available:true,contained:true,activeTab:'one',tabs:[
   {tabId:'one',url:'https://example.test/form',contained:true,owner:taskOwner},
   {tabId:'two',url:'https://example.test/other',contained:true,owner:taskOwner}
  ]}),
  perform:async args=>{calls.push(args);return perform?perform(args,calls.length):{
   tabId:args.tabId,url:args.tabId==='one'?'https://example.test/form':'https://example.test/other',
   documentId:args.tabId+':1',frames:[{observation:'content-observed',elements:[]}]} }
 };
 const browser=new BrowserWorkspace({driver});t.after(()=>browser.close());
 return{handler:createBrowserToolHandler({browser,owner:taskOwner}),browser,calls};
}
const receipt=result=>JSON.parse(result.contentItems[0].text);

test('dependent same-tab mutations require an explicit subsequent page observation; unrelated tabs are independent',async t=>{
 const f=fixture(t);
 const first=await f.handler(invoke('one','fill',{ref:'email',text:'private value'}));
 assert.equal(first.success,true);
 const blocked=await f.handler(invoke('one','select',{ref:'region',value:'remote'}));
 assert.equal(blocked.success,false);
 assert.equal(blocked.code,'BROWSER_REOBSERVE_REQUIRED');
 assert.equal(blocked.actionDispatched,false);assert.equal(blocked.inputDispatched,false);
 assert.equal(receipt(blocked).recovery.nextCall.tabId,'one');
 assert.equal(f.calls.length,1,'Second dependent input must not enter physical browser queue');
 assert.doesNotMatch(JSON.stringify(blocked),/private value|remote/);
 const other=await f.handler(invoke('two','click',{ref:'continue'}));
 assert.equal(other.success,true,'Independent other tab is not blocked');
 const fresh=await f.handler(invoke('one','snapshot'));
 assert.equal(fresh.success,true);
 const token=receipt(fresh).observationReceipt;
 assert.match(token,/^obs-[a-f0-9-]{36}$/);
 const next=await f.handler(invoke('one','select',{ref:'region',value:'remote',observationReceipt:token}));
 assert.equal(next.success,true);
 assert.equal(f.calls.at(-1).observationReceipt,undefined,'The causality receipt is stripped before native browser dispatch');
 assert.deepEqual(f.calls.map(c=>c.action),['fill','click','snapshot','select']);
});

test('a failed or unsettled read cannot clear a dependent same-tab input barrier',async t=>{
 let inspection=0;
 const f=fixture(t,async args=>{
  if(args.action==='read'){
   inspection++;
   if(inspection===1)throw Object.assign(new Error('capture unavailable'),{code:'BROWSER_READ_FAILED'});
   if(inspection===2)return{tabId:args.tabId,url:'https://example.test/form',documentId:'one:1',navigationUnsettled:true,frames:[{}]};
  }
  return{tabId:args.tabId,url:'https://example.test/form',documentId:'one:1',frames:[{observation:'content-observed',elements:[]}]};
 });
 assert.equal((await f.handler(invoke('one','click',{ref:'continue'}))).success,true);
 assert.equal((await f.handler(invoke('one','read'))).success,false);
 assert.equal((await f.handler(invoke('one','click',{ref:'next'}))).code,'BROWSER_REOBSERVE_REQUIRED');
 assert.equal((await f.handler(invoke('one','read'))).success,true);
 assert.equal((await f.handler(invoke('one','click',{ref:'next'}))).code,'BROWSER_REOBSERVE_REQUIRED');
 const observed=await f.handler(invoke('one','snapshot'));assert.equal(observed.success,true);
 assert.equal((await f.handler(invoke('one','click',{ref:'next',observationReceipt:receipt(observed).observationReceipt}))).success,true);
 assert.deepEqual(f.calls.map(c=>c.action),['click','read','read','snapshot','click']);
});

test('concurrent same-tab calls cannot bypass the admission guard while a previous action remains physically in flight',async t=>{
 const held=deferred(),entered=deferred();
 const f=fixture(t,async args=>{
  if(args.action==='fill'){entered.resolve();await held.promise;}
  return{tabId:args.tabId,url:'https://example.test/form',documentId:'one:1',frames:[{observation:'content-observed',elements:[]}]};
 });
 t.after(()=>held.resolve());
 const first=f.handler(invoke('one','fill',{ref:'first',text:'first'}));
 await entered.promise;
 const second=await f.handler(invoke('one','fill',{ref:'second',text:'second'}));
 assert.equal(second.code,'BROWSER_REOBSERVE_REQUIRED');assert.equal(f.calls.length,1);
 const observe=f.handler(invoke('one','snapshot'));
 const next=await f.handler(invoke('one','click',{ref:'continue'}));
 assert.equal(next.code,'BROWSER_REOBSERVE_REQUIRED','Concurrent observation has not yet returned to the model');
 held.resolve();await first;const observed=await observe;
 assert.equal((await f.handler(invoke('one','click',{ref:'continue',observationReceipt:receipt(observed).observationReceipt}))).success,true);
 assert.deepEqual(f.calls.map(x=>x.action),['fill','snapshot','click']);
});

test('unrelated inspection without usable frame data is not a fresh control observation',async t=>{
 const f=fixture(t,async args=>args.action==='read'?{tabId:args.tabId,url:'https://example.test/form',documentId:'one:1',frames:[]}:
 {tabId:args.tabId,url:'https://example.test/form',documentId:'one:1',frames:[{observation:'content-observed'}]});
 await f.handler(invoke('one','click',{ref:'button'}));
 const empty=await f.handler(invoke('one','read'));assert.equal(empty.success,true);
 assert.equal((await f.handler(invoke('one','click',{ref:'button2'}))).code,'BROWSER_REOBSERVE_REQUIRED');
});


test('fresh observation produced in a model batch must not authorize a dependent click unless the caller consumed its receipt',async t=>{
 const f=fixture(t);
 const first=await f.handler(invoke('one','fill',{ref:'first',text:'initial'}));
 assert.equal(first.success,true);
 const snapshot=await f.handler(invoke('one','snapshot'));
 assert.equal(snapshot.success,true);
 const staleBatchClick=await f.handler(invoke('one','click',{ref:'second'}));
 assert.equal(staleBatchClick.code,'BROWSER_REOBSERVE_REQUIRED','A model cannot legitimately select the next current target until it has seen the new observation receipt');
 assert.equal(f.calls.filter(call=>call.action==='click').length,0);
 const token=receipt(snapshot).observationReceipt;
 assert.match(token,/^obs-[a-f0-9-]{36}$/);
 const accepted=await f.handler(invoke('one','click',{ref:'second',observationReceipt:token}));
 assert.equal(accepted.success,true);
 assert.equal((await f.handler(invoke('one','click',{ref:'third',observationReceipt:token}))).code,'BROWSER_REOBSERVE_REQUIRED','The receipt is single-use');
});


test('causality state survives a new handler instance for the same trusted task and tab',async t=>{
 const f=fixture(t),freshHandler=createBrowserToolHandler({browser:f.browser,owner:taskOwner});
 assert.equal((await f.handler(invoke('one','fill',{ref:'first',text:'once'}))).success,true);
 const blocked=await freshHandler(invoke('one','click',{ref:'second'}));
 assert.equal(blocked.code,'BROWSER_REOBSERVE_REQUIRED');
 assert.equal(blocked.actionDispatched,false);assert.equal(f.calls.length,1);
 const observed=await freshHandler(invoke('one','read'));
 const token=receipt(observed).observationReceipt;assert.match(token,/^obs-[a-f0-9-]{36}$/);
 assert.equal((await f.handler(invoke('one','click',{ref:'second',observationReceipt:token}))).success,true);
 assert.deepEqual(f.calls.map(call=>call.action),['fill','read','click']);
});

test('covered-target recovery supplies a fresh receipt, not a second click',async t=>{
 const f=fixture(t,async (args,n)=>{
  if(n===1)throw Object.assign(new Error('covered'),{code:'BROWSER_TARGET_COVERED',inputDispatched:false,blocker:{modalPresent:true}});
  return {tabId:'one',url:'https://example.test/form',documentId:'one:1',frames:[{frame:'main',elements:[{ref:'close-dialog',name:'Close dialog',role:'button'}]}]};
 });
 const failed=await f.handler(invoke('one','click',{ref:'covered'}));
 assert.equal(failed.code,'BROWSER_TARGET_COVERED');
 assert.equal(failed.inputDispatched,false);
 assert.deepEqual(f.calls.map(x=>x.action),['click','snapshot']);
 const {recovery}=receipt(failed);
 assert.equal(recovery.inspectVisualCall.action,'screenshot');
 assert.match(recovery.observationReceipt,/^obs-/);
 assert.equal((await f.handler(invoke('one','click',{ref:'close-dialog',observationReceipt:recovery.observationReceipt}))).success,true);
 assert.deepEqual(f.calls.map(x=>x.action),['click','snapshot','click']);
});
test('snapshot uses the current owned tab when prior identity fields are carried into a read',async t=>{
 const f=fixture(t);
 const fresh=await f.handler(invoke('one','snapshot',{expectedUrl:'https://example.test/old',expectedDocumentId:'old-document'}));
 assert.equal(fresh.success,true);
 assert.equal(f.calls[0].expectedUrl,undefined);
 assert.equal(f.calls[0].expectedDocumentId,undefined);
 assert.equal(receipt(fresh).documentId,'one:1');
});

test('settled navigation and waits supply the observation required by the next action',async t=>{
 const f=fixture(t,async args=>({tabId:args.tabId,url:args.url||'https://example.test/a',documentId:'one:2',frames:[{}]}));
 const first=await f.handler(invoke('one','navigate',{url:'https://example.test/a'}));
 assert.match(receipt(first).observationReceipt,/^obs-/);
 const wait=await f.handler(invoke('one','wait',{text:'ready'}));
 assert.match(receipt(wait).observationReceipt,/^obs-/);
 const nav=await f.handler(invoke('one','navigate',{url:'https://example.test/b',observationReceipt:receipt(wait).observationReceipt}));
 assert.equal(nav.success,true);
 assert.equal((await f.handler(invoke('one','click',{ref:'control'}))).code,'BROWSER_REOBSERVE_REQUIRED');
 assert.deepEqual(f.calls.map(x=>x.action),['navigate','wait','navigate']);
});

test('a paged browser observation can drive the next owned action without reopening the archive',async t=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'blackice-browser-observation-'));
 t.after(()=>rm(dataDir,{recursive:true,force:true}));
 const archive=new TaskExternalContextStore({taskId:taskOwner.taskId,dataDir,thresholdBytes:500});
 const f=fixture(t,async args=>({tabId:args.tabId,url:'https://example.test/form',documentId:'one:3',
   frames:[{frame:'main',elements:[{ref:'next',name:'Next',role:'button'},...Array.from({length:150},(_,i)=>({ref:'ref'+i,name:'long control '+i,value:'x'.repeat(80),tag:'input'}))]}]}));
 assert.equal((await f.handler(invoke('one','click',{ref:'previous'}))).success,true);
 const request=invoke('one','snapshot');
 const observed=await f.handler(request);
 const paged=receipt(await archive.archiveResult({...request,callId:'large-observation'},observed));
 assert.equal(paged.externalContext,true);
 assert.equal(paged.browserObservation.observationReceipt,receipt(observed).observationReceipt);
 const current=paged.browserObservation.frames.flatMap(f=>f.elements).find(x=>x.role==='button');
 assert.equal(current?.ref,'next');
 const input=await f.handler(invoke('one','click',{ref:current.ref,observationReceipt:paged.browserObservation.observationReceipt}));
 assert.equal(input.success,true);
 assert.deepEqual(f.calls.map(x=>x.action),['click','snapshot','click']);
});

test('pointer hit verification diagnostics distinguish failure classes without raw page data',()=>{
 for(const pointerVerification of ['renderer-exception','hit-mismatch','identity-changed','control-disconnected','no-verification']){
  const result=projectBrowserReferenceDiagnostic({reason:'binding-mismatch',pointerCheck:'verify-hit',pointerVerification,
     observedRevision:2,currentRevision:2,rawPage:'secret',selector:'secret'});
  assert.deepEqual(result,{bindingReason:'binding-mismatch',pointerCheck:'verify-hit',pointerVerification,observedRevision:2,currentRevision:2});
 }
 assert.equal(projectBrowserReferenceDiagnostic({reason:'binding-mismatch',pointerCheck:'verify-hit',pointerVerification:'unknown raw text'}).pointerVerification,undefined);
});
