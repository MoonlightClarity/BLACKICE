import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHarnessServer } from '../server.mjs';
import { changeTaskState,createTaskHistory } from '../public/next/workspaces/task-lifecycle.mjs';
import { planningDOM } from './fixture-planning-dom.mjs';

const workflow=()=>({id:'lifecycle-workflow',name:'Lifecycle fixture template',nodes:[
  {id:'input',type:'input'},{id:'agent',type:'agent',name:'Worker',prompt:'Synthetic fixture; never execute.',model:'fixture'},
  {id:'output',type:'output'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}]});
class QuietRuntime extends EventEmitter{
  status(){return{connected:true,authenticated:true,models:[{model:'fixture'}],defaultModel:'fixture'};}
  async start(){return this.status();}async close(){}
  async runAgent(options){
    if(this.allowReadiness&&options.responseOnly){this.readinessCalls++;const captured=JSON.parse(options.prompt.slice(options.prompt.lastIndexOf('\n\n')+2));
      assert.equal(captured.module.kind,'viability','Only schedule readiness uses the response-only fixture.');
      return{output:JSON.stringify({values:Object.fromEntries(captured.template.fields.map(field=>[field.id,field.label+': the supplied isolated fixture task has a local implementation and no missing personal prerequisite.'])),grounding:captured.template.fields.filter(field=>field.grounding==='required').map(field=>({field:field.id,sourceId:'viability:task'})),requirements:[],openQuestions:[],challengeResponses:[]}),threadId:'fixture-readiness',turnId:'fixture-readiness-turn'};}
    assert.fail('Managing saved work must not start an operational model turn.');
  }
}
async function fixture(t,{allowReadiness=false}={}){
  const directory=await mkdtemp(path.join(tmpdir(),'blackice-v2-task-lifecycle-')),dataDir=path.join(directory,'data'),cwd=path.join(directory,'workspace'),apps=[];
  let app,origin,cookie,runtime;
  async function boot(){
    runtime=new QuietRuntime();runtime.allowReadiness=allowReadiness;runtime.readinessCalls=0;
    app=await createHarnessServer({port:0,dataDir,defaultCwd:cwd,runtime,autoAttachDesktop:false});apps.push(app);
    await app.learning.updateSettings({mode:'off'});await app.operations.pause('Disposable lifecycle verification.');
    origin=await app.listen();const response=await fetch(origin);cookie=response.headers.get('set-cookie').split(';',1)[0];await response.arrayBuffer();
  }
  await boot();
  t.after(async()=>{for(const value of apps)await value.close();assert.match(path.basename(directory),/^blackice-v2-task-lifecycle-/);await rm(directory,{recursive:true,force:true});});
  async function api(route,method='GET',payload){
    const response=await fetch(origin+route,{method,headers:{Cookie:cookie,...(payload===undefined?{}:{'Content-Type':'application/json'})},body:payload===undefined?undefined:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});
    const result=await response.json();if(!response.ok)throw Object.assign(Error(result.error||'Request failed'),{status:response.status,code:result.code});return result;
  }
  async function seed(id,{taskId=id,parentRunId=null,status='completed',settled=true}={}){
    const run={id,taskId,parentRunId,status,settled,createdAt:'2026-10-25T09:00:00Z',updatedAt:'2026-10-25T09:01:00Z',
      input:'Saved request '+id,output:'Saved actual result '+id,workflow:workflow(),nodes:{agent:{status,output:'Saved actual result '+id}},events:[]};
    await app.conversations.capture(run);return run;
  }
  return{directory,dataDir,cwd,api,seed,get runtime(){return runtime;},get app(){return app;},async restart(){await app.close();await boot();}};
}

