import test from 'node:test';
import assert from 'node:assert/strict';
import * as io from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PromptTemplateStore, PROMPT_TEMPLATE_FORMAT, createPromptToolHandler, PROMPT_TOOL } from '../lib/prompt-templates.mjs';

const template = (title = 'Reusable test prompt') => ({ title, description: 'A custom reusable outline.', sections: [{ id: 'goal', title: 'Goal', content: '{{task}}', level: 0 }, { id: 'method', title: 'Method', content: 'Verify the actual outcome. {{notes}}', level: 0 }] });
async function fixture(t, options = {}) { const directory = await io.mkdtemp(path.join(tmpdir(), 'relay-prompt-store-')); const store = await new PromptTemplateStore({ dataDir: directory, ...options }).init(); t.after(async () => { await store.close(); assert.match(path.basename(directory), /^relay-prompt-store-/); await io.rm(directory, { recursive: true, force: true }); }); return { directory, store }; }
const unpack = result => JSON.parse(result.contentItems.map(item => item.text).join('\n'));

test('prompt library starts with immutable built-ins without writing a new profile file', async t => {
  const { directory, store } = await fixture(t);
  assert.equal(store.list().length, 6); assert.equal(store.status().count, 0); assert.equal(store.status().healthy, true);
  assert.deepEqual(await io.readdir(directory), []);
  const builtin = store.get('builtin_task'); builtin.sections[0].content = 'changed'; assert.equal(store.get('builtin_task').sections[0].content, '{{task}}');
  assert.throws(() => store.save({ ...template(), id: 'builtin_task' }), /read-only/);
  assert.throws(() => store.remove('builtin_task', { expectedRevision: 1 }), /read-only/);
  assert.throws(() => store.restore('builtin_task', { expectedRevision: 1 }), /read-only/);
});

test('custom prompts persist exact sections and complete revision history through restart', async t => {
  const { directory, store } = await fixture(t); const created = await store.save(template());
  const updated = await store.save({ ...created, title: 'Updated outline' }, { expectedRevision: 1, provenance: { source: 'agent', runId: 'run-1', nodeId: 'agent' } });
  assert.equal(updated.revision, 2); assert.equal(updated.provenance.runId, 'run-1'); assert.deepEqual(updated.sections, created.sections);
  await store.close(); const restored = await new PromptTemplateStore({ dataDir: directory }).init(); t.after(() => restored.close());
  assert.equal(restored.get(created.id).title, 'Updated outline');
  assert.deepEqual(restored.history(created.id).history.map(item => item.revision), [2, 1]);
  assert.equal(restored.history(created.id).history[1].action, 'create');
  assert.deepEqual(restored.list({ query: 'updated' }).map(item => item.id), [created.id]);
  assert.ok(restored.list()[6].fields.some(field => field.key === 'task' && field.required)); assert.equal(Object.hasOwn(restored.list()[6], 'sections'), false);
});

test('concurrent prompt edits require the current revision and cannot silently overwrite each other', async t => {
  const { store } = await fixture(t), created = await store.save(template());
  const changes = await Promise.allSettled([store.save({ ...created, title: 'First edit' }, { expectedRevision: 1 }), store.save({ ...created, title: 'Second edit' }, { expectedRevision: 1 })]);
  assert.equal(changes.filter(item => item.status === 'fulfilled').length, 1); assert.equal(changes.find(item => item.status === 'rejected').reason.status, 409);
  assert.equal(store.get(created.id).title, 'First edit'); assert.equal(store.history(created.id).history.length, 2);
  await assert.rejects(store.save({ ...created, title: 'Missing revision' }), /expectedRevision/);
});

test('independent prompt store instances merge separate writes and reject a stale same-prompt edit', async t => {
  const { directory, store } = await fixture(t), second = await new PromptTemplateStore({ dataDir: directory }).init(); t.after(() => second.close());
  const [firstPrompt, secondPrompt] = await Promise.all([store.save(template('First prompt')), second.save(template('Second prompt'))]);
  const latest = await new PromptTemplateStore({ dataDir: directory }).init(); t.after(() => latest.close()); assert.equal(latest.status().count, 2);
  await second.save({ ...firstPrompt, title: 'Latest first prompt' }, { expectedRevision: 1 });
  await assert.rejects(store.save({ ...firstPrompt, title: 'Stale first prompt' }, { expectedRevision: 1 }), error => error.status === 409);
  assert.equal(store.get(firstPrompt.id).revision, 2); assert.equal(store.list().find(item => item.id === firstPrompt.id).title, 'Latest first prompt'); assert.equal(store.render({ id: firstPrompt.id, values: { task: 'Current committed text' } }).template.revision, 2);
  assert.equal(second.get(secondPrompt.id).title, 'Second prompt');
});

