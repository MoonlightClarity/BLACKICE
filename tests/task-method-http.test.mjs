import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHarnessServer } from '../server.mjs';
import { createTaskToolHandler, TASK_SCHEMA_VERSION } from '../lib/task-state.mjs';

class Runtime extends EventEmitter {
  calls = 0;
  status() { return { connected: true, authenticated: true, defaultModel: 'fixture-model', models: [{ model: 'fixture-model' }] }; }
  async start() { return this.status(); }
  async close() {}
  async runAgent() { this.calls++; throw Error('Method authoring must not start a model.'); }
}
class Desktop extends EventEmitter { status() { return { available: false, enabled: false }; } async setEnabled() { return this.status(); } }

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'blackice-task-method-http-')), runtime = new Runtime();
  const app = await createHarnessServer({ runtime, desktop: new Desktop(), port: 0, dataDir: path.join(root, 'data'), defaultCwd: path.join(root, 'workspace'), autoAttachDesktop: false });
  await app.learning.updateSettings({ mode: 'off' }); const base = await app.listen();
  t.after(async () => { await app.close(); assert.equal(runtime.calls, 0); assert.match(path.basename(root), /^blackice-task-method-http-/); await rm(root, { recursive: true, force: true }); });
  const home = await fetch(base), cookie = home.headers.getSetCookie()[0].split(';')[0]; await home.text();
  const request = async (route, body, { authenticated = true, origin, method = 'POST' } = {}) => {
    const response = await fetch(new URL(route, base), { method, headers: { ...(authenticated ? { cookie } : {}), ...(origin ? { origin } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(6000) });
    const data = await response.json(); return { status: response.status, data };
  };
  let state = await app.tasks.ensure({ taskId: 'branch-method-source', runId: 'source-run', cwd: app.engine.defaultCwd, goal: 'A private task goal that must not become the method description.', defaultPlan: true });
  await writeFile(path.join(app.engine.defaultCwd, 'private-result.txt'), 'Private fixture result.');
  state = await app.tasks.addArtifact(state.taskId, { path: 'private-result.txt' }, { expectedRevision: state.revision });
  state = await app.tasks.setPlan(state.taskId, { plan: { layout: 'parallel', taskType: 'analysis' }, steps: [
    { id: 'inspect', title: 'Inspect the source', kind: 'action', status: 'done', doneWhen: 'The relevant source is inspected.', evidence: 'Private evidence that must stay with the task.', artifactIds: [state.artifacts[0].id], stepType: 'collect' },
    { id: 'route', title: 'Choose the appropriate analysis', kind: 'choice', selectedChildId: 'quantitative' },
    { id: 'quantitative', parentId: 'route', kind: 'action', title: 'Analyze the measurements', condition: 'Measurements are available.', status: 'active', doneWhen: 'Calculations reproduce the reported values.', stepType: 'analyze' },
    { id: 'qualitative', parentId: 'route', kind: 'action', title: 'Compare the observations', condition: 'The input is descriptive.', status: 'skipped', skipReason: 'This fixture supplies measurements.', doneWhen: 'Each finding identifies its supporting observation.', stepType: 'analyze' }
  ] }, { expectedRevision: state.revision, runId: 'source-run', nodeId: 'agent', schemaVersion: 4 });
  return { app, runtime, request, state, base };
}

test('task method preview and save preserve branching while excluding prior outcome claims, and start no work', async t => {
  const { app, request, state } = await fixture(t), route = '/api/tasks/' + state.taskId;
  const preview = await request(route + '/method-draft', { expectedRevision: state.revision });
  assert.equal(preview.status, 200); assert.equal(preview.data.taskRevision, state.revision);
  const method = preview.data.method;
  assert.equal(method.outline.layout, 'parallel'); assert.equal(method.outline.steps.length, 4);
  assert.equal(method.outline.steps.find(step => step.id === 'quantitative').parentId, 'route');
  assert.equal(method.outline.steps.find(step => step.id === 'qualitative').condition, 'The input is descriptive.');
  const text = JSON.stringify(method); for (const excluded of [state.goal, state.steps[0].evidence, state.artifacts[0].id, 'private-result.txt', 'selectedChildId', 'skipReason', '"status"', '"provenance"']) assert.ok(!text.includes(excluded), excluded);
  assert.equal(app.engine.methods.status().custom, 0); assert.deepEqual(await app.tasks.get(state.taskId), state);
  const saved = await request(route + '/method', { expectedRevision: state.revision, name: 'Choose an analysis', description: 'Adapt the analysis to the available evidence.' });
  assert.equal(saved.status, 201); assert.equal(saved.data.reused, false); assert.equal(saved.data.method.name, 'Choose an analysis');
  assert.deepEqual(saved.data.method.outline, method.outline); assert.equal(app.engine.methods.status().custom, 1);
  assert.deepEqual(await app.tasks.get(state.taskId), state, 'saving a reusable method never rewrites the live task plan');
  assert.equal(app.engine.listRuns().length, 0);
});

test('uncertain method save can be retried after task progress or method edits without duplicating or undoing them', async t => {
  const { app, request, state } = await fixture(t), route = '/api/tasks/' + state.taskId + '/method';
  const body = { expectedRevision: state.revision, name: 'Reusable evidence choice', description: 'A reusable analysis approach.' };
  const original = await request(route, body); assert.equal(original.status, 201);
  const edited = await app.engine.methods.update(original.data.method.id, { expectedRevision: original.data.method.revision, name: 'Refined evidence choice' });
  const progressed = await app.tasks.setStep(state.taskId, 'quantitative', { status: 'done', evidence: 'The fixture calculations matched the expected values.' }, { expectedRevision: state.revision, schemaVersion: 4 });
  const retry = await request(route, body); assert.equal(retry.status, 200); assert.equal(retry.data.reused, true);
  assert.equal(retry.data.method.id, original.data.method.id); assert.equal(retry.data.method.name, edited.name); assert.equal(retry.data.method.revision, edited.revision); assert.equal(app.engine.methods.status().custom, 1);
  const different = await request(route, { ...body, name: 'Another intent' }); assert.equal(different.status, 409);
  const stalePreview = await request('/api/tasks/' + state.taskId + '/method-draft', { expectedRevision: state.revision }); assert.equal(stalePreview.status, 409);
  assert.deepEqual(await app.tasks.get(state.taskId), progressed);
});

test('method authoring endpoints enforce session, origin, revision and exact editable fields', async t => {
  const { app, request, state } = await fixture(t), route = '/api/tasks/' + state.taskId + '/method';
  const body = { expectedRevision: state.revision, name: 'One method', description: '' };
  assert.equal((await request(route, body, { authenticated: false })).status, 401);
  assert.equal((await request(route, body, { origin: 'https://foreign.example' })).status, 403);
  for (const value of [{ ...body, outline: { steps: [] } }, { ...body, expectedRevision: 0 }, { ...body, expectedRevision: String(state.revision) }, null, []]) assert.equal((await request(route, value)).status, 400);
  assert.equal((await request(route, { ...body, name: 'x'.repeat(161) })).status, 400);
  assert.equal((await request(route, { ...body, description: 'x'.repeat(2001) })).status, 400);
  assert.equal(app.engine.methods.status().custom, 0); assert.deepEqual(await app.tasks.get(state.taskId), state);
});

test('HTTP method retries share the agent save defaults and durable receipt', async t => {
  const { app, request, state } = await fixture(t);
  const original = await app.engine.methods.saveTaskMethod(state);
  const retry = await request('/api/tasks/' + state.taskId + '/method', { expectedRevision: state.revision });
  assert.equal(retry.status, 200); assert.equal(retry.data.reused, true);
  assert.equal(retry.data.method.id, original.method.id); assert.equal(app.engine.methods.status().custom, 1);
});

test('default workspace and method modules are available from the real application server', async t => {
  const { base } = await fixture(t);
  for (const name of ['task-plan-model.mjs','task-plan-ui.mjs','task-plan.css','task-method-ui.mjs','task-method.css']) {
    const response = await fetch(new URL('/' + name, base)); assert.equal(response.status, 200, name); assert.match(response.headers.get('content-type'), /javascript|css/); assert.ok((await response.text()).length > 100);
  }
});

test('HTTP discovery returns bounded summaries, complete vocabulary, exact full procedures and revision-safe pages', async t => {
  const { request, app } = await fixture(t);
  const first = await request('/api/methods?compact=true', undefined, { method: 'GET' }); assert.equal(first.status, 200); assert.equal(first.data.methods.length, 20); assert.equal(first.data.totalMethods, 589); assert.equal(first.data.nextOffset, 20); assert.ok(first.data.ontology.taskTypes.length >= 7); assert.ok(first.data.methods.every(method => !method.steps));
  const second = await request('/api/methods?compact=true&offset=20&catalogRevision=' + first.data.catalogRevision, undefined, { method: 'GET' }); assert.equal(second.status, 200); assert.equal(second.data.methods.length, 20); assert.ok(second.data.methods.every(method => !first.data.methods.some(previous => previous.id === method.id)));
  for (const query of ['limit=41', 'offset=20', 'offset=-1', 'limit=20.5', 'query=' + 'x'.repeat(501)]) assert.ok([400, 409].includes((await request('/api/methods?compact=true&' + query, undefined, { method: 'GET' })).status));
  const search = await request('/api/methods?compact=true&query=ACH&domain=intelligence&output=matrix', undefined, { method: 'GET' }); assert.equal(search.status, 200); assert.equal(search.data.methods[0].id, 'catalyst-ach');
  const detail = await request('/api/methods/catalyst-ach', undefined, { method: 'GET' }); assert.equal(detail.status, 200); assert.equal(detail.data.steps.length, 6); assert.ok(detail.data.steps[0].instructions.length > 100); assert.ok(detail.data.catalog.prerequisites.length); assert.ok(detail.data.provenance); assert.equal(app.engine.methods.status().custom, 0);
});

test('HTTP draft and save retain authored deep procedures with the same idempotent receipt exposed to relay_task v5', async t => {
  const { request, app, state } = await fixture(t), base = '/api/tasks/' + state.taskId;
  const preview = await request(base + '/method-draft', { expectedRevision: state.revision }), methodSteps = preview.data.method.steps.map(step => ({ ...step, instructions: 'Inspect the original evidence, record its date and source, compare contradictions, and preserve uncertainty while producing ' + step.result, inputs: ['Original records'], checks: [...step.checks, 'Each material statement is supported by the inspected original records.'] }));
  const options = { expectedRevision: state.revision, name: 'A deep adapted evidence method', description: 'Use original records and preserve contradictions.', methodSteps, catalog: { domain: 'research', phases: ['evaluate-evidence'], outputs: ['matrix'], prerequisites: ['Original records are available.'] } };
  const draft = await request(base + '/method-draft', options); assert.equal(draft.status, 200); assert.deepEqual(draft.data.method.steps, methodSteps); assert.equal(app.engine.methods.status().custom, 0);
  const saved = await request(base + '/method', options); assert.equal(saved.status, 201); assert.deepEqual(saved.data.method.steps, methodSteps); assert.deepEqual(saved.data.method.catalog, options.catalog);
  const handler = createTaskToolHandler({ store: app.tasks, taskId: state.taskId, methods: app.engine.methods, schemaVersion: TASK_SCHEMA_VERSION });
  const result = await handler({ name: 'relay_task', arguments: { action: 'save_method', expectedRevision: state.revision, methodName: options.name, methodDescription: options.description, methodSteps, methodCatalog: options.catalog } }); assert.equal(result.success, true, result.contentItems[0].text);
  const retry = JSON.parse(result.contentItems[0].text); assert.equal(retry.created, false); assert.equal(retry.method.id, saved.data.method.id); assert.equal(app.engine.methods.status().custom, 1); assert.deepEqual(await app.tasks.get(state.taskId), state);
  const malformed = structuredClone(options); malformed.methodSteps[0].evidence = 'Do not import this execution claim.';
  assert.equal((await request(base + '/method', malformed)).status, 400); assert.equal(app.engine.methods.status().custom, 1);
});

test('the task draft endpoint preserves the exact source procedure while reading only the referenced method revision', async t => {
  const { request, app } = await fixture(t), source = app.engine.methods.get('catalyst-ach');
  let state = await app.tasks.ensure({ taskId: 'exact-source-procedure', runId: 'method-source-run', cwd: app.engine.defaultCwd, goal: 'A private goal that does not belong in the reusable procedure.', defaultPlan: true });
  state = await app.tasks.setPlan(state.taskId, { plan: { layout: 'sequence', taskType: source.taskType, method: { id: source.id, revision: source.revision } }, steps: source.steps.map(step => ({ id: step.id, title: step.title, kind: 'action', stepType: step.type, result: step.result, doneWhen: step.checks[0] })) }, { expectedRevision: state.revision, schemaVersion: TASK_SCHEMA_VERSION, runId: 'method-source-run', nodeId: 'agent' });
  const response = await request('/api/tasks/' + state.taskId + '/method-draft', { expectedRevision: state.revision }); assert.equal(response.status, 200); assert.deepEqual(response.data.method.steps, source.steps); assert.ok(!JSON.stringify(response.data.method).includes(state.goal));
});
