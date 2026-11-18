import test from 'node:test';
import assert from 'node:assert/strict';
import {createSkillsCatalog,skillIdFromRequestPath} from '../lib/skills-catalog.mjs';
import {searchReleaseSkills,readReleaseSkill} from '../lib/release-skills.mjs';
import {RETRIEVAL_TOOLS,createRetrievalToolHandler} from '../lib/retrieval-tools.mjs';
import path from 'node:path';
test('release catalog is read-only, fresh, and ignores all legacy/native inputs',async()=>{
 const catalog=createSkillsCatalog({knowledge:{list(){throw Error('legacy contamination');}},nativeSkills(){throw Error('ambient contamination');}});
 const list=await catalog.list();assert.equal(list.entries.length,3);assert.ok(list.entries.every(e=>e.immutable&&e.source==='bundled'&&!('content' in e)));assert.ok(!list.entries.some(e=>/directory/.test(e.id)));
 list.entries[0].title='poison';assert.notEqual((await catalog.list()).entries[0].title,'poison');
 const detail=await catalog.detail({id:'builtin-decomposition'});detail.content='poison';assert.notEqual(readReleaseSkill(detail.id).content,'poison');
 await assert.rejects(catalog.detail({id:'saved:legacy'}),{status:404});await assert.rejects(catalog.list({source:'codex'}),{status:400});
 assert.match(readReleaseSkill('builtin-structured-analysis').content,/Advisory use/);assert.ok(searchReleaseSkills('analytic').some(e=>e.id==='builtin-structured-analysis'));
});
test('skill IDs are exact identifiers, not paths',()=>{
 assert.equal(skillIdFromRequestPath('/api/skills/builtin-decomposition'),'builtin-decomposition');
 for(const value of ['saved%3Aa','native%3Aabc','builtin-..%2Fsecret','builtin-decomposition/extra','%XX'])assert.equal(skillIdFromRequestPath('/api/skills/'+value),null);
});
test('model sees discovery/read only, no memory, no ambient instructions or persistent selection',async()=>{
 assert.ok(!RETRIEVAL_TOOLS.some(t=>t.name==='relay_memory'));
 const schema=RETRIEVAL_TOOLS.find(t=>t.name==='relay_skills').inputSchema;assert.deepEqual(schema.properties.action.enum,['search','read']);assert.ok(!schema.properties.content&&!schema.properties.scope);
 const handler=createRetrievalToolHandler({cwd:path.resolve('.'),store:new Proxy({},{get(){throw Error('legacy store read');}})});
 const invoke=arguments_=>handler({name:'relay_skills',arguments:arguments_});
 const all=JSON.parse((await invoke({action:'search'})).contentItems[0].text);assert.equal(all.entries.length,3);assert.equal(all.truncated,false);
 const found=JSON.parse((await invoke({action:'search',query:'dependent'})).contentItems[0].text);assert.ok(found.entries.some(e=>e.id==='builtin-decomposition'));assert.ok(!('content' in found.entries[0]));
 const read=JSON.parse((await invoke({action:'read',id:'builtin-decomposition'})).contentItems[0].text);assert.match(read.entry.content,/When to use/);
 for(const action of ['save','patch','remove','remember'])await assert.rejects(invoke({action,id:'builtin-decomposition'}));
 await assert.rejects(invoke({action:'read',id:'legacy'}),{status:404});
 await assert.rejects(handler({name:'relay_memory',arguments:{action:'search'}}));
});
