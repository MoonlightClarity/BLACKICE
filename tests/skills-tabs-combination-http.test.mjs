import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHarnessServer} from '../server.mjs';

// Real .98 HTTP router + genuine Skills catalog and static delivery, but a
// disposable profile and no Codex, model worker, installed app or browser page.
class NoModelRuntime extends EventEmitter {
  constructor(){super();this.inferences=0;}
  status(){return {connected:false,authenticated:false,models:[],activeTurns:0};}
  async start(){return this.status();}
  async close(){}
  async runAgent(){this.inferences++;throw Error('HTTP acceptance must not start a model.');}
}

test('server delivers release-owned Skills without legacy contamination or model startup',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'blackice-combined-skills-tabs-http-'));
  const cwd=path.join(root,'work');await mkdir(cwd);
  const runtime=new NoModelRuntime();
  const app=await createHarnessServer({
    runtime,remoteAccess:false,autoAttachDesktop:false,port:0,
    dataDir:path.join(root,'data'),defaultCwd:cwd,
  });
  t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
  const address=await app.listen();
  const first=await fetch(address+'/next/');
  assert.equal(first.status,200);
  const html=await first.text();
  assert.match(html,/data-space="skills"/);
  assert.match(html,/href="\/next\/skills\.css"/);
  const cookie=first.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie,'A disposable real server must issue a session cookie.');
  const get=async route=>fetch(address+route,{headers:{Cookie:cookie}});
  for(const [asset,type,content] of [
    ['/next/app.mjs','javascript','createSkillsWorkspace'],
    ['/next/skills.css','css','.next-skills-layout'],
    ['/next/workspaces/skills.mjs','javascript','createSkillsWorkspace'],
    ['/next/workspaces/browser-scoped-cleanup-ui.mjs','javascript','createBrowserScopedCleanup'],
  ]){
    const response=await get(asset);
    const body=await response.text();
    assert.equal(response.status,200,asset+' is explicitly allowlisted');
    assert.match(response.headers.get('content-type'),new RegExp(type),asset+' uses correct MIME');
    if(asset==='/next/app.mjs')assert.match(body,/workspaces\/skills\.mjs/);
    else assert.ok(body.includes(content),asset+' has the expected module content');
  }
  assert.equal((await get('/next/workspaces/undocumented-unlisted-asset.mjs')).status,404);
  const saved=await app.knowledge.upsert({id:'combined-fixture-skill',kind:'skill',
    title:'Scoped combined procedure',summary:'Only an actual saved revision',content:'# Saved\nLatest revision 1',cwd});
  assert.equal(saved.revision,1);
  const listResponse=await get('/api/skills?source=all');
  assert.equal(listResponse.status,200);
  const catalog=await listResponse.json();
  assert.equal(catalog.sources.bundled.status,'available');
  assert.ok(catalog.entries.some(entry=>entry.id==='builtin-browser'));
  assert.ok(!catalog.entries.some(entry=>entry.id==='saved:combined-fixture-skill'));
  const read=await get('/api/skills/builtin-browser');assert.equal(read.status,200);
  const method=await read.json();assert.equal(method.immutable,true);assert.match(method.content,/When to use/);
  assert.equal((await get('/api/skills/saved%3Acombined-fixture-skill')).status,404);
  assert.equal((await get('/api/skills/builtin-..%2Fescape')).status,404);
  assert.equal(runtime.inferences,0);
});
