import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {runPreparedDirectoryAgent} from '../lib/shadowdancer-engine.mjs';
import {ShadowdancerDirectory} from '../lib/shadowdancer-directory.mjs';

const model={id:'fixture-native',model:'fixture-native',contextWindowTokens:272000,runtimeDefaultContextWindowTokens:272000,
  maxContextWindowTokens:872000,effectiveContextWindowPercent:95,contextWindowSource:'runtime-reported'};
const usage=(totalInput,lastInput,window=800000)=>({
  inputTokens:totalInput,outputTokens:1200,totalTokens:totalInput+1200,
  total:{inputTokens:totalInput,outputTokens:1200,totalTokens:totalInput+1200},
  ...(lastInput===undefined?{}:{last:{inputTokens:lastInput,outputTokens:300,totalTokens:lastInput+300}}),
  modelContextWindow:window,
});
const context=(observed=null,input=null,compactionCount=0)=>({
  nativeConfiguredWindowTokens:872000,nativeDefaultContextWindowTokens:272000,nativeMaxContextWindowTokens:872000,
  nativeEffectiveContextWindowPercent:95,nativeObservedWindowTokens:observed,nativeWindowBasis:observed?'runtime-usage':'metadata-percent',
  effectiveWindowTokens:observed||828400,inputBudgetTokens:(observed||828400)-16384,
  outputReserveTokens:8192,headroomTokens:8192,compactAtTokens:812016,autoCompact:true,nativeCompaction:true,
  // An estimate deliberately larger than every measurement must never become a measured peak.
  estimatedInputTokens:9999999,actualInputTokens:input,compactionCount,
  ...(compactionCount?{lastCompaction:{id:'observed-compaction',at:'2026-11-12T19:30:00.000Z',method:'codex-native'}}:{}),
});

async function execute(t,{failIntegration=false,reported=true,resultOnly=false,retainedEvents=Infinity,unmeasuredReceipts=false,api=false}={}){
  const cwd=await mkdtemp(path.join(os.tmpdir(),'directory-context-usage-'));
  t.after(()=>rm(cwd,{recursive:true,force:true}));
  const events=[],calls=[];let pilot;
  const runtime={status:()=>({models:[{...model,...(api?{providerId:'fixture-api',providerType:'openai'}:{})}]}),runAgent:async options=>{
    const phase=JSON.parse(options.prompt.split('CURRENT_DIRECTORY:\n').at(-1));calls.push(options);
    const label=phase.label,emit=value=>options.onEvent?.({threadId:'PRIVATE_EPHEMERAL_THREAD',turnId:'PRIVATE_PROVIDER_TURN',...value});
    assert.equal(options.threadId,undefined);assert.equal(options.continuity,undefined);
    assert.equal(options.context.preset,'extended');assert.equal(options.context.compactAtTokens,812016);
    let measured=usage(label==='work'?176000000:label==='integration'?24525:17000,
      reported?(label==='work'?424813:label==='integration'?24525:17000):undefined,reported||api?800000:null);
    if(!resultOnly){
      emit({type:'thread'});emit({type:'context',context:context()});
      emit({type:'usage',usage:measured,at:'2026-11-12T19:29:00.000Z'});
      emit({type:'context',context:context(reported?800000:null,reported?measured.last.inputTokens:null)});
      if(label==='work'){
        emit({type:'item',stage:'completed',item:{id:'observed-compaction',type:'contextCompaction'},at:'2026-11-12T19:30:00.000Z'});
        emit({type:'context',context:context(reported?800000:null,reported?424813:null,1)});
        measured=usage(176200000,reported?200000:undefined,reported||api?800000:null);
        emit({type:'usage',usage:measured,at:'2026-11-12T19:31:00.000Z'});
        emit({type:'context',context:context(reported?800000:null,reported?200000:null,1)});
        if(unmeasuredReceipts){
          emit({type:'usage',usage:{...usage(1000000000,9999999),last:{inputTokens:9999999,samples:3,availability:{inputTokens:'reported'}}}});
          emit({type:'usage',usage:{...usage(1000000000,9999999),last:{inputTokens:9999999,samples:1,availability:{inputTokens:'partial'}}}});
        }
      }
    }
    if(failIntegration&&label==='integration')throw Object.assign(new Error('Synthetic integration failure.'),{code:'FIXTURE_INTEGRATION_FAILED'});
    const value=label==='decompose'?{atomic:true}:label==='integration'?{answer:'The synthetic result is supported.',used_refs:phase.payload.required_refs}:
      {status:'complete',nextAction:'',finding:'Synthetic checked result.',candidate_answer:'The synthetic result is supported.',uncertainty:''};
    return {output:JSON.stringify(value),threadId:'PRIVATE_EPHEMERAL_THREAD',usage:measured,
      context:context(reported?800000:null,reported?measured.last.inputTokens:null,label==='work'&&!resultOnly?1:0)};
  }};
  const operation=runPreparedDirectoryAgent({runtime,options:{cwd,prompt:'Outer prompt is not provider history.',
    developerInstructions:'Use the observed evidence.',sandbox:'danger-full-access',dynamicTools:[],
    // This incoming session must never be adopted by a disposable Directory phase.
    threadId:'OLD_CHAT_THREAD',continuity:{text:'OLD_PROVIDER_HISTORY'},usageBaseline:{inputTokens:500000000},
    onEvent:event=>{events.push(structuredClone(event));if(events.length>retainedEvents)events.shift();}},
    input:'/directory Explain the synthetic local result.',conversationId:'context-usage',runId:'current-run',model:'fixture-native',
    getAcceptedDirections:()=>({currentUserRequest:{text:'Explain the synthetic local result.'}}),
    onResult:value=>{pilot=value;}});
  if(failIntegration)await assert.rejects(operation,{code:'FIXTURE_INTEGRATION_FAILED'});else await operation;
  return {events,calls,pilot};
}

