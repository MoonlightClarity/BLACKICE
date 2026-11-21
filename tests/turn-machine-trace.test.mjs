import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp,realpath,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConversationArchive } from '../lib/conversations.mjs';
import { RUN_EVENT_LIMITS,retainRunEvent } from '../lib/run-event-retention.mjs';
import { TURN_MACHINE_TRACE_LIMITS,recordTurnMachineEvent,projectTurnMachineTrace } from '../lib/turn-machine-trace.mjs';

const fixture=(directoryDiagnostics='maximal')=>({id:'trace_run',taskId:'trace_task',directoryDiagnostics,settled:true,status:'completed',
  updatedAt:'2026-11-19T14:30:00.000Z',finishedAt:'2026-11-19T14:30:00.000Z',input:'Synthetic trace fixture',
  nodes:{agent:{status:'completed'}},workflow:{nodes:[{id:'agent',type:'agent'}],edges:[]},events:[]});
const wrap=(data,type='agent.event')=>({runId:'trace_run',nodeId:'agent',type,at:'2026-11-19T14:30:00.000Z',data});
test('maximal retains all 2,900 event envelopes before ordinary timeline eviction; other modes are unchanged',()=>{
  const run=fixture();
  for(let i=0;i<2900;i++)retainRunEvent(run,wrap({type:'tool.result',tool:'relay_workspace',action:'read',callId:'call_'+i,success:true}));
  assert.equal(run.events.length,RUN_EVENT_LIMITS.maxEvents);
  assert.equal(run.eventRetention.omittedEvents,400);
  const trace=projectTurnMachineTrace(run);
  assert.equal(trace.coverage.observed,2900);
  assert.equal(trace.coverage.retained,2900);
  assert.deepEqual(trace.coverage.gaps,[]);
  assert.equal(trace.entries[0].sequence,1);
  assert.equal(trace.entries[2899].sequence,2900);
  assert.equal(trace.entries[2899].metadata.tool,'relay_workspace');
  for(const mode of ['off','on','basic','detailed']){
    const baseline=fixture(mode);retainRunEvent(baseline,wrap({type:'message',text:'ordinary visible transcript'}));
    assert.equal(baseline.events[0].data.text,'ordinary visible transcript');
    assert.equal(baseline.turnMachineTrace,undefined);
    assert.equal(projectTurnMachineTrace(baseline).coverage.observed,null);
  }
});