test('deleting a prompt is auditable and Undo restores it as a new revision', async t => {
  const { store } = await fixture(t), created = await store.save(template());
  const removed = await store.remove(created.id, { expectedRevision: 1 }); assert.equal(removed.revision, 2); assert.equal(removed.deleted, true);
  assert.throws(() => store.get(created.id), error => error.status === 404); assert.equal(store.status().deleted, 1); assert.equal(store.list().length, 6); assert.equal(store.list({ includeDeleted: true }).length, 7);
  await assert.rejects(store.restore(created.id, { expectedRevision: 1 }), error => error.status === 409);
  const restored = await store.restore(created.id, { expectedRevision: 2 }); assert.equal(restored.revision, 3); assert.equal(restored.deleted, false); assert.deepEqual(restored.sections, created.sections);
  const edited = await store.save({ ...restored, title: 'Later edit' }, { expectedRevision: 3 });
  const prior = await store.restore(created.id, { expectedRevision: edited.revision, revision: 1 }); assert.equal(prior.title, created.title); assert.equal(prior.revision, 5); assert.equal(prior.restoredFromRevision, 1);
  assert.deepEqual(store.history(created.id).history.map(item => item.action), ['restore', 'update', 'restore', 'delete', 'create']);
});

test('portable prompt JSON excludes IDs and provenance and imports into a fresh custom ID', async t => {
  const { store } = await fixture(t), created = await store.save(template()), document = store.export(created.id);
  assert.equal(document.format, PROMPT_TEMPLATE_FORMAT); assert.equal(document.version, 1); assert.deepEqual(Object.keys(document.template).sort(), ['description', 'sections', 'title']);
  const imported = await store.import(JSON.stringify(document)); assert.notEqual(imported.id, created.id); assert.equal(imported.action, 'import'); assert.deepEqual(imported.sections, created.sections);
  const builtinCopy = await store.import(store.export('builtin_build')); assert.equal(builtinCopy.builtin, false); assert.match(builtinCopy.id, /^prompt_/);
  for (const value of [{ ...document, version: 2 }, { ...document, execute: 'dangerous' }, { ...document, template: { ...document.template, include: 'C:\\secret' } }, { ...document, template: { ...document.template, revision: 7 } }, '{{notJSON}}']) assert.throws(() => store.import(value));
});

test('prompt render receipts hash exact literal output and never change the library', async t => {
  const { directory, store } = await fixture(t); const before = await io.readdir(directory), rendered = store.render({ id: 'builtin_task', values: { task: 'Literal {{context}} $&' } });
  assert.equal(rendered.sha256, createHash('sha256').update(rendered.text).digest('hex')); assert.match(rendered.text, /Literal \{\{context\}\} \$&/); assert.deepEqual(await io.readdir(directory), before);
  assert.throws(() => store.render({ id: 'builtin_task', template: template(), values: { task: 'two sources' } }), /either/);
  assert.throws(() => store.render(null), /Choose a saved/); assert.throws(() => store.render({ id: 'builtin_task', values: { task: 'x' }, include: 'file' }), /Choose a saved/);
});

test('prompt disk failures preserve the prior committed value and report unhealthy until a successful save', async t => {
  let failRename = false; const injected = { ...io, rename: async (from, to) => { if (failRename && to.endsWith('prompt-templates.json')) throw Object.assign(new Error('Fixture disk full'), { code: 'ENOSPC' }); return io.rename(from, to); } };
  const { directory, store } = await fixture(t, { io: injected }), created = await store.save(template()), before = await io.readFile(store.file, 'utf8'); failRename = true;
  await assert.rejects(store.save({ ...created, title: 'Uncommitted' }, { expectedRevision: 1 }), /Fixture disk full/);
  assert.equal(store.get(created.id).title, created.title); assert.equal(await io.readFile(store.file, 'utf8'), before); assert.equal(store.status().healthy, false);
  assert.ok((await io.readdir(directory)).every(name => !name.endsWith('.tmp')));
  failRename = false; const saved = await store.save({ ...created, title: 'Saved later' }, { expectedRevision: 1 }); assert.equal(saved.revision, 2); assert.equal(store.status().healthy, true);
});

