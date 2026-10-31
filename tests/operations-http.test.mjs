import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';
import { recordFixturePlan } from './fixture-task-plan.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const until=async(check,label='HTTP operation condition')=>{const end=Date.now()+7000;while(Date.now()<end){const result=await check();if(result)return result;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail(`${label} did not settle`);};
const workflow=(planningMode='off')=>({id:'http-operation-workflow',name:'HTTP deployed worker',nodes:[{id:'input',type:'input'},{id:'agent',type:'agent',name:'Worker',prompt:'Write the isolated fixture result and independently read it.',model:'http-fixture-model'},{id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{maxParallel:1,planningMode}});
class Desktop extends EventEmitter{status(){return{available:false,enabled:false};}async setEnabled(){return this.status();}}
async function fixture(t,{execute,maxConcurrentRuns=4,planningMode='off'}={}){
  const directory=await mkdtemp(path.join(tmpdir(),'relay-operations-http-')),dataDir=path.join(directory,'data'),cwd=path.join(directory,'workspace'),calls=[],readinessCalls=[],apps=[];
  let app,url,cookie;
  class Runtime extends EventEmitter{
    status(){return{connected:true,authenticated:true,defaultModel:'http-fixture-model',models:[{model:'http-fixture-model'}]};}async start(){return this.status();}async close(){this.closed=true;}
    async runAgent(options){
      if(options.responseOnly){readinessCalls.push(options);const captured=JSON.parse(options.prompt.slice(options.prompt.lastIndexOf('\n\n')+2));
      assert.equal(captured.module.kind,'viability','Only schedule readiness uses the response-only fixture.');
      return{output:JSON.stringify({values:Object.fromEntries(captured.template.fields.map(field=>[field.id,field.label+': the supplied isolated fixture task has a local implementation and no missing personal prerequisite.'])),grounding:captured.template.fields.filter(field=>field.grounding==='required').map(field=>({field:field.id,sourceId:'viability:task'})),requirements:[],openQuestions:[],challengeResponses:[]}),threadId:'fixture-readiness',turnId:'fixture-readiness-turn'};}
      const index=calls.push(options);
      if(execute)return execute(options,index);
      await recordFixturePlan(options,{title:'Write and verify the isolated operation result',doneWhen:'The actual operation-proof.txt file contains the requested fixture output.'});
      options.onEvent({type:'thread',threadId:options.threadId||'http-fixture-thread',model:'http-fixture-model'});
      const content=`Verified operation side effect ${index}.\n`,write=await options.onToolCall({name:'relay_workspace',arguments:{action:'write',path:'operation-proof.txt',text:content}});
      assert.equal(write.success,true);
      const read=await options.onToolCall({name:'relay_workspace',arguments:{action:'read',path:'operation-proof.txt'}});
      assert.equal(read.success,true);assert.match(read.contentItems[0].text,/Verified operation side effect/);
      // These operations tests record task notes voluntarily with automatic Planning off.
      // The checked local write/read, not a synthetic planning response, supplies the completion evidence.
      const task=async arguments_=>{const response=await options.onToolCall({name:'relay_task',arguments:arguments_});assert.equal(response.success,true,response.contentItems?.[0]?.text);return JSON.parse(response.contentItems.find(item=>item.type==='inputText').text);};
      let state=await task({action:'read'});
      for(const step of state.steps.filter(step=>(step.kind||'action')==='action'&&!['done','skipped'].includes(step.status)))state=await task({action:'step',expectedRevision:state.revision,stepId:step.id,status:'done',evidence:'The actual workspace write succeeded and an independent read returned the expected operation-proof.txt content.'});
      await task({action:'review',expectedRevision:state.revision,review:{decision:'respond',summary:'The actual operation-proof.txt write and independent read agreed. This occurrence has no remaining fixture work.'}});
      return{output:content,threadId:options.threadId||'http-fixture-thread'};
    }
  }
  async function boot(){app=await createHarnessServer({port:0,dataDir,defaultCwd:cwd,maxConcurrentRuns,runtime:new Runtime(),desktop:new Desktop()});apps.push(app);await app.learning.updateSettings({mode:'manual'});url=await app.listen();const home=await fetch(url);cookie=home.headers.get('set-cookie').split(';',1)[0];await home.arrayBuffer();return app;}
  await boot();t.after(async()=>{for(const value of apps)await value.close();assert.match(path.basename(directory),/^relay-operations-http-/);await rm(directory,{recursive:true,force:true});});
  const request=async(route,{method='GET',body,auth=true,headers={}}={})=>{const response=await fetch(new URL(route,url),{method,headers:{...(auth?{Cookie:cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,data:await response.json()};};
  const create=async extra=>{const response=await request('/api/operations/deployments',{method:'POST',body:{name:'HTTP fixture operation',input:'Write and verify the isolated fixture result.',cwd,workflow:workflow(planningMode),enabled:true,trigger:{type:'webhook'},...extra}});assert.equal(response.status,201,JSON.stringify(response.data));return response.data;};
  const hook=async(deployment,key,payload,headers={})=>{const secret=(await request(`/api/operations/deployments/${deployment.id}/webhook`)).data;return request(`/hooks/${deployment.id}`,{method:'POST',auth:false,body:payload,headers:{Authorization:`Bearer ${secret.token}`,...(key?{'Idempotency-Key':key}:{}),...headers}});};
  return{get app(){return app;},get url(){return url;},get cookie(){return cookie;},directory,dataDir,cwd,calls,readinessCalls,request,create,hook,async restart(){await app.close();return boot();}};
}

test('authenticated HTTP config reports exact webhook URLs and requires explicit replay of unknown sends',async t=>{
  const f=await fixture(t),sent=[];
  f.app.operations.outboundTransport=async value=>{
    sent.push({id:value.deliveryId,key:value.idempotencyKey,target:value.target.url});
    return sent.length===1?{state:'unknown',httpStatus:503,reason:'Remote outcome unverified.'}:{state:'delivered',httpStatus:202};
  };
  const secret='https://alerts.example.com/private/sensitive-path';
  const invalid=await f.request('/api/operations/deployments',{method:'POST',body:{
    name:'Invalid webhook',input:'Check local facts.',cwd:f.cwd,workflow:workflow(),
    deliveryTarget:{type:'webhook',url:'http://localhost:9229/secret'}}});
  assert.equal(invalid.status,201);
  assert.equal(invalid.data.deliveryTarget.url,'http://localhost:9229/secret');
  const schedule=await f.create({trigger:{type:'manual'},deliveryTarget:{type:'webhook',url:secret},
    missedRunPolicy:{onResume:'once',maxAgeSeconds:3600}});
  assert.deepEqual(schedule.deliveryTarget,{type:'webhook',url:secret,host:'alerts.example.com',configured:true});
  assert.deepEqual(schedule.missedRunPolicy,{onResume:'once',maxAgeSeconds:3600});
  assert.equal(schedule.deliveryTarget.url,secret);
  const admitted=await f.request('/api/operations/deployments/'+schedule.id+'/trigger',{method:'POST',body:{idempotencyKey:'test-http-delivery'}});
  assert.equal(admitted.status,202);
  assert.equal(admitted.data.definition.deliveryTarget.url,secret);
  await until(()=>f.app.operations.getJob(admitted.data.id).outbound?.state==='unknown');
  assert.equal(sent.length,1);
  const current=(await f.request('/api/operations/jobs/'+admitted.data.id)).data;
  assert.equal(current.status,'completed');
  assert.equal(current.outbound.state,'unknown');
  assert.equal(current.definition.deliveryTarget.url,secret);
  const visible=(await f.request('/api/operations')).data;
  assert.equal(visible.deployments.find(item=>item.id===schedule.id).deliveryTarget.url,secret);
  assert.equal(visible.jobs.find(item=>item.id===admitted.data.id).definition.deliveryTarget.url,secret);
  assert.equal((await f.request('/api/operations/jobs/'+admitted.data.id+'/redeliver',{
    method:'POST',auth:false,body:{expectedRevision:current.outbound.revision,confirmPossibleDuplicate:true}})).status,401);
  const url='/api/operations/jobs/'+admitted.data.id+'/redeliver';
  assert.equal((await f.request(url,{method:'POST',body:{expectedRevision:current.outbound.revision}})).status,409);
  assert.equal((await f.request(url,{method:'POST',body:{expectedRevision:current.outbound.revision-1,confirmPossibleDuplicate:true}})).status,409);
  const retry=await f.request(url,{method:'POST',body:{expectedRevision:current.outbound.revision,confirmPossibleDuplicate:true}});
  assert.equal(retry.status,200);
  await until(()=>f.app.operations.getJob(admitted.data.id).outbound?.state==='delivered');
  assert.equal(sent.length,2);
  assert.deepEqual(sent.map(item=>item.key),[admitted.data.id,admitted.data.id]);
  assert.equal(f.app.operations.getJob(admitted.data.id).outbound.attempts.length,2);
  assert.equal((await f.request('/api/operations')).data.jobs.find(item=>item.id===admitted.data.id).outbound.url,secret);
  await f.restart();
  assert.equal(f.app.operations.getJob(admitted.data.id).outbound.state,'delivered');
});

for(const codexHistory of ['relay','codex']) test(`repeated cron occurrences retain revised instructions, conversation and saved task notes across pause and host restart (${codexHistory})`,async t=>{
  const f=await fixture(t),schedule=await f.create({
    name:'Recurring research continuity fixture',
    trigger:{type:'cron',expression:'*/30 * * * *',timezone:'America/New_York'},
    overlap:'skip'
  });
  assert.equal((await f.request('/api/runtime/settings',{method:'POST',body:{codexHistory}})).status,200);
  const trigger=async key=>{
    const admitted=await f.request('/api/operations/deployments/'+schedule.id+'/trigger',{method:'POST',body:{idempotencyKey:key}});
    assert.equal(admitted.status,202,JSON.stringify(admitted.data));
    await until(()=>f.app.operations.getJob(admitted.data.id).status==='completed','completed recurring run');
    return f.app.operations.getJob(admitted.data.id);
  };
  const first=await trigger('research-1'),firstRunId=first.attempts.at(-1).runId;
  assert.ok(firstRunId);
  const firstRun=await f.app.conversations.get(firstRunId);
  assert.equal(firstRun.taskId,firstRunId);
  const originalPlan=await f.app.tasks.get(firstRunId);
  assert.ok(originalPlan.taskId===firstRunId);
  assert.equal(originalPlan.planningReviews.at(-1).runId,firstRunId);
  const originalPrompt=firstRun.workflow.nodes.find(node=>node.id==='agent').prompt;
  const currentInstructions='UPDATED_RECURRING_INSTRUCTIONS: Use current evidence to write and independently verify the isolated fixture result.';
  const updatedWorkflow=workflow();updatedWorkflow.nodes.find(node=>node.id==='agent').prompt=currentInstructions;
  const paused=await f.request('/api/operations/deployments/'+schedule.id,{method:'PUT',body:{
    expectedRevision:schedule.revision,enabled:false,workflow:updatedWorkflow
  }});
  assert.equal(paused.status,200,JSON.stringify(paused.data));
  assert.equal(paused.data.enabled,false);assert.equal(paused.data.nextAt,null);
  await f.restart();
  const restored=(await f.request('/api/operations/deployments/'+schedule.id)).data;
  assert.equal(restored.enabled,false,'an explicit pause survives host restart');
  assert.equal(restored.workflow.nodes.find(node=>node.id==='agent').prompt,currentInstructions);
  const resumed=await f.request('/api/operations/deployments/'+schedule.id,{method:'PUT',body:{
    expectedRevision:restored.revision,enabled:true
  }});
  assert.equal(resumed.status,200,JSON.stringify(resumed.data));
  const second=await trigger('research-2'),secondRunId=second.attempts.at(-1).runId;
  assert.notEqual(firstRunId,secondRunId,'each execution retains an individual run receipt');
  const secondRun=await f.app.conversations.get(secondRunId);
  assert.equal(secondRun.kind,'continuation','scheduled research continues rather than restarting an unrelated conversation');
  assert.equal(secondRun.parentRunId,firstRunId);
  assert.equal(secondRun.taskId,firstRunId,'both runs share one conversation root and persisted Planning task');
  assert.equal(secondRun.workflow.nodes.find(node=>node.id==='agent').prompt,currentInstructions);
  assert.ok(f.calls[1].prompt.includes(currentInstructions),'the actual resumed model turn receives the current instructions');
  assert.equal(f.calls[1].threadId,firstRun.nodes.agent.threadId,'Both current native history and the legacy relay alias resume the persistent conversation');
  assert.equal((await f.app.conversations.get(firstRunId)).workflow.nodes.find(node=>node.id==='agent').prompt,originalPrompt,'prior instructions remain in their original receipt');
  assert.equal(second.continuedFromRunId,firstRunId);
  assert.equal(second.conversationRootId,firstRunId);
  assert.equal(secondRun.metadata?.managedBy,'operations');
  assert.equal(secondRun.metadata?.inboxId,second.attempts.at(-1).inboxId);
  assert.equal(secondRun.metadata?.inboxDispatchId!==undefined,true);
  const family=await f.app.conversations.family(secondRunId);
  assert.equal(family.rootId,firstRunId);
  assert.equal(family.runs.length,2);
  assert.deepEqual(family.runs.map(run=>run.id),[firstRunId,secondRunId]);
  const shared=await f.app.tasks.get(secondRun.taskId);
  assert.equal(shared.taskId,originalPlan.taskId);
  assert.ok(shared.revision>=originalPlan.revision,'the second occurrence keeps the original Planning continuity');
  assert.equal(shared.planningReviews.at(-1).runId,secondRunId,'the continuation reassesses its own newly completed work');
  assert.equal(f.app.conversations.list('active').filter(row=>row.rootId===firstRunId).length,1);
  assert.equal(f.calls.length,2,'no extra model run was started to stitch the conversation together');
  await f.restart();
  const third=await trigger('research-3'),thirdRunId=third.attempts.at(-1).runId;
  const thirdRun=await f.app.conversations.get(thirdRunId);
  assert.equal(thirdRun.kind,'continuation');
  assert.equal(thirdRun.parentRunId,secondRunId,'the next scheduled turn continues the latest run');
  assert.equal(thirdRun.taskId,firstRunId,'subsequent occurrences keep the original Planning identity');
  assert.equal((await f.app.tasks.get(thirdRun.taskId)).planningReviews.at(-1).runId,thirdRunId);
  assert.equal(third.conversationRootId,firstRunId);
  assert.ok(f.calls[2].prompt.includes(currentInstructions),'later occurrences retain the revised instructions');
  assert.equal(f.calls[2].threadId,secondRun.nodes.agent.threadId);
  const longerFamily=await f.app.conversations.family(thirdRunId);
  assert.equal(longerFamily.rootId,firstRunId);
  assert.deepEqual(longerFamily.runs.map(run=>run.id),[firstRunId,secondRunId,thirdRunId]);
  assert.equal(f.app.conversations.list('active').filter(row=>row.rootId===firstRunId).length,1);
  assert.equal(f.calls.length,3,'three admitted occurrences create three runs but only one conversation');
  assert.ok(f.readinessCalls.length>=2,'Original and revised instructions each receive their own structured readiness assessment.');
});
test('parallel schedules remain independent rather than sharing one active provider thread',async t=>{
  const f=await fixture(t),schedule=await f.create({trigger:{type:'manual'},overlap:'parallel'});
  const trigger=async key=>{
    const response=await f.request('/api/operations/deployments/'+schedule.id+'/trigger',{method:'POST',body:{idempotencyKey:key}});
    await until(()=>f.app.operations.getJob(response.data.id).status==='completed');
    return await f.app.conversations.get(f.app.operations.getJob(response.data.id).attempts.at(-1).runId);
  };
  const first=await trigger('parallel-A'),second=await trigger('parallel-B');
  assert.notEqual(first.taskId,second.taskId,'manual/parallel work is not forced into a shared thread');
});
test('ordinary clean host restart retains enabled cronjobs; explicit Stop stays durable',async t=>{
  const f=await fixture(t),created=await f.create({trigger:{type:'cron',expression:'0 9 * * *',timezone:'America/New_York'}});
  assert.equal(f.app.operations.status().paused,false);
  assert.equal(f.app.operations.getDeployment(created.id).enabled,true);
  await f.restart();
  const restored=f.app.operations.getDeployment(created.id);
  assert.equal(f.app.operations.status().paused,false,'clean restart must not silently disable recurring work');
  assert.equal(restored.enabled,true);
  assert.deepEqual(restored.trigger,created.trigger);
  assert.equal(f.app.operations.snapshot().jobs.length,0);
  await f.app.operations.pause('User explicitly stopped scheduled work');
  await f.restart();
  assert.equal(f.app.operations.status().paused,true,'deliberate operator pause survives restart');
  assert.match(f.app.operations.status().pauseReason,/explicitly stopped/);
});
test('scheduled results are locally available, revision-acknowledged, authenticated, and durable',async t=>{
  const f=await fixture(t),deployment=await f.create({enabled:true,trigger:{type:'manual'}});
  const admission=await f.request('/api/operations/deployments/'+deployment.id+'/trigger',{method:'POST',body:{idempotencyKey:'durable-results-fixture'}});
  assert.equal(admission.status,202);
  await until(()=>f.app.operations.getJob(admission.data.id).status==='completed');
  const completed=f.app.operations.getJob(admission.data.id);
  assert.equal(completed.delivery.state,'available');
  assert.equal(completed.delivery.outcome,'completed');
  assert.equal(completed.delivery.revision,2);
  assert.equal(completed.delivery.acknowledgedAt,null);
  assert.match(completed.delivery.preview||'',/Verified operation side effect 1/);
  const snapshot=await f.request('/api/operations');
  assert.equal(snapshot.data.results.available,1);
  assert.equal(snapshot.data.status.availableResults,1);
  assert.equal((await f.request('/api/operations',{auth:false})).status,401);
  const url='/api/operations/jobs/'+admission.data.id+'/acknowledge';
  assert.equal((await f.request(url,{method:'POST',auth:false,body:{expectedRevision:2}})).status,401);
  assert.equal((await f.request(url,{method:'POST',body:{}})).status,400);
  assert.equal((await f.request(url,{method:'POST',body:{expectedRevision:1}})).status,409);
  const acknowledge=await f.request(url,{method:'POST',body:{expectedRevision:2}});
  assert.equal(acknowledge.status,200);
  assert.equal(acknowledge.data.delivery.state,'acknowledged');
  assert.equal((await f.request(url,{method:'POST',body:{expectedRevision:2}})).data.delivery.revision,3);
  assert.equal((await f.request('/api/operations')).data.results.available,0);
  await f.restart();
  const saved=f.app.operations.getJob(admission.data.id);
  assert.equal(saved.delivery.state,'acknowledged');
  assert.equal(saved.delivery.preview,completed.delivery.preview);
  assert.equal(saved.attempts[0].runId,completed.attempts[0].runId);
});

test('deployment setup requires the local session and rejects invalid folders, attachments and stale edits before capture',async t=>{
  const context=await fixture(t),{request,cwd,directory}=context;
  assert.equal((await request('/api/operations',{auth:false})).status,401);assert.equal((await request('/api/operations/deployments',{method:'POST',auth:false,body:{}})).status,401);
  const base={name:'Validation fixture',input:'Capture a valid task.',cwd,workflow:workflow()};
  assert.equal((await request('/api/operations/deployments',{method:'POST',body:{...base,cwd:'relative-folder'}})).status,400);
  assert.equal((await request('/api/operations/deployments',{method:'POST',body:{...base,cwd:path.join(directory,'missing-folder')}})).status,400);
  const regularFile=path.join(directory,'not-a-folder.txt');await writeFile(regularFile,'A regular file.');assert.equal((await request('/api/operations/deployments',{method:'POST',body:{...base,cwd:regularFile}})).status,400);
  assert.ok([400,404].includes((await request('/api/operations/deployments',{method:'POST',body:{...base,attachmentIds:['file_missing']}})).status));assert.equal((await request('/api/operations')).data.deployments.length,0);
  const deployment=await context.create({enabled:false,trigger:{type:'manual'}});const changed=await request(`/api/operations/deployments/${deployment.id}`,{method:'PUT',body:{name:'Updated deployment',expectedRevision:deployment.revision}});assert.equal(changed.status,200);assert.equal(changed.data.revision,2);
  const inspected=await request(`/api/operations/deployments/${deployment.id}`);assert.equal(inspected.status,200);assert.equal(inspected.data.revision,2);assert.equal(inspected.data.name,'Updated deployment');assert.equal(inspected.data.trigger.type,'manual');
  assert.equal(Object.hasOwn(inspected.data,'webhookToken'),false,'the inspected schedule must not expose its secret');
  assert.equal((await request(`/api/operations/deployments/${deployment.id}`,{auth:false})).status,401,'inspection requires the local session');
  assert.equal((await request(`/api/operations/deployments/${deployment.id}`,{method:'PUT',body:{cwd:path.join(directory,'still-missing')}})).status,400);assert.ok([400,404].includes((await request(`/api/operations/deployments/${deployment.id}`,{method:'PUT',body:{attachmentIds:['file_missing']}})).status));assert.equal((await request(`/api/operations/deployments/${deployment.id}`,{method:'PUT',body:{name:'Stale overwrite',expectedRevision:1}})).status,409);
  const secret=(await request(`/api/operations/deployments/${deployment.id}/webhook`)).data;assert.match(secret.token,/^[a-f0-9]{64}$/);assert.equal((await request(`/api/operations/deployments/${deployment.id}/webhook`,{auth:false})).status,401);assert.ok(!JSON.stringify((await request('/api/operations')).data).includes(secret.token));assert.ok(!JSON.stringify((await request('/api/status')).data).includes(secret.token));assert.equal(context.calls.length,0);
});

test('deployment HTTP definitions expose explicit overlap choices while rejecting unknown policies',async t=>{
  const context=await fixture(t),deployment=await context.create({enabled:true,trigger:{type:'interval',everySeconds:10}});assert.equal(deployment.overlap,'parallel');
  for(const overlap of ['queue','skip','parallel']){const updated=await context.request(`/api/operations/deployments/${deployment.id}`,{method:'PUT',body:{overlap}});assert.equal(updated.status,200);assert.equal(updated.data.overlap,overlap);assert.equal((await context.request('/api/operations')).data.deployments.find(value=>value.id===deployment.id).overlap,overlap);}
  const invalid=await context.request(`/api/operations/deployments/${deployment.id}`,{method:'PUT',body:{overlap:'hidden-limit'}});assert.equal(invalid.status,400);assert.equal(context.app.operations.getDeployment(deployment.id).overlap,'parallel');assert.equal(context.calls.length,0);
});

test('finite webhook and manual HTTP admissions stop at the saved lifetime count and replay original receipts after reaching it',async t=>{
  const context=await fixture(t);await context.app.operations.pause('Inspect finite HTTP receipts before dispatch.');const deployment=await context.create({limits:{maxIterations:2}}),first=await context.hook(deployment,'finite-http-1',{step:1}),second=await context.request(`/api/operations/deployments/${deployment.id}/trigger`,{method:'POST',body:{idempotencyKey:'finite-http-2'}});assert.equal(first.status,202);assert.equal(second.status,202);
  const blocked=await context.hook(deployment,'finite-http-3',{step:3});assert.equal(blocked.status,409);assert.match(blocked.data.error,/Stopped after 2/);const duplicate=await context.hook(deployment,'finite-http-1',{step:1});assert.equal(duplicate.status,202);assert.equal(duplicate.data.id,first.data.id);assert.equal(context.calls.length,0);
  const state=(await context.request('/api/operations')).data,saved=state.deployments.find(item=>item.id===deployment.id);assert.equal(saved.admittedJobs,2);assert.equal(saved.limitStatus.reached,true);assert.equal(saved.limitStatus.remainingIterations,0);assert.equal(state.jobs.length,2);
  await context.request('/api/operations/resume',{method:'POST',body:{}});await until(()=>context.app.operations.getJob(second.data.id).status==='completed');assert.equal(context.calls.length,2);await context.restart();const restored=context.app.operations.getDeployment(deployment.id);assert.equal(restored.admittedJobs,2);assert.equal(restored.limitStatus.reached,true);assert.equal((await context.hook(deployment,'finite-http-4',{})).status,409);
});

test('HTTP finite duration and explicit timezone end dates persist while invalid limits are rejected before definition capture',async t=>{
  const context=await fixture(t);for(const limits of [{maxIterations:-1},{runForSeconds:0},{endAt:'2030-01-01T09:00:00'}]){const response=await context.request('/api/operations/deployments',{method:'POST',body:{name:'Invalid finite fixture',input:'Do this task',cwd:context.cwd,workflow:workflow(),limits}});assert.equal(response.status,400);}assert.equal(context.app.operations.list().length,0);
  const deployment=await context.create({enabled:false,trigger:{type:'manual'},limits:{maxIterations:500000,runForSeconds:30*86400,endAt:'2030-01-05T17:30:00-05:00'}});assert.equal(deployment.activatedAt,null);assert.equal(deployment.limits.endAt,'2030-01-05T22:30:00.000Z');assert.equal(deployment.limits.runForSeconds,30*86400);const updated=await context.request(`/api/operations/deployments/${deployment.id}`,{method:'PUT',body:{enabled:true,expectedRevision:deployment.revision}});assert.equal(updated.status,200);assert.ok(updated.data.activatedAt);assert.equal(Date.parse(updated.data.limitStatus.endsAt)-Date.parse(updated.data.activatedAt),30*86400000);const disk=JSON.parse(await readFile(path.join(context.dataDir,'operations.json'),'utf8'));assert.equal(disk.deployments[0].activatedAt,updated.data.activatedAt);assert.deepEqual(disk.deployments[0].limits,updated.data.limits);
});

test('calendar preview is session-protected and read-only, while real DST fold ticks persist as separate jobs',async t=>{
  const context=await fixture(t,{maxConcurrentRuns:null}),{request}=context,trigger={type:'cron',expression:'30 1 * * *',timezone:'America/New_York'};let clock=Date.parse('2026-11-01T04:00:00Z');context.app.operations.clock=()=>clock;context.app.operations.kick=()=>{};
  assert.equal((await request('/api/operations/schedule-preview',{method:'POST',body:{trigger},auth:false})).status,401);
  const preview=await request('/api/operations/schedule-preview',{method:'POST',body:{trigger,count:2}});assert.equal(preview.status,200);assert.deepEqual(preview.data.occurrences.map(value=>value.iso),['2026-11-01T05:30:00.000Z','2026-11-01T06:30:00.000Z']);assert.equal((await request('/api/operations')).data.jobs.length,0);assert.equal(context.calls.length,0);
  for(const body of [{trigger,count:1000000},{trigger:{...trigger,timezone:'Invalid/Zone'}},{trigger:{...trigger,expression:'0 0 30 FEB *'}},{trigger:{type:'manual'}}])assert.equal((await request('/api/operations/schedule-preview',{method:'POST',body})).status,400);
  for(const asset of ['/schedule-model.mjs','/conversation-menu.mjs','/brand.css','/assets/relay-field.svg']){const response=await fetch(context.url+asset);assert.equal(response.status,200);assert.match(response.headers.get('content-type'),asset.endsWith('.css')?/css/:asset.endsWith('.svg')?/image\/svg/:/javascript/);await response.arrayBuffer();}
  const deployment=await context.create({trigger});assert.equal(deployment.nextAt,preview.data.nextAt);const scheduled=[];
  for(const occurrence of preview.data.occurrences){clock=occurrence.at;await context.app.operations.poll();await until(async()=>{await context.app.operations.poll();return context.app.operations.snapshot().jobs.filter(job=>job.status==='completed').length===scheduled.length+1;});scheduled.push(occurrence.at);}
  const jobs=context.app.operations.snapshot().jobs;assert.equal(context.calls.length,2);assert.deepEqual(jobs.map(job=>job.scheduledAt).sort(),scheduled);assert.ok(jobs.every(job=>job.source==='cron'&&job.attempts.length===1));assert.equal(new Set(jobs.map(job=>job.keyHash)).size,2);
  const disk=JSON.parse(await readFile(path.join(context.dataDir,'operations.json'),'utf8'));assert.deepEqual(disk.deployments[0].trigger,trigger);await context.restart();assert.equal(context.app.operations.status().paused,false,'clean host restart resumes when all run receipts are settled');assert.equal(context.app.operations.snapshot().jobs.length,2);assert.equal(context.calls.length,2);
});

test('unlimited HTTP webhook jobs overlap beyond four with independent durable receipts',async t=>{
  const release=deferred(),context=await fixture(t,{maxConcurrentRuns:null,planningMode:'off',execute:async(options,index)=>{options.onEvent({type:'thread',threadId:`parallel-http-${index}`,model:'http-fixture-model'});await new Promise((resolve,reject)=>{const stop=()=>reject(Object.assign(new Error('Cancelled'),{code:'ABORT_ERR'}));if(options.signal.aborted)return stop();options.signal.addEventListener('abort',stop,{once:true});release.promise.then(()=>{options.signal.removeEventListener('abort',stop);resolve();});});return{output:`Verified independent HTTP operation ${index}.`,threadId:`parallel-http-${index}`};}});
  try{const deployment=await context.create(),jobs=[];for(let index=0;index<6;index++)jobs.push((await context.hook(deployment,`parallel-job:${index}`,{index})).data);await until(()=>context.calls.length===6&&jobs.every(job=>context.app.operations.getJob(job.id).status==='running'));assert.equal(context.app.engine.executionStatus().unlimited,true);assert.equal(context.app.engine.executionStatus().activeCount,6);assert.equal(new Set(jobs.map(job=>context.app.operations.getJob(job.id).attempts[0].runId)).size,6);const duplicate=await context.hook(deployment,'parallel-job:0',{index:0});assert.equal(duplicate.data.id,jobs[0].id);assert.equal(context.calls.length,6);release.resolve();await until(()=>jobs.every(job=>context.app.operations.getJob(job.id).status==='completed'));assert.ok(jobs.every(job=>context.app.operations.getJob(job.id).attempts.length===1));}finally{release.resolve();}
});

test('webhook bearer auth works without a browser cookie, deduplicates delivery, and executes the attached worker exactly once',async t=>{
  const context=await fixture(t),deployment=await context.create(),{request,hook,cwd,calls}=context,secret=(await request(`/api/operations/deployments/${deployment.id}/webhook`)).data;
  assert.equal((await request(`/hooks/${deployment.id}`,{method:'POST',auth:false,body:{value:42},headers:{'Idempotency-Key':'missing-auth'}})).status,403);assert.equal((await request(`/hooks/${deployment.id}`,{method:'POST',auth:false,body:{value:42},headers:{Authorization:'Bearer wrong','Idempotency-Key':'wrong-token'}})).status,403);
  assert.equal((await hook(deployment,null,{value:42})).status,400);assert.equal((await hook(deployment,'cross-origin',{value:42},{Origin:'https://unrelated.invalid'})).status,403);assert.equal((await hook(deployment,'cross-site',{value:42},{'Sec-Fetch-Site':'cross-site'})).status,403);
  const [first,duplicate]=await Promise.all([hook(deployment,'delivery-42',{value:42}),hook(deployment,'delivery-42',{value:42})]);assert.equal(first.status,202);assert.equal(duplicate.status,202);assert.equal(first.data.id,duplicate.data.id);assert.equal((await hook(deployment,'delivery-42',{value:43})).status,409);
  await until(()=>context.app.operations.getJob(first.data.id).status==='completed');assert.equal(calls.length,1);assert.equal(await readFile(path.join(cwd,'operation-proof.txt'),'utf8'),'Verified operation side effect 1.\n');
  const saved=(await request(`/api/operations/jobs/${first.data.id}`)).data;assert.equal(saved.attempts.length,1);assert.ok(saved.attempts[0].runId);const run=(await request(`/api/runs/${saved.attempts[0].runId}`)).data;assert.equal(run.status,'completed');assert.match(run.input,/UNTRUSTED TRIGGER DATA/);assert.match(run.input,/"value":42/);assert.equal(run.workflow.nodes[1].model,'http-fixture-model');assert.ok(run.events.some(event=>event.data.type==='workspace.action'&&event.data.action==='write'));
  const rotated=await request(`/api/operations/deployments/${deployment.id}/rotate`,{method:'POST',body:{}});assert.equal(rotated.status,200);assert.notEqual(rotated.data.token,secret.token);assert.equal((await request(`/hooks/${deployment.id}`,{method:'POST',auth:false,body:{value:42},headers:{Authorization:`Bearer ${secret.token}`,'Idempotency-Key':'old-token'}})).status,403);
});

test('Stop all pauses operations and the global inbox, restart retains receipts, and Resume starts only the saved next job',async t=>{
  const entered=deferred();const context=await fixture(t,{maxConcurrentRuns:1,planningMode:'off',execute:async(options,index)=>{if(index===1){entered.resolve();await new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('Stopped fixture worker'),{name:'AbortError'})),{once:true}));}return{output:'Verified resumed fixture.',threadId:'stop-fixture-thread'};}}),deployment=await context.create();
  const first=await context.hook(deployment,'first-stop-job',{number:1});await entered.promise;const second=await context.hook(deployment,'second-saved-job',{number:2});const active=context.app.operations.getJob(first.data.id);await until(()=>context.app.operations.getJob(first.data.id).attempts[0]?.runId);const runId=context.app.operations.getJob(first.data.id).attempts[0].runId;
  assert.equal((await context.request('/api/runs/stop-all',{method:'POST',body:{}})).status,200);await until(()=>context.app.operations.getJob(first.data.id).status==='cancelled');assert.equal(context.app.operations.status().paused,true);assert.equal(context.app.inbox.status().paused,true);assert.equal(context.app.operations.getJob(second.data.id).status,'queued');assert.equal(context.calls.length,1);
  await context.restart();assert.equal(context.app.operations.getJob(first.data.id).attempts[0].runId,runId);assert.equal(context.app.operations.getJob(first.data.id).status,'cancelled');assert.equal(context.app.operations.status().paused,true);assert.equal(context.calls.length,1);const duplicate=await context.hook(deployment,'first-stop-job',{number:1});assert.equal(duplicate.data.id,first.data.id);
  const resumed=await context.request('/api/operations/resume',{method:'POST',body:{resumeInbox:true}});assert.equal(resumed.status,200);await until(()=>context.app.operations.getJob(second.data.id).status==='completed');assert.equal(context.calls.length,2);assert.equal(context.app.operations.getJob(second.data.id).attempts.length,1);assert.equal(active.id,first.data.id);
});

test('shutdown drains an admitted webhook write, blocks later hooks and mutations, and never runs the late captured job',async t=>{
  const context=await fixture(t),deployment=await context.create(),secret=(await context.request(`/api/operations/deployments/${deployment.id}/webhook`)).data,entered=deferred(),release=deferred(),save=context.app.operations.save.bind(context.app.operations);let delayed=false;
  context.app.operations.save=async next=>{if(!delayed&&next.jobs.length){delayed=true;entered.resolve();await release.promise;}return save(next);};
  const delivery=context.hook(deployment,'admitted-on-close',{value:'saved'});await entered.promise;let closed=false;const closing=context.app.close().then(()=>{closed=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);
  try{assert.equal((await context.request('/api/operations/deployments',{method:'POST',body:{}})).status,503);assert.equal((await context.request(`/hooks/${deployment.id}`,{method:'POST',auth:false,body:{value:'late'},headers:{Authorization:`Bearer ${secret.token}`,'Idempotency-Key':'late'}})).status,503);}finally{release.resolve();}
  const captured=await delivery;assert.equal(captured.status,202);await closing;assert.equal(context.calls.length,0);assert.equal(context.app.operations.getJob(captured.data.id).status,'queued');
  const disk=JSON.parse(await readFile(path.join(context.dataDir,'operations.json'),'utf8'));assert.equal(disk.jobs.length,1);assert.equal(disk.jobs[0].id,captured.data.id);
});

test('a partial webhook body cannot be admitted after shutdown begins',async t=>{
  const context=await fixture(t),deployment=await context.create(),secret=(await context.request(`/api/operations/deployments/${deployment.id}/webhook`)).data,entered=deferred(),release=deferred(),target=new URL(context.url),payload=JSON.stringify({value:'complete only after close'});
  context.app.desktop.setEnabled=async()=>{entered.resolve();await release.promise;return{enabled:false};};
  const reading=deferred();context.app.server.once('request',req=>{req.once('data',()=>reading.resolve());});
  let req;const response=new Promise((resolve,reject)=>{req=http.request({hostname:target.hostname,port:target.port,path:`/hooks/${deployment.id}`,method:'POST',headers:{Authorization:`Bearer ${secret.token}`,'Idempotency-Key':'partial-body','Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(chunks).toString())}));});req.on('error',reject);req.write(payload.slice(0,8));});
  await reading.promise;const closing=context.app.close();await entered.promise;req.end(payload.slice(8));try{const result=await response;assert.equal(result.status,503);assert.equal(context.app.operations.snapshot().jobs.length,0);assert.equal(context.calls.length,0);}finally{release.resolve();await closing;}
});

test('conversation HTTP reads retain actual turns after recent-run eviction and continuation survives restart',async t=>{
  const context=await fixture(t);await context.app.runtimeSettings.update({codexHistory:'codex'});const first=await context.request('/api/runs',{method:'POST',body:{workflow:workflow(),input:'Write the first conversation fixture.'}});assert.equal(first.status,201);await until(()=>context.app.engine.getRun(first.data.id).settled);
  const next=await context.request(`/api/runs/${first.data.id}/continue`,{method:'POST',body:{nodeId:'agent',message:'Write the next verified turn.'}});assert.equal(next.status,201);await until(()=>context.app.engine.getRun(next.data.id).settled);assert.equal(context.calls[1].threadId,'http-fixture-thread');
  const before=(await context.request(`/api/conversations/${next.data.id}`)).data;assert.equal(before.runs.length,2);assert.equal(before.runs[0].id,first.data.id);assert.equal(before.runs[1].id,next.data.id);
  await context.app.conversations.family(next.data.id);context.app.engine.runs.delete(first.data.id);const archived=await context.request(`/api/runs/${first.data.id}`);assert.equal(archived.status,200);assert.equal(archived.data.nodes.agent.threadId,'http-fixture-thread');assert.match(archived.data.output,/side effect 1/);assert.equal((await context.request('/api/conversations',{auth:false})).status,401);
  await context.restart();const family=(await context.request(`/api/conversations/${next.data.id}`)).data;assert.equal(family.runs.length,2);assert.equal(family.runs[0].id,first.data.id);assert.equal(context.calls.length,2,'opening archived conversations does not run agents');
  const continued=await context.request(`/api/runs/${first.data.id}/continue`,{method:'POST',body:{nodeId:'agent',message:'Continue the archived original turn.'}});assert.equal(continued.status,201);await until(()=>context.app.engine.getRun(continued.data.id).settled);assert.equal(context.calls.length,3);assert.equal(context.calls[2].threadId,'http-fixture-thread');assert.equal((await context.request(`/api/conversations/${continued.data.id}`)).data.runs.length,3);
});
