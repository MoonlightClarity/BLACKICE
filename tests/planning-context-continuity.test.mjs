import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PlanningBrowserStore} from '../lib/planning-browser.mjs';
import {PlanningBrowserRuntime} from '../lib/planning-browser-runtime.mjs';
import {TaskViability, viabilityDefinition, viabilityFingerprint} from '../lib/task-viability.mjs';

const currentInput='Morgan café project.';
const previousInput="Publish Morgan O'Neill's approved café project report using the saved brief.";
const originalTime='2026-10-30T12:00:00.000Z';
const latestTime='2026-10-31T00:00:00.000Z';
const workflow=()=>({id:'context-fixture',name:'Context fixture',nodes:[
  {id:'input',type:'input'},
  {id:'agent',type:'agent',name:'Worker',model:'fixture-model',effort:'low',prompt:'Complete the requested task using available evidence.'},
  {id:'output',type:'output'},
],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{planningMode:'on'}});
const snapshot=request=>JSON.parse(request.sources.find(source=>source.id==='viability:continuity')?.text||'null');
const capturedSnapshot=call=>JSON.parse(call.sources.find(source=>source.id==='viability:continuity')?.text||'null');
const recordedRun=(cwd,overrides={})=>({id:'earlier-project',taskId:'earlier-project',cwd,workflowName:'Project record',input:previousInput,
  output:'The earlier worker inspected the saved project record.',status:'cancelled',settled:true,createdAt:originalTime,finishedAt:latestTime,
  workflow:workflow(),nodes:{agent:{status:'cancelled',output:''}},
  taskState:{taskId:'earlier-project',revision:4,goal:'An agent-authored project follow-up, not a user instruction.'},
  events:[{type:'agent.event',runId:'earlier-project',nodeId:'agent',at:latestTime,data:{type:'item',stage:'completed',duringSettlement:true,threadId:'saved-thread',turnId:'saved-turn',item:{type:'dynamicToolCall',id:'saved-record-call',tool:'relay_browser',status:'completed',success:true,contentItems:[{type:'inputText',text:'Morgan café project record: observed_receipt_17.'}]}}}],...overrides});

async function fixture(t,{onCapture,historyError}={}){
  const dir=await mkdtemp(path.join(tmpdir(),'blackice-planning-context-'));
  const store=await new PlanningBrowserStore({dataDir:dir}).init(),calls=[];
  let retained=[],historyReads=0;
  const engine={listRuns:()=>{historyReads++;if(historyError)throw historyError;return structuredClone(retained);}};
  const runtime={runAgent:async options=>{
    const input=JSON.parse(options.prompt.slice(options.prompt.lastIndexOf('\n\n')+2));calls.push(input);await onCapture?.(input);
    return {output:JSON.stringify({values:Object.fromEntries(input.template.fields.map(field=>[field.id,field.label+': a bounded fixture finding.'])),grounding:input.template.fields.filter(field=>field.grounding==='required').map(field=>({field:field.id,sourceId:'viability:task'})),requirements:[],openQuestions:[],challengeResponses:[]}),threadId:'analysis-fixture',turnId:'analysis-'+calls.length};
  }};
  const settings={defaultModel:'fixture-model',defaultEffort:'low',maxSubagents:2};
  const runner=new PlanningBrowserRuntime({store,runtime,defaultCwd:dir,getSettings:()=>settings});
  const service=new TaskViability({store,runner,engine,identity:{read:async()=>({content:'The current profile names the project topic.'})},getSettings:()=>settings});
  t.after(async()=>{await runner.close();await service.close();await store.close();await rm(dir,{recursive:true,force:true});});
  const run=(overrides={})=>({id:'current-context-run',taskId:'current-context-run',input:currentInput,cwd:dir,workflow:workflow(),attachmentIds:[],planningMode:'on',createdAt:latestTime,...overrides});
  return {dir,store,service,engine,calls,run,setHistory:runs=>{retained=runs;},get historyReads(){return historyReads;}};
}

