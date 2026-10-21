import test from 'node:test';
import assert from 'node:assert/strict';
import {observeExternalActions} from '../public/observe-model.mjs';
import {renderObserveExternalActions,initObserveUI} from '../public/observe-ui.mjs';

const destination='https://www.linkedin.com/in/example/recent-activity/all/';
const permalink='https://www.linkedin.com/feed/update/urn:li:activity:123/';
const receipt=(extra={})=>({id:'blackice-post',destination,contentExcerpt:'Building BLACKICE together.',status:'uncertain',attempts:1,preparedAt:'2026-10-17T12:00:00Z',attemptedAt:'2026-10-17T12:00:01Z',attemptedBy:{runId:'publication-run',nodeId:'agent'},...extra});
const run=(extra={})=>({id:'observed-run',status:'completed',input:'Check publication recovery.',workflow:{nodes:[],edges:[]},nodes:{},events:[],taskState:{taskId:'shared-task',revision:2,externalActions:[receipt()]},...extra});

test('a settled run keeps an uncertain remote outcome visible rather than implying the send failed',()=>{
  const model=observeExternalActions(run()),html=renderObserveExternalActions(model);
  assert.equal(model.needsInspection,1);assert.equal(model.confirmed,0);assert.equal(model.receipts[0].attempts,1);
  assert.match(html,/Needs inspection/);assert.match(html,/may already have succeeded/);assert.match(html,/before retrying/);assert.match(html,/1 saved attempt/);assert.doesNotMatch(html,/Confirmed result|send failed|Retry now/);
  assert.match(html,/href="https:\/\/www\.linkedin\.com\/in\/example\/recent-activity\/all\/"/);
});

test('confirmed receipts preserve the original result link, attachment identity, evidence, and recording run',()=>{
  const value=receipt({status:'confirmed',url:permalink,evidence:'Exact text and loaded image checked at the permalink.',attachmentSha256:'a'.repeat(64),confirmedAt:'2026-10-17T12:01:00Z',confirmedBy:{runId:'original-send',nodeId:'publisher'}}),model=observeExternalActions(run({taskState:{externalActions:[value]}})),html=renderObserveExternalActions(model,{canOpenConversation:true});
  assert.equal(model.receipts[0].url,permalink);assert.equal(model.receipts[0].sourceRunId,'original-send');assert.equal(model.needsInspection,0);assert.equal(model.confirmed,1);
  assert.ok(html.includes('href="'+permalink+'"'));assert.match(html,/Open confirmed result/);assert.match(html,/without sending it again/);assert.match(html,/Exact text and loaded image checked/);assert.ok(html.includes('a'.repeat(64)));assert.match(html,/data-observe-action="receipt-conversation"/);assert.match(html,/shared across turns/);assert.match(html,/Receipts are agent reports/);
});

test('backup recovery remains visible even before a receipt exists and marks incomplete counts honestly',()=>{
  const empty=observeExternalActions(run({taskState:{externalRecovery:{required:true,note:'Newer receipts may be missing.'}}})),emptyHtml=renderObserveExternalActions(empty);
  assert.match(emptyHtml,/Recovered task state/);assert.match(emptyHtml,/Newer receipts may be missing/);assert.doesNotMatch(emptyHtml,/0 prepared/);
  const recovered=observeExternalActions(run({taskState:{externalActions:[receipt({attempts:0,attemptsMayBeIncomplete:true,recoveredFromBackup:true})],externalRecovery:{required:true}}})),html=renderObserveExternalActions(recovered);
  assert.match(html,/0 saved attempts · count may be incomplete/);assert.match(html,/Needs inspection/);
});

test('prepared and reconciled-absent actions do not imply a send or independent website verification',()=>{
  const model=observeExternalActions(run({taskState:{externalActions:[receipt({status:'prepared',attempts:0,attemptedBy:undefined}),receipt({id:'checked-absent',status:'prepared',absenceEvidence:'Fresh destination inspection found no matching post.',reconciledAt:'2026-10-17T12:03:00Z',reconciledBy:{runId:'recovery-run'}})]}})),html=renderObserveExternalActions(model);
  assert.equal(model.confirmed,0);assert.equal(model.needsInspection,0);assert.match(html,/No send attempt is recorded/);assert.match(html,/Absence checked/);assert.match(html,/No new attempt is recorded/);assert.match(html,/Fresh destination inspection/);assert.doesNotMatch(html,/Open confirmed result/);
});

