import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PlanningBrowserStore} from '../lib/planning-browser.mjs';
import {PlanningBrowserRuntime} from '../lib/planning-browser-runtime.mjs';
import {planningModuleTemplate} from '../public/planning-browser-model.mjs';
import {planningBrowserCatalog,projectPlanningBrowserExecution,handlePlanningBrowserHttp} from '../lib/planning-browser-http.mjs';
import {planningRequestActivity,planningConversationActivity} from '../public/next/workspaces/planning-browser.mjs';
import {cycleStageRows,cycleStateLabel} from '../public/next/workspaces/response-cycle-ui.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject};};
async function fixture(t){
  const directory=await mkdtemp(path.join(os.tmpdir(),'planning-display-')),store=await new PlanningBrowserStore({dataDir:directory}).init(),calls=[];
  const runner=new PlanningBrowserRuntime({store,defaultCwd:directory,getSettings:()=>({maxSubagents:1}),runtime:{runAgent:()=>{const call=deferred();calls.push(call);return call.promise;}}});
  t.after(async()=>{for(const call of calls)call.reject(Error('Owned fixture cleanup'));await runner.close();await store.close();await rm(directory,{recursive:true,force:true});});
  for(const id of ['first','second']){await store.create({id,conversationId:'conversation-'+id,title:id,objective:'Compare the supplied choices.'});await store.addNode(id,{id:'frame',kind:'frame',title:'Reframe',prompt:'State another useful frame.'});}
  const output=id=>JSON.stringify({values:Object.fromEntries(planningModuleTemplate('frame').fields.map(f=>[f.id,f.label+' based on the supplied choices.'])),grounding:planningModuleTemplate('frame').fields.filter(f=>f.grounding==='required').map(f=>({field:f.id,sourceId:'request:'+id})),openQuestions:[],challengeResponses:[]});
  const get=async id=>{let result;await handlePlanningBrowserHttp({req:{method:'GET'},res:{},pathname:'/api/planning-browser/requests/'+id,store,runner,json:(_res,status,value)=>{assert.equal(status,200);result=value;}});return result;};
  return {directory,store,runner,calls,output,get};
}
test('real capacity queue is Queued in catalog and detail although its durable attempt is running',async t=>{
  const f=await fixture(t),first=await f.runner.start({requestId:'first',nodeId:'frame',expectedNodeRevision:1});
  const second=await f.runner.start({requestId:'second',nodeId:'frame',expectedNodeRevision:1});
  assert.equal(second.attempt.status,'running');assert.equal(second.attempt.workerStatus,'queued');assert.equal(f.calls.length,1);
  const before=await readFile(f.store.file('second'),'utf8');
  const catalog=await planningBrowserCatalog({store:f.store,runner:f.runner});
  assert.equal(planningRequestActivity(catalog.requests.find(r=>r.id==='first')),'running');
  const row=catalog.requests.find(r=>r.id==='second');
  assert.equal(row.summary.running,1);assert.equal(row.execution.running,0);assert.equal(planningRequestActivity(row),'queued');
  assert.equal(planningConversationActivity({status:'running',settled:false},[row]),'queued','A waiting parent status cannot relabel its queued planning worker.');
  const detail=await f.get('second');
  assert.equal(detail.attempts[0].status,'running');assert.equal(detail.attempts[0].workerStatus,'queued');
  assert.equal(detail.nodes[0].readiness.state,'running');assert.equal(detail.nodes[0].executionStatus,'queued');
  assert.equal(planningRequestActivity(detail),'queued');
  assert.equal(cycleStageRows(detail,{stageNodeIds:{feasibility:'frame'}})[0].state,'queued');
  assert.equal(cycleStateLabel('running','queued'),'Cycle queued');
  assert.equal(await readFile(f.store.file('second'),'utf8'),before,'Display reads do not rewrite the durable ledger.');
  const foreign=projectPlanningBrowserExecution(await f.store.get('second'),{attempts:[]});
  assert.equal(foreign.execution.state,'unknown');assert.equal(foreign.nodes[0].executionStatus,'unknown');assert.equal(foreign.attempts[0].status,'running');
  assert.equal(planningRequestActivity(foreign),'unknown');
  assert.equal(projectPlanningBrowserExecution(row,null).execution.state,'unknown');
  f.calls[0].resolve({output:f.output('first')});await f.runner.wait('first',first.attempt.id);
  assert.equal(f.calls.length,2);assert.equal((await f.get('second')).execution.state,'running');
  f.calls[1].resolve({output:f.output('second')});await f.runner.wait('second',second.attempt.id);
  assert.equal((await f.get('second')).execution.state,'idle');
});
test('real cancellation remains Stopping until provider settlement without rewriting stored running',async t=>{
  const f=await fixture(t),claim=await f.runner.start({requestId:'first',nodeId:'frame',expectedNodeRevision:1});
  const stopping=f.runner.cancel(claim.attempt.id,{reason:'Owned display fixture.'});
  await new Promise(resolve=>setImmediate(resolve));
  const detail=await f.get('first');
  assert.equal(detail.execution.state,'stopping');assert.equal(detail.attempts[0].status,'running');
  assert.equal(detail.attempts[0].workerStatus,'cancelling');assert.equal(detail.nodes[0].executionStatus,'cancelling');
  f.calls[0].resolve({output:f.output('first')});await stopping;
  const stopped=await f.get('first');assert.equal(stopped.attempts[0].status,'cancelled');assert.equal(stopped.execution.state,'idle');
});
test('admission and repair are observed separately; unowned or unavailable activity is never completed',()=>{
  const request={id:'a',summary:{running:1},nodes:[{id:'frame',readiness:{state:'running'}}],attempts:[{id:'saved',nodeId:'frame',status:'running'}],cycles:[{id:'cycle',state:'running',stageNodeIds:{feasibility:'frame'}}]};
  for(const [status,state] of [['admitting','queued'],['repairing','repairing'],['queued','queued'],['running','running'],['cancelling','stopping']]){
    const view=projectPlanningBrowserExecution(request,{attempts:[{requestId:'a',id:'saved',nodeId:'frame',status}]});
    assert.equal(view.execution.state,state);assert.equal(view.cycles[0].executionStatus,state);
  }
  assert.equal(projectPlanningBrowserExecution({id:'fresh',summary:{running:0}},null).execution.state,'unknown');
  const unavailable=projectPlanningBrowserExecution(request,null);
  assert.equal(unavailable.execution.available,false);assert.equal(unavailable.execution.state,'unknown');
  assert.equal(unavailable.cycles[0].executionStatus,'unknown');assert.equal(request.attempts[0].workerStatus,undefined);
  assert.equal(projectPlanningBrowserExecution(request,{attempts:[{requestId:'elsewhere',id:'saved',nodeId:'frame',status:'running'}]}).execution.state,'unknown');
});