test('a new short request captures actual scoped history before its analytical assessment',async t=>{
  const f=await fixture(t),old=recordedRun(f.dir),before=structuredClone(old);
  f.setHistory([recordedRun(path.join(tmpdir(),'other-project-workspace'),{id:'other-project',input:currentInput+' OTHER_WORKSPACE_MARKER'}),recordedRun(f.dir,{id:'current-context-run',input:currentInput+' CURRENT_RUN_MARKER'}),old]);
  const result=await f.service.forRun(f.run()),request=await f.store.get(result.requestId),context=capturedSnapshot(f.calls[0]);
  assert.ok(context,'Planning must receive the history evidence that the worker can retrieve');
  assert.equal(f.calls[0].sources.find(source=>source.id==='viability:task').text,currentInput,'the current test request is not expanded or rewritten');
  assert.equal(request.objective,currentInput);
  assert.ok(context.userRequests.some(row=>row.source==='user-request'&&row.runId===old.id&&row.text===previousInput));
  const goal=context.observations.find(row=>row.source==='task-state');
  assert.equal(goal.text,old.taskState.goal);
  assert.ok(!context.userRequests.some(row=>row.text===old.taskState.goal),'an agent goal must not become a user direction');
  const receipt=context.observations.find(row=>row.source==='tool-receipt'&&row.callId==='saved-record-call');
  assert.ok(receipt);assert.equal(receipt.runId,old.id);assert.equal(receipt.nodeId,'agent');assert.equal(receipt.threadId,'saved-thread');assert.equal(receipt.turnId,'saved-turn');assert.equal(receipt.success,true);assert.equal(receipt.duringSettlement,true);
  assert.match(receipt.text,/observed_receipt_17/);
  assert.doesNotMatch(JSON.stringify(context),/OTHER_WORKSPACE_MARKER|CURRENT_RUN_MARKER/);
  assert.deepEqual(snapshot(request),context);
  assert.deepEqual(old,before);
});

test('explicit continuation requests retain literal chronology without searching unrelated runs',async t=>{
  const f=await fixture(t),earlier={source:'user-request',runId:'first-direction',at:originalTime,text:'Prepare the Morgan café project draft only.'},later={source:'user-request',runId:'later-direction',at:latestTime,text:'Use the revised supplied project brief for the remaining work.'};
  f.setHistory([recordedRun(f.dir,{input:'UNRELATED_HISTORY_MARKER'})]);
  const result=await f.service.forRun(f.run({kind:'continuation',priorUserRequests:[later,earlier]}));
  const context=snapshot(await f.store.get(result.requestId));
  assert.ok(context);
  assert.deepEqual(context.userRequests.map(row=>row.text),[earlier.text,later.text]);
  assert.deepEqual(context.userRequests.map(row=>row.at),[originalTime,latestTime]);
  assert.ok(context.userRequests.every(row=>row.source==='user-request'));
  assert.equal(f.historyReads,0,'existing conversation chronology takes precedence over broad retrieval');
});

test('the captured context stays fixed across source refresh and a held-request continuation',async t=>{
  let f;
  f=await fixture(t,{onCapture:()=>f.setHistory([recordedRun(f.dir,{input:'LATER_HISTORY_MARKER: a different project request.'})])});
  f.setHistory([recordedRun(f.dir)]);
  const original=f.run(),first=await f.service.forRun(original),saved=await f.store.get(first.requestId),frozen=structuredClone(saved.viability.definition),before=snapshot(saved);
  assert.ok(before);assert.equal(f.historyReads,1);
  let refreshed=await f.service.refreshSources(saved,saved.viability.definition);
  assert.deepEqual(snapshot(refreshed),before);assert.doesNotMatch(JSON.stringify(snapshot(refreshed)),/LATER_HISTORY_MARKER/);
  const continued=f.run({id:'continued-context-run',taskId:original.id,input:'Continue using the recorded answer.',priorUserRequests:[{source:'user-request',runId:original.id,at:latestTime,text:currentInput}],viability:{requestId:first.requestId,baseInput:currentInput,resumeChecked:true}});
  const second=await f.service.forRun(continued);refreshed=await f.store.get(second.requestId);
  assert.equal(second.requestId,first.requestId);
  assert.equal(refreshed.viability.fingerprint,viabilityFingerprint(frozen));
  assert.deepEqual(refreshed.viability.definition,frozen);
  assert.deepEqual(snapshot(refreshed),before);
  assert.equal(f.historyReads,1,'source refresh and a checked continuation reuse the captured records');
  assert.equal(f.calls.length,1,'unchanged captured evidence does not spend another analytical turn');
});

