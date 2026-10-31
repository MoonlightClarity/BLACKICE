import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';

import {PlanningBrowserStore} from '../lib/planning-browser.mjs';
import {planningModuleTemplate} from '../public/planning-browser-model.mjs';
import {tokenUsageMeasurement,emptyTokenUsage} from '../public/token-usage.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');

async function fixture(t){
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'planning-usage-compat-'));
  const store=new PlanningBrowserStore({dataDir});await store.init();
  t.after(async()=>{await store.close();await fs.rm(dataDir,{recursive:true,force:true});});
  const request=await store.create({conversationId:'conversation-fixture',title:'Synthetic route choice',objective:'Choose a reliable synthetic route.',cwd:dataDir});
  const graph=await store.addNode(request.id,{id:'choice',kind:'decision',title:'Synthetic choice',prompt:'Produce the named public analytical fields.',parentId:null});
  const writer=store.runtimeWriter();
  const claim=await writer.beginAttempt(request.id,'choice',{expectedNodeRevision:graph.nodes.find(n=>n.id==='choice').revision,ownerId:'fixture-worker',model:'synthetic-model'});
  return {store,writer,requestId:request.id,attemptId:claim.attempt.id,dataDir};
}
const metadata=usage=>({runId:'actual-run',executionNodeId:'actual-worker',threadId:'actual-thread',turnId:'actual-turn',itemId:'actual-message',model:'synthetic-model',provider:'fixture',usage});
function output(requestId){
  const fields=planningModuleTemplate('decision').fields;
  return JSON.stringify({values:Object.fromEntries(fields.map(f=>[f.id,'Synthetic evidence and explanation for '+f.label+'.'])),grounding:fields.filter(f=>f.grounding==='required').map(f=>({field:f.id,sourceId:'request:'+requestId}))});
}
const observed=()=>tokenUsageMeasurement({inputTokens:4665,outputTokens:4094,totalTokens:8759,cachedInputTokens:null,reasoningOutputTokens:4302});
const envelope=(last=observed(),total=last)=>({...structuredClone(total),total:structuredClone(total),last:structuredClone(last),modelContextWindow:null});
async function durable(f){
  const saved=JSON.parse(await fs.readFile(f.store.file(f.requestId),'utf8'));
  const reopened=new PlanningBrowserStore({dataDir:f.dataDir});await reopened.init();
  try{await reopened.get(f.requestId);}finally{await reopened.close();}
  return {saved,attempt:saved.attempts.find(a=>a.id===f.attemptId)};
}

test('reported availability and sample metadata persist in completed response provenance',async t=>{
  const f=await fixture(t),usage=envelope(),text=output(f.requestId);
  await f.writer.recordResponse(f.requestId,f.attemptId,{output:text,metadata:metadata(usage)});
  const {saved,attempt}=await durable(f);
  assert.equal(attempt.status,'completed');assert.ok(attempt.finishedAt);
  assert.equal(attempt.outputHash,hash(text));assert.deepEqual(attempt.metadata.usage,usage);
  const response=saved.responses.find(r=>r.id===attempt.responseId);
  assert.deepEqual(response.provenance.usage,usage);assert.equal(response.provenance.contentHash,attempt.outputHash);
  assert.equal(attempt.metadata.usage.reasoningOutputTokens,4302);
});

test('observed provider truncation settles failed attempt with exact usage and error code',async t=>{
  const f=await fixture(t),usage=envelope(),partialOutput='{"synthetic":';
  await f.writer.fail(f.requestId,f.attemptId,{message:'Provider response was truncated.',partialOutput,metadata:{...metadata(usage),errorCode:'PROVIDER_TRUNCATED'}});
  const {saved,attempt}=await durable(f);
  assert.equal(attempt.status,'failed');assert.ok(attempt.finishedAt);assert.equal(attempt.metadata.errorCode,'PROVIDER_TRUNCATED');
  assert.equal(attempt.partialOutput,partialOutput);assert.deepEqual(attempt.metadata.usage,usage);
  assert.equal(saved.responses.length,0);assert.ok(saved.history.some(h=>h.action==='failed'));
});

