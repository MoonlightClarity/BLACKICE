import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {RETRIEVAL_TOOLS, createRetrievalToolHandler} from '../lib/retrieval-tools.mjs';
import {createSkillLibrary} from '../lib/skill-library.mjs';
import {createSkillsCatalog} from '../lib/skills-catalog.mjs';

const spec = RETRIEVAL_TOOLS.find(tool => tool.name === 'relay_skills');
const decode = result => JSON.parse(result.contentItems[0].text);
const invoke = (handler, args) => handler({name:'relay_skills', arguments:args});

test('Skills publishes closed search/read contracts and the actual returned-ID format', () => {
  assert.deepEqual(spec.inputSchema.properties.action.enum, ['search', 'read']);
  assert.equal(spec.inputSchema.additionalProperties, false);
  const branches = spec.inputSchema.oneOf;
  assert.equal(branches.length, 2);
  const search = branches.find(branch => branch.properties.action.const === 'search');
  const read = branches.find(branch => branch.properties.action.const === 'read');
  assert.equal(search.additionalProperties, false);
  assert.equal(read.additionalProperties, false);
  assert.deepEqual(Object.keys(search.properties).sort(), ['action','limit','offset','query']);
  assert.deepEqual(search.required, ['action']);
  assert.deepEqual(Object.keys(read.properties).sort(), ['action','id']);
  assert.deepEqual(read.required, ['action','id']);
  const pattern = new RegExp(read.properties.id.pattern);
  for (const id of ['builtin-decomposition','library-modular-development','A_b-9']) assert.ok(pattern.test(id));
  for (const id of ['modular development','../secret','saved:legacy','日本語','', 'a'.repeat(101)]) assert.equal(pattern.test(id), false);
  assert.equal(read.properties.id.pattern, spec.inputSchema.properties.id.pattern);
  assert.equal(RETRIEVAL_TOOLS.find(tool => tool.name === 'relay_history').inputSchema.properties.id.pattern, undefined);
});

test('real Skills catalog supports browsing, paging, search and complete Unicode body reads', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-skills-action-contract-'));
  t.after(() => fs.rm(root, {recursive:true, force:true, maxRetries:5, retryDelay:50}));
  const entries = ['alpha','beta','gamma'].map(id => ({
    id:'library-contract-'+id, title:'Contract method '+id, description:'A complete modular method',
    tags:['contractfixture'], source:{kind:'first-party', revision:'contract-1'}, bodyFile:id+'.md',
  }));
  await fs.writeFile(path.join(root, 'index.json'), JSON.stringify({version:1, entries}));
  const fence = String.fromCharCode(96).repeat(3);
  const body = '# Contract method alpha\n\nInspect → write → verify.\n日本語 · café · 🙂\n\n'+fence+'js\nconst value = "résumé";\n'+fence+'\n';
  await fs.writeFile(path.join(root, 'alpha.md'), body);
  const catalog = createSkillsCatalog({library:createSkillLibrary({root}), dataDir:path.join(root,'data')});
  const handler = createRetrievalToolHandler({cwd:root, skillsCatalog:catalog});
  const browse = decode(await invoke(handler, {action:'search'}));
  assert.ok(browse.entries.length > 0);
  const first = decode(await invoke(handler, {action:'search', query:'contractfixture', limit:2, offset:0}));
  assert.equal(first.entries.length, 2); assert.equal(first.totalMatches, 3); assert.equal(first.nextOffset, 2);
  assert.ok(first.entries.every(entry => !Object.hasOwn(entry,'content')));
  const next = decode(await invoke(handler, {action:'search', query:'contractfixture', limit:2, offset:first.nextOffset}));
  assert.equal(next.entries.length, 1); assert.equal(next.nextOffset, null);
  assert.equal(new Set([...first.entries,...next.entries].map(entry => entry.id)).size, 3);
  const found = decode(await invoke(handler, {action:'search', query:'Contract method alpha'}));
  assert.equal(found.entries[0].id, 'library-contract-alpha');
  const read = decode(await invoke(handler, {action:'read', id:found.entries[0].id}));
  assert.equal(read.entry.content, body);
  await assert.rejects(invoke(handler, {action:'read', id:'library-contract-absent'}), error => error.status === 404 && error.code === 'SKILL_NOT_FOUND');
});

const invalidCalls = [
  ['search with a well-formed but irrelevant id', {action:'search', id:'library-modular-development'}, /does not accept.*id/],
  ['actual failed model search shape', {action:'search', id:'modular development', query:'modular development', limit:5}, /does not accept.*id/],
  ['read with a query', {action:'read', id:'builtin-decomposition', query:'text'}, /does not accept.*query/],
  ['read with a limit', {action:'read', id:'builtin-decomposition', limit:1}, /does not accept.*limit/],
  ['read with a search page', {action:'read', id:'builtin-decomposition', offset:0}, /does not accept.*offset/],
  ['read without its returned identifier', {action:'read'}, /requires.*id/],
  ['read with a path', {action:'read', id:'../secret'}, /Invalid retrieval entry ID/],
  ['read with an unreturned phrase', {action:'read', id:'modular development'}, /Invalid retrieval entry ID/],
  ['read with a null identifier', {action:'read', id:null}, /Invalid retrieval entry ID/],
  ['read with an empty identifier', {action:'read', id:''}, /Invalid retrieval entry ID/],
  ['search with null query', {action:'search', query:null}, /Search query must be/],
  ['search with an oversized query', {action:'search', query:'x'.repeat(257)}, /Search query must be/],
  ['search with an out-of-range limit', {action:'search', limit:51}, /Limit must be/],
  ['search with a negative page', {action:'search', offset:-1}, /offset/],
  ['search with a fractional page', {action:'search', offset:1.5}, /offset/],
  ['unknown action', {action:'save', id:'builtin-decomposition'}, /Unknown knowledge action/],
];
for (const [name, args, expected] of invalidCalls) test('Skills rejects '+name+' before catalog dispatch', async () => {
  let calls = 0;
  const forbidden = () => { calls++; throw new Error('Catalog must not be called'); };
  const handler = createRetrievalToolHandler({cwd:process.cwd(), skillsCatalog:{list:forbidden, detail:forbidden}});
  await assert.rejects(invoke(handler,args), error => error.status === 400 && expected.test(error.message));
  assert.equal(calls, 0);
});
