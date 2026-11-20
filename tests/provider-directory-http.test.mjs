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
  async runAgent(){throw Error('Models settings discovery must never start inference');}
}

test('the standalone Model Catalog route and static module are no longer served', {timeout:20000}, async t=>{
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
  const home=await get('/');assert.equal(home.status,200);
  const cookie={Cookie:home.headers['set-cookie'][0].split(';',1)[0]};
  assert.equal((await get('/api/provider-directory?source=supported',cookie)).status,404);
  assert.equal((await get('/next/workspaces/settings-provider-directory.mjs',cookie)).status,404);
  assert.equal((await get('/next/workspaces/settings-providers.mjs',cookie)).status,200);
  assert.equal((await get('/next/workspaces/settings-subscriptions.mjs',cookie)).status,200);
  assert.equal(runtime.status().activeTurns,0);
});
