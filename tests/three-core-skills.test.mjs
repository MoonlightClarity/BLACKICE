
import test from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createSkillsCatalog} from '../lib/skills-catalog.mjs';
import {readReleaseSkill,searchReleaseSkills} from '../lib/release-skills.mjs';
import {createRetrievalToolHandler} from '../lib/retrieval-tools.mjs';
import {SkillFolderStore} from '../lib/skill-folders.mjs';
const ids=['builtin-decomposition','builtin-task-grounding','builtin-structured-analysis'];
test('only three current release definitions exist; removed defaults are not fallback content',async()=>{
 assert.deepEqual(searchReleaseSkills().map(x=>x.id),ids);
 const hashes=['e0cba61e8cfc4f8953aef1b5fdb21130075ed8dc626b9692920ecd20568d8a8e','5a0f2a99882ff9483f758e37da8ebfa01a9c964f2dea357b8c5d7f333e556576','8615e23de4559575e6f0c9a81086006ae6843e547bd77d587cb981415dac6fd4'];
 assert.deepEqual(ids.map(id=>createHash('sha256').update(readReleaseSkill(id).content).digest('hex')),hashes);
 const catalog=createSkillsCatalog();assert.deepEqual((await catalog.list()).entries.map(x=>x.id),ids);
 for(const id of ['builtin-browser','builtin-browser-tab-management','builtin-file-discovery','builtin-job-search','builtin-inference','builtin-time-management','builtin-feasibility','builtin-branching','builtin-replanning','builtin-metacognition','builtin-verification','builtin-delegation']){
  assert.throws(()=>readReleaseSkill(id),{status:404});await assert.rejects(catalog.detail({id}),{status:404});
 }
});
test('actual saved documents survive removal without retaining bundled definitions or rewriting files',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'three-skills-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const file=path.join(root,'skill-edits','skills.json');await mkdir(path.dirname(file));
 const content='# My own tab procedure\nKeep my chosen final page open.\n';
 const state={version:1,entries:{'builtin-browser-tab-management':{revision:7,content},'my-custom-method':{revision:3,content:'My personal text without a heading'},'builtin-file-discovery':{revision:4,deleted:true},'builtin-browser':{revision:8,deleted:true,content:'# My deleted edited method'}}};
 const bytes=JSON.stringify(state,null,2);await writeFile(file,bytes);
 const catalog=createSkillsCatalog({dataDir:root});t.after(()=>catalog.close());
 assert.equal((await catalog.list()).entries.length,5);assert.equal((await catalog.list({source:'bundled'})).entries.length,3);
 assert.equal((await catalog.detail({id:'builtin-browser-tab-management'})).content,content);assert.equal((await catalog.detail({id:'my-custom-method'})).title,'my custom method');
 assert.deepEqual((await catalog.list({source:'deleted'})).entries.map(x=>x.id),['builtin-browser']);
 await assert.rejects(catalog.detail({id:'builtin-file-discovery'}),{status:404});
 const handler=createRetrievalToolHandler({cwd:root,dataDir:root});const result=JSON.parse((await handler({name:'relay_skills',arguments:{action:'read',id:'builtin-browser-tab-management'}})).contentItems[0].text);
 assert.equal(result.entry.content,content);assert.equal(result.entry.source,'user');assert.equal(await readFile(file,'utf8'),bytes);
 const folders=new SkillFolderStore({dataDir:root});let f=await folders.mutate({action:'create',id:'mine',name:'Mine',expectedRevision:0});f=await folders.mutate({action:'assign',skillId:'my-custom-method',folderId:'mine',expectedRevision:f.revision});assert.equal(f.assignments['my-custom-method'],'mine');
 const edited=await catalog.save({id:'builtin-browser-tab-management',value:{expectedRevision:7,content:content+'Owner change\n'}});assert.equal(edited.revision,8);
 await assert.rejects(catalog.save({id:edited.id,value:{expectedRevision:7,content:'stale'}}),{status:409});
 const deleted=await catalog.delete({id:edited.id,value:{expectedRevision:8}});await catalog.restore({id:edited.id,value:{expectedRevision:deleted.revision}});
 const reopened=createSkillsCatalog({dataDir:root});assert.equal((await reopened.detail({id:edited.id})).content,edited.content);
 const final=JSON.parse(await readFile(file,'utf8'));assert.deepEqual(final.entries['my-custom-method'],state.entries['my-custom-method']);assert.deepEqual(final.entries['builtin-file-discovery'],state.entries['builtin-file-discovery']);
 assert.throws(()=>readReleaseSkill(edited.id),{status:404});await assert.rejects(handler({name:'relay_skills',arguments:{action:'save',id:edited.id}}));
});
test('headingless current edits keep ordinary default titles, not builtin identifiers',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'skill-title-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const catalog=createSkillsCatalog({dataDir:root});await catalog.save({id:'builtin-decomposition',value:{expectedRevision:1,content:'Approved headingless task document'}});
 assert.equal((await catalog.detail({id:'builtin-decomposition'})).title,'Task decomposition');
});

