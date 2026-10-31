import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {PlanningBrowserStore} from '../lib/planning-browser.mjs';
import {PlanningBrowserRuntime,planningModuleOutputSchema} from '../lib/planning-browser-runtime.mjs';
import {planningModuleTemplate} from '../public/planning-browser-model.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(check){for(let n=0;n<100;n++){if(await check())return;await tick();}throw new Error('Fixture did not reach the expected state.');}
function publicOutput(requestId,kind='frame',suffix='A'){
  const template=planningModuleTemplate(kind);
  return JSON.stringify({values:Object.fromEntries(template.fields.map(field=>[field.id,field.label+' actual public finding '+suffix])),
    grounding:template.fields.filter(field=>field.grounding==='required').map(field=>({field:field.id,sourceId:'request:'+requestId})),openQuestions:[],challengeResponses:[]});
}
async function fixture(t,{settings={},automatic=false,provider}={}){
  const directory=await mkdtemp(path.join(os.tmpdir(),'planning-worker-'));
  const store=await new PlanningBrowserStore({dataDir:directory}).init(),calls=[];
  const runtime={runAgent:options=>{const done=deferred();calls.push({options,...done});return provider?provider(options,done,calls):done.promise;}};
  const events=[];
  const runner=new PlanningBrowserRuntime({store,runtime,defaultCwd:directory,getSettings:()=>({maxSubagents:2,subagentsEnabled:automatic,...settings}),onUpdated:event=>events.push(event)});
  t.after(async()=>{for(const call of calls)call.reject(Object.assign(new Error('fixture cleanup'),{code:'ABORT_ERR'}));await runner.close();await store.close();await rm(directory,{recursive:true,force:true});});
  async function request(id='request-a',objective='Choose a supported route for A.'){
    let record=await store.create({id,conversationId:'same-conversation',title:id,objective});
    record=await store.addNode(id,{id:'frame',kind:'frame',title:'Reframe',prompt:'Expose an alternative frame.'});
    return record;
  }
  return {store,runner,calls,events,request};
}

test('concurrent requests in one conversation keep separate captured objectives and actual responses',async t=>{
  const f=await fixture(t);await f.request('request-a','Choose route A with its own constraint.');await f.request('request-b','Choose route B with a different constraint.');
  const a=await f.runner.start({requestId:'request-a',nodeId:'frame',expectedNodeRevision:1});
  const b=await f.runner.start({requestId:'request-b',nodeId:'frame',expectedNodeRevision:1});
  assert.equal(f.calls.length,2);assert.equal(f.runner.status().activeCount,2);
  assert.match(f.calls[0].options.prompt,/route A/);assert.doesNotMatch(f.calls[0].options.prompt,/route B/);
  f.calls[1].resolve({output:publicOutput('request-b'),threadId:'thread-b',turnId:'turn-b',usage:{totalTokens:13}});
  await f.runner.wait('request-b',b.attempt.id);
  assert.equal((await f.store.get('request-a')).responses.length,0);assert.equal(f.runner.status().activeCount,1);
  f.calls[0].resolve({output:publicOutput('request-a'),threadId:'thread-a',turnId:'turn-a',usage:{totalTokens:17}});
  await Promise.all(f.runner.activePromises());
  for(const [id,claim,thread] of [['request-a',a,'thread-a'],['request-b',b,'thread-b']]){
    const r=await f.store.get(id),response=r.responses[0];
    assert.equal(response.provenance.attemptId,claim.attempt.id);assert.equal(response.provenance.threadId,thread);
    assert.equal(r.attempts[0].outputHash,createHash('sha256').update(publicOutput(id)).digest('hex'));
  }
  assert.equal(f.runner.status().activeCount,0);assert.ok(f.events.every(e=>e.type==='planning.browser.updated'&&e.data.requestId));
});

test('capacity queues independent modules, duplicate admission is rejected and queued cancellation never calls provider',async t=>{
  const f=await fixture(t,{settings:{maxSubagents:1}});await f.request('request-a');await f.request('request-b');
  await f.runner.start({requestId:'request-a',nodeId:'frame',expectedNodeRevision:1});
  const b=await f.runner.start({requestId:'request-b',nodeId:'frame',expectedNodeRevision:1});
  assert.equal(b.attempt.workerStatus,'queued');assert.equal(f.calls.length,1);assert.equal(f.runner.status().activeCount,2);
  await assert.rejects(f.runner.start({requestId:'request-a',nodeId:'frame',expectedNodeRevision:1}),{code:'PLANNING_NODE_BUSY'});
  await f.runner.cancel(b.attempt.id);assert.equal(f.calls.length,1);assert.equal((await f.store.get('request-b')).attempts[0].status,'cancelled');
  f.calls[0].resolve({output:publicOutput('request-a')});await Promise.all(f.runner.activePromises());
});

