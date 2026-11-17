import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {KnowledgeStore,createKnowledgeToolHandler} from '../lib/knowledge.mjs';
import {createSkillsCatalog} from '../lib/skills-catalog.mjs';
import {BROWSER_TOOL} from '../lib/browser.mjs';
import {capabilityGuidance} from '../lib/tool-routing.mjs';
test('built-in skills are absent while saved skill search, read, update and removal remain available',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'blackice-tool-guidance-'));
 const store=await new KnowledgeStore({dataDir:dir}).init();
 t.after(async()=>{await store.writeChain.catch(()=>{});await rm(dir,{recursive:true,force:true});});
 const invoke=args=>createKnowledgeToolHandler({store,cwd:dir})({name:'relay_skills',arguments:args});
 const decode=r=>JSON.parse(r.contentItems[0].text);
 assert.deepEqual(decode(await invoke({action:'search'})).entries,[]);
 for(const id of ['builtin:browser','builtin:job-search','builtin:planning-v4','builtin:planning-v5','builtin:autonomy'])
  await assert.rejects(invoke({action:'read',id}));
 const approve=async response=>{const result=decode(response);assert.equal(result.pendingApproval,true);return (await store.decideApproval(result.approvalId,{decision:'approve'})).entry;};
 const saved=await approve(await invoke({action:'save',title:'User procedure',content:'Original method'}));
 assert.equal(decode(await invoke({action:'read',id:saved.id})).entry.content,'Original method');
 await approve(await invoke({action:'patch',id:saved.id,oldText:'Original',newText:'Updated',expectedRevision:saved.revision}));
 assert.equal(decode(await invoke({action:'search',query:'Updated'})).entries.length,1);
 const catalog=createSkillsCatalog({knowledge:store,defaultCwd:dir});
 assert.equal((await catalog.list()).entries.length,1);
 assert.equal((await catalog.list({source:'bundled'})).entries.length,0);
 assert.equal((await catalog.detail({id:'saved:'+saved.id})).content,'Updated method');
 await approve(await invoke({action:'remove',id:saved.id}));
 assert.equal(store.status().count,0);
});
test('browser and job guidance belongs to the browser tool rather than global skill discovery',()=>{
 assert.match(BROWSER_TOOL.description,/native site search/);
 assert.match(BROWSER_TOOL.description,/relevant job boards/);
 assert.match(BROWSER_TOOL.description,/educated inference/);
 assert.doesNotMatch(BROWSER_TOOL.description,/citizenship|builtin:/i);
 const general=capabilityGuidance([{name:'relay_skills'},{name:'relay_browser'}],{planningMode:'off'});
 assert.doesNotMatch(general,/BUNDLED TASK SKILLS|builtin:browser|job boards|BROWSER STATE RECOVERY|relay_browser:/);
});
test('no packaged built-in skill files or loaders remain',async()=>{
 for(const relative of ['lib/bundled-task-skills.mjs','lib/planning-skill.mjs','skills/browser/SKILL.md','skills/job-search/SKILL.md','skills/planning/SKILL.md','skills/planning/CONTRACT-V2.md','skills/autonomy/SKILL.md'])
  await assert.rejects(access(new URL('../'+relative,import.meta.url)),{code:'ENOENT'});
});
