import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ProviderRuntime} from '../lib/providers.mjs';
import {PlanningBrowserStore} from '../lib/planning-browser.mjs';
import {PlanningBrowserRuntime} from '../lib/planning-browser-runtime.mjs';
import {planningInvocationEvidence} from '../lib/planning-invocation.mjs';
import {planningModuleTemplate} from '../public/planning-browser-model.mjs';
import {planningProgressForRun,mergeChatRunUpdate} from '../public/next/chat/model.mjs';
import {projectFamily} from '../public/next/chat/reader-model.mjs';

const output=()=>JSON.stringify({values:Object.fromEntries(planningModuleTemplate('frame').fields.map(field=>[field.id,'A concise supported finding for '+field.label])),
  grounding:planningModuleTemplate('frame').fields.filter(field=>field.grounding==='required').map(field=>({field:field.id,sourceId:'request:invocation'})),openQuestions:[],challengeResponses:[]});
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'blackice-planning-invocation-'));
  let response='A model answered successfully, but this is not a valid Planning response.';
  const runtime=await new ProviderRuntime({dataDir:root,codex:{status:()=>({connected:false,authenticated:false,models:[]}),on(){},async close(){}},
    modelLimitResolver:{enrich:async(_config,models)=>models},fetchImpl:async url=>{
      if(String(url).endsWith('/models'))return Response.json({data:[]});
      const events=[{choices:[{index:0,delta:{content:response}}]},{choices:[{index:0,delta:{},finish_reason:'stop'}]}];
      return new Response(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
    }}).init();
  await runtime.saveProvider({id:'fixture',type:'compatible',baseUrl:'http://127.0.0.1:1/v1',models:['model']});
  const store=await new PlanningBrowserStore({dataDir:root}).init();
  await store.create({id:'invocation',conversationId:'fixture',title:'Invocation check',objective:'Compare the supplied frames.',cwd:root});
  await store.addNode('invocation',{id:'frame',kind:'frame',title:'Frame the question',prompt:'Compare the bounded question.'});
  const runner=new PlanningBrowserRuntime({store,runtime,defaultCwd:root,getSettings:()=>({defaultModel:'fixture::model'})});
  t.after(async()=>{await runner.close();await runtime.close();await store.close();
    assert.equal(path.dirname(root).toLowerCase(),path.resolve(os.tmpdir()).toLowerCase());assert.match(path.basename(root),/^blackice-planning-invocation-/);await fs.rm(root,{recursive:true,force:true});});
  const run=async()=>{const r=await store.get('invocation'),node=r.nodes.find(item=>item.id==='frame');const claim=await runner.start({requestId:r.id,nodeId:node.id,expectedNodeRevision:node.revision});await runner.wait(r.id,claim.attempt.id);return store.get(r.id);};
  return {runtime,store,runner,run,setResponse:value=>{response=value}};
}

test('successful provider text is explicitly separate from failed structured Planning invocations',async t=>{
  const f=await fixture(t),r=await f.run(),provider=f.runtime.listProviders()[0];
  assert.equal(provider.lastGenerationOk,true);assert.equal(provider.generationVerification,'provider-response');assert.equal(provider.planningInvocationVerified,false);
  assert.equal(provider.modelChecks.model.lastGenerationOk,true);assert.equal(provider.modelChecks.model.planningInvocationVerified,false);
  assert.equal(r.responses.length,0);assert.equal(f.runner.status().invocations.length,2,'Initial and bounded format repair are separate actual invocations.');
  for(const check of f.runner.status().invocations){assert.equal(check.providerResponse,'completed');assert.equal(check.status,'failed');assert.equal(check.structuredResponseValid,false);assert.equal(check.durableResponseRecorded,false);assert.equal(check.stageReady,false);assert.equal(check.responseId,undefined);}
});

