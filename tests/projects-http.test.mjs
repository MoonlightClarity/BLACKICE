import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHarnessServer} from '../server.mjs';

const until=async(check,label='project condition')=>{const end=Date.now()+7000;while(Date.now()<end){const value=await check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail(`${label} did not settle`);};
class Desktop extends EventEmitter{status(){return{available:false,enabled:false};}async setEnabled(){return this.status();}}
async function fixture(t,{execute,externalReceipt=false}={}){
  const root=await mkdtemp(path.join(tmpdir(),'blackice-projects-http-')),dataDir=path.join(root,'data'),cwd=path.join(root,'workspace'),calls=[],apps=[];
  let app,url,cookie;
  class Runtime extends EventEmitter{
    status(){return{connected:true,authenticated:true,defaultModel:'project-fixture-model',models:[{model:'project-fixture-model'}]};}
    async start(){return this.status();}async close(){}
    async runAgent(options){
      calls.push(options);
      assert.ok(!options.dynamicTools.some(tool=>tool.name==='relay_project'),'project workers cannot recursively orchestrate projects');
      if(execute)return execute(options,calls.length);
      const review=options.prompt.includes('You are Independent verifier.\n');
      options.onEvent({type:'thread',threadId:`project-fixture-${calls.length}`,model:'project-fixture-model'});
      const taskCall=async args=>{const result=await options.onToolCall({name:'relay_task',arguments:args});assert.equal(result.success,true,JSON.stringify(result));return JSON.parse(result.contentItems[0].text);};
      let taskState=await taskCall({action:'read'});
      taskState=await taskCall({action:'plan',expectedRevision:taskState.revision,steps:[{
        id:'assigned',title:review?'Inspect the saved proof against its criterion':'Write the requested proof file',status:'active',
        result:review?'An independent acceptance verdict with the observed proof content and any failed criterion.':'proof.txt saved with this fixture attempt\'s intended content and a write receipt.',
        note:review?'Read proof.txt through relay_workspace, compare its actual content with the requirement that it contains accepted, and return the verdict with the observed content.':'Write the fixture\'s initial or repaired content to proof.txt through relay_workspace and inspect the returned write receipt; a separate reviewer will check acceptance.',
        doneWhen:review?'The actual proof file is read and compared with the requested content.':'The intended file is written and its gateway receipt confirms the write.',
      }]});
      if(!review){
        const repaired=options.prompt.includes('PREVIOUS VERIFICATION: REPAIR THESE FAILURES');
        const text=repaired&&!options.prompt.includes('FORCE_FAILURE')?'accepted\n':'draft\n';
        const saved=await options.onToolCall({name:'relay_workspace',arguments:{action:'write',path:'proof.txt',text}});assert.equal(saved.success,true);
        if(externalReceipt){
          let state=await options.onToolCall({name:'relay_task',arguments:{action:'read'}});assert.equal(state.success,true);state=JSON.parse(state.contentItems[0].text);
          for(const external of [{operation:'prepare',destination:'https://example.com/fixture-result',content:'Synthetic local receipt fixture; no remote action is performed.'},{operation:'attempt'},{operation:'confirm',url:'https://example.com/fixture-result/one',evidence:'Synthetic receipt fixture for project recovery; no website is contacted.'}]){
            const recorded=await options.onToolCall({name:'relay_task',arguments:{action:'external',expectedRevision:state.revision,external:{receiptId:'http-recovery-fixture',...external}}});assert.equal(recorded.success,true,JSON.stringify(recorded));state=JSON.parse(recorded.contentItems[0].text);
          }
          taskState=state;
        }
        await taskCall({action:'step',expectedRevision:taskState.revision,stepId:'assigned',status:'done',evidence:`The workspace write returned success for proof.txt with intended content ${text.trim()}. Independent acceptance is checked by a separate reviewer.`});
        return{output:`Wrote proof.txt: ${text.trim()}.`,threadId:`project-fixture-${calls.length}`};
      }
      const read=await options.onToolCall({name:'relay_workspace',arguments:{action:'read',path:'proof.txt'}});assert.equal(read.success,true);
      const actual=JSON.parse(read.contentItems[0].text).content,passed=actual.includes('accepted');
      await taskCall({action:'step',expectedRevision:taskState.revision,stepId:'assigned',status:'done',evidence:`Read the actual proof and compared it with the acceptance criterion. Observed ${actual.trim()}; criterion passed: ${passed}.`});
      return{output:JSON.stringify({passed,summary:passed?'Read the saved file and confirmed accepted.':'Read the saved file; it still contains draft.',criteria:[{criterion:'proof.txt contains accepted',passed,evidence:`Observed ${actual.trim()}`}]}),threadId:`project-fixture-${calls.length}`};
    }
  }
  const boot=async()=>{
    app=await createHarnessServer({port:0,dataDir,defaultCwd:cwd,runtime:new Runtime(),desktop:new Desktop(),autoAttachDesktop:false});apps.push(app);
    await app.learning.updateSettings({mode:'manual'});url=await app.listen();const home=await fetch(url);cookie=home.headers.get('set-cookie').split(';',1)[0];await home.arrayBuffer();
  };
  await boot();
  t.after(async()=>{for(const value of apps)await value.close();assert.match(path.basename(root),/^blackice-projects-http-/);await rm(root,{recursive:true,force:true});});
  const request=async(route,{method='GET',body,auth=true}={})=>{const response=await fetch(new URL(route,url),{method,headers:{...(auth?{Cookie:cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,data:await response.json()};};
  const definition=extra=>({name:'HTTP project',objective:'Create and independently check an accepted proof file.',cwd,maxRepairs:1,tasks:[{id:'proof',title:'Write proof',instructions:'Create proof.txt and verify its actual contents.',acceptanceCriteria:['proof.txt contains accepted']}],...extra});
  const create=async extra=>{const response=await request('/api/projects',{method:'POST',body:definition(extra)});assert.equal(response.status,201,JSON.stringify(response.data));return response.data;};
  return{root,dataDir,cwd,calls,request,definition,create,get app(){return app;},async restart(){await app.close();await boot();}};
}

test('project HTTP is session-protected; create saves a draft and dispatches no work',async t=>{
  const context=await fixture(t);
  for(const route of ['/api/projects','/api/capabilities'])assert.equal((await context.request(route,{auth:false})).status,401);
  assert.equal((await context.request('/api/projects',{method:'POST',body:context.definition(),auth:false})).status,401);
  assert.equal((await context.request('/api/capabilities',{method:'POST',body:{projectId:'missing'},auth:false})).status,401);
  assert.equal((await context.request('/api/projects',{method:'POST',body:context.definition({cwd:'relative'})})).status,400);
  const project=await context.create();
  assert.equal(project.status,'draft');assert.equal(project.tasks[0].status,'pending');assert.equal(project.tasks[0].attempts.length,0);
  assert.equal(context.calls.length,0);
  const saved=JSON.parse(await readFile(path.join(context.dataDir,'projects.json'),'utf8'));
  assert.equal(saved.projects[0].id,project.id);assert.equal(saved.projects[0].status,'draft');
  const changed=await context.request(`/api/projects/${project.id}`,{method:'PUT',body:{name:'Edited shared project',expectedRevision:project.revision}});
  assert.equal(changed.status,200);assert.equal(changed.data.name,'Edited shared project');
  assert.equal((await context.request(`/api/projects/${project.id}`,{method:'PUT',body:{name:'Stale edit',expectedRevision:project.revision}})).status,409);
  assert.equal(context.calls.length,0);
});

test('project HTTP implements, independently reviews, repairs, then saves and reuses an evidence-backed capability as a fresh draft',async t=>{
  const context=await fixture(t),project=await context.create();
  assert.equal((await context.request(`/api/projects/${project.id}/start`,{method:'POST',body:{},auth:false})).status,401);
  assert.equal((await context.request(`/api/projects/${project.id}/start`,{method:'POST',body:{}})).status,200);
  await until(()=>['completed','needs_attention'].includes(context.app.projects.get(project.id).status),'review and repair cycle');
  const completed=(await context.request(`/api/projects/${project.id}`)).data,task=completed.tasks[0];
  assert.equal(completed.status,'completed',JSON.stringify(task));
  assert.equal(context.calls.length,4);assert.equal(task.attempts.length,2);assert.equal(task.attempts[0].verification.verdict.passed,false);assert.equal(task.attempts[1].verification.verdict.passed,true);
  assert.equal(task.verification.kind,'agent-verifier');assert.match(task.verification.limitation,/not a guarantee/);
  assert.equal(await readFile(path.join(context.cwd,'proof.txt'),'utf8'),'accepted\n');
  const allRunIds=task.attempts.flatMap(attempt=>[attempt.implementation.runId,attempt.verification.runId]);
  assert.equal(new Set(allRunIds).size,4);for(const runId of allRunIds)assert.equal((await context.request(`/api/runs/${runId}`)).data.status,'completed');
  const save=await context.request('/api/capabilities',{method:'POST',body:{projectId:project.id,name:'Write accepted proof'}});
  assert.equal(save.status,201,JSON.stringify(save.data));assert.equal(save.data.verification,'agent-reviewed');assert.equal(save.data.evidence[0].verificationRunId,task.attempts[1].verification.runId);
  const reused=await context.request(`/api/capabilities/${save.data.id}/use`,{method:'POST',body:{name:'Revalidate proof here',cwd:context.cwd}});
  assert.equal(reused.status,201);assert.notEqual(reused.data.id,project.id);assert.equal(reused.data.status,'draft');assert.equal(reused.data.tasks[0].status,'pending');assert.deepEqual(reused.data.tasks[0].attempts,[]);assert.equal(reused.data.tasks[0].verification,undefined);assert.equal(context.calls.length,4);
  await context.restart();
  assert.equal(context.app.projects.get(project.id).status,'completed');assert.equal(context.app.projects.get(reused.data.id).status,'draft');assert.equal(context.app.capabilities.get(save.data.id).evidence[0].verificationRunId,task.attempts[1].verification.runId);assert.equal(context.calls.length,4,'restart never replays completed or draft work');
});

test('a failed acceptance review blocks capability saving and requires explicit retry',async t=>{
  const context=await fixture(t),project=await context.create({maxRepairs:0,tasks:[{id:'proof',title:'Fail explicitly',instructions:'FORCE_FAILURE: leave proof.txt in draft.',acceptanceCriteria:['proof.txt contains accepted']}]});
  await context.request(`/api/projects/${project.id}/start`,{method:'POST',body:{}});
  await until(()=>context.app.projects.get(project.id).status==='needs_attention');
  const blocked=context.app.projects.get(project.id);assert.equal(blocked.tasks[0].status,'blocked');assert.equal(context.calls.length,2);
  assert.equal((await context.request('/api/capabilities',{method:'POST',body:{projectId:project.id}})).status,409);
  assert.equal((await context.request(`/api/projects/${project.id}/start`,{method:'POST',body:{}})).status,409);
  const retry=await context.request(`/api/projects/${project.id}/retry-task`,{method:'POST',body:{taskId:'proof'}});
  assert.equal(retry.status,200);assert.equal(retry.data.status,'paused');assert.equal(retry.data.tasks[0].status,'pending');assert.equal(retry.data.tasks[0].cycle,2);assert.equal(context.calls.length,2,'retry prepares work without starting it');
});

test('HTTP recovery stages a held original-result review, survives restart and saves its new review evidence without another implementation',async t=>{
  const context=await fixture(t,{externalReceipt:true}),project=await context.create({maxRepairs:2});await context.request(`/api/projects/${project.id}/start`,{method:'POST',body:{}});await until(()=>context.app.projects.get(project.id).status==='needs_attention');
  const blocked=context.app.projects.get(project.id),original=blocked.tasks[0].attempts[0];assert.equal(context.calls.length,2);assert.equal(blocked.tasks[0].retryHold.runId,original.implementation.runId);
  const route=`/api/projects/${project.id}/review-task`;assert.equal((await context.request(route,{method:'POST',body:{taskId:'proof'},auth:false})).status,401);assert.equal((await context.request(route,{method:'POST',body:{taskId:'missing'}})).status,404);
  assert.equal((await context.request(`/api/projects/${project.id}/retry-task`,{method:'POST',body:{taskId:'proof'}})).status,409,'a fresh implementation remains held');
  await writeFile(path.join(context.cwd,'proof.txt'),'accepted\n');
  const prepared=await context.request(route,{method:'POST',body:{taskId:'proof'}});assert.equal(prepared.status,200,JSON.stringify(prepared.data));assert.equal(prepared.data.status,'paused');assert.equal(prepared.data.tasks[0].status,'verifying');assert.equal(prepared.data.tasks[0].attempts[1].verification.status,'prepared');assert.deepEqual(prepared.data.tasks[0].attempts[1].implementation,original.implementation);assert.equal(context.calls.length,2);
  assert.equal((await context.request(route,{method:'POST',body:{taskId:'proof'}})).status,409);await context.app.projects.poll();assert.equal(context.calls.length,2);
  await context.restart();assert.equal(context.app.projects.get(project.id).tasks[0].attempts[1].verification.status,'prepared');assert.equal(context.calls.length,2);
  await context.request(`/api/projects/${project.id}/start`,{method:'POST',body:{}});await until(()=>context.app.projects.get(project.id).status==='completed');const completed=(await context.request(`/api/projects/${project.id}`)).data,recovery=completed.tasks[0].attempts[1];
  assert.equal(context.calls.length,3);assert.equal(context.calls.filter(call=>call.prompt.includes('You are Project implementer.\n')).length,1);assert.equal(recovery.mode,'review_only');assert.equal(recovery.sourceAttempt,1);assert.equal(recovery.implementation.runId,original.implementation.runId);assert.notEqual(recovery.verification.runId,original.verification.runId);assert.equal(completed.tasks[0].verification.runId,recovery.verification.runId);assert.match(recovery.verification.verdict.criteria[0].evidence,/accepted/);
  const saved=await context.request('/api/capabilities',{method:'POST',body:{projectId:project.id}});assert.equal(saved.status,201,JSON.stringify(saved.data));assert.equal(saved.data.evidence[0].implementationRunId,original.implementation.runId);assert.equal(saved.data.evidence[0].verificationRunId,recovery.verification.runId);
  const state=await context.app.tasks.get(original.implementation.runId);assert.equal(state.externalActions.length,1);assert.equal(state.externalActions[0].status,'confirmed');assert.equal(state.externalActions[0].attempts,1);
});

test('Stop all pauses project dispatch, retains the interrupted run, and restart never replays it',async t=>{
  const context=await fixture(t,{execute:async options=>new Promise((resolve,reject)=>{
    const stop=()=>reject(Object.assign(Error('Stopped project implementation.'),{name:'AbortError',code:'ABORT_ERR'}));
    if(options.signal.aborted)return stop();options.signal.addEventListener('abort',stop,{once:true});
  })}),project=await context.create();
  await context.request(`/api/projects/${project.id}/start`,{method:'POST',body:{}});
  await until(()=>context.calls.length===1&&context.app.projects.get(project.id).tasks[0].attempts[0]?.implementation.runId);
  const runId=context.app.projects.get(project.id).tasks[0].attempts[0].implementation.runId;
  assert.equal((await context.request('/api/runs/stop-all',{method:'POST',body:{}})).status,200);
  await until(async()=>{await context.app.projects.poll();return context.app.projects.get(project.id).tasks[0].status==='blocked';});
  assert.equal(context.app.projects.get(project.id).status,'paused');assert.equal(context.app.engine.getRun(runId).status,'cancelled');assert.equal(context.calls.length,1);
  await context.restart();
  const restored=context.app.projects.get(project.id);assert.equal(restored.status,'paused');assert.equal(restored.tasks[0].attempts[0].implementation.runId,runId);assert.equal(restored.tasks[0].status,'blocked');assert.equal(context.calls.length,1);
});
