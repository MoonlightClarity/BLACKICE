import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {reviewModularOutcome,createModularCompletionController} from '../lib/modular-completion.mjs';

import {estimateContextTokens} from '../lib/context.mjs';

const policy={version:2,modules:{anti_overalignment:true}};
const context={preset:'custom',windowTokens:12000,outputReserveTokens:1000,headroomTokens:1000};
const assessment={decision:'respond',summary:'Observed evidence supports the response.',remaining:[],nextAction:'',evidenceRefs:['user-request'],blockers:[]};
const aborted=()=>Object.assign(new Error('Reviewer stopped'),{name:'AbortError',code:'ABORT_ERR'});
async function fixture(t){
 const cwd=await mkdtemp(path.join(os.tmpdir(),'review-exhaustion-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
 const snapshot={request:{id:'user-request',text:'Preserve public outputs.'},policy,evidence:{auditRoot:path.join(cwd,'receipts'),records:[
  {id:'receipt',source:'host-dispatch-receipt',tool:'relay_browser',action:'read',success:true,result:{contentItems:[{type:'inputText',text:'Observed receipt. '+('source '.repeat(30000))}]}}
 ]}};
 return {cwd,snapshot};
}
function callFor(options){
 const packet=JSON.parse(options.prompt.split('\n\n').find(part=>part.startsWith('{"snapshot":')));
 return {name:'relay_directory_context',arguments:{action:'read',ref:packet.snapshot.evidence.records[0].savedSource.ref,limit:100}};
}
for(const inputTokens of ['exact-zero',10000,11000,9950]){
 test('exhausted reviewer capacity '+inputTokens+' ends one review, preserves candidate and parent signal',async t=>{
  const {cwd,snapshot}=await fixture(t),parent=new AbortController(),usage=[],updates=[];
  const candidate={output:'No applications were submitted. Research is incomplete.'},before=structuredClone(candidate);
  let reviews=0,reads=0,returns=0;
  const runtime={async runAgent(options){
   reviews++;assert.notEqual(options.signal,parent.signal);
   const measuredInput=inputTokens==='exact-zero'?10000-estimateContextTokens(callFor(options)):inputTokens;
   options.onEvent({type:'usage',usage:{last:{inputTokens:measuredInput,outputTokens:0}}});
   try{reads++;await options.onToolCall(callFor(options));assert.fail('No capacity read must succeed');}
   catch(error){assert.equal(error.code,'MODULAR_REVIEW_CONTEXT_CAPACITY');}
   assert.equal(options.signal.aborted,true);assert.equal(parent.signal.aborted,false);
   // Native transports wrap tool callback errors, then reject when their signal stops.
   if(inputTokens==='exact-zero')throw Object.assign(new Error('Provider wrapped host cancellation'),{code:'MODULAR_REVIEW_CONTEXT_CAPACITY'});
   throw aborted();
  }};
  const controller=createModularCompletionController({policy,signal:parent.signal,getSnapshot:()=>snapshot,onReturn:()=>returns++,onUpdate:value=>updates.push(value),
   review:args=>reviewModularOutcome({cwd,runtime,model:'fixture',context,signal:parent.signal,...args,onUsage:value=>usage.push(value)})});
  assert.equal(await controller.beforeFinal(candidate),null);
  const state=await controller.assertReady();
  assert.equal(reviews,1);assert.equal(reads,1);assert.equal(returns,0);assert.deepEqual(candidate,before);
  assert.equal(state.reviewUnavailable,true);assert.equal(state.assessment.decision,'unreviewed');
  assert.equal(state.assessment.status,'unavailable');assert.equal(state.assessment.reason,'MODULAR_REVIEW_CONTEXT_CAPACITY');
  assert.equal(state.assessment.evidenceRefs,undefined);assert.equal(updates.some(row=>row.status==='sufficient'),false);
  assert.equal(usage.length,1);assert.ok(usage[0].reviewContext.capacityStop);if(inputTokens==='exact-zero')assert.equal(usage[0].reviewContext.capacityStop.remainingTokens,0);
  else assert.equal(usage[0].reviewContext.lastInputTokens,inputTokens);
 });
}
test('queued reads cannot continue after local exhaustion or refund capacity',async t=>{
 const {cwd,snapshot}=await fixture(t);let calls=0;
 await assert.rejects(reviewModularOutcome({cwd,snapshot,candidate:{output:'Partial'},model:'fixture',context,runtime:{async runAgent(options){
  calls++;options.onEvent({type:'usage',usage:{last:{inputTokens:10000,outputTokens:0}}});
  const replies=await Promise.allSettled([options.onToolCall(callFor(options)),options.onToolCall(callFor(options))]);
  assert.ok(replies.every(row=>row.status==='rejected'&&row.reason.code==='MODULAR_REVIEW_CONTEXT_CAPACITY'));
  options.onEvent({type:'usage',usage:{last:{inputTokens:100,outputTokens:0}}});
  await assert.rejects(options.onToolCall(callFor(options)),{code:'MODULAR_REVIEW_CONTEXT_CAPACITY'});
  return {output:JSON.stringify(assessment)};
 }}}),{code:'MODULAR_REVIEW_CONTEXT_CAPACITY'});
 assert.equal(calls,1);
});
test('owner cancellation wins even after reviewer-local capacity stop',async t=>{
 const {cwd,snapshot}=await fixture(t),parent=new AbortController(),updates=[];
 const controller=createModularCompletionController({policy,signal:parent.signal,getSnapshot:()=>snapshot,onUpdate:r=>updates.push(r),review:args=>reviewModularOutcome({
  cwd,model:'fixture',context,signal:parent.signal,...args,runtime:{async runAgent(options){
   options.onEvent({type:'usage',usage:{last:{inputTokens:10000,outputTokens:0}}});
   await assert.rejects(options.onToolCall(callFor(options)),{code:'MODULAR_REVIEW_CONTEXT_CAPACITY'});
   parent.abort();throw aborted();
  }}
 })});
 await assert.rejects(controller.beforeFinal({output:'Partial'}),{code:'ABORT_ERR'});
 assert.equal(updates.some(row=>row.status==='unavailable'),false);
});
test('ordinary parent cancellation reaches reviewer and is not optional recovery',async t=>{
 const {cwd,snapshot}=await fixture(t),parent=new AbortController();
 await assert.rejects(reviewModularOutcome({cwd,snapshot,candidate:{output:'Partial'},model:'fixture',context,signal:parent.signal,runtime:{async runAgent(options){
  parent.abort();assert.equal(options.signal.aborted,true);throw aborted();
 }}}),{code:'ABORT_ERR'});
});
test('real provider failures remain errors even coinciding with a local capacity stop',async t=>{
 const {cwd,snapshot}=await fixture(t);
 for(const exhaust of [false,true]){
  const controller=createModularCompletionController({policy,getSnapshot:()=>snapshot,review:args=>reviewModularOutcome({
   cwd,model:'fixture',context,...args,runtime:{async runAgent(options){
    if(exhaust){options.onEvent({type:'usage',usage:{last:{inputTokens:10000,outputTokens:0}}});await assert.rejects(options.onToolCall(callFor(options)));}
    throw Object.assign(new Error('provider failed'),{code:'PROVIDER_UNAVAILABLE'});
   }}
  })});
  await assert.rejects(controller.beforeFinal({output:'Partial'}),{code:'PROVIDER_UNAVAILABLE'});
 }
});
test('valid saved evidence still completes normally and does not abort reviewer',async t=>{
 const {cwd,snapshot}=await fixture(t);
 const controller=createModularCompletionController({policy,getSnapshot:()=>snapshot,review:args=>reviewModularOutcome({
  cwd,model:'fixture',context,...args,runtime:{async runAgent(options){
   options.onEvent({type:'usage',usage:{last:{inputTokens:3000,outputTokens:0}}});
   const call=callFor(options);call.arguments.limit=1800;
   const receipt=await options.onToolCall(call);assert.equal(receipt.success,true);assert.equal(options.signal.aborted,false);
   assert.match(JSON.parse(receipt.contentItems[0].text).text,/Observed receipt/);
   return {output:JSON.stringify({...assessment,evidenceRefs:['evidence-0001']})};
  }}
 })});
 assert.equal(await controller.beforeFinal({output:'Observed receipt.'}),null);
 const state=await controller.assertReady();assert.equal(state.reviewUnavailable,false);assert.equal(state.assessment.decision,'respond');
 assert.equal(state.assessment.evidenceInspection.reads.length,1);
});
test('capacity recovery never clears a preceding grounded contradiction',async t=>{
 const {cwd,snapshot}=await fixture(t);let reviews=0;
 const controller=createModularCompletionController({policy,getSnapshot:()=>snapshot,review:args=>{
  if(++reviews===1)return {...assessment,evidenceRefs:['user-request','evidence-0001'],outcomeChecks:[{
   obligation:'Preserve public outputs',basis:'user-request',contractQuote:'Preserve public outputs.',contractRefs:['user-request'],
   resultRefs:['evidence-0001'],disposition:'contradicted',material:true,reason:'Recorded result contradicts the requested output.'
  }]};
  return reviewModularOutcome({cwd,model:'fixture',context,...args,runtime:{async runAgent(options){
   options.onEvent({type:'usage',usage:{last:{inputTokens:10000,outputTokens:0}}});
   await options.onToolCall(callFor(options));return {output:JSON.stringify(assessment)};
  }}});
 }});
 await assert.rejects(controller.beforeFinal({output:'Done'}),{code:'MODULAR_REVIEW_CONFLICT'});assert.equal(reviews,2);
});
