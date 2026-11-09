import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { compactRunEvent, compactRunHistory, retainRunEvent, RUN_EVENT_LIMITS } from '../lib/run-event-retention.mjs';
import { archiveOversizedRuns } from '../lib/run-history-archive.mjs';
import { AtomicJsonSnapshots } from '../lib/coalescing-persistence.mjs';
import { HarnessEngine } from '../lib/engine.mjs';
import { executionProjection, recordedExecutionOutputs } from '../lib/response-cycle.mjs';

const make = (type, state, at='2026-11-02T18:00:00Z') =>
  ({ type:'agent.event', runId:'run-one', nodeId:'agent', at, data:{type,taskId:'task-one',state} });
const taskState=revision=>({
  taskId:'task-one',revision,
  plan:{origin:'agent',authoredBy:{runId:'run-one',nodeId:'agent'}},
  planningReviews:[{runId:'run-one',decision:'respond'}],
  steps:[{id:'a',evidence:'x'.repeat(900000)}]
});

test('task-state snapshots become small timeline receipts without losing plan revisions or conclusions', () => {
  const input=make('task.state',taskState(42));
  const projected=compactRunEvent(input);
  assert.equal(projected.data.state.revision,42);
  assert.equal(projected.data.state.plan.authoredBy.runId,'run-one');
  assert.equal(projected.data.state.planningReviews[0].decision,'respond');
  assert.ok(JSON.stringify(projected).length<1500);
  assert.equal(input.data.state.steps[0].evidence.length,900000,'live full event is not mutated');
});

test('heavy tool result events are indexed while real assistant messages remain intact', () => {
  const giant={type:'agent.event',runId:'run-one',at:'2026-11-02T18:00:01Z',data:{
    type:'item',stage:'completed',item:{type:'dynamicToolCall',tool:'relay_browser',id:'call-one',
      arguments:{action:'snapshot',tabId:'tab-a'},status:'completed',success:true,
      contentItems:[{type:'inputText',text:'z'.repeat(800000)}]}
  }};
  const small=compactRunEvent(giant);
  assert.ok(JSON.stringify(small).length<1300);
  assert.equal(small.data.item.action,'snapshot');
  assert.equal(small.data.item.target,'tab-a');
  assert.equal(small.data.item.omittedChars,800000-300);
  const answer={type:'agent.event',runId:'run-one',data:{type:'item',stage:'completed',item:{type:'agentMessage',text:'Final answer from the saved source.'}}};
  assert.deepEqual(compactRunEvent(answer),answer);
});

