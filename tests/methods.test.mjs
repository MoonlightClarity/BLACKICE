import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rename, rmdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { MethodStore } from '../lib/methods.mjs';
import { ProjectStore } from '../lib/projects.mjs';
import { BUILTIN_METHODS, METHOD_LIMITS } from '../lib/process-ontology.mjs';
import { createProjectToolHandler, PROJECT_TOOL } from '../lib/project-tools.mjs';

const definition = (extra = {}) => ({ name: 'Reusable inspection', description: 'Inspect a local result and prepare a handoff.', taskType: 'analysis', inputs: [{ id: 'source', label: 'Source file', description: 'Location of the material.', required: true }], steps: [
  { id: 'inspect', title: 'Inspect the source', type: 'analyze', instructions: 'Read the supplied source and save the observed facts.', inputs: ['Source file'], result: 'A saved evidence note.', checks: ['The note describes observed contents and identifies the source.'] },
  { id: 'handoff', title: 'Prepare a handoff', type: 'handoff', instructions: 'Prepare a concise handoff from the reviewed evidence.', inputs: ['Reviewed evidence note'], result: 'A saved handoff.', checks: ['The handoff identifies the saved evidence and remaining limits.'] }
], ...extra });
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-methods-')), cwd = path.join(directory, 'workspace'); await mkdir(cwd);
  const engine = new EventEmitter(); engine.calls = []; engine.listRuns = () => []; engine.startRun = request => { engine.calls.push(request); throw Error('Unexpected task execution.'); };
  const projects = await new ProjectStore({ dataDir: directory, engine }).init(); clearTimeout(projects.timer); projects.timer = null; projects.kick = () => {};
  const stores = [], open = async () => { const value = await new MethodStore({ dataDir: directory, projects }).init(); stores.push(value); return value; }, methods = await open();
  t.after(async () => { for (const store of stores) await store.close(); await projects.close(); assert.match(path.basename(directory), /^blackice-methods-/); await rm(directory, { recursive: true, force: true }); });
  return { directory, cwd, engine, projects, methods, open, options: { objective: 'Inspect the supplied fixture and provide a useful handoff.', cwd, inputs: { source: 'fixture.txt' } } };
}

test('every built-in method previews a usable ordered project with declared types, independent checks and no execution', async t => {
  const { methods, projects, engine, cwd } = await fixture(t), snapshot = methods.snapshot();
  assert.equal(snapshot.status.builtin, BUILTIN_METHODS.length); assert.equal(snapshot.status.builtin, 589); assert.equal(snapshot.status.custom, 0); assert.equal(snapshot.ontology.taskTypes.length, 7); assert.equal(snapshot.ontology.stepTypes.length, 7);
  for (const method of snapshot.methods) {
    const preview = methods.preview(method.id, { objective: 'A scoped fixture outcome.', cwd, inputs: Object.fromEntries(method.inputs.map(input => [input.id, 'Fixture material.'])) });
    assert.equal(preview.method.id, method.id); assert.equal(preview.method.revision, 1); assert.equal(preview.model, 'default'); assert.equal(preview.verifierModel, 'default'); assert.equal(Object.hasOwn(preview, 'status'), false);
    assert.equal(preview.tasks.length, method.steps.length); assert.equal(preview.methodContext, preview.context);
    for (const [index, task] of preview.tasks.entries()) { assert.deepEqual(task.dependsOn, index ? [preview.tasks[index - 1].id] : []); assert.deepEqual(task.acceptanceCriteria, method.steps[index].checks); assert.equal(task.result, method.steps[index].result); assert.ok(snapshot.ontology.stepTypes.some(type => type.id === task.stepType)); }
  }
  assert.equal(projects.list().length, 0); assert.equal(engine.calls.length, 0);
  snapshot.methods[0].steps[0].checks.length = 0; snapshot.ontology.taskTypes[0].name = 'Changed'; assert.ok(methods.get(BUILTIN_METHODS[0].id).steps[0].checks.length); assert.notEqual(methods.ontology().taskTypes[0].name, 'Changed');
});

