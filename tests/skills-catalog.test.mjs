import test from 'node:test';
import assert from 'node:assert/strict';
import {createSkillsCatalog,skillIdFromRequestPath} from '../lib/skills-catalog.mjs';
import {searchReleaseSkills,readReleaseSkill} from '../lib/release-skills.mjs';
import {KNOWLEDGE_TOOLS,KNOWLEDGE_INSTRUCTIONS,createKnowledgeToolHandler} from '../lib/knowledge.mjs';
import path from 'node:path';
test('release catalog is read-only, fresh, and ignores all legacy/native inputs',async()=>{
 const catalog=createSkillsCatalog({knowledge:{list(){throw Error('legacy contamination');}},nativeSkills(){throw Error('ambient contamination');}});
 const list=await catalog.list();assert.equal(list.entries.length,13);assert.ok(list.entries.every(e=>e.immutable&&e.source==='bundled'&&!('content' in e)));assert.ok(!list.entries.some(e=>/directory/.test(e.id)));
 list.entries[0].title='poison';assert.notEqual((await catalog.list()).entries[0].title,'poison');
 const detail=await catalog.detail({id:'builtin-browser'});detail.content='poison';assert.notEqual(readReleaseSkill(detail.id).content,'poison');
 await assert.rejects(catalog.detail({id:'saved:legacy'}),{status:404});await assert.rejects(catalog.list({source:'codex'}),{status:400});
 assert.match(readReleaseSkill('builtin-job-search').content,/job boards/);assert.ok(searchReleaseSkills('job').some(e=>e.id==='builtin-job-search'));
});
test('skill IDs are exact identifiers, not paths',()=>{
 assert.equal(skillIdFromRequestPath('/api/skills/builtin-browser'),'builtin-browser');
 for(const value of ['saved%3Aa','native%3Aabc','builtin-..%2Fsecret','builtin-browser/extra','%XX'])assert.equal(skillIdFromRequestPath('/api/skills/'+value),null);
});
test('model sees discovery/read only, no memory, no ambient instructions or persistent selection',async()=>{
 assert.equal(KNOWLEDGE_INSTRUCTIONS,'');assert.ok(!KNOWLEDGE_TOOLS.some(t=>t.name==='relay_memory'));
 const schema=KNOWLEDGE_TOOLS.find(t=>t.name==='relay_skills').inputSchema;assert.deepEqual(schema.properties.action.enum,['search','read']);assert.ok(!schema.properties.content&&!schema.properties.scope);
 const handler=createKnowledgeToolHandler({cwd:path.resolve('.'),store:new Proxy({},{get(){throw Error('legacy store read');}})});
 const invoke=arguments_=>handler({name:'relay_skills',arguments:arguments_});
 const found=JSON.parse((await invoke({action:'search',query:'browser'})).contentItems[0].text);assert.ok(found.entries.some(e=>e.id==='builtin-browser'));assert.ok(!('content' in found.entries[0]));
 const read=JSON.parse((await invoke({action:'read',id:'builtin-browser'})).contentItems[0].text);assert.match(read.entry.content,/When to use/);
 for(const action of ['save','patch','remove','remember'])await assert.rejects(invoke({action,id:'builtin-browser'}));
 await assert.rejects(invoke({action:'read',id:'legacy'}),{status:404});
 await assert.rejects(handler({name:'relay_memory',arguments:{action:'search'}}));
});