test('host metadata only: bound snapshot + applied mutation, opaque correlation and no reads of raw payload',()=>{
  const run=fixture();
  const secret='sk-PRIVATE-abcdef';
  const raw={type:'directory.snapshot',phase:'delivered',boundRevision:3,liveRevision:4,callId:secret,
    tool:'relay_directory_action',name:secret};
  for(const name of ['arguments','content','input','prompt','result','resultExcerpt','reasoning','text','target','message','url'])
    Object.defineProperty(raw,name,{enumerable:true,get(){assert.fail(name+' must not be read');}});
  recordTurnMachineEvent(run,wrap(raw));
  recordTurnMachineEvent(run,wrap({type:'directory.mutation',phase:'rejected',operation:'plan',suppliedRevisionType:'string',
    suppliedRevision:secret,boundRevision:3,liveRevision:4,acceptedRevision:4,reason:secret,code:'DIRECTORY_CHANGED',callId:secret}));
  recordTurnMachineEvent(run,wrap({type:'usage',model:'gpt-6-luna',providerId:secret,usage:{inputTokens:7,last:{outputTokens:3}}}));
  recordTurnMachineEvent(run,wrap({type:secret,text:secret},secret));
  recordTurnMachineEvent(run,wrap({status:'completed',error:secret},'run.updated'));
  recordTurnMachineEvent(run,{...wrap(raw),runId:'other'});
  const trace=projectTurnMachineTrace(run),json=JSON.stringify(trace.entries);
  assert.doesNotMatch(json,/PRIVATE|target|prompt|ResultExcerpt|arguments|reasoning":/);
  assert.doesNotMatch(JSON.stringify(run.turnMachineTrace),/PRIVATE/);
  assert.deepEqual(trace.entries.map(entry=>entry.kind),['directory.snapshot','directory.mutation','usage','other-event','other-event']);
  assert.equal(trace.entries[0].callRef,trace.entries[1].callRef);
  assert.equal(trace.entries[0].metadata.phase,'delivered');
  assert.equal(trace.entries[1].metadata.code,'DIRECTORY_CHANGED');
  assert.equal(trace.entries[1].metadata.operation,'plan');
  assert.equal(trace.entries[1].metadata.suppliedRevisionType,'string');
  assert.equal(trace.entries[1].metadata.suppliedRevision,undefined);
  assert.equal(trace.entries[1].metadata.acceptedRevision,4);
  assert.equal(trace.entries[2].metadata.model,'gpt-6-luna');
  assert.equal(trace.entries[2].metadata.usage.last.outputTokens,3);
  assert.equal(trace.entries[4].metadata.status,'completed');
});

test('Directory model-tool refusal codes survive projection and restore without arbitrary payload',()=>{
  const run=fixture();
  const known=['DIRECTORY_TOOL_ACTION','DIRECTORY_TOOL_ARGUMENTS','DIRECTORY_TOOL_SCHEMA'];
  const unknown=['DIRECTORY_TOOL_UNRECOGNIZED','PRIVATE_ERROR_CODE'];
  for(const code of [...known,...unknown]){
    const raw={type:'directory.mutation',phase:'rejected',operation:'plan',code,actionDispatched:false,secret:'PRIVATE_VALUE'};
    for(const name of ['arguments','claim','message','result','prompt','error','reasoning','text'])
      Object.defineProperty(raw,name,{enumerable:true,get(){assert.fail(name+' must not be read');}});
    recordTurnMachineEvent(run,wrap(raw));
  }
  const expected=[
    ...known.map(code=>({phase:'rejected',operation:'plan',code,actionDispatched:false})),
    ...unknown.map(()=>({phase:'rejected',operation:'plan',actionDispatched:false}))
  ];
  const projected=value=>projectTurnMachineTrace(value).entries.map(entry=>entry.metadata);
  assert.deepEqual(projected(run),expected);
  assert.doesNotMatch(JSON.stringify(run.turnMachineTrace),/PRIVATE|DIRECTORY_TOOL_UNRECOGNIZED/);
  const restored=JSON.parse(JSON.stringify(run));
  for(const entry of restored.turnMachineTrace.head)
    Object.assign(entry.metadata,{arguments:'PRIVATE_ARGUMENTS',message:'PRIVATE_MESSAGE',result:'PRIVATE_RESULT',prompt:'PRIVATE_PROMPT',reason:'PRIVATE_REASON'});
  unknown.forEach((code,index)=>{restored.turnMachineTrace.head[known.length+index].metadata.code=code;});
  assert.deepEqual(projected(restored),expected);
  assert.doesNotMatch(JSON.stringify(projectTurnMachineTrace(restored)),/PRIVATE|DIRECTORY_TOOL_UNRECOGNIZED/);
});

test('workspace run action survives JSON round-trip without command or output',()=>{
  const run=fixture();
  const workspace={type:'workspace.action',action:'run'};
  const result={type:'tool.result',tool:'relay_workspace',status:'completed',success:true,action:'run',callId:'workspace-call'};
  for(const row of [workspace,result])
    for(const key of ['command','arguments','output','target','result','message'])
      Object.defineProperty(row,key,{enumerable:true,get(){assert.fail(key+' must not be read');}});
  recordTurnMachineEvent(run,wrap(workspace));
  recordTurnMachineEvent(run,wrap(result));
  const expected=[
    ['workspace.action',{action:'run'}],
    ['tool.result',{action:'run',tool:'relay_workspace',status:'completed',success:true}]
  ];
  const projection=value=>projectTurnMachineTrace(value).entries.map(({kind,metadata})=>[kind,metadata]);
  assert.deepEqual(projection(run),expected);
  const restored={...fixture(),turnMachineTrace:JSON.parse(JSON.stringify(run.turnMachineTrace))};
  assert.deepEqual(projection(restored),expected);
});

test('maximal keeps provider termination separate from host acceptance and omits non-allowlisted text',()=>{
  const run=fixture();
  const raw={type:'provider.final',providerType:'compatible',providerTermination:'stop',reviewConfigured:false,remainingSteps:2,incomplete:false,turnId:'one'};
  for(const name of ['output','prompt','reasoning','candidate']) Object.defineProperty(raw,name,{get(){assert.fail(name+' must not be read');}});
  recordTurnMachineEvent(run,wrap(raw));
  recordTurnMachineEvent(run,wrap({type:'host.final-review',reviewDecision:'not-configured',turnId:'one'}));
  recordTurnMachineEvent(run,wrap({type:'provider.final',providerType:'mistral-vibe',providerTermination:'not-an-observed-reason',reviewConfigured:true}));
  recordTurnMachineEvent(run,wrap({type:'host.final-review',reviewDecision:'rejected',code:'DIRECTORY_ACTION_UNFINISHED'}));
  const trace=projectTurnMachineTrace(run);
  assert.equal(trace.entries[0].turnRef,trace.entries[1].turnRef);
  assert.deepEqual(trace.entries.map(({kind,metadata})=>[kind,metadata]),[
    ['provider.final',{providerType:'compatible',providerTermination:'stop',reviewConfigured:false,remainingSteps:2,incomplete:false}],
    ['host.final-review',{reviewDecision:'not-configured'}],
    ['provider.final',{providerType:'mistral-vibe',reviewConfigured:true}],
    ['host.final-review',{reviewDecision:'rejected',code:'DIRECTORY_ACTION_UNFINISHED'}]
  ]);
});

test('ring limit keeps first and latest observations, reports exact dropped span, and does not invent restored detail',()=>{
  const run=fixture(), {headEntries,tailEntries}=TURN_MACHINE_TRACE_LIMITS,total=headEntries+tailEntries+87;
  for(let i=0;i<total;i++)recordTurnMachineEvent(run,wrap({type:'delta'}));
  const trace=projectTurnMachineTrace(run);
  assert.equal(trace.entries.length,headEntries+tailEntries);
  assert.equal(trace.coverage.observed,total);
  assert.equal(trace.coverage.dropped,87);
  assert.deepEqual(trace.coverage.gaps,[{from:headEntries+1,to:headEntries+87}]);
  assert.equal(trace.entries.at(-1).sequence,total);
  run.turnMachineTrace.head.splice(10,1);
  run.turnMachineTrace.head[0].metadata={reason:'SECRET_IN_RESTORED',result:'SECRET_IN_RESTORED',itemKind:'danger'};
  const recovered=projectTurnMachineTrace(JSON.parse(JSON.stringify(run)));
  assert.deepEqual(recovered.coverage.gaps,[{from:11,to:11},{from:headEntries+1,to:headEntries+87}]);
  assert.equal(recovered.coverage.dropped,88);
  assert.doesNotMatch(JSON.stringify(recovered),/SECRET_IN_RESTORED/);
  assert.equal(projectTurnMachineTrace({...run,turnMachineTrace:undefined}).coverage.source,'not-recorded');
});

test('real conversation archive reopens the safe journal independently of retained timeline',async t=>{
  const temp=await realpath(tmpdir()),dir=await mkdtemp(path.join(temp,'blackice-machine-trace-'));
  class NoLive extends EventEmitter{runs=new Map();listRuns(){return[];}getRun(){throw Error('No live run');}}
  const engine=new NoLive(), stores=[];
  t.after(async()=>{
    for(const archive of stores)await archive.close();
    const resolved=await realpath(dir);
    assert.equal(path.dirname(resolved),temp);
    assert.match(path.basename(resolved),/^blackice-machine-trace-/);
    await rm(resolved,{recursive:true,force:true});
  });
  const run=fixture();const first=await new ConversationArchive({dataDir:dir,engine}).init();stores.push(first);
  retainRunEvent(run,wrap({type:'tool.result',tool:'relay_workspace',success:false,code:'TOOL_UNAVAILABLE',result:'never copied into trace'}));
  retainRunEvent(run,wrap({type:'planning.module',moduleId:'builtin-decomposition',artifact:'pending-actions',phase:'completed',revision:8}));
  retainRunEvent(run,wrap({type:'workspace.search.coverage',tool:'relay_workspace',action:'search',callId:'coverage',searchScope:'explicit-file',searchBackend:'rg',searchRoute:'rg',timedOut:true,truncated:true,matchLimit:50,output:'PRIVATE_RESULT'}));
  run.events.length=0;
  await first.capture(run);await first.close();
  const reopened=await new ConversationArchive({dataDir:dir,engine:new NoLive()}).init();stores.push(reopened);
  const ordinary=await reopened.get(run.id);assert.equal(ordinary.turnMachineTrace,undefined);
  const saved=await reopened.get(run.id,{includeMachineTrace:true});
  assert.equal(saved.events.length,0);
  const trace=projectTurnMachineTrace(saved);
  assert.equal(trace.entries.length,3);
  assert.equal(trace.entries[0].metadata.code,'TOOL_UNAVAILABLE');
  assert.equal(trace.entries[1].metadata.moduleId,'builtin-decomposition');
  assert.equal(trace.entries[1].metadata.revision,8);
  assert.equal(trace.entries[2].metadata.timedOut,true);
  assert.equal(trace.entries[2].metadata.returnedMatches,undefined);
  assert.doesNotMatch(JSON.stringify(trace),/never copied into trace|PRIVATE_RESULT/);
});

test('browser binding diagnosis survives machine export with only host comparisons and run-scoped call reference',()=>{
 const run=fixture();
 recordTurnMachineEvent(run,wrap({type:'browser.reference',action:'click',phase:'rejected',tool:'relay_browser',code:'BROWSER_REF_STALE',bindingReason:'document-changed',observedRevision:4,retiredAtRevision:6,currentRevision:8,bindingEvent:'in-page-navigation',topUrlChanged:true,frameLineageChanged:false,actionDispatched:false,callId:'click-call',url:'PRIVATE_URL',ref:'PRIVATE_REF',frameId:'PRIVATE_FRAME'}));
 const [entry]=projectTurnMachineTrace(run).entries;
 assert.equal(entry.kind,'browser.reference');assert.match(entry.callRef,/^[a-f0-9]{24}$/);
 assert.deepEqual(entry.metadata,{observedRevision:4,retiredAtRevision:6,currentRevision:8,bindingEvent:'in-page-navigation',bindingReason:'document-changed',phase:'rejected',action:'click',tool:'relay_browser',code:'BROWSER_REF_STALE',topUrlChanged:true,frameLineageChanged:false,actionDispatched:false});
 assert.doesNotMatch(JSON.stringify(entry),/PRIVATE|click-call/);
});

test('maximal machine trace reprojects only bounded renderer binding diagnostics on export',()=>{
 const run=fixture();
 recordTurnMachineEvent(run,wrap({type:'browser.reference',action:'fill',phase:'rejected',bindingReason:'control-changed',controlBindingCause:'identity-changed',controlBindingPhase:'fill-ready',controlNameChanged:true,controlTypeChanged:'PRIVATE_TYPE',value:'PRIVATE_VALUE'}));
 recordTurnMachineEvent(run,wrap({type:'browser.reference',action:'fill',bindingReason:'control-changed',controlBindingCause:'PRIVATE_CAUSE',controlBindingPhase:'PRIVATE_PHASE',controlNameChanged:true}));
 const [valid,invalid]=projectTurnMachineTrace(run).entries;
 assert.deepEqual(valid.metadata,{bindingReason:'control-changed',phase:'rejected',action:'fill',controlBindingCause:'identity-changed',controlBindingPhase:'fill-ready',controlNameChanged:true});
 assert.deepEqual(invalid.metadata,{bindingReason:'control-changed',action:'fill'});
 assert.doesNotMatch(JSON.stringify([valid,invalid]),/PRIVATE/);
});

test('workspace search coverage matches the same call in maximal export, safely reprojects after rehydration',()=>{
 const run=fixture();
 const callId='opaque-fixture-search';
 const data={type:'workspace.search.coverage',tool:'relay_workspace',action:'search',callId,searchScope:'explicit-file',
  searchBackend:'filesystem',searchRoute:'rg-unavailable',returnedMatches:2,scannedFiles:1,skippedFiles:0,
  perFileByteLimit:16*1024*1024,matchLimit:50,truncated:false};
 for(const key of ['path','query','output','matches','contentItems'])
  Object.defineProperty(data,key,{enumerable:true,get(){assert.fail('producer payload must not be read: '+key);}});
 recordTurnMachineEvent(run,wrap(data));
 recordTurnMachineEvent(run,wrap({type:'tool.result',tool:'relay_workspace',action:'search',success:true,callId}));
 const restored=JSON.parse(JSON.stringify(run));
 Object.assign(restored.turnMachineTrace.head[0].metadata,{path:'PRIVATE_PATH',query:'PRIVATE_QUERY',returnedMatches:'PRIVATE_BAD_COUNT'});
 const [coverage,result]=projectTurnMachineTrace(restored).entries;
 assert.equal(coverage.kind,'workspace.search.coverage');
 assert.equal(coverage.callRef,result.callRef);
 assert.match(coverage.callRef,/^[0-9a-f]{24}$/);
 assert.deepEqual(coverage.metadata,{action:'search',tool:'relay_workspace',truncated:false,searchScope:'explicit-file',
  searchBackend:'filesystem',searchRoute:'rg-unavailable',scannedFiles:1,skippedFiles:0,
  perFileByteLimit:16*1024*1024,matchLimit:50});
 assert.doesNotMatch(JSON.stringify(projectTurnMachineTrace(restored)),/PRIVATE_|opaque-fixture-search/);
 const live=projectTurnMachineTrace(run).entries[0];
 assert.equal(live.metadata.returnedMatches,2);
 assert.equal(live.metadata.timedOut,undefined);
 const preview=JSON.parse(JSON.stringify(run));
 Object.assign(preview.turnMachineTrace.head[0].metadata,{resultPreviewOnly:true,truncated:true,returnedMatches:100});
 const replayed=projectTurnMachineTrace(preview).entries[0];
 assert.equal(replayed.metadata.resultPreviewOnly,true);
 assert.equal(replayed.metadata.returnedMatches,undefined);
});


test('browser observations rehydrate as bounded returned evidence without unrelated claims or raw data',()=>{
 const run=fixture();
 const data={type:'browser.observation',action:'click',phase:'returned',tool:'relay_browser',
  callRef:'abcd'.repeat(6),frameCount:1,contentFrameCount:1,enabledControlCount:2};
 for(const key of ['url','frameText','values','screenshot','callId'])
  Object.defineProperty(data,key,{get(){assert.fail('browser payload must not be read: '+key);}});
 recordTurnMachineEvent(run,wrap(data));
 const restored=JSON.parse(JSON.stringify(run));
 Object.assign(restored.turnMachineTrace.head[0].metadata,{url:'PRIVATE_URL',text:'PRIVATE_TEXT',
  phase:'delivered',success:true,actionDispatched:true,frameCount:999,enabledControlCount:'PRIVATE_VALUE'});
 const evidence=projectTurnMachineTrace(restored).entries[0];
 assert.equal(evidence.kind,'browser.observation');
 assert.equal(evidence.callRef,data.callRef);
 assert.deepEqual(evidence.metadata,{tool:'relay_browser',phase:'returned',action:'click',contentFrameCount:1});
 assert.doesNotMatch(JSON.stringify(evidence),/PRIVATE_|dispatch|deliver|success/);
});

test('maximal export preserves controlled continuation reasons and browser tabs, not free text',()=>{
  const run=fixture();
  retainRunEvent(run,wrap({type:'tool.result',tool:'relay_browser',action:'tabs',success:true,result:'Private tab title'}));
  retainRunEvent(run,wrap({type:'chat.execution-review',reviewMode:'ordinary-chat',reviewDecision:'accepted',reason:'blocker-wording-matched',candidate:'Private draft'}));
  retainRunEvent(run,wrap({type:'chat.execution-review',reason:'not on the allowlist'}));
  const {entries}=projectTurnMachineTrace(run);
  assert.equal(entries[0].metadata.action,'tabs');
  assert.deepEqual(entries[1].metadata,{reviewMode:'ordinary-chat',reviewDecision:'accepted',reason:'blocker-wording-matched'});
  assert.equal(entries[2].metadata?.reason,undefined);
  assert.doesNotMatch(JSON.stringify(entries),/Private|not on the allowlist/);
});

test('destination references join click and inspection after trace restore',()=>{
 const run=fixture(), popup='a'.repeat(24), parent='b'.repeat(24);
 recordTurnMachineEvent(run,wrap({type:'browser.destination',action:'click',phase:'popup-during-click',
   callRef:'1'.repeat(24),browserTabRef:popup,sourceBrowserTabRef:parent,url:'private popup address'}));
 recordTurnMachineEvent(run,wrap({type:'browser.destination',action:'snapshot',phase:'inspection-returned',
   callRef:'2'.repeat(24),browserTabRef:popup,tabId:'private raw tab'}));
 const {entries}=projectTurnMachineTrace(JSON.parse(JSON.stringify(run)));
 assert.equal(entries[0].browserTabRef,entries[1].browserTabRef);
 assert.equal(entries[0].sourceBrowserTabRef,parent);
 assert.equal(entries[0].metadata.phase,'popup-during-click');
 assert.equal(entries[1].metadata.phase,'inspection-returned');
 assert.notEqual(entries[0].callRef,entries[1].callRef);
 assert.doesNotMatch(JSON.stringify(entries),/private/);
});
