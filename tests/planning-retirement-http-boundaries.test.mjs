import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHarnessServer} from '../server.mjs';
import {planningModuleTemplate} from '../public/planning-browser-model.mjs';
import {RemoteAccessManager} from '../lib/remote-access.mjs';
import {createRemoteTransportFixture} from './fixtures/remote-transport.mjs';

const BASE='/api/planning-browser/requests';
class Runtime extends EventEmitter {
  calls=[];
  status(){return {connected:true,authenticated:true,ready:true,models:[{model:'retirement-fixture'}],defaultModel:'retirement-fixture'};}
  async start(){return this.status();}
  async close(){}
  async runAgent(options){this.calls.push(options);assert.equal(options.responseOnly,true);assert.deepEqual(options.dynamicTools,[]);if(!this.output)throw Error('Unexpected provider admission');return {output:this.output,threadId:'synthetic-thread',turnId:'synthetic-turn'};}
}
class Desktop extends EventEmitter {status(){return {available:false,enabled:false};}async setEnabled(){return this.status();}}
function request(url,route,{method='GET',headers={},body}={}){
 const encoded=body===undefined?undefined:JSON.stringify(body);
 return new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port:url.port,path:route,method,agent:false,headers:{Host:url.host,...(encoded===undefined?{}:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(encoded)}),...headers}},res=>{
   const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);res.on('end',()=>{const text=Buffer.concat(chunks).toString();let value;try{value=JSON.parse(text);}catch{}resolve({status:res.statusCode,headers:res.headers,value,text});});
  });req.on('error',reject);req.setTimeout(7000,()=>req.destroy(Error('Retirement HTTP fixture timed out.')));req.end(encoded);
 });
}
async function fixture(t){
 const directory=await mkdtemp(path.join(tmpdir(),'planning-retired-http-')),runtime=new Runtime(),transport=createRemoteTransportFixture();
 const remoteAccess=new RemoteAccessManager({dataDir:directory,transport:transport.transport,defaultHttpsPort:8443});
 let app;t.after(async()=>{try{await app?.close();}finally{await rm(directory,{recursive:true,force:true});}});
 app=await createHarnessServer({port:0,dataDir:directory,defaultCwd:directory,runtime,desktop:new Desktop(),remoteAccess,autoAttachDesktop:false});
 await app.learning.updateSettings({mode:'manual'});
 const url=new URL(await app.listen()),page=await request(url,'/'),cookie=page.headers['set-cookie'][0].split(';')[0];
 const local=(route,{authenticated=true,...options}={})=>request(url,route,{...options,headers:{...(authenticated?{Cookie:cookie}:{}),...options.headers}});
 return {app,runtime,local,directory};
}
function output(requestId){
 const fields=planningModuleTemplate('frame').fields;
 return JSON.stringify({values:Object.fromEntries(fields.map(field=>[field.id,'Synthetic supported finding for '+field.label])),grounding:fields.filter(field=>field.grounding==='required').map(field=>({field:field.id,sourceId:'request:'+requestId})),openQuestions:[],challengeResponses:[]});
}
test('assembled authenticated HTTP retires automatic cycles, answers and diagnostics before all service dispatch',async t=>{
 const f=await fixture(t),store=f.app.planningBrowser;
 await store.create({id:'archive',conversationId:'archive-chat',title:'Saved synthetic record',objective:'Keep recorded evidence readable.'});
 await store.addNode('archive',{id:'frame',kind:'frame',title:'Saved frame'});
 const raw=JSON.parse(await readFile(store.file('archive'),'utf8'));raw.responseCycle={version:1,rootCycleId:'old-cycle',cycles:[]};store._validate(raw);
 await writeFile(store.file('archive'),JSON.stringify(raw));const original=await readFile(store.file('archive'),'utf8');
 const called=[];
 for(const [service,names]of [[f.app.responseCycle,['createCycle','runCycle','editPlan','continueCycle','answerQuestion']],[f.app.taskViability,['answer','answerCurrent']],[f.app.engine,['startRun','resumePlannedRun','resumeViabilityRun']]]){
  for(const name of names)service[name]=()=>{called.push(name);throw Error('Retired handler reached '+name);};
 }
 const routes=[BASE+'/archive/cycles',BASE+'/archive/cycles/old-cycle/run',BASE+'/archive/cycles/old-cycle/plan',BASE+'/archive/cycles/old-cycle/continue',BASE+'/archive/viability/answer','/api/planning-diagnostics/capture','/api/planning-diagnostics/saved/run'];
 for(const route of routes){
  const denied=await f.local(route,{method:'POST',body:{clientRequestId:'retired-try'}});
  assert.equal(denied.status,410,route+' '+denied.text);assert.equal(denied.value.code,'PLANNING_CYCLE_RETIRED');
 }
 for(const mode of ['plan_only','automatic']){
  const denied=await f.local(BASE,{method:'POST',body:{title:'Old caller',objective:'Do not admit this old cycle.',planningExecutionMode:mode}});
  assert.equal(denied.status,410,denied.text);
 }
 const edits=[
  [BASE+'/archive/nodes/frame','PATCH',{title:'Erase history',expectedNodeRevision:1}],
  [BASE+'/archive/nodes','POST',{kind:'frame',title:'New child'}],
  [BASE+'/archive/nodes/frame/run','POST',{expectedNodeRevision:1}],
  [BASE+'/archive/program','PUT',{xml:raw.programXml.replace('Saved frame','Altered frame'),expectedRevision:raw.revision}]
 ];
 for(const [route,method,body]of edits){const denied=await f.local(route,{method,body});assert.equal(denied.status,410,route+' '+denied.text);assert.equal(denied.value.code,'PLANNING_CYCLE_RETIRED');}
 const saved=await f.local(BASE+'/archive');assert.equal(saved.status,200,saved.text);assert.equal(saved.value.nodes[0].title,'Saved frame');
 const xml=await f.local(BASE+'/archive/program');assert.equal(xml.status,200,xml.text);
 assert.equal(await readFile(store.file('archive'),'utf8'),original);assert.deepEqual(called,[]);assert.equal(f.runtime.calls.length,0);
 const unauthenticated=await f.local(routes[0],{method:'POST',body:{},authenticated:false});assert.notEqual(unauthenticated.status,200);assert.notEqual(unauthenticated.status,201);assert.deepEqual(called,[]);
});
test('fresh modular group, frame edit, explicit response-only execution and outcome readback remain available through HTTP',async t=>{
 const f=await fixture(t);
 let response=await f.local(BASE,{method:'POST',body:{conversationId:'current-chat',title:'Current modular graph',objective:'Compare synthetic evidence without effects.',clientRequestId:'current-graph'}});
 assert.equal(response.status,201,response.text);let graph=response.value;assert.equal(graph.responseCycle?.rootCycleId,undefined);assert.equal(f.runtime.calls.length,0);
 response=await f.local(BASE+'/'+graph.id+'/nodes',{method:'POST',body:{kind:'cycle',title:'Current group'}});assert.equal(response.status,201,response.text);graph=response.value;
 const group=graph.nodes.find(node=>node.kind==='cycle');
 response=await f.local(BASE+'/'+graph.id+'/nodes',{method:'POST',body:{kind:'frame',title:'Current frame',parentId:group.id,expectedParentRevision:group.revision}});assert.equal(response.status,201,response.text);graph=response.value;
 let frame=graph.nodes.find(node=>node.kind==='frame');
 response=await f.local(BASE+'/'+graph.id+'/nodes/'+frame.id,{method:'PATCH',body:{title:'Revised current frame',expectedNodeRevision:frame.revision}});assert.equal(response.status,200,response.text);frame=response.value.nodes.find(node=>node.id===frame.id);
 f.runtime.output=output(graph.id);
 response=await f.local(BASE+'/'+graph.id+'/nodes/'+frame.id+'/run',{method:'POST',body:{expectedNodeRevision:frame.revision,clientRequestId:'current-module'}});assert.equal(response.status,202,response.text);
 await Promise.all(f.app.planningBrowserRuntime.activePromises());
 response=await f.local(BASE+'/'+graph.id);assert.equal(response.status,200,response.text);
 const completed=response.value.nodes.find(node=>node.id===frame.id);assert.equal(completed.title,'Revised current frame');assert.equal(response.value.attempts.at(-1).status,'completed');assert.equal(completed.response.provenance.kind,'runtime');assert.equal(completed.response.verifiedAction,false);assert.equal(f.runtime.calls.length,1);
});
