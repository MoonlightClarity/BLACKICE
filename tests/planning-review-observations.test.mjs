import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {verificationScriptHash} from '../lib/workbench-effect-verification.mjs';
import {planningReviewObservationSources,capturePlanningGuestObservationEvents,PLANNING_REVIEW_OBSERVATION_LIMITS} from '../lib/planning-review-observations.mjs';
import {ConversationArchive} from '../lib/conversations.mjs';
import {observationRun} from './fixtures/planning-guest-observation.mjs';

const sha=text=>createHash('sha256').update(text).digest('hex');
const ref={requestId:'request-a',cycleId:'cycle-a',nodeId:'plan-a',nodeRevision:4,responseId:'response-a'};

const observations=result=>result.records.slice(1).map(item=>JSON.parse(item.text));
const valueOf=event=>JSON.parse(event.data.item.contentItems[0].text);
const changeResult=(run,change)=>{const event=run.events[3],result=valueOf(event);change(result);event.data.item.contentItems[0].text=JSON.stringify(result);};

test('complete guest JSON values preserve empty keyed baseline arrays, exact BOM script and result provenance without minting effects',()=>{
  const values=[{uninstallEntries:[],executableHits:[],pathCommands:[],appx:[]},[false,null,'日本語',3],false,null,'a primitive JSON observation'],run=observationRun(values);
  changeResult(run,result=>{result.stderr='A captured warning remains relevant.';});
  const result=planningReviewObservationSources({run,planRef:ref}),rows=observations(result);
  assert.deepEqual(rows.map(row=>row.observations),values);assert.equal(rows[0].scriptSha256,verificationScriptHash(rows[0].script));assert.equal(rows[0].scriptEncoding,'utf8-bom');assert.equal(rows[0].scriptBytes,Buffer.byteLength(rows[0].script)+3);
  assert.equal(rows[0].stdoutSha256,sha(rows[0].stdout));assert.equal(rows[0].stderr,'A captured warning remains relevant.');assert.equal(rows[0].terminal.finishedAt,'2026-11-02T08:02:01.000Z');assert.equal(rows[0].terminal.at,'2026-11-02T08:02:02.000Z');
  for(const row of rows){assert.equal(row.effectVerified,false);assert.equal(row.criterionIds,undefined);assert.equal(row.agentId,undefined,'Do not invent guest identity absent from the host receipt.');assert.deepEqual(row.planRef,ref);assert.equal(row.dispatch.threadId,'thread-a');}
  const manifest=JSON.parse(result.manifest.text);assert.equal(manifest.executionPolicy.executionGuardrails,false);assert.equal(manifest.executionPolicy.savedOutlinePolicy,'optional-auditable-outline');assert.deepEqual(manifest.executionPolicy.taskSchemaVersions,{agent:12});
});

test('missing host bindings, wrong run/node/thread, stale Plan and incomplete job evidence cannot become observations',()=>{
  const changes=[run=>run.events.splice(0,1),run=>run.events[0].data.success=false,run=>run.events[3].runId='old-run',run=>run.events[3].nodeId='another-node',run=>run.events[2].data.turnId='another-turn',run=>run.events[1].data.item.arguments.requestId='wrong-job',run=>{const value=valueOf(run.events[1]);value.launchConfirmed=false;run.events[1].data.item.contentItems[0].text=JSON.stringify(value);},run=>run.events[1].at='2026-11-02T07:00:00Z',
    ...[r=>r.scriptSha256='0'.repeat(64),r=>r.outputComplete=false,r=>r.stdoutTruncated=true,r=>r.outputDrained=false,r=>r.childrenStopped=false,r=>r.stdout='not JSON',r=>r.stdout='1e999'].map(change=>run=>changeResult(run,change))];
  for(const change of changes){const run=observationRun();change(run);assert.equal(observations(planningReviewObservationSources({run,planRef:ref})).length,0);}
  assert.throws(()=>planningReviewObservationSources({run:observationRun(),planRef:{...ref,responseId:'old-plan'}}),{code:'PLANNING_OBSERVATION_BINDING'});
});

