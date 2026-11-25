import test from 'node:test';
import assert from 'node:assert/strict';
import { createTimeManagement } from '../lib/time-management.mjs';
import { normalizePlanningOntology, planningOntologyInstructions, TIME_MANAGEMENT_INSTRUCTIONS } from '../public/planning-module-policy.mjs';
import { createModularCompletionController, createModularEvidenceJournal, modularReviewPrompt } from '../lib/modular-completion.mjs';

const enabled = () => normalizePlanningOntology({version:2,modules:{time_management:true}});

test('time management is off by default, remains an explicit user choice, and cannot impose a stop',()=>{
  const defaults=normalizePlanningOntology();
  assert.equal(defaults.modules.time_management,false);
  assert.equal(createTimeManagement({policy:defaults}),null);
  const old={version:2,modules:{time_management:true}},before=JSON.stringify(old);
  assert.equal(normalizePlanningOntology(old).modules.time_management,true);
  assert.equal(JSON.stringify(old),before);
  assert.ok(planningOntologyInstructions(enabled()).includes(TIME_MANAGEMENT_INSTRUCTIONS));
  assert.match(TIME_MANAGEMENT_INSTRUCTIONS,/host telemetry only/);
  assert.doesNotMatch(TIME_MANAGEMENT_INSTRUCTIONS,/Reassess whether further depth changes/);
});

test('enabled clock preserves tool returns byte-for-byte and records only host-side counters',async()=>{
  let at=0,calls=0;
  const receipt={success:true,contentItems:[{type:'inputText',text:'effect confirmed'}]};
  const clock=createTimeManagement({policy:enabled(),now:()=>at});
  const call=clock.wrap(async()=>{calls++;at+=1000;return receipt;});
  assert.equal(await call({}),receipt);
  at=30000;
  assert.equal(await call({}),receipt);
  assert.equal(receipt.contentItems.length,1,'no model-facing decoration');
  assert.deepEqual(clock.snapshot(),{source:'host-time-observation',scope:'current-node-execution',
    elapsedMs:31000,toolCalls:2,toolElapsedMs:2000,toolErrors:0,
    outcomeCount:'not-inferred-from-tool-calls',deadline:'none-imposed'});
  at=99999999;
  assert.equal(await call({}),receipt,'elapsed time never terminates work');
  assert.equal(calls,3);
});

test('failed tools and thrown errors remain unchanged',async()=>{
  let at=0;const clock=createTimeManagement({policy:enabled(),now:()=>at});
  const error=Error('real failure');
  await assert.rejects(clock.wrap(async()=>{at+=20;throw error;})(),e=>e===error);
  const failure={success:false,code:'BROWSER_TAB_NOT_FOUND',actionDispatched:false,contentItems:[{type:'inputText',text:'failed'}]};
  assert.equal(await clock.wrap(async()=>failure)(),failure);
  assert.equal(clock.snapshot().toolErrors,2);
  assert.equal(clock.snapshot().toolCalls,2);
});

test('clock telemetry does not change modular completion or evidence',async t=>{
  const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),path=await import('node:path');
  const directory=await mkdtemp(path.join(tmpdir(),'blackice-time-journal-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const policy=normalizePlanningOntology({version:2,modules:{time_management:true,verification:true}}),clock=createTimeManagement({policy});
  let reviews=0;
  const controller=createModularCompletionController({policy,
    getSnapshot:async()=>({request:'x',policy,evidence:{records:[]},timeManagement:clock.snapshot()}),
    review:async()=>{reviews++;return {decision:'respond',summary:'answered',remaining:[],nextAction:'',evidenceRefs:[],blockers:[]};}});
  assert.equal(await controller.beforeFinal({output:'answer'}),null);
  assert.equal((await controller.assertReady()).ready,true);
  assert.equal(reviews,1);
  const journal=createModularEvidenceJournal({directory});
  const receipt={success:true,contentItems:[{type:'inputText',text:'exact original result'}]};
  const result=await clock.wrap(journal.wrap(async()=>receipt))({name:'fixture',callId:'only-effect',arguments:{action:'write'}});
  assert.equal(result,receipt);
  assert.equal(result.contentItems.length,1);
  assert.doesNotMatch(JSON.stringify(await journal.snapshot()),/TIME MANAGEMENT OBSERVATION/);
  assert.ok(modularReviewPrompt({request:'bounded',policy,evidence:{records:[]}},{output:'done'}).includes(TIME_MANAGEMENT_INSTRUCTIONS));
  assert.equal(modularReviewPrompt({request:'bounded',policy:normalizePlanningOntology(),evidence:{records:[]}},{output:'done'}).includes(TIME_MANAGEMENT_INSTRUCTIONS),false);
});

test('clock wrapper forwards context identity, AbortSignal, and extra arguments',async()=>{
  const abort=new AbortController(),context={signal:abort.signal,marker:{}},extra={marker:'third'},call={name:'fixture'};
  const clock=createTimeManagement({policy:enabled()});
  const result=await clock.wrap(async(...args)=>{assert.deepEqual(args,[call,context,extra]);return {success:true};})(call,context,extra);
  assert.equal(result.success,true);
  abort.abort();
  await assert.rejects(clock.wrap(async(_call,ctx)=>ctx.signal.throwIfAborted())(call,context),{name:'AbortError'});
});

test('fresh Chat ignores legacy time-management policies without mutating saved bytes',async()=>{
  const {normalizeChatOptions}=await import('../public/next/chat/options-model.mjs');
  for(const selected of [undefined,false,true]){
    const old={version:2,modules:{inference:false,verification:false,...(selected===undefined?{}:{time_management:selected})}},before=JSON.stringify(old);
    const options=normalizeChatOptions({planningOntology:old});
    assert.equal(options.planningMode,'off');
    assert.equal(options.planningOntology,undefined);
    assert.equal(JSON.stringify(old),before);
  }
});