test('running cancellation retains ownership until actual provider settlement and rejects its late result',async t=>{
  const f=await fixture(t);await f.request();const first=await f.runner.start({requestId:'request-a',nodeId:'frame',expectedNodeRevision:1});
  const cancellation=f.runner.cancel(first.attempt.id,{reason:'Changed direction.'});await tick();
  assert.equal(f.runner.status().activeCount,1);assert.equal(f.runner.status().attempts[0].status,'cancelling');
  assert.equal((await f.store.get('request-a')).attempts[0].status,'running');
  await assert.rejects(f.runner.start({requestId:'request-a',nodeId:'frame',expectedNodeRevision:1}),{code:'PLANNING_NODE_BUSY'});
  f.calls[0].resolve({output:publicOutput('request-a','frame','late'),threadId:'late-thread'});await cancellation;
  const r=await f.store.get('request-a');assert.equal(r.responses.length,0);assert.equal(r.attempts[0].status,'cancelled');assert.match(r.attempts[0].partialOutput,/late/);
  const retry=await f.runner.start({requestId:'request-a',nodeId:'frame',expectedNodeRevision:1});assert.notEqual(retry.attempt.id,first.attempt.id);
  f.calls[1].resolve({output:publicOutput('request-a','frame','retry')});await Promise.all(f.runner.activePromises());
  const after=await f.store.get('request-a');assert.equal(after.responses.length,1);assert.equal(after.attempts[1].ownerId,after.attempts[0].ownerId);
});

test('configured model, effort, tier and exact task-specific output schema reach the provider unchanged',async t=>{
  const f=await fixture(t,{settings:{defaultModel:'configured::large',defaultEffort:'high',defaultServiceTier:'default',subagentsEnabled:false}});await f.request();
  await f.runner.start({requestId:'request-a',nodeId:'frame',expectedNodeRevision:1});const options=f.calls[0].options;
  assert.equal(options.model,'configured::large');assert.equal(options.effort,'high');assert.equal(options.responseOnly,true);assert.equal(options.sandbox,'read-only');assert.deepEqual(options.dynamicTools,[]);assert.equal(options.threadId,undefined);
  assert.deepEqual(options.outputSchema.properties.values.required,planningModuleTemplate('frame').fields.map(x=>x.id));
  assert.equal(options.outputSchema.additionalProperties,false);assert.deepEqual(options.outputSchema.properties.grounding.items.properties.sourceId.enum,['request:request-a']);
  f.calls[0].resolve({output:publicOutput('request-a')});await Promise.all(f.runner.activePromises());
  await assert.rejects(f.runner.start({requestId:'request-a',nodeId:'frame',expectedNodeRevision:1,automatic:true}),{code:'PLANNING_AUTOMATIC_DISABLED'});
});

test('invalid public output is preserved visibly and neither tool success nor private reasoning creates a response',async t=>{
  const invalid='{"done":true,"provenance":{"verified":true}}';
  const f=await fixture(t,{provider:(_options,done,calls)=>{if(calls.length===2)done.resolve({output:invalid,threadId:'actual-repair-thread'});return done.promise;}});await f.request();await f.runner.start({requestId:'request-a',nodeId:'frame',expectedNodeRevision:1});
  f.calls[0].options.onEvent({type:'reasoning',text:'PRIVATE_SENTINEL'});
  f.calls[0].options.onEvent({type:'message',text:'Public malformed candidate',itemId:'public-item'});
  f.calls[0].resolve({output:invalid,threadId:'actual-thread'});
  await Promise.all(f.runner.activePromises());const r=await f.store.get('request-a');
  assert.equal(r.responses.length,0);assert.equal(r.attempts.length,2);assert.equal(f.calls.length,2);assert.equal(r.attempts[0].status,'failed');assert.match(r.attempts[0].partialOutput,/provenance/);assert.doesNotMatch(JSON.stringify(r),/PRIVATE_SENTINEL/);
  assert.equal(r.attempts[1].status,'failed');assert.equal(r.attempts[1].repairOf,r.attempts[0].id);assert.equal(r.attempts[0].repairAttemptId,r.attempts[1].id);assert.equal(r.attempts[1].partialOutput,invalid);
  await f.runner.start({requestId:'request-a',nodeId:'frame',expectedNodeRevision:1});
  f.calls[2].options.onEvent({type:'item',item:{type:'dynamicToolCall',status:'completed',success:true}});
  f.calls[2].resolve({output:publicOutput('request-a')});await Promise.all(f.runner.activePromises());
  const after=await f.store.get('request-a');assert.equal(after.responses.length,0);assert.equal(after.attempts.length,3);assert.equal(f.calls.length,3);assert.equal(after.attempts[2].status,'failed');assert.match(after.attempts[2].message,/operational/);
});

