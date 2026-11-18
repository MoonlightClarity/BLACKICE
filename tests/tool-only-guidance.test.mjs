import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRetrievalToolHandler} from '../lib/retrieval-tools.mjs';
import {createSkillsCatalog} from '../lib/skills-catalog.mjs';
import {BROWSER_TOOL} from '../lib/browser.mjs';
import {capabilityGuidance} from '../lib/tool-routing.mjs';
test('release skills are on-demand and immutable; legacy user skill mutations are unavailable',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'blackice-tool-guidance-'));
 t.after(async()=>{await rm(dir,{recursive:true,force:true});});
 const invoke=args=>createRetrievalToolHandler({cwd:dir})({name:'relay_skills',arguments:args});
 const decode=r=>JSON.parse(r.contentItems[0].text);
 const entries=decode(await invoke({action:'search'})).entries;
 assert.ok(entries.length>0);assert.ok(entries.every(e=>e.immutable&&e.source==='bundled'));
 const selected=entries[0],read=decode(await invoke({action:'read',id:selected.id}));
 assert.equal(read.entry.id,selected.id);assert.ok(read.entry.content);
 for(const action of ['save','patch','remove'])await assert.rejects(invoke({action,id:selected.id,title:'Altered',content:'Altered'}));
 const catalog=createSkillsCatalog({defaultCwd:dir});
 assert.deepEqual((await catalog.list()).entries,entries);
 assert.equal((await catalog.detail({id:selected.id})).content,read.entry.content);
});
test('browser and job guidance belongs to the browser tool rather than global skill discovery',()=>{
 assert.match(BROWSER_TOOL.description,/native site search/);
 assert.match(BROWSER_TOOL.description,/relevant job boards/);
 assert.match(BROWSER_TOOL.description,/educated inference/);
 assert.doesNotMatch(BROWSER_TOOL.description,/citizenship|builtin:/i);
 const general=capabilityGuidance([{name:'relay_skills'},{name:'relay_browser'}],{planningMode:'off'});
 assert.doesNotMatch(general,/BUNDLED TASK SKILLS|builtin:browser|job boards|BROWSER STATE RECOVERY|relay_browser:/);
});
test('superseded built-in skill files and old loaders remain absent',async()=>{
 for(const relative of ['lib/bundled-task-skills.mjs','lib/planning-skill.mjs','skills/browser/SKILL.md','skills/job-search/SKILL.md','skills/planning/SKILL.md','skills/planning/CONTRACT-V2.md','skills/autonomy/SKILL.md'])
  await assert.rejects(access(new URL('../'+relative,import.meta.url)),{code:'ENOENT'});
});
