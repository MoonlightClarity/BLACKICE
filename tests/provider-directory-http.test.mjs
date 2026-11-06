import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import http from 'node:http';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHarnessServer} from '../server.mjs';

class QuietRuntime extends EventEmitter {
  status(){return {connected:true,authenticated:true,defaultModel:'fixture',models:[],activeTurns:0};}
  async start(){return this.status();}
  async close(){}
  async runAgent(){throw Error('API directory discovery must never start inference');}
}

test('model provider directory is a real, session-bound GET route with correct filters and a served UI module', {timeout:20000}, async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'blackice-provider-directory-http-'));
  const cwd=path.join(root,'workspace');await mkdir(cwd);
  const runtime=new QuietRuntime();
  const app=await createHarnessServer({runtime,port:0,dataDir:path.join(root,'data'),defaultCwd:cwd});
  t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
  const base=new URL(await app.listen());
  const get=(route,headers={})=>new Promise((resolve,reject)=>{
    const req=http.get({hostname:base.hostname,port:base.port,path:route,headers},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);
      res.on('end',()=>{const body=Buffer.concat(chunks).toString('utf8');
        resolve({status:res.statusCode,headers:res.headers,body,json:String(res.headers['content-type']).includes('application/json')?JSON.parse(body):null});});
    });req.on('error',reject);req.setTimeout(10000,()=>req.destroy(Error('Local fixture request expired')));
  });
  const unauthorized=await get('/api/provider-directory?source=supported');
  assert.equal(unauthorized.status,401);
  const home=await get('/');assert.equal(home.status,200);
  const cookie={Cookie:home.headers['set-cookie'][0].split(';',1)[0]};
  const query=await get('/api/provider-directory?source=supported&query=groq&auth=keyed',cookie);
  assert.equal(query.status,200);
  assert.equal(query.json.total>=1,true);
  assert.ok(query.json.items.some(item=>item.preset==='groq'&&item.supported===true));
  assert.ok(query.json.items.every(item=>item.authentication==='keyed'));
  const keyless=await get('/api/provider-directory?source=supported&query=kilo&auth=keyless',cookie);
  assert.equal(keyless.status,200);
  assert.ok(keyless.json.items.some(item=>item.preset==='kilo_free'));
  const free=await get('/api/provider-directory?source=supported&freeModelsOnly=true',cookie);
  assert.equal(free.status,200);
  assert.ok(free.json.items.length>0);
  assert.ok(free.json.items.every(item=>item.freeModelsDeclared||item.zeroPriceModels>0));
  const invalid=await get('/api/provider-directory?source=bad',cookie);
  assert.equal(invalid.status,400);
  assert.equal(invalid.json.code,'INVALID_MODEL_PROVIDER_SEARCH');
  const module=await get('/next/workspaces/settings-provider-directory.mjs',cookie);
  assert.equal(module.status,200,'The dynamic Settings module is registered on the actual static file server');
  assert.match(module.body,/createProviderDirectoryUI/);
  assert.equal(runtime.status().activeTurns,0);
});