test('untrusted saved text is escaped and unsafe or credential-bearing receipt links are never activated',()=>{
  const unsafe=receipt({status:'confirmed',destination:'javascript:alert(1)',url:'https://user:password@example.com/private',contentExcerpt:'<img src=x onerror=alert(1)>',evidence:'<script>alert(2)</script>',attempts:-1,confirmedBy:{runId:'bad" onclick="send',nodeId:'agent'}}),model=observeExternalActions(run({taskState:{externalActions:[unsafe]}})),html=renderObserveExternalActions(model,{canOpenConversation:true});
  assert.equal(model.receipts[0].destination,null);assert.equal(model.receipts[0].url,null);assert.equal(model.receipts[0].sourceRunId,null);assert.equal(model.receipts[0].attempts,null);assert.equal(model.needsInspection,1);
  assert.doesNotMatch(html,/<img|<script|href=|receipt-conversation/);assert.match(html,/&lt;img/);assert.match(html,/&lt;script/);assert.match(html,/Attempt count unavailable/);assert.match(html,/no usable result link/);
});

test('missing receipts stay silent and malformed saved arrays are bounded without fabricating progress',()=>{
  assert.equal(renderObserveExternalActions(observeExternalActions(run({taskState:{}}))),'');
  assert.equal(observeExternalActions(run({taskState:{externalActions:'invalid'}})).receipts.length,0);
  const model=observeExternalActions(run({taskState:{externalActions:Array.from({length:20},(_,index)=>receipt({id:'receipt-'+index,status:'unrecognized',contentExcerpt:'x'.repeat(1000),evidence:'y'.repeat(9000)}))}}));
  assert.equal(model.receipts.length,8);assert.equal(model.needsInspection,8);assert.equal(model.receipts[0].status,'unknown');assert.equal(model.receipts[0].contentExcerpt.length,160);assert.equal(model.receipts[0].evidence.length,2000);
});

test('outcomes needing inspection appear before quiet confirmed receipts without rewriting saved history',()=>{
  const saved=run({taskState:{externalActions:[receipt({id:'done',status:'confirmed',url:permalink}),receipt({id:'ready',status:'prepared',attempts:0}),receipt({id:'inspect'})]}}),before=structuredClone(saved);
  assert.deepEqual(observeExternalActions(saved).receipts.map(item=>item.id),['inspect','ready','done']);assert.deepEqual(saved,before);
});

