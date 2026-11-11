import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {evaluateParallelAdmission} from '../lib/subagent-simple-gate.mjs';
import {modelUsesLocalResources} from '../lib/subagent-local-resources.mjs';
import {SUBAGENT_TOOL,SUBAGENT_V4_TOOL,SUBAGENT_V5_TOOL,SUBAGENT_SCHEMA_VERSION,subagentToolForExecution,createSubagentToolHandler} from '../lib/subagents.mjs';
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
test('new sessions expose schema6 speed gate without a forecast field',()=>{assert.equal(SUBAGENT_SCHEMA_VERSION,6);assert.equal(SUBAGENT_TOOL.inputSchema.properties.forecast,undefined);assert.match(SUBAGENT_TOOL.description,/two work items/);});
test('saved native v4 raw catalog is byte-equivalent to the prior public source',()=>assert.equal(hash(SUBAGENT_V4_TOOL),'e51b384e15f74bec90f8c27b9d3c8ed9e7ef0686048ce0809268538d78311d11'));
test('saved native v4 canonical catalog retains exact transformed descriptions',()=>{
 assert.equal(hash(subagentToolForExecution(SUBAGENT_V4_TOOL,{planningContractVersion:14})),'ffea2f81e8fb22f55c81194bdb960ef996fabb2c698386c71d0dcda2e2bf6ad0');
 assert.equal(hash(subagentToolForExecution(SUBAGENT_V4_TOOL,{planningContractVersion:14,executionGuardrails:true})),'5c03da0c43ab107f61b8e5d7eaf7a4336db662d6d742446b770d7aa66f7ed942');
});
test('local inference endpoints conservatively share one host capacity',()=>{
 for(const url of ['http://localhost:1234','http://127.0.0.1','http://10.0.0.4','http://192.168.1.2','http://172.16.2.4','http://[fc00::1]','http://[fd12::1]','http://[fe80::1]','http://[fe81::1]','http://[febf::1]'])assert.equal(modelUsesLocalResources('compatible::model',url),true,url);
 assert.equal(modelUsesLocalResources('ollama::model',''),true);
});
test('public DNS names with fc/fd prefix are not private IPv6',()=>{
 for(const url of ['https://fcloud.example/v1','https://fdata.example/v1','https://api.example/v1','https://10.example/v1','https://127.example/v1','http://[fec0::1]','http://172.15.2.4','http://172.32.2.4'])assert.equal(modelUsesLocalResources('compatible::model',url),false,url);
});

test('explicit saved schema version preserves cloned catalog and schema6 gets speed guidance',()=>{
 assert.equal(hash(subagentToolForExecution(structuredClone(SUBAGENT_V4_TOOL),{planningContractVersion:14,schemaVersion:4})),'ffea2f81e8fb22f55c81194bdb960ef996fabb2c698386c71d0dcda2e2bf6ad0');
 assert.doesNotMatch(subagentToolForExecution(SUBAGENT_V5_TOOL,{planningContractVersion:14,schemaVersion:5}).description,/SPEED GATE/);
 assert.ok(subagentToolForExecution(SUBAGENT_V5_TOOL,{planningContractVersion:14,schemaVersion:5}).inputSchema.properties.forecast);
 assert.match(subagentToolForExecution(SUBAGENT_TOOL,{planningContractVersion:14,schemaVersion:6}).description,/SPEED GATE/);
});

test('legacy v5 forecasts stay input-compatible without starting a forecast provider turn', async () => {
  let calls = 0;
  const handler = createSubagentToolHandler({ runtime: { runAgent: async () => { calls++; return { output: 'Checked independently.' }; } } });
  const forecast = { factors: [{ id: 'saved_critical_path_time', wep: 'almost_certain', confidence: 'high', basis: 'A saved v5 request keeps its original input shape.' }] };
  const rejected = result(await handler({ name: SUBAGENT_TOOL.name, arguments: { tasks: tasks('single'), forecast } }));
  assert.equal(rejected.code, 'SUBAGENT_SINGLE_WORK_ITEM'); assert.equal(calls, 0);
  const accepted = result(await handler({ name: SUBAGENT_TOOL.name, arguments: { tasks: tasks('single', 'parallel'), forecast } }));
  assert.equal(accepted.completed, 2); assert.equal(calls, 2);
});

test('saved native v5 catalog is byte-equivalent to the captured installed definition', () => {
  assert.equal(hash(SUBAGENT_V5_TOOL), '5fc1f78f1a831a3d7ac18ffdd106b35b8cb673f98fe8ac2a33a6864bb2ab7a42');
  assert.deepEqual(SUBAGENT_V5_TOOL.inputSchema.required, ['tasks', 'forecast']);
});