test('conflicting repeated terminal results remain rejected even if a later poll repeats the first value',()=>{
  const run=observationRun(),first=structuredClone(run.events.slice(2)),changed=structuredClone(first);
  changed[0].data.callId='poll-changed';changed[1].data.item.id='poll-changed';const terminal=valueOf(changed[1]);terminal.stdout='{"changed":true}';changed[1].data.item.contentItems[0].text=JSON.stringify(terminal);
  run.events.push(...changed,...first.map(event=>{event=structuredClone(event);if(event.data.callId)event.data.callId='poll-last';if(event.data.item)event.data.item.id='poll-last';return event;}));
  const result=planningReviewObservationSources({run,planRef:ref});assert.equal(observations(result).length,0);assert.ok(JSON.parse(result.manifest.text).omissions.some(row=>row.code==='CONFLICTING_TERMINAL_RESULT'));
});

test('chronological bounded selection keeps complete JSON and makes omissions explicit without keyword priorities',()=>{
  const values=[{emptyArray:[]},...Array.from({length:25},(_,index)=>({index,payload:'x'.repeat(4500)}))],run=observationRun(values),result=planningReviewObservationSources({run,planRef:ref}),rows=observations(result),manifest=JSON.parse(result.manifest.text);
  assert.deepEqual(rows[0].observations,values[0]);assert.ok(rows.length<values.length);assert.ok(manifest.omittedObservationCount>0);assert.ok(result.records.reduce((n,row)=>n+row.text.length,0)<=PLANNING_REVIEW_OBSERVATION_LIMITS.contextChars);
  for(const [index,row]of rows.entries()){assert.deepEqual(row.observations,values[index]);assert.equal(row.stdout,JSON.stringify(values[index])+'\r\n');assert.ok(result.records[index+1].text.length<=36000);}
});

test('conversation curation durably retains only bounded linked guest receipts and revalidates them after restart and recent-run eviction',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'guest-observation-archive-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const run=observationRun(),events=structuredClone(run.events),before=planningReviewObservationSources({run,planRef:ref});let live=true;
  const engine=Object.assign(new EventEmitter(),{listRuns:()=>live?[structuredClone(run)]:[],getRun:()=>{if(!live)throw Error('Evicted');return structuredClone(run);},rememberClientRequest:()=>{}});
  const archive=await new ConversationArchive({dataDir:directory,engine}).init();await archive.chain;live=false;await archive.close();
  const persisted=JSON.parse(await readFile(path.join(directory,'conversations',run.id+'.json'),'utf8'));assert.deepEqual(persisted.events,[]);assert.equal(persisted.planningGuestObservationEvents.events.length,4);assert.deepEqual(run.events,events);
  const restarted=await new ConversationArchive({dataDir:directory,engine}).init();t.after(()=>restarted.close());
  const after=planningReviewObservationSources({run:await restarted.get(run.id),planRef:ref});assert.deepEqual(after,before,'No claimed baseline or synthetic receipts may replace the original linked observations.');
  const changed=structuredClone(persisted);changed.planningGuestObservationEvents.events[1].data.item.arguments.script+=' changed';assert.throws(()=>planningReviewObservationSources({run:changed,planRef:ref}),{code:'PLANNING_OBSERVATION_BINDING'});
});

test('curated historical messages without original linked receipts remain evidence-limited instead of synthesizing observations',()=>{
  const run=observationRun();run.events=[{runId:run.id,nodeId:'agent',at:'2026-11-02T08:03:00Z',data:{type:'message',text:'Inventory was empty; everything succeeded.'}}];
  const result=planningReviewObservationSources({run,planRef:ref});assert.equal(observations(result).length,0);assert.equal(JSON.parse(result.manifest.text).selectedObservationCount,0);assert.equal(capturePlanningGuestObservationEvents(run),null);
});