const decode=value=>String(value).replaceAll('&quot;','"').replaceAll('&#39;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');
const attributes=tag=>Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([,key,value])=>[key,decode(value)]));
function fixture(t,{onOpenRun}={}){
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document'),elements=new Map(),listeners=new Map(),opened=[];
  const doc={activeElement:null,getElementById:()=>({})};globalThis.document=doc;
  const basic=()=>({innerHTML:'',textContent:'',hidden:false,value:'',scrollHeight:100,scrollTop:0,clientHeight:100,isConnected:true,classList:{toggle(){},add(){}}});
  const host=basic();host.writes=0;let html='',controls=[],details=[];
  Object.defineProperty(host,'innerHTML',{get:()=>html,set(value){html=value;host.writes++;for(const control of controls)control.isConnected=false;controls=[];details=[];
    for(const[tag]of value.matchAll(/<[a-z][^>]*data-observe-receipt-control="[^"]+"[^>]*>/g)){
      const attrs=attributes(tag),control={parentHost:host,isConnected:true,attributes:attrs,dataset:Object.fromEntries(Object.entries(attrs).filter(([key])=>key.startsWith('data-')).map(([key,value])=>[key.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase()),value])),focus(options){doc.activeElement=this;this.focusOptions=options;},closest(selector){return selector==='[data-observe-action]'&&this.dataset.observeAction?this:null;}};controls.push(control);
    }
    for(const[tag]of value.matchAll(/<details\b[^>]*data-observe-receipt="[^"]+"[^>]*>/g)){const attrs=attributes(tag);details.push({dataset:{observeReceipt:attrs['data-observe-receipt']},open:/\sopen(?:\s|>)/.test(tag)});}
  }});
  host.contains=node=>node?.parentHost===host&&node.isConnected;host.querySelectorAll=()=>controls;
  const element=key=>{if(key==='#observe-workflow')return null;if(key==='#observe-external')return host;if(!elements.has(key))elements.set(key,basic());return elements.get(key);};
  const mount={...basic(),hidden:false,classList:{add(){}},querySelector:element,querySelectorAll:()=>[],addEventListener:(name,handler)=>listeners.set(name,handler),removeEventListener:name=>listeners.delete(name),contains:node=>host.contains(node)};
  const active=run({status:'running'}),other=run({id:'other-run',taskState:{externalActions:[]}}),snapshot={currentRun:active,runs:[active,other]};
  const ui=initObserveUI({mount,getSnapshot:()=>snapshot,onOpenRun:async(...args)=>{opened.push(args);await onOpenRun?.(...args);}});
  t.after(()=>{ui.destroy();if(previous)Object.defineProperty(globalThis,'document',previous);else delete globalThis.document;});
  return{ui,host,active,other,snapshot,opened,element,controls:()=>controls,details:()=>details,enter:()=>ui.enter(),click:control=>listeners.get('click')({target:control}),toggle:detail=>listeners.get('toggle')({target:detail}),select:id=>listeners.get('change')({target:{id:'observe-run',value:id}}),focus:control=>control.focus(),focused:()=>doc.activeElement};
}

test('Activity preserves expanded evidence and keyboard focus across actual receipt updates',t=>{
  const f=fixture(t);f.enter();assert.equal(f.host.hidden,false);const detail=f.details()[0];detail.open=true;f.toggle(detail);const summary=f.controls().find(item=>item.dataset.observeReceiptControl==='blackice-post:evidence');f.focus(summary);const writes=f.host.writes;
  f.active.taskState.revision++;f.ui.update();assert.equal(f.host.writes,writes,'unrelated saved plan revisions do not redraw receipts');assert.strictEqual(f.focused(),summary);
  Object.assign(f.active.taskState.externalActions[0],{status:'confirmed',url:permalink,evidence:'Fresh exact result checked.',confirmedBy:{runId:'publication-run'},confirmedAt:'2026-10-17T12:01:00Z'});f.ui.update();
  assert.equal(f.host.writes,writes+1);assert.equal(f.details()[0].open,true);assert.equal(f.focused().dataset.observeReceiptControl,'blackice-post:evidence');assert.notStrictEqual(f.focused(),summary);assert.equal(f.focused().focusOptions.preventScroll,true);assert.match(f.host.innerHTML,/Fresh exact result checked/);
});

test('receipt navigation uses saved provenance and cannot dispatch a retry or a stale receipt',async t=>{
  const f=fixture(t);f.enter();const button=f.controls().find(item=>item.dataset.observeAction==='receipt-conversation');await f.click(button);assert.deepEqual(f.opened,[['publication-run','mission']]);assert.equal(f.active.taskState.externalActions[0].attempts,1);
  f.active.taskState.externalActions=[];f.ui.update();assert.equal(f.host.hidden,true);await f.click(button);assert.equal(f.opened.length,1,'a detached receipt button cannot act on a replacement view');
});

test('leaving or selecting another task clears receipt evidence and late navigation errors',async t=>{
  let rejectNavigation;const f=fixture(t,{onOpenRun:id=>id==='publication-run'?new Promise((_,reject)=>{rejectNavigation=reject;}):undefined});f.enter();const pending=f.click(f.controls().find(item=>item.dataset.observeAction==='receipt-conversation'));await f.select('other-run');
  assert.equal(f.host.hidden,true);assert.equal(f.host.innerHTML,'');rejectNavigation(Error('Old receipt unavailable.'));await pending;assert.equal(f.element('#observe-error').hidden,true);
  f.ui.leave();assert.equal(f.host.innerHTML,'');assert.equal(f.host.hidden,true);
});
