import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { mkdtemp,mkdir,rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHarnessServer } from '../server.mjs';

class QuietRuntime extends EventEmitter {
  inferences=0;
  status(){return {connected:true,authenticated:true,defaultModel:'fixture-model',models:[{id:'fixture-model',supportsTools:true}],activeTurns:0};}
  async start(){return this.status();}
  async close(){}
  async runAgent(){this.inferences++;throw Error('Activity inspection must never start a model.');}
}
const at='2026-10-31T02:00:00.000Z';
async function setup(t){
  const directory=await mkdtemp(path.join(tmpdir(),'blackice-activity-http-'));
  const cwd=path.join(directory,'workspace');await mkdir(cwd);
  const runtime=new QuietRuntime(),app=await createHarnessServer({runtime,port:0,dataDir:path.join(directory,'data'),defaultCwd:cwd});
  t.after(async()=>{await app.close();assert.match(path.basename(directory),/^blackice-activity-http-/);await rm(directory,{recursive:true,force:true});});
  const target=new URL(await app.listen());
  const request=(route,headers={})=>new Promise((resolve,reject)=>{
    const req=http.get({hostname:target.hostname,port:target.port,path:route,headers},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);
      res.on('end',()=>{const text=Buffer.concat(chunks).toString();resolve({status:res.statusCode,headers:res.headers,text,
        data:String(res.headers['content-type']).includes('application/json')?JSON.parse(text):null});});
    });
    req.setTimeout(10000,()=>req.destroy(Error('Activity HTTP fixture timed out.')));req.on('error',reject);
  });
  const home=await request('/');assert.equal(home.status,200);
  const auth={Cookie:home.headers['set-cookie'][0].split(';',1)[0]};
  return {app,runtime,request,auth};
}
function fullRun(){
  return {id:'activity-http-run',taskId:'activity-http-task',input:'HTTPfixture inspect actual run evidence',output:'Exact partial run output.',
    status:'failed',settled:true,createdAt:at,updatedAt:at,startedAt:at,finishedAt:at,error:'The controlled run failed after a tool result.',errorCode:'FIXTURE_RUN_FAILED',
    workflow:{id:'activity-http-workflow',name:'Activity fixture',nodes:[{id:'agent',name:'Fixture agent',type:'agent'}],edges:[]},
    nodes:{agent:{status:'failed',output:'Exact node output.',error:'Controlled node failure.',toolSummary:{completed:1,failed:1,issues:[{tool:'relay_workspace',message:'Missing fixture file',resolved:false}]}}},
    events:[{type:'agent.event',runId:'activity-http-run',nodeId:'agent',at,data:{type:'tool.result',tool:'relay_workspace',action:'read',
      callId:'activity-http-call',status:'failed',success:false,code:'ENOENT',message:'Exact missing fixture file receipt.'}}]};
}

