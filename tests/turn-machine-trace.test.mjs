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
 recordTurnMachineEvent(run,wrap({type:'browser.reference',action:'click',phase:'rejected',tool:'relay_browser',code:'BROWSER_REF_STALE',bindingReason:'document-changed',observedRevision:4,currentRevision:8,topUrlChanged:true,frameLineageChanged:false,actionDispatched:false,callId:'click-call',url:'PRIVATE_URL',ref:'PRIVATE_REF',frameId:'PRIVATE_FRAME'}));
 const [entry]=projectTurnMachineTrace(run).entries;
 assert.equal(entry.kind,'browser.reference');assert.match(entry.callRef,/^[a-f0-9]{24}$/);
 assert.deepEqual(entry.metadata,{observedRevision:4,currentRevision:8,bindingReason:'document-changed',phase:'rejected',action:'click',tool:'relay_browser',code:'BROWSER_REF_STALE',topUrlChanged:true,frameLineageChanged:false,actionDispatched:false});
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
});
