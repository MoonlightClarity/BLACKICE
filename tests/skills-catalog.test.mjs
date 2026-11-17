import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {KnowledgeStore} from '../lib/knowledge.mjs';
import {createSkillsCatalog,skillIdFromRequestPath} from '../lib/skills-catalog.mjs';

test('HTTP skill IDs survive URL encoding but reject traversal and malformed segments',()=>{
  assert.equal(skillIdFromRequestPath('/api/skills/saved%3Asaved-procedure'),'saved:saved-procedure');
  assert.equal(skillIdFromRequestPath('/api/skills/builtin%3Aplanning-v5'),null);
  assert.equal(skillIdFromRequestPath('/api/skills/native%3A'+'a'.repeat(64)),'native:'+'a'.repeat(64));
  assert.equal(skillIdFromRequestPath('/api/skills/saved%3A..%2Fsecret'),null);
  assert.equal(skillIdFromRequestPath('/api/skills/saved%XX'),null);
  assert.equal(skillIdFromRequestPath('/api/skills/saved%3Akey/extra'),null);
});

async function fixture(t,{nativeSkills}={}){
  const dir=await mkdtemp(path.join(tmpdir(),'blackice-skills-catalog-'));
  const cwd=path.join(dir,'primary'),other=path.join(dir,'secondary');
  await Promise.all([mkdir(cwd),mkdir(other)]);
  const store=await new KnowledgeStore({dataDir:path.join(dir,'data')}).init();
  t.after(async()=>{await store.writeChain.catch(()=>{});await rm(dir,{recursive:true,force:true});});
  return {dir,cwd,other,store,create:()=>createSkillsCatalog({knowledge:store,defaultCwd:cwd,nativeSkills})};
}

test('catalog distinguishes no built-in skills, scoped saved content and excluded native discovery',async t=>{
  const f=await fixture(t,{nativeSkills:async()=>({available:true,skills:[],errors:[]})});
  const global=await f.store.upsert({id:'global-skill',kind:'skill',title:'Prepare release',summary:'Release checklist',content:'# Release\nVerify provenance.'});
  const local=await f.store.upsert({id:'project-skill',kind:'skill',title:'Project checks',content:'# Project\nInspect artifacts.',cwd:f.other});
  const catalog=f.create();
  const listed=await catalog.list({cwd:f.cwd});
  assert.equal(listed.entries.filter(item=>item.source==='bundled').length,0);
  assert.equal(listed.entries.filter(item=>item.source==='saved').length,2);
  assert.equal(listed.sources.codex.status,'not_requested');
  await assert.rejects(catalog.detail({id:'builtin:planning-v5'}),{status:404});
  const saved=listed.entries.find(item=>item.id==='saved:'+global.id);
  assert.equal(saved.scope,'global');assert.equal(saved.applicability,'in_scope');assert.equal(saved.loaded,'not_verified');assert.equal(saved.enabled,null);
  assert.equal((await catalog.detail({id:saved.id})).content,global.content);
  assert.equal(listed.entries.find(item=>item.id==='saved:'+local.id).applicability,'other_workspace');
  assert.equal((await catalog.list({cwd:f.other,source:'saved'})).entries.find(item=>item.id==='saved:project-skill').applicability,'in_scope');
  const found=await catalog.list({query:'provenance',source:'saved'});
  assert.equal(found.entries.some(item=>item.id==='saved:global-skill'),true,'content-only search finds saved skills');
});
test('native skills are read-only, exact discovered paths and never marked enabled',async t=>{
  let calls=0;
  const f=await fixture(t,{nativeSkills:async cwd=>{calls++;return {available:true,skills:[{path:path.join(cwd,'skill','SKILL.md'),name:'Native procedure',description:'Discovered by Codex'}],errors:[]};}});
  const folder=path.join(f.cwd,'skill');await mkdir(folder);await writeFile(path.join(folder,'SKILL.md'),'# Native procedure\nDo not execute.');
  const catalog=f.create(),listed=await catalog.list({source:'codex'}),only=listed.entries[0];
  assert.equal(only.source,'codex');assert.equal(only.enabled,false);assert.equal(only.loaded,'not_loaded_in_blackice');assert.equal(only.applicability,'excluded_by_host');
  assert.equal((await catalog.detail({id:only.id})).content,'# Native procedure\nDo not execute.');
  await assert.rejects(catalog.detail({id:'native:'+'a'.repeat(64)}),{status:404});
  assert.ok(calls>=3);
  await assert.rejects(catalog.detail({id:only.id,cwd:'relative/folder'}),{status:400});
});
test('unavailable and malformed native discovery are surfaced, not disguised as zero installed skills',async t=>{
  const f=await fixture(t,{nativeSkills:async()=>({available:false,skills:[],reason:'Disconnected'})}),catalog=f.create();
  const listed=await catalog.list({source:'codex'});
  assert.equal(listed.sources.codex.status,'unavailable');assert.match(listed.sources.codex.reason,/Disconnected/);
  assert.equal((await catalog.list()).entries.length,0,'no built-in skills remain');
  const broken=createSkillsCatalog({knowledge:f.store,defaultCwd:f.cwd,nativeSkills:async()=>({available:true,skills:null})});
  assert.equal((await broken.list({source:'codex'})).sources.codex.status,'error');
  assert.equal((await broken.list({source:'bundled'})).sources.codex.status,'not_requested');
});
test('a saved skill inspection rereads latest revision after concurrent updates without modifying it',async t=>{
  const f=await fixture(t);const first=await f.store.upsert({id:'revision-skill',kind:'skill',title:'Review',content:'initial'});
  const catalog=f.create();const initial=await catalog.detail({id:'saved:revision-skill'});
  assert.equal(initial.revision,1);
  await f.store.upsert({...first,content:'revised',expectedRevision:1});
  const next=await catalog.detail({id:'saved:revision-skill'});
  assert.equal(next.revision,2);assert.equal(next.content,'revised');assert.equal(f.store.get('revision-skill').revision,2);
  await assert.rejects(f.store.upsert({...first,content:'stale',expectedRevision:1}),{status:409});
  assert.equal(f.store.get('revision-skill').content,'revised');
});
test('invalid scope and source arguments fail without altering knowledge',async t=>{
  const f=await fixture(t),catalog=f.create();
  await assert.rejects(catalog.list({source:'imaginary'}),{status:400});
  await assert.rejects(catalog.list({refresh:'yes'}),{status:400});
  await assert.rejects(catalog.list({cwd:'relative'}),{status:400});
  await assert.rejects(catalog.list({query:'x'.repeat(257)}),{status:400});
  await assert.rejects(catalog.detail({id:'saved:not-found'}),{status:404});
  assert.equal(f.store.status().count,0);
});
