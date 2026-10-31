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

test('real BLACKICE server serves only the current interface and keeps old bookmarks from changing settings',async t=>{
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
  const cookie=initial.headers['set-cookie']?.[0]?.split(';',1)[0];
  assert.ok(cookie,'V2 session cookie must be established on launch.');
  const settingsRoutes=['/api/runtime/settings','/api/execution/settings','/api/providers'];
  const beforeSettings=await Promise.all(settingsRoutes.map(async route=>{
    const result=await get(route,cookie);assert.equal(result.status,200);return JSON.parse(result.text);
  }));
  for(const route of ['/legacy','/legacy/','/legacy/index.html']){
    const old=await get(route,cookie);
    assert.equal(old.status,302,route+' redirects to the current interface.');
    assert.equal(old.headers.location,'/');
    assert.equal(old.headers['cache-control'],'no-store');
    assert.doesNotMatch(old.text,/src="\/app\.js"/);
    const destination=await get(old.headers.location,cookie);
    assert.equal(destination.status,200);assert.match(destination.text,/src="\/next\/app\.mjs"/);
  }
  const index=await get('/index.html',cookie);
  assert.equal(index.status,200);assert.match(index.text,/src="\/next\/app\.mjs"/);
  const afterSettings=await Promise.all(settingsRoutes.map(async route=>JSON.parse((await get(route,cookie)).text)));
  assert.deepEqual(afterSettings,beforeSettings,'Opening old interface URLs never saves or replaces preferences.');
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

test('native models HTTP refresh awaits a fresh catalog while routine reads stay cached and no inference runs',async t=>{
  class CatalogRuntime extends QuietRuntime {
    constructor(){super();this.starts=[];this.revision=0;this.inferences=0;this.failRefresh=false;}
    async start(options){
      this.starts.push(options);
      if(options?.connectCodex){
        await new Promise(resolve=>setImmediate(resolve));
        if(this.failRefresh)throw Error('Native metadata refresh failed');
        this.revision++;
      }
      return this.status();
    }
    codexModelCatalog(){return {connected:true,authenticated:true,
      modelCatalog:{refreshedAt:this.revision?'2026-10-30T16:00:00Z':'2026-10-30T15:00:00Z'},
      models:[{id:'cached-model',contextWindowTokens:this.revision?196000:null},
        ...(this.revision?[{id:'newly-advertised-hidden',hidden:true,contextWindowTokens:196000}]:[])]};}
    async runAgent(){this.inferences++;throw Error('A metadata route must never generate text.');}
  }
  const directory=await mkdtemp(path.join(tmpdir(),'blackice-native-refresh-http-'));
  const cwd=path.join(directory,'workspace');await mkdir(cwd);const runtime=new CatalogRuntime();
  const app=await createHarnessServer({runtime,port:0,dataDir:path.join(directory,'data'),defaultCwd:cwd});
  const url=await app.listen();
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const target=new URL(url),get=(route,cookie)=>new Promise((resolve,reject)=>{
    const req=http.get({hostname:target.hostname,port:target.port,path:route,headers:cookie?{Cookie:cookie}:{}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text:Buffer.concat(chunks).toString('utf8')}));res.on('error',reject);
    });req.on('error',reject);req.setTimeout(15000,()=>req.destroy(Error('Native catalog route did not respond.')));
  });
  const initial=await get('/');assert.equal(initial.status,200);
  const cookie=initial.headers['set-cookie']?.[0]?.split(';',1)[0];assert.ok(cookie);runtime.starts=[];
  for(const route of ['/api/codex/models','/api/codex/models?refresh=false','/api/codex/models?refresh=1']){
    const result=await get(route,cookie);assert.equal(result.status,200);
    assert.equal(JSON.parse(result.text).models.length,1);assert.equal(runtime.starts.length,0,'Only refresh=true forces a native catalog read.');
  }
  const refreshed=await get('/api/codex/models?refresh=true',cookie);assert.equal(refreshed.status,200);
  assert.deepEqual(runtime.starts,[{connectCodex:true}]);
  const fresh=JSON.parse(refreshed.text);assert.equal(fresh.modelCatalog.refreshedAt,'2026-10-30T16:00:00Z');
  assert.equal(fresh.models.length,2);assert.equal(fresh.models[0].contextWindowTokens,196000);assert.equal(fresh.models[1].hidden,true);
  const cached=await get('/api/codex/models',cookie);assert.equal(cached.status,200);assert.deepEqual(JSON.parse(cached.text),fresh);assert.equal(runtime.starts.length,1);
  runtime.failRefresh=true;const failed=await get('/api/codex/models?refresh=true',cookie);
  assert.ok(failed.status>=400,'A failed refresh must not report the previous catalog as a fresh success.');assert.match(failed.text,/Native metadata refresh failed/);
  assert.deepEqual(runtime.starts,[{connectCodex:true},{connectCodex:true}]);assert.equal(runtime.inferences,0);assert.equal(runtime.revision,1);
});
