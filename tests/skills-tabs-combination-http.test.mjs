import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHarnessServer} from '../server.mjs';
import {readReleaseSkill} from '../lib/release-skills.mjs';

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
  const memory=path.join(root,'data','knowledge.json'),bytes=JSON.stringify({entries:[{id:'combined-fixture-skill',kind:'skill',title:'Scoped combined procedure',content:'Not release content'}]});await mkdir(path.dirname(memory));await writeFile(memory,bytes);
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
  assert.doesNotMatch(html,/data-space="skills"/);
  assert.match(html,/data-space="runtime"/);
  assert.match(html,/href="\/next\/skills\.css"/);
  const cookie=first.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie,'A disposable real server must issue a session cookie.');
  const get=async route=>fetch(address+route,{headers:{Cookie:cookie}});
  for(const [asset,type,content] of [
    ['/next/app.mjs','javascript','createRuntimeWorkspace'],
    ['/next/skills.css','css','.next-skills-layout'],
    ['/next/workspaces/runtime.mjs','javascript','createRuntimeWorkspace'],
    ['/next/workspaces/browser-scoped-cleanup-ui.mjs','javascript','createBrowserScopedCleanup'],
  ]){
    const response=await get(asset);
    const body=await response.text();
    assert.equal(response.status,200,asset+' is explicitly allowlisted');
    assert.match(response.headers.get('content-type'),new RegExp(type),asset+' uses correct MIME');
    if(asset==='/next/app.mjs'){assert.match(body,/workspaces\/runtime\.mjs/);assert.doesNotMatch(body,/workspaces\/skills\.mjs/);}
    else assert.ok(body.includes(content),asset+' has the expected module content');
  }
  assert.equal((await get('/next/workspaces/skills.mjs')).status,404);
  assert.equal((await get('/next/workspaces/undocumented-unlisted-asset.mjs')).status,404);
  const org=await (await get('/api/runtime/organization')).json();
  assert.deepEqual(org,await (await get('/api/skills/folders')).json());
  const orgHeaders={Cookie:cookie,Origin:new URL(address).origin,'Content-Type':'application/json'};
  const write=await fetch(address+'/api/runtime/organization',{method:'POST',headers:orgHeaders,body:JSON.stringify({action:'create',id:'runtime-http-parent',name:'Runtime category',parentId:'runtime:system',expectedRevision:org.revision})});
  assert.equal(write.status,200);
  const written=await write.json();
  assert.deepEqual(written,await (await get('/api/skills/folders')).json());
  assert.equal(written.folders[0].parentId,'runtime:system');
  assert.equal(Object.hasOwn(app,'knowledge'),false);
  const listResponse=await get('/api/skills?source=all');
  assert.equal(listResponse.status,200);
  const catalog=await listResponse.json();
  assert.equal(catalog.sources.bundled.status,'available');
  const listed=catalog.entries.find(entry=>entry.id==='builtin-decomposition');
  assert.ok(listed);assert.equal(Object.hasOwn(listed,'content'),false);
  assert.ok(!catalog.entries.some(entry=>entry.id==='saved:combined-fixture-skill'));
  const read=await get('/api/skills/builtin-decomposition');assert.equal(read.status,200);
  const method=await read.json(),expected=readReleaseSkill('builtin-decomposition');
  assert.equal(method.immutable,true);assert.equal(method.source,'bundled');
  assert.equal(method.content,expected.content,'HTTP detail must deliver the complete current release-owned skill body.');
  assert.equal(method.revision,expected.revision);assert.equal(listed.revision,method.revision);
  assert.equal((await get('/api/skills/saved%3Acombined-fixture-skill')).status,404);
  assert.equal((await get('/api/skills/builtin-..%2Fescape')).status,404);
  assert.equal(await readFile(memory,'utf8'),bytes);
  assert.equal(runtime.inferences,0);
});