test('Planning success requires the actual schema-valid durable response, hash and captured node revision',async t=>{
  const f=await fixture(t);f.setResponse(output());const r=await f.run(),check=f.runner.status().invocations[0];
  assert.equal(check.status,'succeeded');assert.equal(check.structuredResponseValid,true);assert.equal(check.durableResponseRecorded,true);assert.equal(check.currentForNode,true);assert.equal(check.stageReady,true);
  assert.equal(check.responseId,r.responses[0].id);assert.equal(check.outputHash,r.attempts[0].outputHash);assert.equal(check.nodeRevision,r.nodes[0].revision);
  assert.equal(check.adoptionVerified,false);assert.equal(check.effectsVerified,false);
  const changed=structuredClone(r);changed.responses[0].provenance.contentHash='0'.repeat(64);
  assert.equal(planningInvocationEvidence(changed,r.attempts[0].id).status,'unverified','A completed status alone cannot replace actual saved public output proof.');
});

test('schema-valid output cannot pass Planning when its durable save fails',async t=>{
  const f=await fixture(t);f.setResponse(output());
  f.runner.writer={...f.runner.writer,recordResponse:async()=>{throw Object.assign(new Error('Fixture persistence failed.'),{code:'FIXTURE_SAVE_FAILED'})}};
  const r=await f.run(),check=f.runner.status().invocations[0];
  assert.equal(f.runtime.listProviders()[0].lastGenerationOk,true);assert.equal(r.responses.length,0);assert.equal(check.status,'failed');assert.equal(check.structuredResponseValid,true);assert.equal(check.durableResponseRecorded,false);assert.equal(check.stageReady,false);
});

test('editing a captured node invalidates its invocation readiness rather than promoting historical response success',async t=>{
  const f=await fixture(t);f.setResponse(output());const r=await f.run();
  const changed=await f.store.updateNode(r.id,'frame',{prompt:'The user changed the comparison.'},{expectedNodeRevision:r.nodes[0].revision});
  const check=planningInvocationEvidence(changed,r.attempts[0].id);
  assert.equal(check.status,'stale');assert.equal(check.durableResponseRecorded,true);assert.equal(check.currentForNode,false);assert.equal(check.stageReady,false);
});

test('visible Planning labels require bound phase proof and distinguish adoption from task completion across reader updates',()=>{
  const ref={requestId:'request',cycleId:'cycle',nodeId:'plan',nodeRevision:4,responseId:'response'};
  const stage={scope:'planning-invocation',stage:'plan',status:'succeeded',attemptId:'attempt',nodeId:'plan',nodeRevision:4,responseId:'response',outputHash:'a'.repeat(64),structuredResponseValid:true,durableResponseRecorded:true,currentForNode:true,stageReady:true};
  const run={id:'run',status:'running',settled:false,responseCycle:{state:'executing',requestId:'request',cycleId:'cycle',planRef:ref}};
  assert.equal(planningProgressForRun(run).label,'Planning result unverified');
  run.responseCycle.planning={scope:'planning-cycle',stages:[stage],planAdopted:true,planRef:ref,taskSuccessVerified:true,privateText:'Never copy this unbounded provider text.'};
  assert.equal(planningProgressForRun(run).label,'Plan adopted · working on task');
  const projected=projectFamily({runs:[run]}).runs[0];assert.equal(planningProgressForRun(projected).planAdopted,true);
  const merged=mergeChatRunUpdate({id:'run'},run);assert.equal(planningProgressForRun(merged).planAdopted,true);
  assert.equal(merged.responseCycle.planning.taskSuccessVerified,false);assert.doesNotMatch(JSON.stringify(projected),/privateText|unbounded provider text/);
  for(const key of ['responseId','outputHash','structuredResponseValid','durableResponseRecorded','currentForNode','stageReady']){
    const invalid=structuredClone(run);delete invalid.responseCycle.planning.stages[0][key];assert.equal(planningProgressForRun(invalid).label,'Planning result unverified',key);
  }
  run.responseCycle.state='paused_after_plan';run.responseCycle.planning.planAdopted=false;
  assert.equal(planningProgressForRun(run).label,'Plan checked · awaiting review');assert.equal(planningProgressForRun(run).planAdopted,false);
  run.responseCycle.state='completed';run.status='completed';run.settled=true;
  assert.equal(planningProgressForRun(run).label,'Planning result unverified','A plain final model response cannot mark the complete Planning cycle verified.');
});