test('V2 task lifecycle uses real family archive/Trash/restore routes and survives restart without rewriting task or run evidence',async t=>{
  const f=await fixture(t);await f.seed('family-root');await f.seed('family-child',{taskId:'family-root',parentRunId:'family-root'});
  const state=await f.app.tasks.ensure({taskId:'family-root',runId:'family-child',cwd:f.cwd,goal:'Original durable plan',defaultPlan:true});
  const beforeTask=await readFile(f.app.tasks.file(state.taskId)),beforeRun=await readFile(path.join(f.dataDir,'conversations','family-root.json'));
  let catalog=await f.api('/api/conversations/search?q=&state=active&limit=40&offset=0');
  assert.equal(catalog.conversations.length,1);assert.equal(catalog.conversations[0].taskId,'family-root');
  assert.deepEqual((await changeTaskState(f.api,catalog.conversations,'archive')).failed,[]);
  const archived=await f.api('/api/planning?state=archived&limit=40&offset=0');assert.equal(archived.plans[0].taskId,'family-root');assert.equal(archived.plans[0].revision,state.revision);
  assert.equal((await f.api('/api/conversations/family-child')).runs.length,2);
  catalog=await f.api('/api/conversations/search?q=&state=archived&limit=40&offset=0');
  await changeTaskState(f.api,catalog.conversations,'delete');await f.restart();
  assert.equal((await f.api('/api/conversations/family-child')).state,'deleted');assert.equal((await f.api('/api/planning?state=deleted')).plans[0].editable,false);
  catalog=await f.api('/api/conversations/search?q=&state=deleted&limit=40&offset=0');await changeTaskState(f.api,catalog.conversations,'restore');
  assert.equal((await f.api('/api/conversations/family-root')).state,'active');
  assert.deepEqual(await readFile(f.app.tasks.file(state.taskId)),beforeTask);assert.deepEqual(await readFile(path.join(f.dataDir,'conversations','family-root.json')),beforeRun);
});

test('real empty-query catalog renders all 13 active saved families and pages archived task metadata without full-run reads',async t=>{
  const f=await fixture(t),dom=planningDOM(t),prototype=Object.getPrototypeOf(dom.mount);
  Object.defineProperty(prototype,'type',{get(){return this.getAttribute('type')||this.tagName.toLowerCase();},set(value){this.setAttribute('type',value);},configurable:true});
  prototype.replaceChildren=function(...nodes){for(const child of [...this.children])child.remove();this.rawText='';this.append(...nodes);};
  const calls=[],listeners=new Set();
  const archivedId=index=>'catalog-archive-'+String(index).padStart(3,'0');
  for(let index=0;index<13;index++)await f.seed('catalog-active-'+index);
  await f.seed('catalog-active-child',{taskId:'catalog-active-0',parentRunId:'catalog-active-0'});
  for(let index=0;index<35;index++){await f.seed(archivedId(index));await f.app.conversations.setState(archivedId(index),'archived');}
  const history=createTaskHistory({mount:dom.mount,presentation:'board',api:async(route,method='GET',payload)=>{calls.push({route,method});return f.api(route,method,payload);},events:{subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);}}});
  t.after(()=>history.destroy());
  const until=async read=>{const end=Date.now()+5000;while(Date.now()<end){if(read())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Real saved-task board did not settle.');};
  const count=()=>dom.mount.querySelectorAll('[data-task-id]').length;
  history.enter();await until(()=>count()===13);
  assert.match(dom.$('#next-task-history-status').textContent,/13 loaded tasks/);
  assert.equal(dom.mount.querySelectorAll('[data-task-lane]').length,4);
  assert.equal((await f.api('/api/conversations?state=active')).conversations.length,13,'The empty query agrees with the durable active catalog and groups child runs.');
  dom.$('#next-task-history-state').value='archived';await dom.$('#next-task-history-state').dispatch('change');await until(()=>count()===35);
  await dom.input('#next-task-history-query','archive-034');await until(()=>count()===1);
  await dom.input('#next-task-history-query','');await until(()=>count()===35);
  for(let index=35;index<43;index++){await f.seed(archivedId(index));await f.app.conversations.setState(archivedId(index),'archived');}
  await dom.click('#next-task-history-refresh');await until(()=>count()===40);
  assert.equal(dom.$('#next-task-history-more').hidden,false);
  await dom.click('#next-task-history-more');await until(()=>count()===43);
  assert.equal(dom.$('#next-task-history-more').hidden,true);
  const ids=dom.mount.querySelectorAll('[data-task-id]').map(node=>node.dataset.taskId);assert.equal(new Set(ids).size,43);
  assert.ok(calls.every(call=>call.method==='GET'&&call.route.startsWith('/api/conversations/search?')),'Viewing and filtering cannot write or read full conversation histories.');
  assert.ok(calls.every(call=>new URL(call.route,'http://fixture.local').searchParams.get('limit')==='40'));
  assert.ok(calls.some(call=>new URL(call.route,'http://fixture.local').searchParams.get('offset')==='40'));
  history.leave();assert.equal(listeners.size,0);
});

