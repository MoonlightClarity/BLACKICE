import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,readFile,rm}from'node:fs/promises';import{tmpdir}from'node:os';import path from'node:path';import{SkillFolderStore}from'../lib/skill-folders.mjs';import{readReleaseSkill}from'../lib/release-skills.mjs';
test('skill folder nesting, assignments and revision checks survive reopening without modifying skills',async t=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'skill-folders-')),store=new SkillFolderStore({dataDir});t.after(async()=>{await store.close();await rm(dataDir,{recursive:true,force:true});});const content=readReleaseSkill('builtin-decomposition');
 let s=await store.read();assert.deepEqual(s.folders,[]);
 s=await store.mutate({action:'create',id:'parent',name:'Research',parentId:null,expectedRevision:s.revision});
 s=await store.mutate({action:'create',id:'child',name:'Browser',parentId:'parent',expectedRevision:s.revision});
 s=await store.mutate({action:'assign',skillId:'builtin-decomposition',folderId:'child',expectedRevision:s.revision});
 assert.deepEqual(await new SkillFolderStore({dataDir}).read(),s);assert.deepEqual(readReleaseSkill('builtin-decomposition'),content);
 s=await store.mutate({action:'assign',skillId:'builtin-decomposition',folderId:'category:Documents',expectedRevision:s.revision});
 assert.equal((await new SkillFolderStore({dataDir}).read()).assignments['builtin-decomposition'],'category:Documents');
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

test('deleting a nonempty Skills folder can relocate contents without deleting skill documents',async t=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'skill-folder-preserve-'));
 const store=new SkillFolderStore({dataDir});
 t.after(async()=>{await store.close();await rm(dataDir,{recursive:true,force:true,maxRetries:8,retryDelay:80});});
 let state=await store.read();
 state=await store.mutate({action:'create',id:'parent',name:'Parent',parentId:null,expectedRevision:state.revision});
 state=await store.mutate({action:'create',id:'child',name:'Child',parentId:'parent',expectedRevision:state.revision});
 state=await store.mutate({action:'assign',skillId:'builtin-decomposition',folderId:'parent',expectedRevision:state.revision});
 state=await store.mutate({action:'assign',skillId:'builtin-task-grounding',folderId:'child',expectedRevision:state.revision});
 const old=state.revision;
 await assert.rejects(store.mutate({action:'remove',id:'parent',expectedRevision:state.revision}),{status:409});
 state=await store.mutate({action:'remove',id:'parent',relocateContents:true,expectedRevision:state.revision});
 assert.equal(state.folders.some(folder=>folder.id==='parent'),false);
 assert.equal(state.folders.find(folder=>folder.id==='child').parentId,null);
 assert.equal(state.assignments['builtin-decomposition'],null);
 assert.equal(state.assignments['builtin-task-grounding'],'child');
 await assert.rejects(store.mutate({action:'remove',id:'child',relocateContents:true,expectedRevision:old}),{status:409});
 state=await store.mutate({action:'remove',id:'child',relocateContents:true,expectedRevision:state.revision});
 assert.equal(state.assignments['builtin-task-grounding'],null);
 assert.equal((await new SkillFolderStore({dataDir}).read()).folders.length,0);
 assert.ok(readReleaseSkill('builtin-decomposition').content,'folder deletion does not touch skill data');
});