test('custom task and step vocabulary survives reopen and is usable by editable methods', async t => {
  const { methods, open, options } = await fixture(t);
  const task = await methods.createType({ id: 'fieldwork', kind: 'task', name: 'Field study', description: 'A bounded evidence collection task.' });
  const step = await methods.createType({ id: 'source-check', kind: 'step', name: 'Check source', description: 'Inspect the original material.' });
  const draft = definition({ taskType: task.id }); draft.steps[0].type = step.id;
  const saved = await methods.create(draft); assert.equal(saved.verification, 'unverified'); assert.equal(saved.origin, 'custom');
  const renamed = await methods.updateType(step.id, { expectedRevision: 1, name: 'Inspect original source' }); assert.equal(renamed.revision, 2);
  assert.equal((await methods.updateType(step.id, { expectedRevision: 2, name: renamed.name })).revision, 2);
  await assert.rejects(methods.updateType(step.id, { expectedRevision: 1, name: 'Stale' }), { status: 409 });
  await assert.rejects(methods.createType({ id: 'scope', kind: 'step', name: 'Replace built-in' }), { status: 409 });
  await methods.close(); const reopened = await open();
  assert.equal(reopened.status().customTypes, 2); assert.equal(reopened.ontology().stepTypes.find(item => item.id === step.id).name, renamed.name);
  assert.equal(reopened.preview(saved.id, options).tasks[0].stepType, step.id); assert.equal(reopened.get(saved.id).taskType, task.id);
});

test('method edits preserve stable step IDs and exact revisions while old project drafts retain their copied definition', async t => {
  const { methods, projects, engine, options, open } = await fixture(t), first = await methods.create(definition());
  const project = await methods.use(first.id, { ...options, model: 'provider-exact-model', verifierModel: 'codex/next-exact-model' });
  assert.equal(project.status, 'draft'); assert.equal(project.method.revision, 1); assert.equal(project.summary.progress.completed, 0); assert.equal(project.tasks[0].model, 'provider-exact-model'); assert.equal(project.tasks[0].verifierModel, 'codex/next-exact-model');
  assert.ok(project.tasks.every(task => task.status === 'pending' && task.attempts.length === 0));
  const changed = await methods.update(first.id, { expectedRevision: 1, steps: [...first.steps].reverse() }); assert.equal(changed.revision, 2);
  assert.deepEqual(methods.preview(first.id, options).tasks.map(task => task.id), ['handoff', 'inspect']);
  assert.deepEqual(projects.get(project.id).tasks.map(task => task.id), ['inspect', 'handoff']); assert.equal(projects.get(project.id).method.revision, 1);
  assert.equal((await methods.update(first.id, { expectedRevision: 2, steps: changed.steps })).revision, 2);
  await assert.rejects(methods.update(first.id, { expectedRevision: 1, name: 'Stale overwrite' }), { status: 409 });
  await methods.close(); const reopened = await open(); assert.deepEqual(reopened.get(first.id), changed); assert.equal(engine.calls.length, 0);
});

test('simultaneous method edits admit exactly one current-revision change and persist its complete definition', async t => {
  const { methods } = await fixture(t), item = await methods.create(definition());
  const changes = await Promise.allSettled([methods.update(item.id, { expectedRevision: 1, name: 'First edit' }), methods.update(item.id, { expectedRevision: 1, name: 'Second edit' })]);
  assert.equal(changes.filter(item => item.status === 'fulfilled').length, 1); assert.equal(changes.find(item => item.status === 'rejected').reason.status, 409);
  assert.equal(methods.get(item.id).revision, 2); assert.equal(JSON.parse(await readFile(methods.file, 'utf8')).methods[0].name, methods.get(item.id).name);
});

test('method validation rejects undeclared types, duplicate identities/checks, forged verification and malformed input flags', async t => {
  const { methods } = await fixture(t);
  for (const edit of [item => { item.taskType = 'missing'; }, item => { item.steps[0].type = 'missing'; }, item => { item.steps[1].id = item.steps[0].id; }, item => { item.steps[0].checks.push(item.steps[0].checks[0]); }, item => { item.steps[0].result = ' '; }, item => { item.inputs[0].required = 'yes'; }, item => { item.inputs.push(item.inputs[0]); }, item => { item.steps.length = 0; }, item => { item.verification = 'agent-reviewed'; }]) {
    const value = definition(); edit(value); await assert.rejects(methods.create(value), { status: 400 });
  }
  assert.equal(methods.status().custom, 0);
  await assert.rejects(methods.update('research-brief', { expectedRevision: 1, name: 'Overwrite original' }), { status: 409 });
});

