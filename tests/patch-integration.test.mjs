import test from 'node:test';
import {recordFixturePlan} from './fixture-task-plan.mjs';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHarnessServer} from '../server.mjs';
import {createMissionWorkflow} from '../public/mission-model.mjs';

class Runtime extends EventEmitter{
  status(){return{connected:true,authenticated:true,defaultModel:'fixture',models:[{id:'fixture',available:true}]};}
  async start(){return this.status();}
  async close(){}
  async runAgent(options){
    await recordFixturePlan(options,{title:'Apply the requested patch',doneWhen:'The actual file contains the requested replacement and an undo receipt is returned.'});
    const call=async(name,args)=>{const response=await options.onToolCall({name,arguments:args},{signal:options.signal});assert.equal(response.success,true,response.contentItems?.[0]?.text);return JSON.parse(response.contentItems[0].text);};
    const read=await call('relay_workspace',{action:'read',path:'example.txt'});
    const patch=await call('relay_workspace',{action:'patch',path:'example.txt',oldText:'before',newText:'after',expectedHash:read.sha256});
    return{threadId:'fixture-thread',output:patch.id};
  }
}
async function fixture(t){const root=await mkdtemp(path.join(tmpdir(),'relay-patch-http-')),cwd=path.join(root,'project');await mkdir(cwd);const app=await createHarnessServer({port:0,dataDir:path.join(root,'data'),defaultCwd:cwd,runtime:new Runtime()});await app.learning.updateSettings({mode:'manual'});const url=await app.listen(),page=await fetch(url),cookie=page.headers.get('set-cookie').split(';')[0];await page.text();t.after(async()=>{await app.close();assert.match(path.basename(root),/^relay-patch-http-/);await rm(root,{recursive:true,force:true});});const request=async(route,method='GET',value)=>{const response=await fetch(url+route,{method,headers:{cookie,origin:url,...(value?{'content-type':'application/json'}:{})},...(value?{body:JSON.stringify(value)}:{})});return{status:response.status,data:await response.json()};};return{app,cwd,url,cookie,request};}
async function settled(app,id){const deadline=Date.now()+5000;while(Date.now()<deadline){const run=app.engine.getRun(id);if(run.settled)return run;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Fixture run did not settle.');}

test('an actual engine turn receives patch tools and its HTTP audit/undo changes the actual file',async t=>{
  const{app,cwd,request,url,cookie}=await fixture(t),file=path.join(cwd,'example.txt');await writeFile(file,'prefix before suffix');const workflow=createMissionWorkflow({id:'patch-integration',cwd,model:'fixture',task:'Patch the fixture.'});const admitted=await request('/api/runs','POST',{workflow,input:'Patch the fixture.'});assert.equal(admitted.status,201);const run=await settled(app,(admitted.data.run||admitted.data).id);assert.equal(run.status,'completed');assert.equal(await readFile(file,'utf8'),'prefix after suffix');
  const history=await request('/api/file-patches?cwd='+encodeURIComponent(cwd));assert.equal(history.status,200);assert.equal(history.data.total,1);const item=history.data.patches[0];assert.equal(item.runId,run.id);assert.equal('before' in item,false);
  const detail=await request('/api/file-patches/'+item.id);assert.equal(detail.data.before,'prefix before suffix');assert.equal(detail.data.after,'prefix after suffix');
  const denied=await fetch(url+'/api/file-patches');assert.equal(denied.status,401);const wrongOrigin=await fetch(url+'/api/file-patches/'+item.id+'/undo',{method:'POST',headers:{cookie,origin:'https://outside.invalid','content-type':'application/json'},body:'{}'});assert.equal(wrongOrigin.status,403);
  const undo=await request('/api/file-patches/'+item.id+'/undo','POST',{});assert.equal(undo.status,200);assert.equal(undo.data.undoOf,item.id);assert.equal(await readFile(file,'utf8'),'prefix before suffix');
  const newPatch=await app.engine.filePatches.patch({cwd,path:file,oldText:'before',newText:'new'});await writeFile(file,'user editor content');assert.equal((await request('/api/file-patches/'+newPatch.id+'/undo','POST',{})).status,409);assert.equal(await readFile(file,'utf8'),'user editor content');
});

test('knowledge HTTP patches, conflict checks, deleted history and restores are applied without approval',async t=>{
  const{cwd,request}=await fixture(t),created=await request('/api/knowledge','POST',{kind:'memory',cwd,title:'Preference',content:'Use short paragraphs and keep dates explicit.'});assert.equal(created.status,200);const id=created.data.id;
  const patch=await request('/api/knowledge/'+id+'/patch','POST',{oldText:'short paragraphs',newText:'compact paragraphs',expectedRevision:1});assert.equal(patch.status,200);assert.equal(patch.data.content,'Use compact paragraphs and keep dates explicit.');
  const history=await request('/api/knowledge/'+id+'/history');assert.equal(history.status,200);assert.equal(history.data.currentRevision,2);assert.equal(history.data.history[1].content,created.data.content);
  assert.equal((await request('/api/knowledge/'+id,'DELETE',{expectedRevision:1})).status,409);assert.equal((await request('/api/knowledge/'+id,'DELETE',{expectedRevision:2})).status,200);
  const list=await request('/api/knowledge?kind=memory&cwd='+encodeURIComponent(cwd));assert.equal(list.data.some(entry=>entry.id===id),false);
  const deleted=await request('/api/knowledge?kind=memory&deletedOnly=true');assert.equal(deleted.data.some(entry=>entry.id===id),true);
  const state=await request('/api/knowledge/'+id+'/history');const restored=await request('/api/knowledge/'+id+'/restore','POST',{revision:1,expectedRevision:state.data.currentRevision});assert.equal(restored.status,200);assert.equal(restored.data.content,created.data.content);assert.equal(restored.data.deleted,undefined);
});

test('profile maintenance rejects new patch undo and preserves the actual file',async t=>{
  const{app,cwd,request}=await fixture(t),file=path.join(cwd,'example.txt');await writeFile(file,'before');const receipt=await app.engine.filePatches.patch({cwd,path:file,oldText:'before',newText:'after'});await app.beginMaintenance();assert.equal((await request('/api/file-patches/'+receipt.id+'/undo','POST',{})).status,503);assert.equal(await readFile(file,'utf8'),'after');app.endMaintenance();
});