test('settled Planning review receives visible browser text from the exact compacted call', () => {
  const engine=new HarnessEngine({runtime:{},dataDir:'C:\\temp\\for-test',defaultCwd:'C:\\temp'});
  engine.schedulePersist=()=>{};
  const run={id:'run-one',planningMode:'on',responseCycle:{planRef:{responseId:'adopted-plan'}},
    workflow:{nodes:[{id:'agent',type:'agent',name:'Review the listing'}]},
    nodes:{agent:{status:'completed',output:'The listing is remote and discloses a pay range.'}},events:[]};
  const visible='Current operations analyst listing\nRemote in the US\nCompensation $95,000–$115,000';
  const payload={
    browserPadding:'a'.repeat(400),
    url:'https://user:password@example.test/jobs/analyst?token=query-secret#fragment-secret',
    title:'Operations analyst',documentId:'observed-document-1',
    tabs:[{title:'private-inventory'}],
    frames:[{}, {text:visible,elements:[{name:'private-control',value:'secret-input'}],
      forms:[{action:'private-form'}],semanticRecords:[{text:'private-metadata'}]}]
  };
  engine.notify('agent.event',run,'agent',{type:'tool.result',tool:'relay_browser',action:'read',callId:'listing-call',success:true,status:'completed'});
  engine.notify('agent.event',run,'agent',{type:'item',stage:'completed',item:{type:'dynamicToolCall',tool:'relay_browser',
    id:'listing-call',status:'completed',success:true,arguments:'{"action":"read","tabId":"observed-tab"}',
    contentItems:[{type:'inputText',text:JSON.stringify(payload)},{type:'inputImage',imageUrl:'private-image'}]}});
  const compact=run.events[1], saved=compact.data.item;
  assert.equal(saved.action,'read');
  assert.equal(saved.target,'observed-tab');
  assert.ok(!saved.resultExcerpt.includes(visible));
  assert.ok(!Object.hasOwn(saved,'contentItems'));
  assert.deepEqual(saved.reviewObservation,{url:'https://example.test/jobs/analyst',title:'Operations analyst',
    documentId:'observed-document-1',frames:[{index:1,length:visible.length,sourceTruncated:false,text:visible}]});
  assert.deepEqual(compactRunEvent(compact),compact);

  const first=executionProjection(run,'listing-cycle',recordedExecutionOutputs(run));
  assert.equal(first.limited,false);
  const sources=first.records.map(record=>JSON.parse(record.text));
  const projection=sources.find(source=>source.projection).projection;
  const calls=sources.flatMap(source=>source.calls||[]);
  const [call]=calls;
  assert.equal(calls.length,1);
  assert.equal(call.callId,'listing-call');
  assert.equal(call.action,'read');
  assert.equal(call.records.length,2);
  assert.deepEqual(call.documents,[{record:1,url:'https://example.test/jobs/analyst',title:'Operations analyst',
    documentId:'observed-document-1',visibleText:[{frameIndex:1,length:visible.length,retainedPrefixLength:visible.length,sourceTruncated:false}]}]);
  const [observation]=call.observations;
  assert.equal(projection.pathTable[observation.pathRef],'/reviewObservation/frames/0/text');
  const text=sources.flatMap(source=>source.texts||[]).find(entry=>entry.id===observation.textRef);
  assert.deepEqual(text.ranges,[{start:0,end:visible.length,text:visible}]);
  for(const secret of ['user:password','query-secret','fragment-secret','secret-input','private-form','private-inventory','private-metadata','private-image'])
    assert.ok(!JSON.stringify(sources).includes(secret));

  const restored=JSON.parse(JSON.stringify(run));
  compactRunHistory(restored);
  compactRunHistory(restored);
  assert.deepEqual(restored.events,run.events);
  assert.deepEqual(executionProjection(restored,'listing-cycle',recordedExecutionOutputs(restored)),first);
});

test('browser review retains a bounded prefix of successful, unprotected observations in adopted runs', () => {
  const run={id:'run-one',planningMode:'on',responseCycle:{planRef:{responseId:'adopted-plan'}}};
  const visible='🤝\n'.repeat(9000);
  const result={url:'https://example.test/listing',frames:[{text:visible,truncated:true}]};
  const item={type:'dynamicToolCall',id:'listing-call',tool:'relay_browser',arguments:{action:'open',url:result.url},
    status:'completed',success:true,contentItems:[{type:'inputText',text:JSON.stringify(result)}]};
  const event={type:'agent.event',runId:run.id,nodeId:'agent',data:{type:'item',stage:'completed',item}};
  retainRunEvent(run,event);
  const {reviewObservation}=run.events.at(-1).data.item;
  assert.ok(Buffer.byteLength(JSON.stringify(reviewObservation))<=8*1024);
  const [frame]=reviewObservation.frames;
  assert.equal(frame.length,visible.length);
  assert.equal(frame.sourceTruncated,true);
  assert.ok(frame.text.length>1000&&frame.text.length<visible.length);
  assert.ok(visible.startsWith(frame.text));
  assert.doesNotMatch(frame.text,/[\uD800-\uDBFF]$/);

  for(const excluded of [
    {...item,arguments:{action:'click'}},
    {...item,success:false},
    {...item,status:'inProgress'},
    {...item,contentItems:[{type:'inputText',text:JSON.stringify({...result,protectedContent:true})}]},
    {...item,arguments:{action:'open',url:'file:///private'},contentItems:[{type:'inputText',text:JSON.stringify({...result,url:'file:///private'})}]}
  ]) {
    const stage=excluded.status==='inProgress'?'started':'completed';
    retainRunEvent(run,{...event,data:{...event.data,stage,item:excluded}});
    assert.ok(!Object.hasOwn(run.events.at(-1).data.item,'reviewObservation'));
  }
  const unplanned={id:'unplanned',planningMode:'on'};
  retainRunEvent(unplanned,event);
  assert.ok(!Object.hasOwn(unplanned.events[0].data.item,'reviewObservation'));
});

