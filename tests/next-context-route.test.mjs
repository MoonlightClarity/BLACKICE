import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import http from 'node:http';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHarnessServer} from '../server.mjs';

class QuietRuntime extends EventEmitter {
  constructor(){super();this.inferences=0;}
  status(){return {connected:true,authenticated:true,defaultModel:'fixture-model',activeTurns:0};}
  async start(){return this.status();}
  async close(){}
  async runAgent(){this.inferences++;throw Error('Static asset requests must not start inference.');}
}

test('Chat, Settings and reader worker import graphs reach the real static allowlist including context controls',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'blackice-context-static-http-'));
  const cwd=path.join(directory,'workspace');await mkdir(cwd);
  const runtime=new QuietRuntime();
  const app=await createHarnessServer({runtime,port:0,remoteAccess:false,dataDir:path.join(directory,'data'),defaultCwd:cwd});
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const base=new URL(await app.listen());
  const request=(route,method='GET')=>new Promise((resolve,reject)=>{
    const req=http.request({hostname:base.hostname,port:base.port,path:route,method},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,bytes:Buffer.concat(chunks)}));
    });
    req.on('error',reject);req.setTimeout(15000,()=>req.destroy(Error('Static asset request timed out.')));req.end();
  });
  const pending=['/next/chat/chat.mjs','/next/workspaces/settings.mjs','/next/chat/reader-worker.mjs'];
  const visited=new Map();
  while(pending.length){
    const route=pending.shift();if(visited.has(route))continue;
    const response=await request(route);
    assert.equal(response.status,200,route+' must be served through the actual HTTP handler.');
    assert.match(response.headers['content-type']||'',/^text\/javascript\b/,route+' must be JavaScript.');
    assert.equal(response.headers['cache-control'],'no-store');
    const source=response.bytes.toString('utf8');visited.set(route,source);
    const imports=[...source.matchAll(/\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]/g),
      ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)];
    for(const [,specifier]of imports){
      if(!specifier.startsWith('.')&&!specifier.startsWith('/'))continue;
      const resolved=new URL(specifier,new URL(route,base));
      assert.equal(resolved.origin,base.origin,'Browser modules stay on the local application origin.');
      pending.push(resolved.pathname);
    }
  }
  assert.ok(visited.size>=20,'Traverse the real dependency graph, not just the three entry modules.');
  const helper='/next/core/context-controls.mjs';
  assert.ok(visited.has(helper),'Chat, Settings and reader dependencies must reach context controls.');
  assert.equal(visited.get(helper),await readFile(new URL('../public/next/core/context-controls.mjs',import.meta.url),'utf8'),
    'The route serves the exact new helper, not an HTML fallback or another module.');
  const head=await request(helper,'HEAD');
  assert.equal(head.status,200);assert.match(head.headers['content-type'],/^text\/javascript\b/);assert.equal(head.bytes.length,0);
  assert.equal((await request('/next/core/context-controls.mjs.backup')).status,404,'Adding the helper does not allow adjacent unlisted files.');
  assert.equal((await request('/next/core/unlisted-context-module.mjs')).status,404);
  assert.equal(runtime.inferences,0);
  t.diagnostic('Served '+visited.size+' modules through the real static import graph.');
});
