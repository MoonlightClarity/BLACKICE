import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRetrievalToolHandler} from '../lib/retrieval-tools.mjs';
import {createSkillsCatalog} from '../lib/skills-catalog.mjs';
import {BROWSER_TOOL} from '../lib/browser.mjs';
import {capabilityGuidance} from '../lib/tool-routing.mjs';
test('the model browses the paginated effective skill catalog and cannot mutate it',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'blackice-tool-guidance-'));
 t.after(async()=>{await rm(dir,{recursive:true,force:true});});
 const catalog=createSkillsCatalog({dataDir:dir});
 t.after(()=>catalog.close());
 const invoke=args=>createRetrievalToolHandler({cwd:dir,dataDir:dir})({name:'relay_skills',arguments:args});
 const decode=r=>JSON.parse(r.contentItems[0].text);
 const bundled=(await catalog.list()).entries;
 assert.ok(bundled.length>12,'Catalog exceeds one default model search page.');
 assert.ok(bundled.every(e=>e.immutable&&e.source==='bundled'));
 const selected=bundled[0],ownerText=['# Owner-approved fixture','','Owner-only change.'].join('\n');
 const edited=await catalog.save({id:selected.id,value:{expectedRevision:selected.revision,content:ownerText}});
 const effective=(await catalog.list()).entries;
 const entries=[];let offset=0;
 while(offset!==null){
  const page=decode(await invoke({action:'search',offset}));
  assert.equal(page.totalMatches,effective.length);
  assert.ok(page.entries.length>0&&page.entries.length<=12);
  assert.ok(page.nextOffset===null||page.nextOffset===offset+page.entries.length);
  assert.ok(page.entries.every(e=>e.immutable&&!Object.hasOwn(e,'content')));
  entries.push(...page.entries);offset=page.nextOffset;
 }
 assert.deepEqual(entries,effective,'All model metadata pages match the effective human catalog.');
 assert.ok(entries.some(e=>e.id==='library-what-makes-done'),'Automatic prompt submission is separate from catalog metadata.');
 const read=decode(await invoke({action:'read',id:selected.id}));
 assert.equal(read.entry.id,selected.id);
 assert.equal(read.entry.content,ownerText);assert.equal(read.entry.source,'user');
 for(const action of ['save','patch','remove'])await assert.rejects(invoke({action,id:selected.id,title:'Altered',content:'Altered'}));
 assert.deepEqual(await catalog.detail({id:selected.id}),edited);
});
test('browser API documentation omits task-specific advice and recovery routing is limited to attached browser tools',()=>{
 assert.doesNotMatch(BROWSER_TOOL.description,/native site search|relevant job boards|educated inference/);
 assert.match(BROWSER_TOOL.description,/expectedUrl(?:,| and) expectedDocumentId/);
 assert.match(BROWSER_TOOL.description,/BROWSER_INPUT_DOCUMENT_CHANGED with actionDispatched:false/);
 assert.match(BROWSER_TOOL.description,/foreign ownershipCandidates are not readable/);
 assert.doesNotMatch(BROWSER_TOOL.description,/citizenship|builtin:/i);
 const general=capabilityGuidance([{name:'relay_skills'},BROWSER_TOOL],{planningMode:'off'});
 assert.doesNotMatch(general,/BUNDLED TASK SKILLS|builtin:browser|job boards|BROWSER STATE RECOVERY/);
 assert.match(general,/relay_browser:.*empty task-owned tabs list is not sign-out/);
 assert.match(general,/tabs query:"stopped-task-recovery"/);
 assert.match(general,/ownerKey as expectedOwnerKey/);
 assert.match(general,/url as expectedUrl/);
 assert.match(general,/documentId as expectedDocumentId to take_ownership/);
 const namesOnly=capabilityGuidance([{name:'relay_browser'}],{planningMode:'off'});
 assert.doesNotMatch(namesOnly,/stopped-task-recovery|take_ownership/,'Recovery guidance requires the operation in the actual attached schema.');
 const withoutBrowser=capabilityGuidance([{name:'relay_skills'}],{planningMode:'off'});
 assert.doesNotMatch(withoutBrowser,/relay_browser|stopped-task-recovery|job boards/);
});
test('superseded built-in skill files and old loaders remain absent',async()=>{
 for(const relative of ['lib/bundled-task-skills.mjs','lib/planning-skill.mjs','skills/browser/SKILL.md','skills/job-search/SKILL.md','skills/planning/SKILL.md','skills/planning/CONTRACT-V2.md','skills/autonomy/SKILL.md'])
  await assert.rejects(access(new URL('../'+relative,import.meta.url)),{code:'ENOENT'});
});