test('Activity HTTP uses real server, saved index, selected evidence, and existing session middleware',async t=>{
  const {app,runtime,request,auth}=await setup(t);
  const run=fullRun();app.engine.runs.set(run.id,run);await app.conversations.capture(run);
  for(let index=0;index<95;index++)app.conversations.entries.set('activity-index-'+index,{
    id:'activity-index-'+index,taskId:'activity-index-'+index,title:'HTTPfixture saved '+index,status:'completed',settled:true,createdAt:at,updatedAt:at});
  const client={id:'activity-http-fixture-owner',label:'Activity HTTP fixture',kind:'chatgpt',scopes:['read','commands:run']};
  const {job}=await app.directExecution.jobs.admit({ownerId:client.id,requestId:'activity-http-exact-request',tool:'blackice_run_command',
    arguments:{command:'Controlled fixture only; no command was dispatched.'},requiredScopes:['commands:run'],client,mutating:true});
  const exactResult=JSON.stringify({exitCode:3,stdout:'Exact saved stdout.',stderr:'Exact saved stderr.',fixture:true});
  await app.directExecution.jobs.update(job.id,()=>({status:'failed',dispatched:true,startedAt:at,finishedAt:at,
    effects:{possible:true,confirmed:false},error:{code:'FIXTURE_TOOL_FAILED',message:'Controlled direct action failed.'},
    result:{success:false,contentItems:[{type:'inputText',text:exactResult}]}}));

  await t.test('catalog is bounded and filters before paging without changing source records',async()=>{
    assert.equal((await request('/api/activity')).status,401,'The existing local session applies.');
    const response=await request('/api/activity?source=runs&status=all&q=HTTPfixture&limit=7&offset=0',auth);
    assert.equal(response.status,200);assert.equal(response.headers['cache-control'],'no-store');
    assert.equal(response.data.items.length,7);assert.equal(response.data.total,96);assert.equal(response.data.nextOffset,7);
    assert.deepEqual(response.data.counts,{all:96,active:0,attention:1,finished:96});
    assert.equal(response.data.items.some(item=>'events' in item||'output' in item||'nodes' in item),false);
    const failures=await request('/api/activity?source=runs&status=attention&q=HTTPfixture&limit=7',auth);
    assert.equal(failures.status,200);assert.equal(failures.data.total,1);assert.equal(failures.data.items[0].id,run.id);
    assert.equal(failures.data.items[0].status,'failed');assert.equal(failures.data.items[0].toolCounts.unresolved,1);
    assert.equal(app.engine.runs.get(run.id),run,'Reads do not replace or rewrite execution records.');
  });
  await t.test('selected run exposes exact source IDs, node failure and original tool receipt',async()=>{
    const response=await request('/api/activity/runs/'+run.id+'?offset=0&limit=1',auth);
    assert.equal(response.status,200);
    const detail=response.data;
    assert.equal(detail.item.id,run.id);assert.equal(detail.item.taskId,run.taskId);
    assert.equal(detail.item.status,'failed');assert.equal(detail.item.settled,true);
    assert.equal(detail.error.code,'FIXTURE_RUN_FAILED');assert.equal(detail.output.text,'Exact partial run output.');
    assert.equal(detail.nodes[0].id,'agent');assert.equal(detail.nodes[0].error.message,'Controlled node failure.');
    assert.equal(detail.evidence.total,2);assert.equal(detail.evidence.items[0].nodeId,'agent');
    assert.equal(detail.evidence.retainedSummaryRows,1);
    const evidence=JSON.parse(detail.evidence.items[0].text);
    assert.equal(evidence.callId,'activity-http-call');assert.equal(evidence.message,'Exact missing fixture file receipt.');
    assert.equal(detail.evidence.items[0].success,false);
  });
  await t.test('direct ledger list and detail preserve request identity and stored failure output',async()=>{
    const listing=await request('/api/activity?source=tools&status=attention&q=activity-http-exact-request&limit=1',auth);
    assert.equal(listing.status,200);assert.equal(listing.data.total,1);assert.equal(listing.data.items[0].id,job.id);
    const response=await request('/api/activity/tools/'+job.id+'?offset=0&limit=1',auth);
    assert.equal(response.status,200);
    const detail=response.data;
    assert.equal(detail.item.requestId,'activity-http-exact-request');assert.equal(detail.item.status,'failed');
    assert.deepEqual(detail.item.effects,{possible:true,confirmed:false});
    assert.equal(detail.output.text,exactResult);assert.equal(detail.evidence.items[0].text,exactResult);
    assert.equal(detail.error.code,'FIXTURE_TOOL_FAILED');assert.equal(detail.evidence.nextOffset,1);
    const original=await app.directExecution.jobs.get(job.id);
    assert.equal(original.result.contentItems[0].text,exactResult);assert.equal(original.revision,2,'Read-only inspection never replays or updates the action.');
  });
  await t.test('source failure remains explicit and other catalog results remain available',async()=>{
    const previous=app.directExecution.storageError;
    app.directExecution.storageError={code:'FIXTURE_STORAGE_UNAVAILABLE',message:'Controlled ledger read outage.'};
    try{
      const all=await request('/api/activity?source=all&limit=1',auth);
      assert.equal(all.status,200);assert.equal(all.data.partial,true);assert.equal(all.data.total,96);
      assert.equal(all.data.sources.runs.available,true);assert.equal(all.data.sources.tools.available,false);
      assert.match(all.data.sources.tools.error,/Controlled ledger read outage/);
      const only=await request('/api/activity?source=tools',auth);
      assert.equal(only.data.items.length,0);assert.equal(only.data.partial,true);assert.equal(only.data.sources.tools.available,false);
      assert.equal((await request('/api/activity/tools/'+job.id,auth)).status,503);
    }finally{app.directExecution.storageError=previous;}
    const recovered=await request('/api/activity?source=tools',auth);
    assert.equal(recovered.status,200);assert.equal(recovered.data.partial,false);assert.equal(recovered.data.total,1);
  });
  await t.test('invalid paging and invalid source identifiers produce errors',async()=>{
    for(const query of ['limit=0','limit=101','limit=1.5','offset=-1','offset=9007199254740992','source=missing','status=missing','q='+('x'.repeat(201))]){
      const response=await request('/api/activity?'+query,auth);assert.equal(response.status,400,query);assert.equal(typeof response.data.error,'string');
    }
    assert.equal((await request('/api/activity/runs/'+run.id+'?limit=101',auth)).status,400);
    assert.equal((await request('/api/activity/tools/not-a-direct-job',auth)).status,400);
    assert.equal((await request('/api/activity/runs/does-not-exist',auth)).status,404);
  });
  await t.test('Activity modules and stylesheet are served by the real static route',async()=>{
    for(const route of ['/next/workspaces/activity.mjs','/next/workspaces/activity-model.mjs','/next/workspaces/activity-overview.mjs','/next/activity.css']){
      const response=await request(route,auth);assert.equal(response.status,200,route);
      assert.match(response.headers['content-type'],route.endsWith('.css')?/css/:/javascript/);
      assert.ok(response.text.length>30,route);
    }
  });
  assert.equal(runtime.inferences,0,'All Activity reads are model-free.');
});
