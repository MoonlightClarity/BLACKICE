import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {KnowledgeStore,createKnowledgeToolHandler} from '../lib/knowledge.mjs';
import {createSkillsCatalog} from '../lib/skills-catalog.mjs';
import {BUNDLED_TASK_SKILLS,BUNDLED_TASK_SKILL_GUIDANCE} from '../lib/bundled-task-skills.mjs';
import {capabilityGuidance} from '../lib/tool-routing.mjs';
const decode=r=>JSON.parse(r.contentItems[0].text);
test('two distinct bundled procedures are discoverable, readable and immutable through actual tools',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'blackice-task-skills-'));
 const store=await new KnowledgeStore({dataDir:dir}).init();
 t.after(async()=>{await store.writeChain.catch(()=>{});await rm(dir,{recursive:true,force:true});});
 const handle=createKnowledgeToolHandler({store,cwd:dir});
 const invoke=args=>handle({name:'relay_skills',arguments:args});
 for(const skill of BUNDLED_TASK_SKILLS){
  const search=decode(await invoke({action:'search',query:skill.title}));
  assert.ok(search.entries.some(item=>item.id===skill.id));assert.ok(search.entries.every(item=>!item.content));
  const entry=decode(await invoke({action:'read',id:skill.id})).entry;
  assert.equal(entry.content,skill.content);assert.equal(entry.readOnly,true);assert.equal(entry.sha256,skill.sha256);
  for(const action of ['save','patch','remove'])await assert.rejects(invoke({action,id:skill.id}),/read-only/);
 }
 assert.equal(store.status().count,0);
 await assert.rejects(invoke({action:'read',id:'builtin:../../secret'}),/Invalid/);
 const saved=decode(await invoke({action:'save',title:'User procedure',content:'Useful method'})).entry;
 assert.equal(decode(await invoke({action:'read',id:saved.id})).entry.content,'Useful method');
 assert.ok(decode(await invoke({action:'search',query:'User procedure'})).entries.some(item=>item.id===saved.id));
 const limited=decode(await invoke({action:'search',limit:1}));assert.equal(limited.entries.length,1);assert.equal(limited.truncated,true);
 const catalog=createSkillsCatalog({knowledge:store,defaultCwd:dir});
 for(const skill of BUNDLED_TASK_SKILLS){
  const detail=await catalog.detail({id:skill.id});assert.equal(detail.loaded,'available_on_demand');assert.equal(detail.content,skill.content);
 }
});
test('routing provides exact read IDs only with an attached skills tool and preserves planning off',()=>{
 const instructions=capabilityGuidance([{name:'relay_skills'},{name:'relay_browser'}],{planningMode:'off'});
 assert.ok(instructions.includes(BUNDLED_TASK_SKILL_GUIDANCE));assert.match(instructions,/Automatic planning is off/);
 assert.ok(!capabilityGuidance([{name:'relay_browser'}]).includes(BUNDLED_TASK_SKILL_GUIDANCE));
});
test('separate skill contents cover native sourcing, direct employer route and meaningful alternatives',()=>{
 const browser=BUNDLED_TASK_SKILLS.find(x=>x.id==='builtin:browser').content;
 const jobs=BUNDLED_TASK_SKILLS.find(x=>x.id==='builtin:job-search').content;
 assert.match(browser,/site's own search/);assert.match(browser,/document-changed/);assert.match(browser,/uncertain submissions/);
 assert.match(jobs,/start with relevant job boards/);assert.match(jobs,/employer's current posting/);assert.match(jobs,/General web search is a supplement/);
 assert.match(jobs,/prior submissions/);assert.match(jobs,/deadline/);
});
test('both new skills are included in packaging and source/build identity inventories',async()=>{
 const build=await readFile(new URL('../desktop/electron-builder.yml',import.meta.url),'utf8');
 for(const folder of ['browser','job-search']){
  assert.ok(build.includes('skills/'+folder+'/**/*'));
  for(const file of ['release-check.mjs','release-request.mjs','windows-release-inputs.mjs']){
   assert.ok((await readFile(new URL('../scripts/'+file,import.meta.url),'utf8')).includes('skills/'+folder+'/SKILL.md'));
  }
 }
});
