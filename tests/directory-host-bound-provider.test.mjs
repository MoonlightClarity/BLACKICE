import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {EventEmitter} from 'node:events';import {mkdtemp,rm} from 'node:fs/promises';import path from 'node:path';import {tmpdir} from 'node:os';import {ProviderRuntime} from '../lib/providers.mjs';import {HarnessEngine} from '../lib/engine.mjs';
import {projectTurnMachineTrace} from '../lib/turn-machine-trace.mjs';
class Native extends EventEmitter{status(){return{connected:false,authenticated:false,models:[]};}async close(){}async runAgent(){throw Error('No external model');}}
for(const mode of ['off','on','maximal'])test('real compatible adapter completes planned action after parallel receipt churn without any revision echo: '+mode,{timeout:20000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'directory-wire-'));let engine,runtime,stage=0,prep=0,wireOutcomes;const delivered=[];
 const server=http.createServer(async(req,res)=>{if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'fixture'}]}));return;}let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw),all=JSON.stringify(body.messages);const send=message=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{index:0,finish_reason:message.tool_calls?'tool_calls':'stop',message}]}));};
  if(all.includes('This is one bounded planning phase')){prep++;send({role:'assistant',content:JSON.stringify({status:'proposed',focus:'inspect',reason:'Inspect fixture evidence',sourceRefs:[],actions:[{id:'inspect',objective:'Inspect fixture evidence',dependsOn:[]}]})});return;}
  const tool=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});let calls;
  switch(stage++){
   case 0:wireOutcomes=body.tools?.find(t=>t.function?.name==='relay_directory_action')?.function?.parameters?.properties?.outcome?.enum;calls=[tool('read-initial','relay_directory_action',{action:'read'})];break;
   case 1:calls=Array.from({length:4},(_,i)=>tool('read-file-'+i,'relay_workspace',{action:'list',path:root}));break;
   case 2:calls=[tool('read-after-churn','relay_directory_action',{action:'read'})];break;
   case 3:calls=[tool('focus-current','relay_directory_action',{action:'focus',id:'inspect'})];break;
   case 4:calls=[tool('focused-file','relay_workspace',{action:'list',path:root})];break;
   case 5:calls=[tool('read-for-observation','relay_directory_action',{action:'read'})];break;
   case 6:calls=[tool('record-partial','relay_directory_action',{action:'observe',outcome:'partial',id:'inspect',claim:'Listing checked but not evaluated yet.',receipts:['receipt-5']})];break;
   case 7:calls=[tool('record-observation','relay_directory_action',{action:'observe',outcome:'objective-met',id:'inspect',claim:'The fixture listing returned',receipts:['receipt-5']})];break;
   default:send({role:'assistant',content:'Fixture evidence inspected.'});return;
  }send({role:'assistant',content:null,tool_calls:calls});
 });
 t.after(async()=>{await engine?.close();await runtime?.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 runtime=new ProviderRuntime({codex:new Native(),dataDir:root,modelLimitResolver:{enrich:async(_c,m)=>m}});await runtime.store.init();await runtime.saveProvider({id:'fixture',type:'compatible',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',models:[{id:'fixture',contextWindowTokens:65536,maxOutputTokens:4096}]},{preserveDefault:true});const actual=runtime.runAgent.bind(runtime);runtime.runAgent=o=>actual({...o,onToolResultDelivered:e=>{delivered.push({name:e.call.name,id:e.call.callId});return o.onToolResultDelivered?.(e);}});
 engine=await new HarnessEngine({runtime,dataDir:path.join(root,'engine'),defaultCwd:root}).init();const graph={name:'Wire',nodes:[{id:'i',type:'input'},{id:'a',type:'agent',name:'Agent',model:'fixture::fixture',prompt:'Inspect fixture'},{id:'o',type:'output'}],edges:[{source:'i',target:'a'},{source:'a',target:'o'}],settings:{maxParallel:1,planningMode:'off'}};
 const started=engine.startRun({workflow:graph,input:{task:'Inspect local fixture',directoryActions:'on',chatPlanning:'on',directoryDiagnostics:mode}});await engine.executions.get(started.id);const run=engine.getRun(started.id),state=(await engine.actionDirectories.get(started.id,'fixture')).read();assert.equal(run.status,'completed',run.error);assert.equal(prep,1);assert.deepEqual(wireOutcomes,['objective-met','partial']);assert.equal(state.actions[0].state,'observed');assert.deepEqual(state.actions[0].notes[0].receipts,['receipt-5']);assert.equal(state.actionRevision,4);assert.equal(state.receipts.length,5);assert(delivered.some(x=>x.name==='relay_directory_action'));assert.equal(new Set(delivered.filter(x=>x.name==='relay_workspace').map(x=>x.id)).size,5);
 if(mode==='maximal'){
  const trace=projectTurnMachineTrace(engine.runs.get(started.id));const phases=trace.entries.filter(e=>e.kind==='directory.snapshot');
  assert(phases.some(e=>e.metadata.phase==='bound'&&e.metadata.actionRevision===1));
  assert(phases.some(e=>e.metadata.phase==='delivered'&&e.metadata.snapshotRevision>=9));
  assert(trace.entries.some(e=>e.kind==='directory.mutation'&&e.metadata.operation==='focus'&&e.metadata.revisionPresent===false&&e.metadata.reason==='host-snapshot-binding'&&e.metadata.resultActionRevision===2));
  assert(trace.entries.some(e=>e.kind==='directory.mutation'&&e.metadata.observeOutcome==='partial'));
  const gates=trace.entries.filter(e=>e.kind==='directory.effect');
  assert(gates.some(e=>e.metadata.phase==='gate'&&e.metadata.callClass==='observation'&&e.metadata.decision==='allow'&&e.metadata.gateActionRevision===1));
  const reserved=gates.find(e=>e.metadata.phase==='reserved'&&e.receiptRef);
  assert(reserved);
  assert(gates.some(e=>e.receiptRef===reserved.receiptRef&&e.metadata.phase==='dispatch'&&e.sequence>reserved.sequence));
  assert(gates.some(e=>e.receiptRef===reserved.receiptRef&&e.metadata.phase==='returned'&&e.sequence>reserved.sequence));
  assert(trace.entries.some(e=>e.kind==='directory.final'&&e.metadata.phase==='after-provider'&&e.metadata.ready===true&&e.metadata.reason==='ready'));
 }
});
