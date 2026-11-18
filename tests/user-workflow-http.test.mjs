import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHarnessServer} from '../server.mjs';
class Runtime extends EventEmitter {status(){return{connected:true,authenticated:true,defaultModel:'fixture-model',models:[{id:'fixture-model',supportsTools:true}]};}async runAgent(){return{output:'Fixture complete',threadId:'fixture'};}async close(){}}
async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'blackice-user-workflow-http-'));await mkdir(path.join(root,'work'));
 const app=await createHarnessServer({runtime:new Runtime(),dataDir:path.join(root,'data'),defaultCwd:path.join(root,'work'),port:0});const base=await app.listen();const home=await fetch(base);const cookie=home.headers.get('set-cookie').split(';')[0];
 t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
 return {app,root,request:async(route,method='GET',value,extra={})=>{const response=await fetch(new URL(route,base),{method,headers:{Cookie:cookie,...(method==='GET'?{}:{'Content-Type':'application/json'}),...extra},...(method==='GET'?{}:{body:JSON.stringify(value||{})})});return{status:response.status,value:await response.json()};}};
}
test('real authenticated API authors exact approved workflow, executes once, and retires learning/memory routes',async t=>{
 const f=await fixture(t),{request}=f;
 const definition={id:'workflow-create-001',name:'User procedure',description:'Explicit test',instructions:'Report the supplied fixture text.',status:'draft',expectedRevision:0};
 const draft=await request('/api/user-workflows','POST',definition);assert.equal(draft.status,200);assert.equal((await request('/api/user-workflows','POST',definition)).value.id,draft.value.id);
 const route='/api/user-workflows/'+draft.value.id;
 assert.equal((await request(route+'/execute','POST',{expectedRevision:1,requestId:'workflow-run-001'})).status,403);
 const approved=await request('/api/user-workflows','POST',{...definition,id:draft.value.id,status:'approved',expectedRevision:1});assert.equal(approved.value.revision,2);
 assert.equal((await request(route+'/execute','POST',{expectedRevision:1,requestId:'workflow-run-001'})).status,409);
 const run=await request(route+'/execute','POST',{expectedRevision:2,requestId:'workflow-run-001',input:'Fixture input'});assert.equal(run.status,201,JSON.stringify(run.value));
 const duplicate=await request(route+'/execute','POST',{expectedRevision:2,requestId:'workflow-run-001',input:'Fixture input'});assert.equal(duplicate.status,201,JSON.stringify(duplicate.value));assert.equal(duplicate.value.id,run.value.id);
 const revoked=await request('/api/user-workflows','POST',{...definition,status:'draft',expectedRevision:2});assert.equal(revoked.value.revision,3);
 const recovered=await request(route+'/execute','POST',{expectedRevision:2,requestId:'workflow-run-001',input:'Fixture input'});assert.equal(recovered.value.id,run.value.id);
 assert.equal((await request(route+'/execute','POST',{expectedRevision:2,requestId:'workflow-run-002',input:'Fixture input'})).status,409);
 assert.equal((await request(route+'/execute','POST',{expectedRevision:2,requestId:'workflow-run-001',input:'Changed'})).status,409);
 const actual=f.app.engine.getRun(run.value.id);assert.match(JSON.stringify(actual.input),/User procedure/);assert.match(JSON.stringify(actual.input),/Fixture input/);
 assert.equal((await request('/api/knowledge','POST',{kind:'memory',title:'No',content:'No'})).status,410);
 assert.equal((await request('/api/learning/review','POST',{runId:run.value.id})).status,410);
 assert.equal(f.app.learning.status().enabled,false);
 assert.equal((await request('/api/swarm')).status,410);
 assert.equal((await request('/api/conversations/'+run.value.id+'/autonomy','POST',{mode:'on'})).status,410);
 const before=await readFile(f.app.userWorkflows.file,'utf8');
 assert.equal((await request('/api/user-workflows','POST',definition,{'x-blackice-remote':'1'})).status,403);
 assert.equal(await readFile(f.app.userWorkflows.file,'utf8'),before);
 assert.equal((await request('/api/user-workflows')).value.workflows.length,1);
});
