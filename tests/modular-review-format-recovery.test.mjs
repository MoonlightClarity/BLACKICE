import test from 'node:test';
import assert from 'node:assert/strict';
import {createModularCompletionController,reviewModularOutcome,modularReviewPrompt} from '../lib/modular-completion.mjs';

const policy={version:2,modules:{verification:true}};
const snapshot={request:{id:'user-request',text:'Save and verify the requested output.'},policy,evidence:{records:[{id:'receipt',result:{saved:true}}]}};
const candidate={output:'The requested output is saved.'};
const good=()=>({decision:'respond',summary:'The requested output is supported.',remaining:[],nextAction:'',evidenceRefs:['evidence-0001'],blockers:[]});

test('malformed required fields are retained and repaired without task replay or silent coercion',async()=>{
  const updates=[],calls=[];let returns=0;
  const malformed={...good(),remaining:null};
  const c=createModularCompletionController({policy,getSnapshot:()=>snapshot,onUpdate:r=>updates.push(r),onReturn:()=>returns++,
    review:async args=>{calls.push(args);return calls.length===1?malformed:good();}});
  await c.beforeFinal(candidate);
  assert.equal(calls.length,2);assert.equal(returns,0);
  assert.ok(calls.every(x=>x.snapshot===snapshot&&x.candidate===candidate));
  assert.equal(updates[1].assessment.remaining,null);
  assert.deepEqual(updates[1].validation.fieldErrors,['remaining: expected string array']);
  assert.deepEqual(calls[1].repair.previousAssessment,malformed);
  const prompt=modularReviewPrompt(snapshot,candidate,calls[1].repair);
  assert.match(prompt,/ASSESSMENT FORMAT CORRECTION ONLY/);assert.doesNotMatch(prompt,/EVIDENCE CITATION CORRECTION ONLY/);
  assert.equal((await c.assertReady()).ready,true);
});

test('unreadable review output preserves raw evidence and usage then uses read-only schema repair',async()=>{
  const updates=[],requests=[],usage=[];let returns=0;
  const runtime={async runAgent(options){
    requests.push(options);assert.equal(options.sandbox,'read-only');assert.equal(options.responseOnly,true);
    assert.equal(options.dynamicTools,undefined);
    return {output:requests.length===1?'{"decision":':JSON.stringify(good()),usage:{totalTokens:17}};
  }};
  const c=createModularCompletionController({policy,getSnapshot:()=>snapshot,onUpdate:r=>updates.push(r),onReturn:()=>returns++,
    review:args=>reviewModularOutcome({runtime,cwd:process.cwd(),model:'fixture',...args,onUsage:u=>usage.push(u)})});
  await c.beforeFinal(candidate);
  assert.equal(requests.length,2);assert.equal(returns,0);assert.equal(usage.length,2);
  assert.equal(updates[1].unparsedOutput,'{"decision":');
  assert.match(requests[1].prompt,/unreadable JSON/);
  assert.equal((await c.assertReady()).ready,true);
});

test('persistent invalid fields stop after a shared three-assessment budget and never mark completion',async()=>{
  const updates=[];let calls=0,returns=0;
  const c=createModularCompletionController({policy,getSnapshot:()=>snapshot,onUpdate:r=>updates.push(r),onReturn:()=>returns++,
    review:async()=>{calls++;return {...good(),blockers:[null]};}});
  await assert.rejects(c.beforeFinal(candidate),{code:'MODULAR_REVIEW_INVALID'});
  assert.equal(calls,3);assert.equal(returns,0);
  assert.equal(updates.at(-1).status,'rejected-format');assert.deepEqual(updates.at(-1).assessment.blockers,[null]);
  await assert.rejects(c.assertReady(),{code:'MODULAR_OUTCOME_INCOMPLETE'});
});

test('format repair does not bypass citation validation or reset total repair budget',async()=>{
  let calls=0;const updates=[];
  const c=createModularCompletionController({policy,getSnapshot:()=>snapshot,onUpdate:r=>updates.push(r),review:async()=>{
    calls++;return calls===1?null:{...good(),evidenceRefs:['invented']};
  }});
  await assert.rejects(c.beforeFinal(candidate),{code:'MODULAR_REVIEW_EVIDENCE'});
  assert.equal(calls,3);assert.equal(updates.at(-1).status,'rejected-evidence');
});

test('format repair preserves genuine remaining work rather than promoting it to completion',async()=>{
  let calls=0,returns=0;
  const c=createModularCompletionController({policy,getSnapshot:()=>snapshot,onReturn:()=>returns++,review:async()=>{
    calls++;return calls===1?{...good(),decision:'invalid'}:{...good(),decision:'continue',remaining:['Verify output contents'],nextAction:'Read the saved output.'};
  }});
  const result=await c.beforeFinal(candidate);
  assert.ok(result);assert.equal(returns,1);
  await assert.rejects(c.assertReady(),{code:'MODULAR_OUTCOME_INCOMPLETE'});
});

test('provider, capacity and cancellation errors are not retried as formatting',async()=>{
  for(const code of ['ABORT_ERR','MODULAR_REVIEW_CONTEXT_CAPACITY','PROVIDER_UNAVAILABLE']){
    let calls=0;
    const c=createModularCompletionController({policy,getSnapshot:()=>snapshot,review:async()=>{calls++;throw Object.assign(new Error(code),{code});}});
    await assert.rejects(c.beforeFinal(candidate),{code});assert.equal(calls,1);
  }
});