test('Directory keeps configured capacity separate from measured per-phase peaks and observed native windows',async t=>{
  const f=await execute(t),summary=f.pilot.stats.contextUsage;
  assert.equal(summary.configured.inputBudgetTokens,812016);
  assert.equal(summary.peakInputTokens,424813,'cumulative 176M input and token estimates are not peak context');
  assert.equal(summary.peak.modelContextWindowTokens,800000,'the actual provider window is not replaced by metadata');
  assert.deepEqual(summary.reportedModelWindows,[800000]);
  const work=summary.phases.find(row=>row.phase==='work'),integration=summary.phases.find(row=>row.phase==='integration');
  assert.equal(work.peakInputTokens,424813);assert.equal(work.lastInputTokens,200000);
  assert.equal(work.measurementUpdates,2,'the final returned usage receipt does not double-count the last update');
  assert.equal(work.initialContext.nativeConfiguredWindowTokens,872000);
  assert.equal(work.initialContext.nativeObservedWindowTokens,null);
  assert.equal(work.latestContext.nativeObservedWindowTokens,800000);
  assert.equal(integration.peakInputTokens,24525,'a fresh integration does not inherit the work-phase peak');
  assert.equal(summary.compactionCount,1,'item and context receipts refer to one observed compaction');
  assert.equal(work.compactions.length,1);assert.equal(work.compactionCount,1);
  assert.ok(summary.phases.every(row=>row.directoryTurnId&&row.phase&&row.module&&row.status==='completed'));
  assert.ok(f.events.some(event=>event.type==='directory.context'&&event.directoryTurnId===work.directoryTurnId));
  assert.ok(f.events.some(event=>event.type==='directory.compaction'&&event.directoryTurnId===work.directoryTurnId));
  assert.ok(f.events.filter(event=>event.type==='usage').every(event=>event.directoryTurnId&&event.directoryUsage));
  assert.ok(!f.events.some(event=>['thread','context'].includes(event.type)),'no resumable Chat context is adopted');
  assert.doesNotMatch(JSON.stringify(f.events),/PRIVATE_EPHEMERAL_THREAD|PRIVATE_PROVIDER_TURN|OLD_CHAT_THREAD|OLD_PROVIDER_HISTORY/);
  assert.deepEqual(f.events.findLast(event=>event.type==='directory.context.summary').contextUsage,summary);
});

test('Directory retains measured peak diagnostics on failure even when earlier events are pruned',async t=>{
  const f=await execute(t,{failIntegration:true,retainedEvents:2});
  assert.equal(f.pilot,undefined);
  const summary=f.events.findLast(event=>event.type==='directory.context.summary').contextUsage;
  assert.equal(summary.status,'failed');assert.equal(summary.peakInputTokens,424813);
  assert.equal(summary.peak.phase,'work');assert.equal(summary.compactionCount,1);
  assert.equal(summary.phases.find(row=>row.phase==='integration').status,'failed');
  assert.equal(summary.phases.find(row=>row.phase==='work').status,'completed');
});

test('missing per-call measurements remain unknown despite known capacity, estimates and cumulative usage',async t=>{
  const f=await execute(t,{reported:false}),summary=f.pilot.stats.contextUsage;
  assert.equal(summary.configured.inputBudgetTokens,812016);
  assert.equal(summary.peakInputTokens,null);assert.equal(summary.peak,null);assert.equal(summary.measuredPhases,0);
  assert.deepEqual(summary.reportedModelWindows,[]);
  assert.ok(summary.phases.every(row=>row.peakInputTokens===null&&row.lastInputTokens===null&&row.observedModelWindowTokens===null));
});