test('saved outline policy is optional only for the admitted current contract with Guardrails Off',()=>{
  const policy=run=>JSON.parse(planningReviewObservationSources({run,planRef:ref}).manifest.text).executionPolicy;
  for(const version of [7,8,9,10,11,undefined]){const run=observationRun();run.nodes.agent.taskSchemaVersion=version;assert.equal(policy(run).savedOutlinePolicy,'not-established');}
  const current=observationRun();current.runtimeSettings.executionGuardrails=true;assert.equal(policy(current).savedOutlinePolicy,'enforced-execution-leaves');
  current.runtimeSettings.executionGuardrails=false;assert.equal(policy(current).savedOutlinePolicy,'optional-auditable-outline');
  current.workflow.nodes.push({id:'another',type:'agent'});current.nodes.another={status:'completed'};assert.equal(policy(current).savedOutlinePolicy,'not-established');
});

test('retention omissions and conflicting terminal tombstones survive recapture and event eviction',()=>{
  const run=observationRun(Array.from({length:35},(_,index)=>index));run.planningGuestObservationEvents=capturePlanningGuestObservationEvents(run);
  assert.equal(run.planningGuestObservationEvents.omittedCount,3);run.events=[];
  const manifest=JSON.parse(planningReviewObservationSources({run,planRef:ref}).manifest.text);assert.equal(manifest.selectedObservationCount,32);assert.equal(manifest.omittedObservationCount,3);
  run.planningGuestObservationEvents=capturePlanningGuestObservationEvents(run);assert.equal(JSON.parse(planningReviewObservationSources({run,planRef:ref}).manifest.text).omittedObservationCount,3);
  const conflict=observationRun(),original=structuredClone(conflict.events);conflict.planningGuestObservationEvents=capturePlanningGuestObservationEvents(conflict);
  changeResult(conflict,result=>{result.stdout='{"changed":true}';});conflict.planningGuestObservationEvents=capturePlanningGuestObservationEvents(conflict);
  assert.equal(conflict.planningGuestObservationEvents.events.length,0);assert.equal(conflict.planningGuestObservationEvents.omissions[0].code,'CONFLICTING_TERMINAL_RESULT');
  conflict.events=original;conflict.planningGuestObservationEvents=capturePlanningGuestObservationEvents(conflict);conflict.events=[];
  const rejected=JSON.parse(planningReviewObservationSources({run:conflict,planRef:ref}).manifest.text);assert.equal(rejected.selectedObservationCount,0);assert.equal(rejected.omittedObservationCount,1);
});

test('archive settlement capture, sparse live readback, bootstrap and restart preserve original witnesses after the event ring rolls',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'guest-observation-rollover-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const run=observationRun(),complete=structuredClone(run),before=planningReviewObservationSources({run,planRef:ref});run.events=[];let live=true;
  const engine=Object.assign(new EventEmitter(),{listRuns:()=>live?[structuredClone(run)]:[],getRun:()=>{if(!live)throw Error('Evicted');return structuredClone(run);},rememberClientRequest:()=>{}});
  let archive=await new ConversationArchive({dataDir:directory,engine}).init();
  for(const event of complete.events){run.events.push(event);engine.emit('event',{...event,type:'agent.event'});}
  await archive.chain;const liveRead=await archive.get(run.id);assert.deepEqual(planningReviewObservationSources({run:liveRead,planRef:ref}),before);await archive.capture(liveRead);assert.deepEqual(planningReviewObservationSources({run:await archive.get(run.id),planRef:ref}),before,'Presentation timeline annotations must neither conflict with nor replace original receipt identities.');
  run.events=Array.from({length:2500},(_,index)=>({runId:run.id,nodeId:'agent',at:'2026-11-02T08:03:00Z',data:{type:'delta',text:String(index)}}));
  await archive.capture(run);assert.deepEqual(planningReviewObservationSources({run:await archive.get(run.id),planRef:ref}),before);
  await archive.close();archive=await new ConversationArchive({dataDir:directory,engine}).init();assert.deepEqual(planningReviewObservationSources({run:await archive.get(run.id),planRef:ref}),before,'Bootstrap cannot replace the archive with the sparser canonical event ring.');
  await archive.close();live=false;archive=await new ConversationArchive({dataDir:directory,engine}).init();t.after(()=>archive.close());assert.deepEqual(planningReviewObservationSources({run:await archive.get(run.id),planRef:ref}),before);
});
