import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {PlanningBrowserStore} from '../lib/planning-browser.mjs';
import {planningModuleTemplate} from '../public/planning-browser-model.mjs';

async function fixture(t,options={}){
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'planning-browser-test-'));
  const store=new PlanningBrowserStore({dataDir,...options});await store.init();
  t.after(async()=>{await store.close();await fs.rm(dataDir,{recursive:true,force:true});});
  const request=await store.create({conversationId:'conversation-fixture',title:'Fictional route choice',objective:'Choose a reliable route while preserving useful alternatives.',cwd:dataDir});
  return {store,dataDir,requestId:request.id};
}
const byId=(request,id)=>request.nodes.find(n=>n.id===id);
async function add(f,id,kind='decision',parentId=null){
  const request=await f.store.get(f.requestId);
  return f.store.addNode(f.requestId,{id,kind,title:id,prompt:'Produce the named public analytical fields.',parentId},{...(parentId?{expectedParentRevision:byId(request,parentId).revision}:{})});
}
function answer(kind,requestId,overrides={}){
  const fields=planningModuleTemplate(kind).fields;
  return {values:Object.fromEntries(fields.map(field=>[field.id,'Fictional evidence and explanation for '+field.label+'.'])),grounding:fields.filter(field=>field.grounding==='required').map(field=>({field:field.id,sourceId:'request:'+requestId})),...overrides};
}
async function human(f,nodeId,value){
  const request=await f.store.get(f.requestId),node=byId(request,nodeId);
  return f.store.recordHumanResponse(f.requestId,nodeId,value||answer(node.kind,f.requestId),{expectedNodeRevision:node.revision,actor:{type:'human',id:'fixture-user'}});
}
async function link(f,value){
  const request=await f.store.get(f.requestId);
  return f.store.link(f.requestId,value,{expectedNodeRevision:byId(request,value.from).revision});
}
const stamp={runId:'actual-run',executionNodeId:'actual-worker',threadId:'actual-thread',turnId:'actual-turn',itemId:'actual-message',model:'synthetic-provider',provider:'fixture',usage:{inputTokens:40,outputTokens:70}};