test('real project Archive/Restore guards organization revisions and keeps its tasks unchanged',async t=>{
  const f=await fixture(t);
  const project=await f.api('/api/projects','POST',{name:'Saved project',objective:'Produce a checked result',cwd:f.cwd,
    tasks:[{id:'build',title:'Build result',instructions:'Implement fixture work',acceptanceCriteria:['Result checked'],dependsOn:[]}]});
  const initial=(await f.api('/api/projects')).projects.find(item=>item.id===project.id);
  const operation=archived=>({expectedRevision:initial.organizationRevision,operations:[{type:'update_project',projectId:project.id,archived}]});
  const archived=await f.api('/api/planning/organization','POST',operation(true));
  await assert.rejects(f.api('/api/planning/organization','POST',operation(false)),{status:409});
  let listed=(await f.api('/api/projects')).projects.find(item=>item.id===project.id);
  assert.equal(listed.archived,true);assert.deepEqual(listed.tasks,project.tasks);assert.equal(listed.revision,project.revision);
  await f.api('/api/planning/organization','POST',{expectedRevision:archived.revision,operations:[{type:'update_project',projectId:project.id,archived:false}]});
  listed=(await f.api('/api/projects')).projects.find(item=>item.id===project.id);assert.equal(listed.archived,false);assert.deepEqual(listed.tasks,project.tasks);
});

test('schedule removal and template deletion retain actual job history and saved run/workflow copies',async t=>{
  const f=await fixture(t,{allowReadiness:true}),template=await f.api('/api/workflows','POST',workflow());
  await f.seed('template-run');
  const schedule=await f.api('/api/operations/deployments','POST',{name:'Disposable scheduled work',input:'Retain original task',cwd:f.cwd,workflow:template,trigger:{type:'manual'},enabled:false});
  const scheduleCopy=structuredClone(f.app.operations.state.deployments.find(item=>item.id===schedule.id).workflow);
  const readiness=await f.api('/api/operations/deployments/'+schedule.id+'/readiness','POST',{});
  assert.equal(readiness.nodes.find(node=>node.id==='viability').readiness.state,'ready');assert.equal(f.runtime.readinessCalls,1);
  const job=await f.api('/api/operations/deployments/'+schedule.id+'/trigger','POST',{});
  assert.equal((await f.api('/api/operations')).jobs.find(item=>item.id===job.id).status,'queued');
  await f.api('/api/workflows/'+template.id,'DELETE',{});
  assert.equal((await f.api('/api/workflows?view=index')).some(item=>item.id===template.id),false);
  assert.deepEqual(f.app.operations.state.deployments.find(item=>item.id===schedule.id).workflow,scheduleCopy);
  assert.equal((await f.api('/api/conversations/template-run')).runs[0].workflow.id,template.id);
  await f.api('/api/operations/deployments/'+schedule.id,'DELETE',{});
  const current=await f.api('/api/operations');assert.equal(current.deployments.some(item=>item.id===schedule.id),false);
  assert.equal(current.jobs.find(item=>item.id===job.id).status,'cancelled');
  await f.restart();assert.equal((await f.api('/api/operations')).jobs.find(item=>item.id===job.id).status,'cancelled');
  assert.equal((await f.api('/api/conversations/template-run')).runs.length,1);
});