test('unavailable usage retains null counts and sample without inventing zero',async t=>{
  const f=await fixture(t),usage=envelope(tokenUsageMeasurement());
  await f.writer.fail(f.requestId,f.attemptId,{message:'Accepted response failed.',metadata:metadata(usage)});
  const {attempt}=await durable(f);assert.deepEqual(attempt.metadata.usage,usage);
  assert.equal(attempt.metadata.usage.totalTokens,null);assert.equal(attempt.metadata.usage.samples,1);
  assert.equal(attempt.metadata.usage.availability.totalTokens,'unavailable');
});

test('partial aggregate and unavailable last response persist on cancelled attempt',async t=>{
  const f=await fixture(t),total=observed();total.samples=2;
  for(const field of Object.keys(total.availability))if(total[field]!==null)total.availability[field]='partial';
  const usage=envelope(tokenUsageMeasurement(),total);
  await f.writer.cancel(f.requestId,f.attemptId,{message:'Synthetic cancellation.',metadata:metadata(usage)});
  const {attempt}=await durable(f);assert.equal(attempt.status,'cancelled');assert.ok(attempt.finishedAt);
  assert.deepEqual(attempt.metadata.usage,usage);assert.equal(attempt.metadata.usage.availability.totalTokens,'partial');
  assert.equal(attempt.metadata.usage.last.totalTokens,null);
});

for(const [name,usage] of [
  ['legacy nested numeric and null values',{inputTokens:40,outputTokens:70,cache:{read:0},modelContextWindow:null}],
  ['empty canonical measurement',emptyTokenUsage()],
  ['null legacy usage',null],
]){
  test('preserves '+name,async t=>{
    const f=await fixture(t);
    await f.writer.recordResponse(f.requestId,f.attemptId,{output:output(f.requestId),metadata:metadata(usage)});
    const {attempt}=await durable(f);assert.deepEqual(attempt.metadata.usage,usage);assert.equal(attempt.status,'completed');
  });
}

const invalidCases=[
  ['unknown availability enum',()=>({availability:{totalTokens:'estimated'}})],
  ['unknown availability field',()=>({availability:{unrecognizedTokens:'reported'}})],
  ['non-object availability',()=>({availability:'reported'})],
  ['array availability',()=>({availability:['reported']})],
  ['numeric availability enum',()=>({availability:{totalTokens:1}})],
  ['unrelated string',()=>({note:'Synthetic explanatory text'})],
  ['nested availability outside measurements',()=>({extra:{availability:{totalTokens:'reported'}}})],
  ['invalid nested total availability',()=>({total:{availability:{totalTokens:'estimated'}}})],
  ['negative sample count',()=>({samples:-1})],
  ['fractional sample count',()=>({samples:1.5})],
  ['string sample count',()=>({last:{samples:'1'}})],
  ['unsafe sample count',()=>({samples:Number.MAX_SAFE_INTEGER+1})],
  ['numeric-string token count',()=>({totalTokens:'8759'})],
  ['negative token count',()=>({inputTokens:-1})],
  ['NaN token count',()=>({inputTokens:NaN})],
  ['infinite token count',()=>({inputTokens:Infinity})],
  ['boolean token count',()=>({inputTokens:true})],
  ['invalid usage field name',()=>({'bad.key':1})],
  ['excessive nesting',()=>({a:{b:{c:{d:{e:1}}}}})],
  ['oversized metadata',()=>Object.fromEntries(Array.from({length:200},(_,i)=>['field_'+i+'x'.repeat(65),i]))],
];
for(const [name,makeUsage] of invalidCases){
  test('rejects '+name+' without mutating durable attempt',async t=>{
    const f=await fixture(t),before=await fs.readFile(f.store.file(f.requestId));
    await assert.rejects(f.writer.fail(f.requestId,f.attemptId,{message:'Synthetic failure.',metadata:metadata(makeUsage())}),{code:'PLANNING_BROWSER_INVALID'});
    const after=await fs.readFile(f.store.file(f.requestId));assert.deepEqual(after,before);
    const {attempt}=await durable(f);assert.equal(attempt.status,'running');assert.equal(attempt.finishedAt,undefined);
  });
}