test('a provider final receipt can supply actual measurements when it emits no usage or context events',async t=>{
  const f=await execute(t,{resultOnly:true}),summary=f.pilot.stats.contextUsage;
  assert.equal(summary.peakInputTokens,424813);assert.equal(summary.peak.phase,'work');
  assert.equal(summary.peak.modelContextWindowTokens,800000);
  assert.ok(summary.phases.every(row=>row.measurementUpdates===1));
  assert.ok(summary.phases.every(row=>row.latestContext.nativeObservedWindowTokens===800000));
  assert.equal(summary.compactionCount,0);
});

test('multi-call compaction totals and partial receipts cannot replace a reported context peak',async t=>{
  const f=await execute(t,{unmeasuredReceipts:true}),summary=f.pilot.stats.contextUsage;
  assert.equal(summary.peakInputTokens,424813);
  assert.equal(summary.phases.find(row=>row.phase==='work').measurementUpdates,2);
});

test('API adapter metadata is not an observed model window',async t=>{
  const f=await execute(t,{api:true,reported:false});
  // The API adapter's copied capacity in an accounting event is not telemetry.
  assert.deepEqual(f.pilot.stats.contextUsage.reportedModelWindows,[]);
});

test('phase observers retain original usage, compaction and filtered context after Chat telemetry',async t=>{
  const cwd=await mkdtemp(path.join(os.tmpdir(),'directory-phase-observer-'));
  t.after(()=>rm(cwd,{recursive:true,force:true}));
  const chat=[],observed=[],emitted=[
    {type:'thread',threadId:'PRIVATE_THREAD',turnId:'PRIVATE_TURN'},
    {type:'context',context:context(800000,424813)},
    {type:'usage',usage:usage(176000000,424813)},
    {type:'item',stage:'completed',item:{id:'observed-compaction',type:'contextCompaction'}},
  ];
  t.mock.method(ShadowdancerDirectory.prototype,'run',async function(){
    this.onProgress({phase:'integration',module:'probe',turnId:'probe-turn',event:'started'});
    await this.runtime.runAgent({directoryTurnId:'probe-turn',prompt:'Probe saved-source context observer.',responseOnly:true,
      onEvent:event=>{observed.push(event);if(event.type==='context')assert.equal(chat.at(-1)?.type,'directory.context');}});
    return {answer:'Observer probe completed.',stats:this.stats};
  });
  await runPreparedDirectoryAgent({runtime:{status:()=>({models:[model]}),runAgent:async options=>{
    for(const event of emitted)options.onEvent(event);return {output:'{}'};
  }},options:{cwd,sandbox:'read-only',dynamicTools:[],onEvent:event=>chat.push(event)},
    input:'/directory Observe saved source.',conversationId:'observer',runId:'observer-run',model:'fixture-native'});
  assert.deepEqual(observed,emitted,'a filtered or transformed Chat event must still reach the private phase observer unchanged');
  assert.ok(!chat.some(event=>event.type==='context'||event.type==='thread'));
  assert.doesNotMatch(JSON.stringify(chat),/PRIVATE_THREAD|PRIVATE_TURN/);
});

test('the wrapper enables atomic completion only for an explicitly present outcome controller',async t=>{
  const cwd=await mkdtemp(path.join(os.tmpdir(),'directory-atomic-gate-'));
  t.after(()=>rm(cwd,{recursive:true,force:true}));
  const gates=[];
  t.mock.method(ShadowdancerDirectory.prototype,'run',async function(){gates.push(typeof this.reviewWorkCandidate==='function');return {answer:'A completed synthetic report.',stats:this.stats};});
  for(const [index,enabled]of [undefined,false,'true',true].entries()){
    await runPreparedDirectoryAgent({runtime:{status:()=>({models:[model]}),runAgent:async()=>{throw new Error('No model call belongs to the forwarding probe.');}},
      options:{cwd,sandbox:'read-only',dynamicTools:[],onBeforeFinal:async()=>null},input:'/directory Probe outcome capability.',
      conversationId:'atomic-gate',runId:'gate-'+index,model:'fixture-native',supportsAtomicOutcomeReview:enabled,
      getCompletionAssessment:()=>({decision:'respond',status:'sufficient',summary:'Synthetic outcome accepted.'})});
  }
  assert.deepEqual(gates,[false,false,false,true],'callback/getter presence alone must not authorize atomic completion');
});
