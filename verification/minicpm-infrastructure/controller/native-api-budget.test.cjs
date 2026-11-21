'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{pathToFileURL}=require('node:url');
const api=require('./native-api.cjs');
const {createBenchmarkDeadline}=require('../../../lib/benchmark-run-deadline.mjs');
function config(){
 const method='Read METHOD.md and save implementation.\n';
 return {controllerId:'budget-controller',requestId:'budget-request',workflowId:'budget-workflow',caseId:'D0',connectionId:'budget-connection',origin:'http://127.0.0.1:53151',workspace:'C:/fixture/D0/original',task:'Implement the frozen task.',method:{text:method,sha256:api.sha(method)},model:'fixture::MiniCPM-test',context:{preset:'custom',windowTokens:4096,autoCompact:false,outputReserveTokens:256,headroomTokens:128},budgets:{wallMs:300000,settlementGraceMs:60000,pollIntervalMs:1000,windowMs:4000,fetchTimeoutMs:1000,maxReceiptPages:8},allowedCommands:['node test-public.cjs'],benchmark:{profile:'minicpm-code-v1',scaffoldReceiptPath:'C:/fixture-receipts/D0.json',scaffoldReceiptSha256:'1'.repeat(64)}};
}
async function prepared(cfg){
 const operation=api.prepare(cfg,1),url=pathToFileURL(path.resolve(__dirname,'../../../public/mission-model.mjs')).href;
 // Only resolve the browser's absolute module URL to the same real source file in Node.
 const expression=operation.arguments.expression.replace("import('/mission-model.mjs')",'import('+JSON.stringify(url)+')');
 assert.notEqual(expression,operation.arguments.expression);
 return {operation,value:await new Function('location','return '+expression)({origin:cfg.origin})};
}
function nativeRun(cfg,body,status='running'){
 const run={id:'owned-budget-run',taskId:'owned-budget-run',metadata:{clientRequestId:cfg.requestId},cwd:cfg.workspace,workflow:body.workflow,createdAt:new Date().toISOString(),status,settled:false,directoryActions:'on',directoryDiagnostics:'maximal',executionModes:{directoryMode:'off'},benchmark:{schema:'blackice.minicpm.benchmark-profile.v1',profile:cfg.benchmark.profile,workspace:cfg.workspace,caseId:'D0',publicCaseCount:2,command:'node test-public.cjs',scaffoldReceiptPath:cfg.benchmark.scaffoldReceiptPath,scaffoldReceiptSha256:cfg.benchmark.scaffoldReceiptSha256,contractSha256:'2'.repeat(64)},benchmarkBudget:body.input.benchmarkBudget};
 run.benchmarkDeadline=createBenchmarkDeadline(run);return run;
}
test('R10 API prepare executes the actual workflow builder with an explicit host wall budget',async()=>{
 const cfg=config(),{operation,value}=await prepared(cfg);
 assert.deepEqual(value.body.input.benchmarkBudget,{wallMs:cfg.budgets.wallMs});
 assert.equal(value.body.requestId,cfg.requestId);assert.equal(value.body.workflow.id,cfg.workflowId);
 assert.deepEqual(api.prepare(cfg,1),operation);
});
test('R10 API replay keeps identical start arguments and a changed budget changes the authored hash',async()=>{
 const cfg=config(),{value}=await prepared(cfg),body=value.body,before=api.sha(body);
 const first=api.start(cfg,2,body),again=api.start(cfg,2,JSON.parse(JSON.stringify(body)));
 assert.deepEqual(again,first);assert.equal(api.sha(body),before);
 const changed=structuredClone(cfg);changed.budgets.wallMs++;
 assert.throws(()=>api.start(changed,2,body),/Prepared benchmark wall budget mismatch/);
 const newBody=structuredClone(body);newBody.input.benchmarkBudget.wallMs++;
 const different=api.start(changed,2,newBody);
 assert.notEqual(api.sha(newBody),before);assert.notEqual(different.expressionSha256,first.expressionSha256);
 assert.equal(different.arguments.requestId,first.arguments.requestId); // Direct retry identity detects changed arguments too.
});
test('R10 API refuses missing, ambiguous or changed prepared budget before creating a start',async()=>{
 const cfg=config(),{value}=await prepared(cfg);
 for(const change of [b=>delete b.input.benchmarkBudget,b=>b.input.benchmarkBudget={wallMs:300000,ignored:true},b=>b.input.benchmarkBudget.wallMs='300000']){
  const b=structuredClone(value.body);change(b);assert.throws(()=>api.start(cfg,2,b));
 }
});
test('R10 API validates actual admitted budget and deadline while preserving cleanup identity',async()=>{
 const cfg=config(),{value}=await prepared(cfg),run=nativeRun(cfg,value.body);
 assert.equal(api.assertOwned(run,cfg,run.id),run);
 for(const change of [r=>delete r.benchmarkBudget,r=>r.benchmarkBudget.wallMs++,r=>r.benchmarkDeadline.deadlineAt=new Date(Date.parse(r.benchmarkDeadline.deadlineAt)+1).toISOString(),r=>delete r.benchmarkDeadline]){
  const bad=structuredClone(run);change(bad);
  assert.throws(()=>api.assertOwned(bad,cfg,bad.id));
  assert.equal(api.assertOwnedIdentity(bad,cfg,bad.id),bad);
 }
});
test('R10 API observes an actual blocked settled host run as terminal without sending cancellation',async()=>{
 const cfg=config(),{value}=await prepared(cfg),run=nativeRun(cfg,value.body,'blocked');run.settled=true;
 const now=Date.now(),op=api.observe(cfg,3,run.id,new Date(now+300000).toISOString(),new Date(now+360000).toISOString());
 let calls=0;
 const fetch=async(route,options)=>{calls++;assert.equal(options.method,'GET');assert.equal(route,'/api/runs/'+run.id);return{ok:true,status:200,text:async()=>JSON.stringify(run)};};
 const result=await new Function('location','fetch','AbortSignal','return '+op.arguments.expression)({origin:cfg.origin},fetch,AbortSignal);
 assert.equal(calls,1);assert.equal(result.run.status,'blocked');assert.equal(result.run.settled,true);assert.deepEqual(result.cancellations,[]);
});
