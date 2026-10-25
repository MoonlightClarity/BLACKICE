import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHarnessServer} from '../server.mjs';

class QuietRuntime extends EventEmitter {
  status(){return {connected:true,authenticated:true,defaultModel:'fixture-model',activeTurns:0};}
  async start(){return this.status();}
  async close(){}
  async runAgent(){return {output:'Fixture only',threadId:'fixture-thread'};}
}

test('real BLACKICE server defaults to V2, retains classic recovery, and serves workers and native assets',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'blackice-next-real-http-'));
  const cwd=path.join(directory,'workspace');await mkdir(cwd);
  const app=await createHarnessServer({runtime:new QuietRuntime(),port:0,dataDir:path.join(directory,'data'),defaultCwd:cwd});
  const url=await app.listen();
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const target=new URL(url);
  const get=(route,cookie)=>new Promise((resolve,reject)=>{
    const req=http.get({hostname:target.hostname,port:target.port,path:route,
      headers:cookie?{Cookie:cookie}:{}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));
      res.on('end',()=>{const bytes=Buffer.concat(chunks);resolve({status:res.statusCode,headers:res.headers,
        bytes,text:bytes.toString('utf8')});});
      res.on('error',reject);
    });
    req.on('error',reject);req.setTimeout(15000,()=>req.destroy(Error('Static route did not respond.')));
  });
  const initial=await get('/');
  assert.equal(initial.status,200);
  assert.match(initial.text,/src="\/next\/app\.mjs"/);
  const classic=await get('/legacy/');
  assert.equal(classic.status,200);
  assert.match(classic.text,/src="\/app\.js"/);
  const cookie=initial.headers['set-cookie']?.[0]?.split(';',1)[0];
  assert.ok(cookie,'V2 session cookie must be established on launch.');
  const next=await get('/next/',cookie);
  assert.equal(next.status,200);
  assert.match(next.text,/src="\/next\/app\.mjs"/);
  assert.doesNotMatch(next.text,/src="\/app\.js"/);
  assert.ok(next.headers['set-cookie'],'Explicit V2 alias should still establish a local session.');
  const assets=['/next/app.mjs','/next/chat/chat.mjs','/next/chat/reader-worker.mjs',
    '/next/chat/reader-client.mjs','/next/chat/reader-model.mjs','/next/workspaces/planning.mjs',
    '/next/workspaces/activity.mjs','/next/workspaces/browser-model.mjs',
    '/next/workspaces/browser-native.mjs',
    '/next/base.css','/next/chat.css','/next/chat-management.css','/next/brand.css','/next/controls.css','/next/browser.css','/next/knowledge.css',
    '/next/workspaces/task-lifecycle.mjs',
    '/next/workspaces/knowledge.mjs','/next/workspaces/knowledge-model.mjs',
    '/next/workspaces/settings.mjs','/next/workspaces/settings-identity.mjs',
    '/next/workspaces/settings-providers.mjs','/next/workspaces/settings-connections.mjs','/next/workspaces/settings-import.mjs',
    '/next/settings.css','/next/settings-identity.css','/next/settings-providers.css','/next/settings-connections.css',
    '/native-apps-ui.mjs','/native-apps.css'];
  for(const resource of assets){
    const result=await get(resource,cookie);
    assert.equal(result.status,200,resource+' should be served by the real HTTP route.');
    assert.match(result.headers['content-type'],/\b(?:javascript|css)\b/,resource+' content type.');
    assert.ok(result.text.length>30,resource+' must not be an empty response.');
  }
  for(const [resource,type] of [['/assets/blackice-v2-mark.svg','image/svg+xml'],['/assets/fonts/Oxanium-Variable.ttf','font/ttf'],['/assets/fonts/ShareTechMono-Regular.ttf','font/ttf']]){
    const result=await get(resource,cookie);
    assert.equal(result.status,200,resource+' must reach the actual installed HTTP asset route.');
    assert.equal(result.headers['content-type'],type);
    assert.ok(result.text.length>30);
  }
  const ice=await get('/assets/blackice-dark-ice.png',cookie);
  assert.equal(ice.status,200,'Current dark-ice artwork must reach the real HTTP route.');
  assert.equal(ice.headers['content-type'],'image/png');
  assert.equal(createHash('sha256').update(ice.bytes).digest('hex'),
    'c98b645d1d9de19ab89fc9dc10b50fe1a745db576fa997d096533b9ef4b7cd34',
    'The HTTP route must serve the exact approved dark-ice image bytes.');
  for(const resource of ['/assets/blackice-v2-field.svg','/assets/blackice-v2-horizon.svg']){
    assert.equal((await get(resource,cookie)).status,404,'Retired city artwork must stay unavailable: '+resource);
  }
  const unlisted=await get('/next/missing-secret-file.mjs',cookie);
  assert.equal(unlisted.status,404,'Unknown filenames never escape the static allowlist.');
});