test('empty or failed worker output leaves required fields open and records actual partial public text',async t=>{
  const f=await fixture(t);await f.request();await f.runner.start({requestId:'request-a',nodeId:'frame',expectedNodeRevision:1});
  f.calls[0].options.onEvent({type:'delta',delta:'Partial public answer'});f.calls[0].reject(new Error('Synthetic transport interrupted'));
  await Promise.all(f.runner.activePromises());let r=await f.store.get('request-a');assert.equal(r.responses.length,0);assert.equal(r.attempts[0].partialOutput,'Partial public answer');
  await f.runner.start({requestId:'request-a',nodeId:'frame',expectedNodeRevision:1});f.calls[1].resolve({output:''});await Promise.all(f.runner.activePromises());
  r=await f.store.get('request-a');assert.equal(r.responses.length,0);assert.match(r.attempts[1].message,/no public structured/);
});

test('close includes a pending durable admission and does not let it launch after cancellation',async t=>{
  const f=await fixture(t);await f.request();const gate=deferred(),original=f.runner.writer;
  f.runner.writer={...original,beginAttempt:async(...args)=>{await gate.promise;return original.beginAttempt(...args);}};
  const start=f.runner.start({requestId:'request-a',nodeId:'frame',expectedNodeRevision:1});await tick();
  assert.equal(f.runner.status().activeCount,1);assert.equal(f.runner.activePromises().length,1);
  const closing=f.runner.close();gate.resolve();await start;await closing;
  assert.equal(f.calls.length,0);assert.equal((await f.store.get('request-a')).attempts[0].status,'cancelled');assert.equal(f.runner.status().closed,true);assert.equal(f.runner.status().activeCount,0);
  await assert.rejects(f.runner.start({requestId:'request-a',nodeId:'frame',expectedNodeRevision:1}),{code:'PLANNING_RUNTIME_CLOSED'});
});

test('client idempotency replay does not repeat a completed provider effect or change actual response hash',async t=>{
  const f=await fixture(t);await f.request();const options={requestId:'request-a',nodeId:'frame',expectedNodeRevision:1,clientRequestId:'same-start'};
  const first=await f.runner.start(options);f.calls[0].resolve({output:publicOutput('request-a')});await Promise.all(f.runner.activePromises());
  const second=await f.runner.start(options);assert.equal(second.attempt.id,first.attempt.id);assert.equal(f.calls.length,1);assert.equal((await f.store.get('request-a')).responses.length,1);
});

test('task-specific schemas differ and cannot accept another module type or a model-supplied completion key',()=>{
  const frame=planningModuleOutputSchema({template:planningModuleTemplate('frame'),sources:[]}),comparison=planningModuleOutputSchema({template:planningModuleTemplate('comparison'),sources:[]});
  assert.ok(frame.properties.values.required.includes('alternativeFrame'));assert.ok(comparison.properties.values.required.includes('choiceSensitivity'));
  assert.equal(comparison.properties.values.properties.alternativeFrame,undefined);assert.equal(frame.properties.status,undefined);assert.equal(frame.additionalProperties,false);
});

test('parallel modules within one request append independent actual results without clobbering a sibling',async t=>{
  const f=await fixture(t);await f.request();await f.store.addNode('request-a',{id:'compare',kind:'comparison',title:'Compare',prompt:'Use common criteria.'});
  await Promise.all([f.runner.start({requestId:'request-a',nodeId:'frame',expectedNodeRevision:1}),f.runner.start({requestId:'request-a',nodeId:'compare',expectedNodeRevision:1})]);
  assert.equal(f.calls.length,2);
  for(const call of f.calls){const kind=call.options.outputSchema.properties.values.properties.choiceSensitivity?'comparison':'frame';call.resolve({output:publicOutput('request-a',kind)});}
  await Promise.all(f.runner.activePromises());const r=await f.store.get('request-a');assert.equal(r.responses.length,2);assert.deepEqual(new Set(r.responses.map(x=>x.nodeId)),new Set(['frame','compare']));
  assert.equal(new Set(r.attempts.map(x=>x.ownerId)).size,2);
});

