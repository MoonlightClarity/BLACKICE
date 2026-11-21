import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {evaluateParallelAdmission} from '../lib/subagent-simple-gate.mjs';
import {modelUsesLocalResources} from '../lib/subagent-local-resources.mjs';
import {SUBAGENT_TOOL,SUBAGENT_SCHEMA_VERSION,subagentToolForExecution,createSubagentToolHandler} from '../lib/subagents.mjs';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const tasks=(...ids)=>ids.map(id=>({id,prompt:'Synthetic independent part '+id}));
const result=x=>JSON.parse(x.contentItems[0].text);
test('host static gate admits overlapping tasks without forecasting',()=>{
 const r=evaluateParallelAdmission({tasks:tasks('a','b'),maxParallel:2});assert.equal(r.allowed,true);assert.equal(r.parallelWidth,2);assert.equal(r.providerCalls,0);
});
for(const [name,items,capacity,code] of [
 ['single',tasks('a'),3,'SUBAGENT_SINGLE_WORK_ITEM'],
 ['one slot',tasks('a','b'),1,'SUBAGENT_NO_PARALLEL_CAPACITY'],
 ['serial',[{id:'a'},{id:'b',dependsOn:['a']}],3,'SUBAGENT_SERIAL_DAG'],
 ['cycle',[{id:'a',dependsOn:['b']},{id:'b',dependsOn:['a']}],3,'SUBAGENT_CYCLIC_DAG']
])test('static gate rejects '+name,()=>{const r=evaluateParallelAdmission({tasks:items,maxParallel:capacity});assert.equal(r.allowed,false);assert.equal(r.code,code);assert.equal(r.providerCalls,0);});
test('rejected handler admission starts no worker and does not prepare ownership',async()=>{
 let calls=0,prepared=0;const records=[];
 const h=createSubagentToolHandler({runtime:{runAgent:async()=>{calls++;return{output:'synthetic'};}},cwd:'C:\\synthetic',maxParallel:2,prepareTasks:()=>{prepared++;},onAdmission:r=>records.push(r)});
 const rejected=result(await h({name:SUBAGENT_TOOL.name,arguments:{tasks:tasks('a')}}));assert.equal(rejected.code,'SUBAGENT_SINGLE_WORK_ITEM');assert.equal(calls,0);assert.equal(prepared,0);assert.equal(records.length,1);
 const accepted=result(await h({name:SUBAGENT_TOOL.name,arguments:{tasks:tasks('a','b')}}));assert.equal(accepted.completed,2);assert.equal(calls,2);assert.equal(prepared,1);
});



test('local inference endpoints conservatively share one host capacity',()=>{
 for(const url of ['http://localhost:1234','http://127.0.0.1','http://10.0.0.4','http://192.168.1.2','http://172.16.2.4','http://[fc00::1]','http://[fd12::1]','http://[fe80::1]','http://[fe81::1]','http://[febf::1]'])assert.equal(modelUsesLocalResources('compatible::model',url),true,url);
 assert.equal(modelUsesLocalResources('ollama::model',''),true);
});
test('public DNS names with fc/fd prefix are not private IPv6',()=>{
 for(const url of ['https://fcloud.example/v1','https://fdata.example/v1','https://api.example/v1','https://10.example/v1','https://127.example/v1','http://[fec0::1]','http://172.15.2.4','http://172.32.2.4'])assert.equal(modelUsesLocalResources('compatible::model',url),false,url);
});







test('current delegation refuses old forecast, canWrite and per-worker model inputs before work',async()=>{let calls=0;const handler=createSubagentToolHandler({runtime:{runAgent:async()=>{calls++;return{output:'done'};}}});for(const args of [{tasks:tasks('a','b'),forecast:{}},{tasks:[{id:'a',prompt:'A',canWrite:false},{id:'b',prompt:'B'}]},{tasks:[{id:'a',prompt:'A',model:'other'},{id:'b',prompt:'B'}]}]){assert.equal((await handler({name:SUBAGENT_TOOL.name,arguments:args})).success,false);assert.equal(calls,0);}assert.match(subagentToolForExecution(SUBAGENT_TOOL,{planningContractVersion:14}).description,/at least two tasks can overlap and two worker slots are available/);});