test('a failed prompt write after another writer commits keeps the refreshed external revision visible', async t => {
  let failRename = false; const injected = { ...io, rename: async (from, to) => { if (failRename && to.endsWith('prompt-templates.json')) throw Object.assign(new Error('Fixture storage failure'), { code: 'ENOSPC' }); return io.rename(from, to); } };
  const { directory, store } = await fixture(t, { io: injected }), first = await store.save(template()), other = await new PromptTemplateStore({ dataDir: directory }).init(); t.after(() => other.close());
  const external = await other.save({ ...first, title: 'Externally committed revision' }, { expectedRevision: 1 }); failRename = true;
  await assert.rejects(store.save({ ...external, title: 'Uncommitted local draft' }, { expectedRevision: 2 }), /Fixture storage failure/);
  assert.equal(store.get(first.id).title, external.title); assert.equal(store.get(first.id).revision, 2); assert.equal(store.history(first.id).history.length, 2); assert.equal(JSON.parse(await io.readFile(store.file, 'utf8')).entries[0].title, external.title);
  failRename = false; await store.save({ ...external, title: 'Successful later edit' }, { expectedRevision: 2 });
});

test('a transient prompt unlock error is retried without losing the committed save receipt', async t => {
  let failures = 0; const injected = { ...io, rename: async (from, to) => { const result = await io.rename(from, to); if (to.endsWith('prompt-templates.json')) failures = 1; return result; }, readFile: async (file, ...args) => { if (file.endsWith('owner.json') && failures-- > 0) throw Object.assign(new Error('Transient owner read failure'), { code: 'EACCES' }); return io.readFile(file, ...args); } };
  const { directory, store } = await fixture(t, { io: injected }), saved = await store.save(template());
  assert.equal(saved.revision, 1); assert.equal(store.get(saved.id).title, saved.title); assert.equal(store.status().healthy, true); assert.ok(!(await io.readdir(directory)).includes('prompt-templates.json.lock'));
});

test('persistent prompt unlock errors preserve successful receipts and make subsequent writes read-only', async t => {
  let failUnlock = false; const injected = { ...io, rename: async (from, to) => { const result = await io.rename(from, to); if (to.endsWith('prompt-templates.json')) failUnlock = true; return result; }, readFile: async (file, ...args) => { if (file.endsWith('owner.json') && failUnlock) throw Object.assign(new Error('Persistent owner read failure'), { code: 'EACCES' }); return io.readFile(file, ...args); } };
  const { store } = await fixture(t, { io: injected }), saved = await store.save(template());
  assert.equal(saved.revision, 1); assert.equal(store.get(saved.id).title, saved.title); assert.equal(JSON.parse(await io.readFile(store.file, 'utf8')).entries[0].revision, 1); assert.equal(store.status().healthy, false); assert.equal(store.status().recoveryRequired, true); assert.match(store.status().error, /receipts remain valid/);
  await assert.rejects(store.save({ ...saved, title: 'Blocked later edit' }, { expectedRevision: 1 }), error => error.status === 503);
});

test('unrecoverable prompt corruption preserves both files, keeps built-ins, and blocks custom writes', async t => {
  const { directory, store } = await fixture(t); await store.close(); await io.writeFile(store.file, '{bad-primary'); await io.writeFile(`${store.file}.bak`, '{bad-backup');
  const degraded = await new PromptTemplateStore({ dataDir: directory }).init(); t.after(() => degraded.close()); assert.equal(degraded.status().healthy, false); assert.equal(degraded.status().recoveryRequired, true); assert.match(degraded.status().error, /Existing files were preserved/);
  assert.equal(degraded.list().length, 6); assert.match(degraded.render({ id: 'builtin_task', values: { task: 'Ordinary work remains possible' } }).text, /Ordinary work remains possible/); await assert.rejects(degraded.save(template()), error => error.status === 503); assert.throws(() => degraded.get('prompt_missing'), error => error.status === 503);
  assert.equal(await io.readFile(store.file, 'utf8'), '{bad-primary'); assert.equal(await io.readFile(`${store.file}.bak`, 'utf8'), '{bad-backup');
});

