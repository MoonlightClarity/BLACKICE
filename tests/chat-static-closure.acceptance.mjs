import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {SourceTextModule} from 'node:vm';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createHarnessServer} from '../server.mjs';

class OfflineRuntime extends EventEmitter {
  status(){return {connected:true,authenticated:true,defaultModel:'offline-fixture',activeTurns:0};}
  async start(){return this.status();}
  async close(){}
  async runAgent(){throw Error('Static module validation never runs a model');}
}

test('every static Chat module dependency is served and parses over real loopback HTTP', {timeout:20000}, async t=>{
  const temporary=await realpath(tmpdir());
  const directory=await mkdtemp(path.join(temporary,'blackice-chat-module-closure-'));
  let app;
  t.after(async()=>{
    await app?.close();
    const resolved=await realpath(directory);
    assert.equal(path.dirname(resolved),temporary);
    assert.match(path.basename(resolved),/^blackice-chat-module-closure-/);
    await rm(resolved,{recursive:true,force:true});
  });
  app=await createHarnessServer({runtime:new OfflineRuntime(),port:0,dataDir:path.join(directory,'data'),defaultCwd:directory});
  const origin=new URL(await app.listen()).origin;
  const get=url=>new Promise((resolve,reject)=>{
    const req=http.get(url,res=>{
      const data=[];
      res.setEncoding('utf8');
      res.on('data',chunk=>data.push(chunk));
      res.on('end',()=>resolve({code:res.statusCode,contentType:res.headers['content-type'],text:data.join('')}));
      res.on('error',reject);
    });
    req.on('error',reject);req.setTimeout(3000,()=>req.destroy(Error('Static HTTP request timed out: '+url.pathname)));
  });
  const root=new URL('/next/chat/chat.mjs',origin);
  const visited=new Set();
  async function visit(url,importer){
    assert.equal(url.origin,origin,'No cross-origin static dependency');
    if(visited.has(url.href))return;
    visited.add(url.href);
    const result=await get(url);
    assert.equal(result.code,200,url.pathname+' imported by '+importer);
    assert.match(result.contentType??'',/javascript/i,url.pathname);
    const module=new SourceTextModule(result.text,{identifier:url.href});
    for(const specifier of module.dependencySpecifiers){
      assert.match(specifier,/^(?:\.\.?\/|\/)/,url.pathname+' has a non-URL dependency: '+specifier);
      await visit(new URL(specifier,url),url.pathname);
    }
  }
  await visit(root,'Chat entry');
  assert.ok(visited.has(new URL('/next/chat/tool-failure.mjs',origin).href),'Include the dependency missed by the earlier packaged route');
  assert.ok(visited.size>=30,'Exercise the real dependency tree, not only the entry route');
});
