import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHarnessServer} from '../server.mjs';
class Runtime extends EventEmitter {status(){return {connected:true,authenticated:true,models:[]};} async start(){return this.status();} async close(){} async runAgent(){throw Error('Unexpected model run');}}
test('removed authored workflow feature has no UI, API or model tool and leaves saved bytes alone',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'removed-workflow-')),dataDir=path.join(root,'data');await mkdir(dataDir);
 const file=path.join(dataDir,'user-workflows.json'),saved='{"obsolete":"preserve without loading"}';await writeFile(file,saved);
 const app=await createHarnessServer({runtime:new Runtime(),dataDir,defaultCwd:root,port:0,remoteAccess:false});const base=await app.listen();
 t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
 const response=await fetch(base),cookie=response.headers.get('set-cookie').split(';')[0],html=await response.text();assert.doesNotMatch(html,/data-space="userWorkflows"/);
 for(const route of ['/api/user-workflows','/api/user-workflows/one','/next/workspaces/user-workflows.mjs']){
  const r=await fetch(new URL(route,base),{headers:{Cookie:cookie}});assert.equal(r.status,404,route);
 }
 const post=await fetch(new URL('/api/user-workflows',base),{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{}'});assert.equal(post.status,404);
 assert.equal(await readFile(file,'utf8'),saved);
 assert.equal('userWorkflows' in app,false);
});
