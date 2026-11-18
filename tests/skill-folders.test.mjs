import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,readFile,rm}from'node:fs/promises';import{tmpdir}from'node:os';import path from'node:path';import{SkillFolderStore}from'../lib/skill-folders.mjs';import{readReleaseSkill}from'../lib/release-skills.mjs';
test('skill folder nesting, assignments and revision checks survive reopening without modifying skills',async t=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'skill-folders-')),store=new SkillFolderStore({dataDir});t.after(async()=>{await store.close();await rm(dataDir,{recursive:true,force:true});});const content=readReleaseSkill('builtin-decomposition');
 let s=await store.read();assert.deepEqual(s.folders,[]);
 s=await store.mutate({action:'create',id:'parent',name:'Research',parentId:null,expectedRevision:s.revision});
 s=await store.mutate({action:'create',id:'child',name:'Browser',parentId:'parent',expectedRevision:s.revision});
 s=await store.mutate({action:'assign',skillId:'builtin-decomposition',folderId:'child',expectedRevision:s.revision});
 assert.deepEqual(await new SkillFolderStore({dataDir}).read(),s);assert.deepEqual(readReleaseSkill('builtin-decomposition'),content);
 const before=await readFile(store.file,'utf8');
 for(const value of [{action:'update',id:'parent',parentId:'child'},{action:'remove',id:'parent'},{action:'assign',skillId:'made-up',folderId:'child'},{action:'create',id:'other',name:'Browser',parentId:'parent'},{action:'create',id:'bad',name:'',parentId:null}])await assert.rejects(store.mutate({...value,expectedRevision:s.revision}));
 await assert.rejects(store.mutate({action:'update',id:'child',name:'Stale',expectedRevision:0}),e=>e.status===409);
 assert.equal(await readFile(store.file,'utf8'),before);
 s=await store.mutate({action:'assign',skillId:'builtin-decomposition',folderId:null,expectedRevision:s.revision});s=await store.mutate({action:'update',id:'child',name:'Web',parentId:null,expectedRevision:s.revision});s=await store.mutate({action:'remove',id:'parent',expectedRevision:s.revision});assert.equal(s.folders.length,1);
});
test('concurrent store writers cannot lose an edit',async t=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'skill-folder-race-')),a=new SkillFolderStore({dataDir}),b=new SkillFolderStore({dataDir});t.after(async()=>{await Promise.all([a.close(),b.close()]);await rm(dataDir,{recursive:true,force:true});});
 const outcomes=await Promise.allSettled([a.mutate({action:'create',id:'a',name:'A',parentId:null,expectedRevision:0}),b.mutate({action:'create',id:'b',name:'B',parentId:null,expectedRevision:0})]);assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal((await a.read()).folders.length,1);
});