test('legacy readiness definitions retain their fingerprint and checked continuation identity',async t=>{
  const f=await fixture(t),definition={input:currentInput,cwd:f.dir,workflow:workflow(),attachmentIds:[]};
  assert.deepEqual(viabilityDefinition(definition),definition);
  let saved=await f.service.ensure({scope:'request',scopeId:'legacy-run',conversationId:'legacy-conversation',definition,linkedRunId:'legacy-run'});
  saved=await f.service.assess(saved.id);
  const fingerprint=saved.viability.fingerprint;
  const result=await f.service.forRun(f.run({id:'legacy-continuation',taskId:'legacy-conversation',input:'Continue.',priorUserRequests:[{source:'user-request',runId:'legacy-run',at:originalTime,text:previousInput}],viability:{requestId:saved.id,baseInput:currentInput,resumeChecked:true}}));
  assert.equal(result.requestId,saved.id);
  assert.equal((await f.store.get(saved.id)).viability.fingerprint,fingerprint);
  assert.equal(f.historyReads,0);
  assert.equal(f.calls.length,1);
});

test('an unavailable optional history lookup is visible and does not become a source-recovery gate',async t=>{
  const f=await fixture(t,{historyError:Object.assign(Error('Fixture history is unavailable.'),{code:'FIXTURE_HISTORY_UNAVAILABLE'})});
  const result=await f.service.forRun(f.run()),request=await f.store.get(result.requestId),context=snapshot(request);
  assert.equal(result.state,'ready');assert.equal(request.viability.recoveryIssue,null);assert.equal(f.calls.length,1);
  assert.ok(context);assert.equal(context.history.status,'unavailable');assert.match(context.history.error.message,/Fixture history is unavailable/);
  assert.deepEqual(context.userRequests,[]);
});

test('large retained continuity stays bounded and explicitly reports omitted or shortened context',async t=>{
  const f=await fixture(t),rows=Array.from({length:24},(_,index)=>({source:'user-request',runId:'prior-'+index,at:new Date(Date.UTC(2026,9,1+index)).toISOString(),text:'Morgan project record '+index+'. '+('Recorded detail. '.repeat(1500))}));
  const result=await f.service.forRun(f.run({kind:'continuation',priorUserRequests:rows})),request=await f.store.get(result.requestId),source=request.sources.find(item=>item.id==='viability:continuity'),context=snapshot(request);
  assert.ok(context);assert.ok(source.text.length<=36000,'the added captured context has its own finite budget');assert.equal(context.truncated,true);
  assert.equal(context.userRequestCount,rows.length);assert.ok(context.userRequests.length<rows.length);
  assert.equal(context.userRequests[0].runId,'prior-0');assert.equal(context.userRequests.at(-1).runId,'prior-23');
  assert.ok(context.userRequests.some(row=>row.truncated===true&&row.textLength>row.text.length));
});

test('Planning Off performs no continuity lookup or analytical work',async t=>{
  const f=await fixture(t),result=await f.service.forRun(f.run({planningMode:'off'}));
  assert.equal(result.skipped,true);assert.equal(f.historyReads,0);assert.equal(f.calls.length,0);
});