test('thousands of large snapshots remain well below the per-run event budget', () => {
  const run={id:'run-one',events:[],taskState:taskState(10)};
  for(let i=1;i<=1100;i++)retainRunEvent(run,make('task.state',taskState(i)));
  assert.ok(run.eventRetention.bytes<RUN_EVENT_LIMITS.perRunBytes,JSON.stringify(run.eventRetention));
  assert.ok(run.events.length<=RUN_EVENT_LIMITS.maxEvents);
  assert.equal(run.taskState.steps[0].evidence.length,900000);
  assert.equal(run.events.at(-1).data.state.revision,1100);
});

test('the live event subscriber still receives full Planning evidence while stored history is projected', () => {
  const engine=new HarnessEngine({runtime:{},dataDir:'C:\\temp\\for-test',defaultCwd:'C:\\temp'});
  engine.schedulePersist=()=>{};
  const run={id:'run-one',taskId:'task-one',events:[],nodes:{}};
  let original;
  engine.on('event',event=>{original=event});
  engine.notify('agent.event',run,'agent',{type:'task.state',state:taskState(17),taskId:'task-one'});
  assert.equal(original.data.state.steps[0].evidence.length,900000);
  assert.equal(run.events[0].data.state.revision,17);
  assert.ok(JSON.stringify(run.events).length<1600);
});

test('content-addressed original archive is byte-identical and reused without overwriting it',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'blackice-run-archive-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const original=JSON.stringify([{id:'one',events:[make('task.state',taskState(1))]}]);
  await writeFile(path.join(dir,'runs.json'),original);
  const saved=await archiveOversizedRuns(dir,{thresholdBytes:100});
  assert.ok(saved?.relativePath?.startsWith('run-event-archives/'));
  assert.equal(saved.sha256,createHash('sha256').update(original).digest('hex'));
  const at=path.join(dir,saved.relativePath);
  assert.equal(await readFile(at,'utf8'),original);
  assert.equal((await archiveOversizedRuns(dir,{thresholdBytes:100})).relativePath,saved.relativePath);
  assert.equal((await readdir(path.join(dir,'run-event-archives'))).length,1);
  const compact={id:'one',taskId:'one',events:[compactRunEvent(make('task.state',taskState(1)))],eventRetention:{sourceArchive:saved}};
  await writeFile(path.join(dir,'runs.json'),JSON.stringify([compact]));
  assert.equal(await readFile(at,'utf8'),original,'migration may never mutate the immutable full archive');
});

test('validated startup archive is not reparsed on its first shorter write, with current and backup intact',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'blackice-prime-history-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'runs.json'),full='[{"id":"a","events":[1,2,3]}]';
  await writeFile(file,full);
  const writer=new AtomicJsonSnapshots(dir);
  const before=await stat(file);
  const valid=JSON.parse(await readFile(file,'utf8'));
  assert.equal(valid[0].id,'a');
  writer.primeValidated('runs.json',full,before,await stat(file));
  const compact='[{"id":"a","events":[]}]';
  assert.equal(await writer.write('runs.json',compact),true);
  assert.equal(await readFile(file,'utf8'),compact);
  assert.equal(await readFile(file+'.bak','utf8'),full);
  const installedStat=await stat(file);
  assert.throws(()=>writer.primeValidated('runs.json','different',before,installedStat),{code:'STORAGE_CHANGED'});
});

test('existing saved run histories are compacted without losing durable messages',()=>{
  const run={events:[
    make('task.state',taskState(1)),
    {type:'agent.event',data:{type:'message',text:'The actual user-facing answer'}},
    ...Array.from({length:5},(_,i)=>make('task.state',taskState(i+2)))
  ]};
  compactRunHistory(run,{sourceArchive:{format:1,relativePath:'run-event-archives/original.json',sha256:'a'.repeat(64)}});
  assert.ok(JSON.stringify(run).length<9000);
  assert.ok(run.events.some(e=>e.data.type==='message'&&e.data.text==='The actual user-facing answer'));
  assert.ok(run.eventRetention.compacted);
  assert.equal(run.eventRetention.sourceArchive.relativePath,'run-event-archives/original.json');
});