test('host resolves an actual inherited subtree owner and rejects a client-supplied impersonation',async t=>{
  const f=await fixture(t);await f.request();let r=await f.store.addNode('request-a',{id:'child',parentId:'frame',kind:'inquiry',title:'Investigate',prompt:'Discriminate between causes.'},{expectedParentRevision:1});
  r=await f.store.assign(r.id,'frame',{ownerId:'assigned-subagent',scope:'subtree',label:'Assigned analyst'},{expectedNodeRevision:r.nodes.find(x=>x.id==='frame').revision});
  await assert.rejects(f.runner.start({requestId:r.id,nodeId:'child',expectedNodeRevision:1,ownerId:'forged-owner'}),{code:'PLANNING_RUNTIME_OWNER'});
  const claim=await f.runner.start({requestId:r.id,nodeId:'child',expectedNodeRevision:1});assert.equal(claim.attempt.ownerId,'assigned-subagent');
  f.calls[0].resolve({output:publicOutput(r.id,'inquiry')});await Promise.all(f.runner.activePromises());
  assert.equal((await f.store.get(r.id)).attempts[0].ownerId,'assigned-subagent');
});

test('stale module revision fails before a provider call and leaves its edited declaration intact',async t=>{
  const f=await fixture(t);await f.request();await f.store.updateNode('request-a','frame',{prompt:'The user changed the question.'},{expectedNodeRevision:1});
  await assert.rejects(f.runner.start({requestId:'request-a',nodeId:'frame',expectedNodeRevision:1}),{code:'PLANNING_NODE_CONFLICT'});
  assert.equal(f.calls.length,0);const r=await f.store.get('request-a');assert.equal(r.attempts.length,0);assert.equal(r.nodes[0].prompt,'The user changed the question.');assert.equal(f.runner.status().activeCount,0);
});

test('downstream worker receives the pinned producer field and actual source revision',async t=>{
  const f=await fixture(t);await f.request();let r=await f.store.recordHumanResponse('request-a','frame',publicOutput('request-a','frame','pinned-producer'),{expectedNodeRevision:1});
  const producer=r.responses[0];r=await f.store.addNode(r.id,{id:'decision',kind:'decision',title:'Choose',prompt:'Use the alternate frame as a real decision input.'});
  r=await f.store.link(r.id,{id:'frame-consumption',kind:'consumes',from:'decision',to:'frame',sourceField:'alternativeFrame',sourceResponseId:producer.id,sourceResponseRevision:producer.revision,freshness:'pinned'},{expectedNodeRevision:1});
  const node=r.nodes.find(x=>x.id==='decision');const claim=await f.runner.start({requestId:r.id,nodeId:node.id,expectedNodeRevision:node.revision});
  assert.deepEqual(claim.attempt.inputs[0].values,{alternativeFrame:producer.values.alternativeFrame});assert.equal(claim.attempt.inputs[0].responseId,producer.id);assert.equal(claim.attempt.inputs[0].responseRevision,producer.revision);
  assert.match(f.calls[0].options.prompt,/pinned-producer/);assert.ok(f.calls[0].options.outputSchema.properties.grounding.items.properties.sourceId.enum.includes('response:'+producer.id));
  f.calls[0].resolve({output:publicOutput(r.id,'decision')});await Promise.all(f.runner.activePromises());
});

test('an identical active transport retry recovers its durable claim without another provider turn',async t=>{
  const f=await fixture(t);await f.request();const options={requestId:'request-a',nodeId:'frame',expectedNodeRevision:1,clientRequestId:'active-retry'};
  const first=await f.runner.start(options),replay=await f.runner.start({...options});
  assert.equal(replay.attempt.id,first.attempt.id);assert.equal(f.calls.length,1);
  await assert.rejects(f.runner.start({...options,model:'changed-model'}),{code:'PLANNING_IDEMPOTENCY_CONFLICT'});
  f.calls[0].resolve({output:publicOutput('request-a')});await Promise.all(f.runner.activePromises());
});

test('another host cannot replay a persisted running attempt or assume its provider has stopped',async t=>{
  const f=await fixture(t);await f.request();let foreignCalls=0;
  const second=new PlanningBrowserRuntime({store:f.store,defaultCwd:process.cwd(),runtime:{runAgent:async()=>{foreignCalls++;return {output:publicOutput('request-a')};}}});
  t.after(()=>second.close());const options={requestId:'request-a',nodeId:'frame',expectedNodeRevision:1,clientRequestId:'unknown-host-replay'};
  const first=await f.runner.start(options);
  await assert.rejects(second.start(options),{code:'PLANNING_ATTEMPT_UNOWNED'});assert.equal(foreignCalls,0);
  await assert.rejects(second.cancel(first.attempt.id),{code:'PLANNING_ATTEMPT_NOT_OWNED'});
  assert.equal((await f.store.get('request-a')).attempts[0].status,'running');assert.equal(f.runner.status().activeCount,1);
  f.calls[0].resolve({output:publicOutput('request-a')});await Promise.all(f.runner.activePromises());
  const completed=await second.start(options);assert.equal(completed.attempt.status,'completed');assert.equal(foreignCalls,0);
});
