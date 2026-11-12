import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserRecoveryBinding, assertBrowserRecoveryBinding } from '../lib/browser-recovery-binding.mjs';
import { createBrowserToolHandler, BrowserWorkspace } from '../lib/browser.mjs';
import { inspectObservedFormControl } from '../desktop/browser-operation-observation.mjs';
const call = (extra={}) => ({name:'relay_browser',arguments:{browser:'relay',action:'fill',tabId:'one',ref:'e1',text:'Example',...extra}});
const observed = () => ({current:true,tabId:'one',documentId:'doc1',url:'https://example.test/form',control:{ref:'e1',kind:'field',recovery:{version:1,nodeId:'node1',stateDigest:'a'.repeat(64),tag:'INPUT',type:'text',label:'Name'}}});
test('recovery binds exact call, document, DOM identity, control state and form payload', () => {
  const op=call(), value=observed(), binding=createBrowserRecoveryBinding(op,op.arguments,value);
  assert.deepEqual(assertBrowserRecoveryBinding(binding,op,op.arguments,value),binding);
  for(const change of [
    row=>{row.documentId='doc2';}, row=>{row.url='https://else.test';}, row=>{row.tabId='two';},
    row=>{row.control.recovery.nodeId='node2';}, row=>{row.control.recovery.stateDigest='b'.repeat(64);},
    row=>{row.control.form={payloadDigest:'changed'};}
  ]) {const next=structuredClone(value);change(next);assert.throws(()=>assertBrowserRecoveryBinding(binding,op,op.arguments,next),{code:'BROWSER_RECOVERY_CHANGED',actionDispatched:false});}
  const changed=call({text:'Different'});assert.throws(()=>assertBrowserRecoveryBinding(binding,changed,changed.arguments,value),{code:'BROWSER_RECOVERY_CHANGED'});
});
test('no opaque coordinate/focused typing, external scheme or unsupported history recovery', () => {
  for(const args of [{action:'type',text:'x'},{action:'click',ref:undefined,x:1,y:1},{action:'upload',paths:['file']},{action:'open',url:'javascript:alert(1)'},{action:'back'},{action:'reload'},{action:'press',key:'Enter'}]) {
    const op=call(args);assert.throws(()=>createBrowserRecoveryBinding(op,op.arguments,observed()),{code:'BROWSER_RECOVERY_CHANGED'});
  }
  const op=call({action:'open',url:'https://example.test/new',ref:undefined,tabId:undefined,text:undefined});
  assert.equal(createBrowserRecoveryBinding(op,op.arguments,null).page,null);
});
test('native noncredential control inspection hashes current value and stable DOM identity without input', async () => {
  const state={},el={isConnected:true,tagName:'INPUT',type:'text',value:'First',name:'name',textContent:'',attributes:[{name:'name',value:'name'}],getAttribute:name=>name==='name'?'name':null};
  const args={action:'fill',ref:'e1',hostRecoveryInspection:true};
  const a=await inspectObservedFormControl(el,state,args),same=await inspectObservedFormControl(el,state,args);
  assert.equal(a.recovery.nodeId,same.recovery.nodeId);assert.equal(a.recovery.stateDigest,same.recovery.stateDigest);
  assert.equal(JSON.stringify(a).includes('First'),false);
  el.value='Second';const b=await inspectObservedFormControl(el,state,args);
  assert.notEqual(a.recovery.stateDigest,b.recovery.stateDigest);
  const replacement=await inspectObservedFormControl({...el},state,args);assert.notEqual(a.recovery.nodeId,replacement.recovery.nodeId);
  el.type='password';assert.equal((await inspectObservedFormControl(el,state,args)).recovery,undefined);
});
test('raw handler exposes native capture and revalidation, forwards final input check, rejects drift', async () => {
  let observation=observed(),inputChecks=0,dispatched=0;
  const status={available:true,contained:true,activeTab:'one',tabs:[{tabId:'one',url:observation.url,browser:'relay'}]};
  const browser={status:()=>status,observeOperation:async(_args,opts)=>{assert.equal(opts.recoveryInspection,true);return structuredClone(observation);},
    perform:async(args,opts)=>{assert.equal(typeof opts.recoveryInput,'function');await opts.recoveryInput({});inputChecks++;dispatched++;return {tabId:'one',url:observation.url};}};
  const handler=createBrowserToolHandler({browser});const op=call();
  const binding=await handler.captureRecoveryBinding(op);assert.equal(binding.page.documentId,'doc1');
  assert.equal((await handler(op,{recoveryBinding:binding})).success,true);assert.equal(inputChecks,1);assert.equal(dispatched,1);
  observation.documentId='doc2';const failed=await handler(op,{recoveryBinding:binding});
  assert.equal(failed.success,false);assert.equal(failed.code,'BROWSER_RECOVERY_CHANGED');assert.equal(dispatched,1);
});
test('late native rejection never claims preparation had no effects', async () => {
  const observation=observed();const browser={status:()=>({available:true,contained:true,activeTab:'one',tabs:[{tabId:'one',url:observation.url,browser:'relay'}]}),
    observeOperation:async()=>structuredClone(observation),
    perform:async(args,opts)=>{observation.documentId='drift';await opts.recoveryInput({prepared:true});assert.fail('must not dispatch');}};
  const handler=createBrowserToolHandler({browser}),op=call(),binding=await handler.captureRecoveryBinding(op);
  const failed=await handler(op,{recoveryBinding:binding});const body=JSON.parse(failed.contentItems[0].text);
  assert.equal(body.code,'BROWSER_RECOVERY_CHANGED');assert.equal(Object.hasOwn(body,'actionDispatched'),false);assert.equal(Object.hasOwn(body,'inputDispatched'),false);
});
test('credential or unsupported submit payload cannot degrade to button-only recovery', async () => {
  const el={isConnected:true,tagName:'BUTTON',type:'submit',form:{isConnected:true,elements:[{type:'password'}]}};
  assert.equal((await inspectObservedFormControl(el,{}, {action:'click',ref:'submit',hostRecoveryInspection:true})).recovery,undefined);
  el.type='image';
  assert.equal((await inspectObservedFormControl(el,{}, {action:'click',ref:'submit',hostRecoveryInspection:true})).recovery,undefined);
});
test('workspace preserves recovery inspection and native final check callbacks', async () => {
  let inspected=false,checked=false;
  const driver={status:()=>({available:true,contained:true,activeTab:'one',tabs:[{tabId:'one',url:'https://example.test',browser:'relay'}]}),
    observeOperation:async(args,opts)=>{inspected=opts.recoveryInspection;return observed();},
    perform:async(args,opts)=>{await opts.recoveryInput({});return {tabId:'one'};}};
  const browser=new BrowserWorkspace({driver});await browser.observeOperation({action:'fill',tabId:'one',ref:'e1',text:'a'},{recoveryInspection:true});
  await browser.perform({action:'fill',tabId:'one',ref:'e1',text:'a'},{recoveryInput:async()=>{checked=true;}});
  assert.equal(inspected,true);assert.equal(checked,true);
});