test('multiple request roots persist under a conversation without replacing one another',async t=>{
  const f=await fixture(t);await add(f,'root');await add(f,'child','inquiry','root');
  const second=await f.store.create({conversationId:'conversation-fixture',title:'Second concurrent request',objective:'Investigate a different fictional question.'});
  const reopened=new PlanningBrowserStore({dataDir:f.dataDir});await reopened.init();t.after(()=>reopened.close());
  assert.equal((await reopened.list({conversationId:'conversation-fixture'})).requests.length,2);
  assert.equal((await reopened.get(f.requestId)).nodes.length,2);assert.equal((await reopened.get(second.id)).nodes.length,0);
});
test('two store instances preserve independent node edits and reject same-node stale CAS',async t=>{
  const f=await fixture(t);let state=await add(f,'left');state=await add(f,'right');
  const other=new PlanningBrowserStore({dataDir:f.dataDir});await other.init();t.after(()=>other.close());
  await Promise.all([f.store.updateNode(f.requestId,'left',{title:'Left improved'},{expectedNodeRevision:byId(state,'left').revision}),other.updateNode(f.requestId,'right',{title:'Right improved'},{expectedNodeRevision:byId(state,'right').revision})]);
  state=await f.store.get(f.requestId);assert.equal(byId(state,'left').title,'Left improved');assert.equal(byId(state,'right').title,'Right improved');
  const revision=byId(state,'left').revision;
  const settled=await Promise.allSettled([f.store.updateNode(f.requestId,'left',{prompt:'First competing edit'},{expectedNodeRevision:revision}),other.updateNode(f.requestId,'left',{prompt:'Second competing edit'},{expectedNodeRevision:revision})]);
  assert.equal(settled.filter(r=>r.status==='fulfilled').length,1);assert.equal(settled.find(r=>r.status==='rejected').reason.code,'PLANNING_NODE_CONFLICT');
});
test('same-node authored responses advance CAS instead of silently overwriting each other',async t=>{
  const f=await fixture(t);const state=await add(f,'choice'),revision=byId(state,'choice').revision;
  const settled=await Promise.allSettled([f.store.recordHumanResponse(f.requestId,'choice',answer('decision',f.requestId),{expectedNodeRevision:revision}),f.store.recordHumanResponse(f.requestId,'choice',answer('decision',f.requestId),{expectedNodeRevision:revision})]);
  assert.equal(settled.filter(r=>r.status==='fulfilled').length,1);assert.equal(settled.find(r=>r.status==='rejected').reason.code,'PLANNING_NODE_CONFLICT');
  const final=byId(await f.store.get(f.requestId),'choice');assert.equal(final.response.nodeRevision,final.revision);assert.equal(final.readiness.state,'ready');
});
test('partial public responses retain missing cognitive fields without becoming ready',async t=>{
  const f=await fixture(t);await add(f,'choice');const state=await human(f,'choice',{values:{recommendation:'Inspect the inexpensive route first.'}});
  const node=byId(state,'choice');assert.equal(node.readiness.state,'missing_fields');assert(node.readiness.missingFields.includes('strongestAlternative'));assert.equal(node.readiness.responseRecorded,true);assert.equal(node.readiness.verifiedAction,false);
  await assert.rejects(human(f,'choice',{values:{},done:true}));
  assert.throws(()=>f.store.updateNode(f.requestId,'choice',{status:'done'},{expectedNodeRevision:node.revision}));
});
test('child creation uses parent CAS and containment moves preserve parent revisions',async t=>{
  const f=await fixture(t);let state=await add(f,'root'),original=byId(state,'root').revision;await add(f,'child','inquiry','root');
  await assert.rejects(f.store.addNode(f.requestId,{id:'stale-child',parentId:'root',kind:'action',title:'Stale'},{expectedParentRevision:original}),{code:'PLANNING_NODE_CONFLICT'});
  state=await add(f,'other');const rootRevision=byId(state,'root').revision,otherRevision=byId(state,'other').revision;
  state=await f.store.updateNode(f.requestId,'child',{parentId:'other'},{expectedNodeRevision:byId(state,'child').revision});
  assert.equal(byId(state,'root').revision,rootRevision+1);assert.equal(byId(state,'other').revision,otherRevision+1);
  await assert.rejects(f.store.updateNode(f.requestId,'other',{parentId:'child'},{expectedNodeRevision:byId(state,'other').revision}),{code:'PLANNING_CONTAINMENT_CYCLE'});
});
test('combined containment and dependency waits reject cycles while semantic cycles remain legal',async t=>{
  const f=await fixture(t);await add(f,'parent','frame');await add(f,'child','decision','parent');await human(f,'parent');
  await assert.rejects(link(f,{kind:'depends_on',from:'child',to:'parent'}),{code:'PLANNING_DEPENDENCY_CYCLE'});
  await link(f,{kind:'consumes',from:'child',to:'parent',sourceField:'objective'});
  await assert.rejects(link(f,{kind:'depends_on',from:'parent',to:'child'}),{code:'PLANNING_DEPENDENCY_CYCLE'});
  await link(f,{kind:'supports',from:'child',to:'parent'});await link(f,{kind:'challenges',from:'parent',to:'child'});
  const state=await f.store.get(f.requestId);assert.equal(state.edges.filter(e=>e.kind==='supports'||e.kind==='challenges').length,2);
});
test('runtime response stamps cannot be minted by human or direct untrusted store calls',async t=>{
  const f=await fixture(t);const state=await add(f,'choice'),revision=byId(state,'choice').revision;
  await assert.rejects(f.store.beginAttempt(f.requestId,'choice',{expectedNodeRevision:revision,ownerId:'worker'}),{code:'PLANNING_RUNTIME_WRITE_FORBIDDEN'});
  await assert.rejects(f.store.recordResponse(f.requestId,'fake',{output:'{}',metadata:stamp}),{code:'PLANNING_RUNTIME_WRITE_FORBIDDEN'});
  await assert.rejects(human(f,'choice',{values:{},provenance:{kind:'runtime',runId:'fake'}}));
  assert.throws(()=>f.store.recordExternalResponse(f.requestId,'choice',{values:{}},{expectedNodeRevision:revision}),{code:'PLANNING_EXTERNAL_WRITE_FORBIDDEN'});
});
test('trusted runtime retains exact public output, actual metadata and unverified assurance',async t=>{
  const f=await fixture(t);const state=await add(f,'choice'),writer=f.store.runtimeWriter();
  const claim=await writer.beginAttempt(f.requestId,'choice',{expectedNodeRevision:byId(state,'choice').revision,ownerId:'worker',clientRequestId:'start-one'});
  const duplicate=await writer.beginAttempt(f.requestId,'choice',{expectedNodeRevision:byId(state,'choice').revision,ownerId:'worker',clientRequestId:'start-one'});assert.equal(duplicate.attempt.id,claim.attempt.id);assert.equal(claim.created,true);assert.equal(duplicate.created,false);
  const output=' \n'+JSON.stringify(answer('decision',f.requestId))+'\n ';const saved=await writer.recordResponse(f.requestId,claim.attempt.id,{output,metadata:stamp});
  const node=byId(saved,'choice'),attempt=saved.attempts[0];assert.equal(attempt.output,output);assert.equal(attempt.outputHash,createHash('sha256').update(output).digest('hex'));
  assert.equal(node.response.provenance.runId,stamp.runId);assert.deepEqual(node.response.provenance.usage,stamp.usage);assert.equal(node.readiness.state,'ready');assert.equal(node.readiness.verifiedAction,false);
  assert.equal((await writer.recordResponse(f.requestId,claim.attempt.id,{output,metadata:stamp})).responses.length,1);
});
test('active ownership protects edits and unrelated unassigned branches from worker writes',async t=>{
  const f=await fixture(t);let state=await add(f,'root');await add(f,'child','inquiry','root');state=await add(f,'unrelated');
  state=await f.store.assign(f.requestId,'root',{ownerId:'worker-one',scope:'subtree'},{expectedNodeRevision:byId(state,'root').revision});
  assert.equal(byId(state,'child').assignment.ownerId,'worker-one');
  await assert.rejects(f.store.updateNode(f.requestId,'child',{title:'Wrong worker'},{expectedNodeRevision:byId(state,'child').revision,ownerId:'worker-two'}),{code:'PLANNING_NODE_OWNERSHIP'});
  await assert.rejects(f.store.updateNode(f.requestId,'unrelated',{title:'Outside scope'},{expectedNodeRevision:byId(state,'unrelated').revision,ownerId:'worker-one'}),{code:'PLANNING_NODE_OWNERSHIP'});
  const writer=f.store.runtimeWriter(),claim=await writer.beginAttempt(f.requestId,'child',{expectedNodeRevision:byId(state,'child').revision,ownerId:'worker-one'});
  await assert.rejects(f.store.updateNode(f.requestId,'child',{title:'Human concurrent change'},{expectedNodeRevision:claim.attempt.nodeRevision}),{code:'PLANNING_NODE_OWNERSHIP'});
  await writer.cancel(f.requestId,claim.attempt.id,{reason:'Fixture complete.'});
});
test('late actual responses preserve stale definition provenance instead of overwriting edits',async t=>{
  const f=await fixture(t);let state=await add(f,'choice'),writer=f.store.runtimeWriter();
  const claim=await writer.beginAttempt(f.requestId,'choice',{expectedNodeRevision:byId(state,'choice').revision,ownerId:'worker'});
  await f.store.updateNode(f.requestId,'choice',{prompt:'New definition requiring a different comparison.'},{expectedNodeRevision:claim.attempt.nodeRevision,ownerId:'worker'});
  state=await writer.recordResponse(f.requestId,claim.attempt.id,{output:JSON.stringify(answer('decision',f.requestId)),metadata:stamp});
  const node=byId(state,'choice');assert.equal(node.prompt,'New definition requiring a different comparison.');assert.equal(node.response.nodeRevision,claim.attempt.nodeRevision);assert.equal(node.readiness.state,'stale');
});
test('latest consumption stales precisely while pinned historical response remains auditable',async t=>{
  const f=await fixture(t);await add(f,'producer');await add(f,'consumer');await add(f,'historical');let state=await human(f,'producer'),original=byId(state,'producer').response;
  await link(f,{kind:'consumes',from:'consumer',to:'producer',sourceField:'recommendation'});await link(f,{kind:'consumes',from:'historical',to:'producer',sourceResponseId:original.id,sourceResponseRevision:original.revision,sourceField:'recommendation',freshness:'pinned'});
  await human(f,'consumer');await human(f,'historical');state=await human(f,'producer');
  assert.equal(byId(state,'consumer').readiness.state,'stale');assert.equal(byId(state,'historical').readiness.state,'ready');assert.equal(byId(state,'consumer').response.inputs[0].responseId,original.id);
  const writer=f.store.runtimeWriter(),claim=await writer.beginAttempt(f.requestId,'consumer',{expectedNodeRevision:byId(state,'consumer').revision,ownerId:'worker'});
  assert.equal(claim.attempt.inputs[0].responseId,byId(state,'producer').response.id);
  await human(f,'producer');state=await writer.recordResponse(f.requestId,claim.attempt.id,{output:JSON.stringify(answer('decision',f.requestId)),metadata:stamp});
  assert.equal(byId(state,'consumer').readiness.state,'stale');assert.equal(byId(state,'consumer').response.inputs[0].responseId,claim.attempt.inputs[0].responseId);
});
test('whole-branch dependencies require children and retain exact descendant input revisions',async t=>{
  const f=await fixture(t);await add(f,'parent','frame');await add(f,'child','inquiry','parent');await add(f,'consumer');await human(f,'parent');await link(f,{kind:'depends_on',from:'consumer',to:'parent'});
  const writer=f.store.runtimeWriter();let state=await f.store.get(f.requestId);
  await assert.rejects(writer.beginAttempt(f.requestId,'consumer',{expectedNodeRevision:byId(state,'consumer').revision,ownerId:'worker'}),{code:'PLANNING_INPUT_MISSING'});
  state=await human(f,'child');const captured=byId(state,'child').response;const claim=await writer.beginAttempt(f.requestId,'consumer',{expectedNodeRevision:byId(state,'consumer').revision,ownerId:'worker'});
  assert.equal(claim.attempt.inputs[0].subtree[0].responseId,captured.id);assert(claim.attempt.sources.some(source=>source.id==='response:'+captured.id));
  await human(f,'child');state=await writer.recordResponse(f.requestId,claim.attempt.id,{output:JSON.stringify(answer('decision',f.requestId)),metadata:stamp});
  assert(byId(state,'consumer').readiness.staleInputs.some(input=>input.nodeId==='child'));
});
test('incoming challenge snapshots name the exact edge and actual producer response',async t=>{
  const f=await fixture(t);await add(f,'claim');await add(f,'challenge');let state=await human(f,'challenge');const challenger=byId(state,'challenge').response;
  state=await link(f,{id:'challenge-edge',kind:'challenges',from:'challenge',to:'claim'});
  const writer=f.store.runtimeWriter(),attempt=(await writer.beginAttempt(f.requestId,'claim',{expectedNodeRevision:byId(state,'claim').revision,ownerId:'worker'})).attempt;
  assert.deepEqual(attempt.challenges.map(c=>[c.edgeId,c.nodeId,c.responseId,c.responseRevision]),[['challenge-edge','challenge',challenger.id,challenger.revision]]);
  await writer.cancel(f.requestId,attempt.id,{reason:'Fixture complete.'});
});
test('failure and cancellation preserve partial public output without a completion artifact',async t=>{
  for(const action of ['fail','cancel']){
    const f=await fixture(t);const state=await add(f,'choice'),writer=f.store.runtimeWriter();
    const attempt=(await writer.beginAttempt(f.requestId,'choice',{expectedNodeRevision:byId(state,'choice').revision,ownerId:'worker'})).attempt;
    const partial='  incomplete public answer\n';const saved=await writer[action](f.requestId,attempt.id,{reason:'Fixture interruption',partialOutput:partial,metadata:stamp});
    assert.equal(saved.responses.length,0);assert.equal(saved.attempts[0].partialOutput,partial);assert.equal(saved.attempts[0].metadata.model,stamp.model);
    await assert.rejects(writer.recordResponse(f.requestId,attempt.id,{output:JSON.stringify(answer('decision',f.requestId)),metadata:stamp}),{code:'PLANNING_ATTEMPT_SETTLED'});
  }
});
test('external authored answers have host receipt provenance distinct from human and runtime',async t=>{
  const f=await fixture(t);let state=await add(f,'choice');const actor={type:'external-agent',id:'c'.repeat(240)},receipt={jobId:'direct-real-job',connectionId:actor.id,requestId:'external-action',tool:'blackice_planning_graph_write'};
  state=await f.store.addSource(f.requestId,{title:'External public note',text:'Fictional observed source content.'},{actor});
  assert.equal(state.sources.find(s=>s.kind==='external_provided').provenance.kind,'external_agent');
  state=await f.store.externalWriter().recordResponse(f.requestId,'choice',answer('decision',f.requestId),{expectedNodeRevision:byId(state,'choice').revision,actor,receipt});
  const response=byId(state,'choice').response;assert.equal(response.provenance.kind,'external_agent');assert.deepEqual(response.provenance.receipt,receipt);assert.equal(response.provenance.runId,undefined);assert.equal(response.verifiedAction,false);
  assert.throws(()=>f.store.externalWriter().recordResponse(f.requestId,'choice',{values:{}},{expectedNodeRevision:byId(state,'choice').revision,actor,receipt:{...receipt,runId:'forged'}}));
});
test('runtime evidence cannot replace an actual request source identity',async t=>{
  const f=await fixture(t);const state=await add(f,'choice'),writer=f.store.runtimeWriter();const attempt=(await writer.beginAttempt(f.requestId,'choice',{expectedNodeRevision:byId(state,'choice').revision,ownerId:'worker'})).attempt;
  await assert.rejects(writer.recordResponse(f.requestId,attempt.id,{output:JSON.stringify(answer('decision',f.requestId)),metadata:stamp,evidence:[{id:'request:'+f.requestId,kind:'source',text:'Replacement objective'}]}),{code:'PLANNING_SOURCE_COLLISION'});
  await writer.cancel(f.requestId,attempt.id,{reason:'Fixture complete.'});
});
test('knowledge inputs are actual scoped snapshots rather than caller-written provenance',async t=>{
  let entry;const f=await fixture(t,{knowledge:{get:async()=>entry}});await add(f,'choice');
  entry={id:'memory-one',kind:'memory',revision:4,title:'Observed constraint',content:'Fictional source content',cwd:f.dataDir,provenance:{source:'fixture'}};
  let state=await link(f,{kind:'knowledge',from:'choice',to:'memory-one'});assert(state.sources.some(s=>s.id==='knowledge:memory-one:4'&&s.text===entry.content));
  entry={...entry,cwd:path.join(f.dataDir,'other-workspace')};await assert.rejects(link(f,{kind:'knowledge',from:'choice',to:'memory-one'}),{code:'PLANNING_KNOWLEDGE_SCOPE'});
  assert.throws(()=>f.store.addSource(f.requestId,{title:'Forged',text:'Claim',provenance:{kind:'runtime'}}));
});
test('invalid saved runtime provenance is diagnosed without rewriting damaged bytes',async t=>{
  const f=await fixture(t);const state=await add(f,'choice'),writer=f.store.runtimeWriter();const attempt=(await writer.beginAttempt(f.requestId,'choice',{expectedNodeRevision:byId(state,'choice').revision,ownerId:'worker'})).attempt;
  await writer.recordResponse(f.requestId,attempt.id,{output:JSON.stringify(answer('decision',f.requestId)),metadata:stamp});
  const file=path.join(f.dataDir,'planning-browser','requests',f.requestId+'.json');const raw=JSON.parse(await fs.readFile(file,'utf8'));raw.attempts[0].output='forged saved bytes';const damaged=JSON.stringify(raw);await fs.writeFile(file,damaged);
  await assert.rejects(f.store.get(f.requestId),{code:'PLANNING_BROWSER_DAMAGED'});assert.equal(await fs.readFile(file,'utf8'),damaged);assert.equal((await f.store.list()).errors.length,1);
});