test('valid prompt backups recover corrupt primary files without discarding forensic evidence', async t => {
  const { directory, store } = await fixture(t), first = await store.save(template()); await store.save({ ...first, title: 'Second revision' }, { expectedRevision: 1 }); await store.close(); await io.writeFile(store.file, '{corrupt-primary');
  const recovered = await new PromptTemplateStore({ dataDir: directory }).init(); t.after(() => recovered.close());
  assert.equal(recovered.status().recovered, true); assert.equal(recovered.get(first.id).title, first.title); const files = await io.readdir(directory); assert.ok(files.some(name => name.startsWith('prompt-templates.json.corrupt-')));
  assert.equal((await recovered.save({ ...recovered.get(first.id), title: 'Repaired' }, { expectedRevision: 1 })).revision, 2);
});

test('prompt files removed after load cannot silently replace the saved library', async t => {
  const { store } = await fixture(t), created = await store.save(template()); await io.rm(store.file);
  await assert.rejects(store.save({ ...created, title: 'Overwrite vanished file' }, { expectedRevision: 1 }), /Existing files were preserved/);
  assert.equal(store.get(created.id).title, created.title); assert.equal(store.status().healthy, false);
});

test('stopped prompt mutations cannot commit and accepted writes drain before close', async t => {
  const { store } = await fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(store.save(template(), { signal: controller.signal }), error => error.name === 'AbortError'); assert.equal(store.status().count, 0);
  const first = store.save(template('Admitted before close')), second = store.save(template('Also admitted')); const closing = store.close();
  const saved = await Promise.all([first, second]); await closing; assert.equal(saved.length, 2); assert.equal(store.status().count, 2);
  await assert.rejects(store.save(template('Too late')), /closing/);
});

test('agent prompt tools save render audit and restore with actual run provenance and no task execution', async t => {
  const { store } = await fixture(t), events = [], handler = createPromptToolHandler({ store, runId: 'run-123', nodeId: 'writer', onEvent: event => events.push(event) });
  const call = async (argumentsValue, success = true) => { const result = await handler({ name: PROMPT_TOOL.name, arguments: argumentsValue }); assert.equal(result.success, success, JSON.stringify(unpack(result))); return unpack(result); };
  const catalog = await call({ action: 'list' }); assert.equal(catalog.templates.length, 6);
  const saved = (await call({ action: 'save', template: template('Made in chat') })).template; assert.equal(saved.provenance.runId, 'run-123'); assert.equal(saved.provenance.nodeId, 'writer'); assert.equal(saved.provenance.source, 'agent');
  const rendered = await call({ action: 'render', id: saved.id, values: { task: 'A real literal draft' } }); assert.match(rendered.text, /A real literal draft/);
  await call({ action: 'delete', id: saved.id, expectedRevision: 0 }, false); const removed = (await call({ action: 'delete', id: saved.id, expectedRevision: 1 })).template;
  const restored = (await call({ action: 'restore', id: saved.id, expectedRevision: removed.revision })).template; assert.equal(restored.revision, 3);
  assert.equal((await call({ action: 'history', id: saved.id })).history.length, 3); assert.equal((await call({ action: 'read', id: saved.id })).template.title, 'Made in chat');
  const document = (await call({ action: 'export', id: saved.id })).document; assert.notEqual((await call({ action: 'import', document: JSON.stringify(document) })).template.id, saved.id);
  await call({ action: 'render', id: saved.id, values: { task: 'x' }, command: 'not allowed' }, false); assert.ok(events.length >= 8); assert.ok(events.every(event => !Object.hasOwn(event, 'text')));
});

test('agent prompt tools honor both run and per-call Stop before mutating storage', async t => {
  const { store } = await fixture(t), controller = new AbortController(), handler = createPromptToolHandler({ store, signal: controller.signal });
  controller.abort(); assert.equal((await handler({ name: PROMPT_TOOL.name, arguments: { action: 'save', template: template() } })).success, false);
  const active = createPromptToolHandler({ store }), perCall = new AbortController(); perCall.abort(); assert.equal((await active({ name: PROMPT_TOOL.name, arguments: { action: 'save', template: template() } }, { signal: perCall.signal })).success, false);
  assert.equal(store.status().count, 0);
});
