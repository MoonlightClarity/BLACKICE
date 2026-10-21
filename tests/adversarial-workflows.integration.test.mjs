import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { createHarnessServer } from '../server.mjs';

class HeldRuntime extends EventEmitter {
  constructor({offline=false}={}){super();this.offline=offline;this.calls=[];}
  status(){return{connected:!this.offline,authenticated:!this.offline,defaultModel:'disposable-fixture-model',activeTurns:this.calls.length};}
  async start(){return this.status();}
  async close(){}
  async runAgent(options){
    this.calls.push(options);options.onEvent?.({type:'thread',threadId:`fixture-${this.calls.length}`,model:'disposable-fixture-model'});
    return new Promise((resolve,reject)=>{const abort=()=>reject(Object.assign(new Error('Disposable runtime cancelled.'),{name:'AbortError'}));if(options.signal?.aborted)abort();else options.signal?.addEventListener('abort',abort,{once:true});});
  }
}
class NoDesktop extends EventEmitter { status(){return{enabled:false,available:false};} async setEnabled(){return this.status();} }
const graph={id:'impatient-test',name:'Disposable duplicate test',nodes:[{id:'input',type:'input',name:'Task'},{id:'agent',type:'agent',name:'Agent',model:'default',prompt:'Disposable test; no real tools.'},{id:'output',type:'output',name:'Result'}],edges:[{source:'input',target:'agent'},{source:'agent',target:'output'}],settings:{maxParallel:1}};
async function waitFor(check,label){const deadline=Date.now()+6000;while(Date.now()<deadline){const result=check();if(result)return result;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail(`${label} did not complete`);}
async function connect(app){
  const origin=new URL(await app.listen());let cookie='';
  const request=(route,body)=>new Promise((resolve,reject)=>{
    const text=body===undefined?null:JSON.stringify(body),req=http.request({hostname:origin.hostname,port:origin.port,path:route,method:text===null?'GET':'POST',agent:false,headers:{Cookie:cookie,...(text===null?{}:{Origin:origin.origin,'Content-Type':'application/json','Content-Length':Buffer.byteLength(text)})}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.once('end',()=>{const raw=Buffer.concat(chunks).toString();let data;try{data=JSON.parse(raw);}catch{data=raw;}resolve({status:res.statusCode,data,headers:res.headers});});res.once('error',reject);});req.setTimeout(10000,()=>req.destroy(new Error('Disposable HTTP test timed out.')));req.once('error',reject);req.end(text);
  });
  const home=await request('/');cookie=home.headers['set-cookie'][0].split(';',1)[0];return request;
}

test('impatient duplicate sends, repeated cancel/retry and restart preserve one admission and durable receipts',async t=>{
  const directory=await fs.mkdtemp(path.join(tmpdir(),'relay-impatient-release-')),dataDir=path.join(directory,'data'),cwd=path.join(directory,'workspace'),runtime=new HeldRuntime();const applications=[];
  t.after(async()=>{for(const application of applications)await application.close().catch(()=>{});assert.match(path.basename(directory),/^relay-impatient-release-/);await fs.rm(directory,{recursive:true,force:true});});
  const app=await createHarnessServer({runtime,desktop:new NoDesktop(),dataDir,defaultCwd:cwd,port:0,maxConcurrentRuns:1});applications.push(app);const api=await connect(app);
  const request={requestId:'impatient-one-request',workflow:graph,input:{task:'Start exactly one disposable task',cwd}};
  const duplicates=await Promise.all(Array.from({length:24},()=>api('/api/runs',request)));assert.ok(duplicates.every(value=>value.status===201));assert.equal(new Set(duplicates.map(value=>value.data.id)).size,1);const id=duplicates[0].data.id;
  await waitFor(()=>runtime.calls.length===1,'one runtime admission');
  const stops=await Promise.all(Array.from({length:16},()=>api(`/api/runs/${id}/cancel`,{})));assert.ok(stops.every(value=>value.status===200));await waitFor(()=>app.engine.getRun(id).settled,'cancel settlement');assert.equal(app.engine.getRun(id).status,'cancelled');assert.equal(runtime.calls.length,1);
  const retries=await Promise.all(Array.from({length:12},()=>api(`/api/runs/${id}/retry`,{})));assert.equal(retries.filter(value=>value.status===201).length,1);assert.ok(retries.filter(value=>value.status!==201).every(value=>value.status===409));await waitFor(()=>runtime.calls.length===2,'single retry admission');
  const retryId=retries.find(value=>value.status===201).data.id;await app.close();assert.equal(app.engine.getRun(retryId).settled,true);
  const offline=new HeldRuntime({offline:true}),restarted=await createHarnessServer({runtime:offline,desktop:new NoDesktop(),dataDir,defaultCwd:cwd,port:0,maxConcurrentRuns:1});applications.push(restarted);const afterRestart=await connect(restarted);
  const recovered=await Promise.all(Array.from({length:20},()=>afterRestart('/api/runs',request)));assert.ok(recovered.every(value=>value.status===201&&value.data.id===id&&value.data.status==='cancelled'));assert.equal(offline.calls.length,0,'receipt recovery must not execute work after restart or require a live model');
  const conflict=await afterRestart('/api/runs',{...request,input:{task:'A different task using the old receipt',cwd}});assert.equal(conflict.status,409);assert.equal(offline.calls.length,0);assert.equal(restarted.engine.listRuns().filter(run=>run.retryOf===id).length,1);
});