test('historical response pins preserve the declared dependency DAG',async t=>{
  const f=await fixture(t);await add(f,'left');await add(f,'right');let state=await human(f,'left');state=await human(f,'right');
  const left=byId(state,'left').response,right=byId(state,'right').response;
  await link(f,{kind:'consumes',from:'left',to:'right',sourceResponseId:right.id,sourceResponseRevision:right.revision,freshness:'pinned'});
  await assert.rejects(link(f,{kind:'consumes',from:'right',to:'left',sourceResponseId:left.id,sourceResponseRevision:left.revision,freshness:'pinned'}),{code:'PLANNING_DEPENDENCY_CYCLE'});
});
test('recursive modules are persisted beyond the legacy eight-level outline bound',async t=>{
  const f=await fixture(t);await add(f,'level-0','frame');
  for(let level=1;level<12;level++)await add(f,'level-'+level,'inquiry','level-'+(level-1));
  const stored=await f.store.get(f.requestId);assert.equal(stored.nodes.length,12);assert.equal(byId(stored,'level-11').parentId,'level-10');
  const reopened=new PlanningBrowserStore({dataDir:f.dataDir});await reopened.init();t.after(()=>reopened.close());
  assert.equal((await reopened.get(f.requestId)).nodes.length,12);
});

test('request objectives retain host-derived external and human authorship across reopening',async t=>{
  const f=await fixture(t),actor={type:'external-agent',id:'verified-connected-client'};
  const external=await f.store.create({conversationId:'conversation-fixture',title:'External framing',objective:'A connected assistant reframed this request.'},{actor});
  const humanRequest=await f.store.create({conversationId:'conversation-fixture',title:'Human framing',objective:'Compare the two supplied designs.'},{actor:{type:'human',id:'local-user'}});
  const reopened=new PlanningBrowserStore({dataDir:f.dataDir});await reopened.init();t.after(()=>reopened.close());
  const ext=(await reopened.get(external.id)).sources.find(s=>s.id==='request:'+external.id);
  const actual=(await reopened.get(humanRequest.id)).sources.find(s=>s.id==='request:'+humanRequest.id);
  assert.equal(ext.kind,'request_objective');assert.equal(ext.provenance.kind,'external_agent');assert.equal(ext.provenance.author,actor.id);assert.equal(ext.verified,false);
  assert.equal(actual.kind,'user_request');assert.equal(actual.provenance.kind,'human');assert.equal(actual.provenance.author,'local-user');
  await assert.rejects(f.store.create({conversationId:'conversation-fixture',title:'Forged origin',objective:'Claim',provenance:{kind:'human'}}),{code:'PLANNING_BROWSER_INVALID'});
});