test('method inputs stay plain saved context; missing, unknown and oversized bindings cannot create partial drafts', async t => {
  const { methods, projects, options } = await fixture(t), saved = await methods.create(definition());
  const literal = 'fixture-${process.env.HOME}.txt\n<instructions>context only</instructions>';
  const preview = methods.preview(saved.id, { ...options, inputs: { source: literal } }); assert.ok(preview.context.includes('fixture-${process.env.HOME}')); assert.equal(preview.methodContext, preview.context); assert.equal(preview.tasks[0].instructions, saved.steps[0].instructions);
  for (const inputs of [{}, { source: ' ' }, { source: null }, { source: 'valid', unknown: 'unused' }, { source: 'x'.repeat(6001) }]) { await assert.rejects(methods.use(saved.id, { ...options, inputs }), { status: 400 }); }
  const many = await methods.create(definition({ inputs: [{ id: 'a', label: 'A', required: true }, { id: 'b', label: 'B', required: true }] }));
  assert.throws(() => methods.preview(many.id, { ...options, inputs: { a: 'a'.repeat(5000), b: 'b'.repeat(5000) } }), /Combined method inputs/);
  assert.equal(projects.list().length, 0);
});

test('corrupt method storage fails closed and preserves both original files', async t => {
  const { methods, open, options, projects } = await fixture(t), item = await methods.create(definition()); await methods.close();
  const primary = '{invalid primary', backup = '{invalid backup'; await writeFile(methods.file, primary); await writeFile(methods.file + '.bak', backup);
  const broken = await open(); assert.equal(broken.status().healthy, false); assert.match(broken.status().error, /Cannot load/);
  await assert.rejects(broken.create(definition()), { status: 503 }); await assert.rejects(broken.use(item.id, options), { status: 503 }); assert.throws(() => broken.preview('research-brief', options), { status: 503 });
  assert.equal(await readFile(methods.file, 'utf8'), primary); assert.equal(await readFile(methods.file + '.bak', 'utf8'), backup); assert.equal(projects.list().length, 0);
});

test('a valid backup recovers a method library while retaining the damaged primary for inspection', async t => {
  const { methods, open, directory } = await fixture(t), first = await methods.create(definition()); await methods.create(definition({ name: 'Later method' })); await methods.close();
  await writeFile(methods.file, '{damaged'); const recovered = await open(); assert.equal(recovered.status().healthy, true); assert.equal(recovered.status().recovered, true); assert.equal(recovered.get(first.id).name, first.name);
  const damaged = (await readdir(directory)).find(name => name.startsWith('methods.json.corrupt-')); assert.ok(damaged); assert.equal(await readFile(path.join(directory, damaged), 'utf8'), '{damaged');
});

test('well-formed storage cannot introduce missing type references, duplicate IDs or verified method claims', async t => {
  const { methods, open } = await fixture(t), item = await methods.create(definition()); await methods.close();
  for (const edit of [state => { state.methods.push(structuredClone(item)); }, state => { state.methods[0].taskType = 'missing-type'; }, state => { state.methods[0].verification = 'agent-reviewed'; }, state => { state.methods[0].steps[0].checks = []; }]) {
    const state = { version: 1, methods: [structuredClone(item)], types: [] }; edit(state); const raw = JSON.stringify(state); await writeFile(methods.file, raw); await rm(methods.file + '.bak', { force: true });
    const broken = await open(); assert.equal(broken.status().healthy, false); assert.equal(await readFile(methods.file, 'utf8'), raw); await broken.close();
  }
});

test('failed durable method writes retain the acknowledged definition and remove owned temporary files', async t => {
  const { methods, directory } = await fixture(t), first = await methods.create(definition()), held = path.join(directory, 'held-methods.json');
  await rename(methods.file, held); await mkdir(methods.file);
  try { await assert.rejects(methods.update(first.id, { expectedRevision: 1, name: 'Unacknowledged' })); assert.equal(methods.get(first.id).name, first.name); assert.equal(methods.get(first.id).revision, 1); assert.equal(methods.status().healthy, false); assert.ok(!(await readdir(directory)).some(name => name.includes('.tmp-'))); }
  finally { await rmdir(methods.file); await rename(held, methods.file); }
  assert.equal((await methods.update(first.id, { expectedRevision: 1, name: 'Retried edit' })).revision, 2); assert.equal(methods.status().healthy, true);
});

