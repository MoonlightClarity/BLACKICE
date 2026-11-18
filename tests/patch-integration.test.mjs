import test from 'node:test';
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
    const call=async(name,args)=>{const response=await options.onToolCall({name,arguments:args},{signal:options.signal});assert.equal(response.success,true,response.contentItems?.[0]?.text);return JSON.parse(response.contentItems[0].text);};
    const read=await call('relay_workspace',{action:'read',path:'example.txt'});
    const patch=await call('relay_workspace',{action:'patch',path:'example.txt',oldText:'before',newText:'after',expectedHash:read.sha256});
    return{threadId:'fixture-thread',output:patch.id};
  }
}
async function fixture(t){const root=await mkdtemp(path.join(tmpdir(),'relay-patch-http-')),cwd=path.join(root,'project');await mkdir(cwd);const app=await createHarnessServer({port:0,dataDir:path.join(root,'data'),defaultCwd:cwd,runtime:new Runtime()});const url=await app.listen(),page=await fetch(url),cookie=page.headers.get('set-cookie').split(';')[0];await page.text();t.after(async()=>{await app.close();assert.match(path.basename(root),/^relay-patch-http-/);await rm(root,{recursive:true,force:true});});const request=async(route,method='GET',value)=>{const response=await fetch(url+route,{method,headers:{cookie,origin:url,...(value?{'content-type':'application/json'}:{})},...(value?{body:JSON.stringify(value)}:{})});return{status:response.status,data:await response.json()};};return{app,cwd,url,cookie,request};}
async function settled(app,id){const deadline=Date.now()+5000;while(Date.now()<deadline){const run=app.engine.getRun(id);if(run.settled)return run;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Fixture run did not settle.');}

test('an actual engine turn receives patch tools and its HTTP audit/undo changes the actual file',async t=>{
  const{app,cwd,request,url,cookie}=await fixture(t),file=path.join(cwd,'example.txt');await writeFile(file,'prefix before suffix');const workflow=createMissionWorkflow({id:'patch-integration',cwd,model:'fixture',task:'Patch the fixture.',planningMode:'off'});const admitted=await request('/api/runs','POST',{workflow,input:'Patch the fixture.'});assert.equal(admitted.status,201);const run=await settled(app,(admitted.data.run||admitted.data).id);assert.equal(run.status,'completed');assert.equal(await readFile(file,'utf8'),'prefix after suffix');
  const history=await request('/api/file-patches?cwd='+encodeURIComponent(cwd));assert.equal(history.status,200);assert.equal(history.data.total,1);const item=history.data.patches[0];assert.equal(item.runId,run.id);assert.equal('before' in item,false);
  const detail=await request('/api/file-patches/'+item.id);assert.equal(detail.data.before,'prefix before suffix');assert.equal(detail.data.after,'prefix after suffix');
  const denied=await fetch(url+'/api/file-patches');assert.equal(denied.status,401);const wrongOrigin=await fetch(url+'/api/file-patches/'+item.id+'/undo',{method:'POST',headers:{cookie,origin:'https://outside.invalid','content-type':'application/json'},body:'{}'});assert.equal(wrongOrigin.status,403);
  const undo=await request('/api/file-patches/'+item.id+'/undo','POST',{});assert.equal(undo.status,200);assert.equal(undo.data.undoOf,item.id);assert.equal(await readFile(file,'utf8'),'prefix before suffix');
  const newPatch=await app.engine.filePatches.patch({cwd,path:file,oldText:'before',newText:'new'});await writeFile(file,'user editor content');assert.equal((await request('/api/file-patches/'+newPatch.id+'/undo','POST',{})).status,409);assert.equal(await readFile(file,'utf8'),'user editor content');
});

test('retired knowledge HTTP mutations and history cannot create or revive mutable memories',async t=>{
 const{app,cwd,request,url}=await fixture(t);
 const before=await app.knowledge.list({cwd});
 for(const [route,method,value] of [
 ['/api/knowledge','POST',{kind:'memory',cwd,title:'Preference',content:'Use short paragraphs.'}],
 ['/api/knowledge/legacy/patch','POST',{oldText:'short',newText:'compact',expectedRevision:1}],
 ['/api/knowledge/legacy/history','GET'],
 ['/api/knowledge/legacy','DELETE',{expectedRevision:1}],
 ['/api/knowledge?kind=memory&deletedOnly=true','GET'],
 ['/api/knowledge/legacy/restore','POST',{revision:1,expectedRevision:2}]
 ]){
  const result=await request(route,method,value);assert.equal(result.status,410,route);assert.equal(result.data.code,'KNOWLEDGE_RETIRED',route);
 }
 assert.deepEqual(await app.knowledge.list({cwd}),before);
 assert.equal((await fetch(url+'/api/knowledge')).status,401,'Retirement does not bypass authentication');
});

test('profile maintenance rejects new patch undo and preserves the actual file',async t=>{
  const{app,cwd,request}=await fixture(t),file=path.join(cwd,'example.txt');await writeFile(file,'before');const receipt=await app.engine.filePatches.patch({cwd,path:file,oldText:'before',newText:'after'});await app.beginMaintenance();assert.equal((await request('/api/file-patches/'+receipt.id+'/undo','POST',{})).status,503);assert.equal(await readFile(file,'utf8'),'after');app.endMaintenance();
});