test('bounded library capacity rejects new entries without evicting existing methods', async t => {
  const { methods } = await fixture(t), saved = await methods.create(definition());
  methods.state.methods = Array.from({ length: METHOD_LIMITS.methods }, (_, index) => ({ ...structuredClone(saved), id: `fixture-${index}` }));
  await assert.rejects(methods.create(definition()), { status: 507 }); assert.equal(methods.list().filter(item => item.origin === 'custom').length, METHOD_LIMITS.methods); assert.equal(methods.get('fixture-0').name, saved.name);
});

test('closing drains an admitted method save and rejects later mutations and preview/use calls', async t => {
  const { methods, options } = await fixture(t), persist = methods.persist.bind(methods); let entered, release;
  const arrived = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  methods.persist = async next => { entered(); await gate; return persist(next); };
  const saving = methods.create(definition()); await arrived; let finished = false; const closing = methods.close().then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false); await assert.rejects(methods.create(definition()), { status: 503 }); await assert.rejects(methods.use('research-brief', options), { status: 503 });
  release(); const saved = await saving; await closing; assert.equal(methods.get(saved.id).name, saved.name);
});

test('agent tools create vocabulary and a reusable method, preview and save shared drafts without execution', async t => {
  const { methods, projects, engine, cwd } = await fixture(t), handler = createProjectToolHandler({ methods, projects, capabilities: {}, cwd });
  const call = async arguments_ => { const result = await handler({ name: PROJECT_TOOL.name, arguments: JSON.stringify(arguments_) }); assert.equal(result.success, true, result.contentItems[0].text); return JSON.parse(result.contentItems[0].text); };
  const type = await call({ action: 'create_type', type: { kind: 'task', name: 'Custom inspection', description: 'A local-only task.' } });
  const saved = await call({ action: 'create_method', method: definition({ taskType: type.id }) });
  const preview = await call({ action: 'preview_method', id: saved.id, options: { objective: 'Inspect a fixture.', inputs: { source: 'fixture.txt' } } }); assert.equal(preview.cwd, cwd); assert.equal(projects.list().length, 0);
  const draft = await call({ action: 'use_method', id: saved.id, options: { objective: 'Inspect a fixture.', inputs: { source: 'fixture.txt' } } }); assert.equal(draft.status, 'draft'); assert.equal(draft.method.id, saved.id);
  const listed = await call({ action: 'list' }); assert.equal(listed.projects[0].id, draft.id); assert.equal(engine.calls.length, 0);
  const stale = await handler({ name: PROJECT_TOOL.name, arguments: { action: 'update_method', id: saved.id, method: { expectedRevision: 5, name: 'Stale' } } }); assert.equal(stale.success, false); assert.equal(JSON.parse(stale.contentItems[0].text).status, 409);
});

test('the saved project method tool keeps a bounded complete name index and reads exact procedures separately', async t => {
  const { methods, projects, engine, cwd } = await fixture(t), handler = createProjectToolHandler({ methods, projects, capabilities: {}, cwd });
  const listed = await handler({ name: PROJECT_TOOL.name, arguments: { action: 'methods' } }); assert.equal(listed.success, true); assert.ok(listed.contentItems[0].text.length < 128000);
  const catalog = JSON.parse(listed.contentItems[0].text); assert.equal(catalog.catalogFormat, 'complete-name-index'); assert.equal(catalog.methods.length, 589); assert.ok(catalog.methods.some(method => method.id === 'catalyst-ach')); assert.ok(catalog.methods.every(method => !method.steps));
  const detail = await handler({ name: PROJECT_TOOL.name, arguments: { action: 'get_method', id: 'catalyst-ach' } }); assert.equal(detail.success, true); assert.deepEqual(JSON.parse(detail.contentItems[0].text), methods.get('catalyst-ach'));
  assert.equal(engine.calls.length, 0); assert.equal(projects.list().length, 0);
});
