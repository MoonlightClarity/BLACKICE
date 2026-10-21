import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rename, rmdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHarnessServer } from '../server.mjs';
import { ProviderRuntime } from '../lib/providers.mjs';

const DEFAULT_MODEL = 'fixture/default-wire';
const EXACT_MODEL = 'Private/Exact-Model:2026.10';
const REVIEW_MODEL = 'Private/Review-Model:2026.10';

class FixtureCodex extends EventEmitter {
  constructor() { super(); this.calls = []; }
  status() {
    return {
      connected: true, authenticated: true, defaultModel: DEFAULT_MODEL, activeTurns: 0,
      models: [
        { id: 'fixture-visible', model: DEFAULT_MODEL, displayName: 'Fixture visible model', hidden: false },
        { id: 'fixture-hidden', model: 'fixture/hidden-wire', displayName: 'Fixture hidden model', hidden: true },
      ],
      modelCatalog: { hiddenModelsIncluded: true, stale: false, refreshing: false },
    };
  }
  async start() { return this.status(); }
  async runAgent(options) { this.calls.push(options); throw new Error('Authoring HTTP fixtures must not execute an inference.'); }
  async close() {}
}

async function application(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-authoring-http-'));
  const dataDir = path.join(directory, 'data'), cwd = path.join(directory, 'workspace');
  const codex = new FixtureCodex(), networkCalls = [];
  const runtime = new ProviderRuntime({ codex, dataDir, fetchImpl: async (...args) => {
    networkCalls.push(args); throw new Error('Authoring HTTP fixtures must not contact a model endpoint.');
  } });
  let app;
  t.after(async () => {
    try { if (app) await app.close(); else await runtime.close(); }
    finally {
      assert.match(path.basename(directory), /^blackice-authoring-http-/);
      await rm(directory, { recursive: true, force: true });
    }
  });
  await runtime.init();
  // An existing explicit preference makes accidental default changes observable.
  await runtime.store.setDefaultModel(DEFAULT_MODEL);
  app = await createHarnessServer({ runtime, port: 0, dataDir, defaultCwd: cwd, autoAttachDesktop: false });
  await app.learning.updateSettings({ mode: 'manual' });
  const url = await app.listen(), target = new URL(url);
  const request = (route, options = {}) => new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const headers = { ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...options.headers };
    const req = http.request({ hostname: target.hostname, port: target.port, path: route, method: options.method || 'GET', headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('Authoring HTTP response was interrupted.')));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          const data = String(res.headers['content-type']).includes('application/json') ? JSON.parse(text) : text;
          resolve({ status: res.statusCode, headers: res.headers, data, text });
        } catch (cause) { reject(cause); }
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error(`Authoring HTTP request timed out: ${options.method || 'GET'} ${route}`)));
    req.on('error', reject); req.end(payload);
  });
  const home = await request('/');
  assert.equal(home.status, 200);
  const cookie = home.headers['set-cookie']?.[0]?.split(';', 1)[0];
  assert.ok(cookie, 'the real page response supplies the local API session');
  const auth = { Cookie: cookie };
  const api = (route, options = {}) => request(route, { ...options, headers: { ...auth, ...options.headers } });
  const noExecution = async () => {
    const runs = await api('/api/runs'); assert.equal(runs.status, 200); assert.deepEqual(runs.data, []);
    const status = await api('/api/status'); assert.equal(status.status, 200); assert.equal(status.data.execution.activeRunCount, 0);
    assert.equal(codex.calls.length, 0, 'authoring routes must not invoke the native runtime');
    assert.equal(networkCalls.length, 0, 'authoring routes must not probe an API provider');
  };
  return { app, runtime, request, api, auth, dataDir, cwd, noExecution };
}

const definition = () => ({
  name: 'HTTP evidence handoff', description: 'A reusable two-step authoring fixture.', taskType: 'analysis',
  inputs: [{ id: 'source', label: 'Source material', required: true }],
  steps: [
    { id: 'inspect', title: 'Inspect the evidence', type: 'analyze', instructions: 'Record the supplied source facts.', inputs: ['Source material'], result: 'A saved evidence note.', checks: ['The note identifies the source.'] },
    { id: 'handoff', title: 'Prepare the handoff', type: 'handoff', instructions: 'Write a handoff from the evidence note.', inputs: ['Evidence note'], result: 'A saved handoff.', checks: ['The handoff identifies remaining limits.'] },
  ],
});
const projectOptions = cwd => ({
  objective: 'Review the fixture material and produce a clear handoff.', cwd,
  inputs: { source: 'fixture-source.txt' }, model: EXACT_MODEL, verifierModel: REVIEW_MODEL,
});
const expectError = (response, status) => {
  if (status !== undefined) assert.equal(response.status, status, response.text);
  else assert.ok(response.status >= 400 && response.status < 600, `Expected an HTTP error, received ${response.status}: ${response.text}`);
  assert.equal(typeof response.data.error, 'string'); assert.ok(response.data.error.length > 0);
};
async function withBlockedFile(file, operation) {
  const before = await readFile(file, 'utf8'), held = `${file}.http-fixture-held`;
  await rename(file, held);
  let directoryCreated = false;
  try { await mkdir(file); directoryCreated = true; await operation(); }
  finally { if (directoryCreated) await rmdir(file); await rename(held, file); }
  assert.equal(await readFile(file, 'utf8'), before, 'the acknowledged file survives the rejected write');
}

test('model and process HTTP routes require the local session and reject cross-site mutations before changing state', async t => {
  const f = await application(t);
  const savedModel = await f.api('/api/codex/models', { method: 'POST', body: { model: EXACT_MODEL } }); assert.equal(savedModel.status, 200);
  const savedMethod = await f.api('/api/methods', { method: 'POST', body: definition() }); assert.equal(savedMethod.status, 201);
  const savedType = await f.api('/api/method-types', { method: 'POST', body: { id: 'http-evidence', kind: 'step', name: 'Evidence inspection' } }); assert.equal(savedType.status, 201);
  for (const route of ['/api/codex/models', '/api/methods', `/api/methods/${savedMethod.data.id}`]) expectError(await f.request(route), 401);
  const files = ['providers.json', 'methods.json', 'projects.json'].map(name => path.join(f.dataDir, name));
  const before = await Promise.all(files.map(file => readFile(file, 'utf8')));
  const mutations = [
    ['/api/codex/models', 'POST', { model: REVIEW_MODEL }],
    ['/api/codex/models', 'DELETE', { model: EXACT_MODEL }],
    ['/api/methods', 'POST', definition()],
    [`/api/methods/${savedMethod.data.id}`, 'PUT', { expectedRevision: 1, name: 'Blocked method edit' }],
    [`/api/methods/${savedMethod.data.id}/preview`, 'POST', projectOptions(f.cwd)],
    [`/api/methods/${savedMethod.data.id}/use`, 'POST', projectOptions(f.cwd)],
    ['/api/method-types', 'POST', { id: 'blocked-type', kind: 'task', name: 'Blocked type' }],
    [`/api/method-types/${savedType.data.id}`, 'PUT', { expectedRevision: 1, name: 'Blocked type edit' }],
  ];
  for (const [route, method, body] of mutations) {
    expectError(await f.request(route, { method, body }), 401);
    expectError(await f.api(route, { method, body, headers: { Origin: 'https://untrusted.example' } }), 403);
    expectError(await f.api(route, { method, body, headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403);
  }
  assert.deepEqual(await Promise.all(files.map(file => readFile(file, 'utf8'))), before);
  assert.deepEqual((await f.api('/api/codex/models')).data.customModels, [EXACT_MODEL]);
  assert.deepEqual((await f.api('/api/projects')).data.projects, []);
  await f.noExecution();
});

test('native model HTTP registration preserves exact IDs, includes hidden catalog rows, and never changes the saved default', async t => {
  const f = await application(t), statusBefore = (await f.api('/api/status')).data;
  assert.equal(statusBefore.defaultModelSelection, DEFAULT_MODEL);
  const initial = await f.api('/api/codex/models'); assert.equal(initial.status, 200);
  assert.deepEqual(initial.data.models.map(row => [row.id, row.model, row.hidden]), [
    ['fixture-visible', DEFAULT_MODEL, false], ['fixture-hidden', 'fixture/hidden-wire', true],
  ]);
  assert.ok(initial.data.models.every(row => row.source === 'advertised' && row.access.state === 'unverified'));
  const added = await f.api('/api/codex/models', { method: 'POST', body: { model: EXACT_MODEL } }); assert.equal(added.status, 200);
  assert.deepEqual(added.data.customModels, [EXACT_MODEL]);
  const row = added.data.models.find(item => item.id === EXACT_MODEL);
  assert.ok(row); assert.equal(row.model, EXACT_MODEL); assert.equal(row.source, 'custom'); assert.equal(row.access.state, 'unverified');
  const repeated = await f.api('/api/codex/models', { method: 'POST', body: { model: EXACT_MODEL } }); assert.equal(repeated.status, 200);
  assert.equal(repeated.data.models.filter(item => item.id === EXACT_MODEL).length, 1);
  assert.deepEqual((await f.api('/api/codex/models')).data, added.data);
  const during = (await f.api('/api/status')).data;
  assert.equal(during.defaultModelSelection, DEFAULT_MODEL); assert.equal(during.defaultModel, statusBefore.defaultModel);
  assert.ok(during.models.some(item => item.id === EXACT_MODEL && item.model === EXACT_MODEL));
  assert.deepEqual(JSON.parse(await readFile(path.join(f.dataDir, 'providers.json'), 'utf8')).customCodexModels, [EXACT_MODEL]);
  const invalidBodies = [null, [], {}, EXACT_MODEL, { model: 17 }, { model: EXACT_MODEL, defaultModel: EXACT_MODEL }];
  for (const method of ['POST', 'DELETE']) for (const body of invalidBodies) expectError(await f.api('/api/codex/models', { method, body }), 400);
  expectError(await f.api('/api/codex/models', { method: 'POST', body: { model: 'native model with spaces' } }), 400);
  assert.deepEqual((await f.api('/api/codex/models')).data.customModels, [EXACT_MODEL]);
  const removed = await f.api('/api/codex/models', { method: 'DELETE', body: { model: EXACT_MODEL } }); assert.equal(removed.status, 200);
  assert.deepEqual(removed.data.customModels, []); assert.deepEqual(removed.data.models, initial.data.models);
  const after = (await f.api('/api/status')).data;
  assert.equal(after.defaultModelSelection, DEFAULT_MODEL); assert.equal(after.defaultModel, statusBefore.defaultModel);
  const persisted = JSON.parse(await readFile(path.join(f.dataDir, 'providers.json'), 'utf8'));
  assert.equal(persisted.defaultModel, DEFAULT_MODEL); assert.deepEqual(persisted.customCodexModels, []);
  await f.noExecution();
});

test('method HTTP preview does not persist work and use saves only a draft with exact implementation and reviewer model routes', async t => {
  const f = await application(t), library = await f.api('/api/methods'); assert.equal(library.status, 200);
  assert.ok(library.data.methods.length > 0); assert.ok(library.data.ontology.taskTypes.length > 0); assert.ok(library.data.ontology.stepTypes.length > 0);
  assert.deepEqual((await f.api('/api/status')).data.methods, library.data.status);
  const created = await f.api('/api/methods', { method: 'POST', body: definition() }); assert.equal(created.status, 201);
  const method = created.data; assert.equal(method.revision, 1); assert.equal(method.origin, 'custom'); assert.equal(method.verification, 'unverified');
  assert.deepEqual((await f.api(`/api/methods/${method.id}`)).data, method);
  for (const model of [EXACT_MODEL, REVIEW_MODEL]) assert.equal((await f.api('/api/codex/models', { method: 'POST', body: { model } })).status, 200);
  const files = ['methods.json', 'projects.json'].map(name => path.join(f.dataDir, name));
  const before = await Promise.all(files.map(file => readFile(file, 'utf8'))), options = projectOptions(f.cwd);
  const preview = await f.api(`/api/methods/${method.id}/preview`, { method: 'POST', body: options }); assert.equal(preview.status, 200);
  assert.equal(preview.data.method.id, method.id); assert.equal(preview.data.method.revision, 1);
  assert.equal(Object.hasOwn(preview.data, 'status'), false); assert.equal(Object.hasOwn(preview.data, 'id'), false);
  assert.equal(preview.data.model, EXACT_MODEL); assert.equal(preview.data.verifierModel, REVIEW_MODEL);
  assert.deepEqual(preview.data.tasks.map(task => task.dependsOn), [[], ['inspect']]);
  assert.deepEqual(preview.data.tasks.map(task => task.acceptanceCriteria), method.steps.map(step => step.checks));
  assert.ok(preview.data.tasks.every(task => task.model === EXACT_MODEL && task.verifierModel === REVIEW_MODEL));
  assert.match(preview.data.context, /fixture-source\.txt/);
  assert.equal(preview.data.methodContext, preview.data.context);
  assert.deepEqual(await Promise.all(files.map(file => readFile(file, 'utf8'))), before);
  assert.deepEqual((await f.api('/api/projects')).data.projects, []); await f.noExecution();
  expectError(await f.api(`/api/methods/${method.id}/use`, { method: 'POST', body: { ...options, status: 'running' } }), 400);
  assert.deepEqual((await f.api('/api/projects')).data.projects, []);
  const used = await f.api(`/api/methods/${method.id}/use`, { method: 'POST', body: options }); assert.equal(used.status, 201);
  assert.equal(used.data.status, 'draft'); assert.equal(used.data.revision, 1);
  assert.deepEqual(used.data.method, preview.data.method);
  assert.equal(used.data.methodContext, preview.data.methodContext);
  assert.ok(used.data.tasks.every(task => task.status === 'pending' && task.attempts.length === 0 && task.model === EXACT_MODEL && task.verifierModel === REVIEW_MODEL));
  // Run the ordinary scheduler pass as well: a saved draft must stay inadmissible.
  await f.app.projects.poll();
  const saved = await f.api(`/api/projects/${used.data.id}`); assert.equal(saved.status, 200);
  const { groupId, groupName, archived, organizationRevision, organization, ...savedProject } = saved.data;
  assert.deepEqual(savedProject, used.data);
  assert.deepEqual(savedProject, f.app.projects.get(used.data.id));
  assert.deepEqual({ groupId, groupName, archived, organizationRevision }, { groupId: null, groupName: null, archived: false, organizationRevision: 0 });
  assert.deepEqual(organization, { revision: 0, healthy: true, updatedAt: null, groups: [] });
  const persisted = JSON.parse(await readFile(path.join(f.dataDir, 'projects.json'), 'utf8'));
  assert.equal(persisted.projects.length, 1); assert.equal(persisted.projects[0].id, used.data.id); assert.equal(persisted.projects[0].status, 'draft');
  assert.ok(persisted.projects[0].tasks.every(task => task.attempts.length === 0));
  await f.noExecution();
});

test('custom task and step type HTTP edits enforce revisions and appear in the shared method catalog', async t => {
  const f = await application(t);
  const task = await f.api('/api/method-types', { method: 'POST', body: { id: 'http-task-type', kind: 'task', name: 'Local evidence task' } }); assert.equal(task.status, 201);
  const step = await f.api('/api/method-types', { method: 'POST', body: { id: 'http-step-type', kind: 'step', name: 'Inspect local evidence' } }); assert.equal(step.status, 201);
  const source = definition(); source.taskType = task.data.id; source.steps[0].type = step.data.id;
  const created = await f.api('/api/methods', { method: 'POST', body: source }); assert.equal(created.status, 201);
  const updated = await f.api(`/api/method-types/${step.data.id}`, { method: 'PUT', body: { expectedRevision: 1, name: 'Inspect original evidence' } }); assert.equal(updated.status, 200); assert.equal(updated.data.revision, 2);
  const stale = await f.api(`/api/method-types/${step.data.id}`, { method: 'PUT', body: { expectedRevision: 1, name: 'Stale overwrite' } }); expectError(stale, 409);
  const snapshot = await f.api('/api/methods'); assert.equal(snapshot.status, 200);
  assert.deepEqual(snapshot.data.ontology.taskTypes.find(type => type.id === task.data.id), task.data);
  assert.deepEqual(snapshot.data.ontology.stepTypes.find(type => type.id === step.data.id), updated.data);
  const preview = await f.api(`/api/methods/${created.data.id}/preview`, { method: 'POST', body: projectOptions(f.cwd) }); assert.equal(preview.status, 200);
  assert.equal(preview.data.method.taskType, task.data.id); assert.equal(preview.data.tasks[0].stepType, step.data.id);
  const edited = await f.api(`/api/methods/${created.data.id}`, { method: 'PUT', body: { expectedRevision: 1, name: 'Edited HTTP method' } }); assert.equal(edited.status, 200); assert.equal(edited.data.revision, 2);
  expectError(await f.api(`/api/methods/${created.data.id}`, { method: 'PUT', body: { expectedRevision: 1, name: 'Stale method overwrite' } }), 409);
  assert.deepEqual((await f.api(`/api/methods/${created.data.id}`)).data, edited.data);
  const persisted = JSON.parse(await readFile(path.join(f.dataDir, 'methods.json'), 'utf8'));
  assert.deepEqual(persisted.types.find(type => type.id === step.data.id), updated.data); assert.deepEqual(persisted.methods.find(method => method.id === created.data.id), edited.data);
  assert.deepEqual((await f.api('/api/projects')).data.projects, []); await f.noExecution();
});

test('routed model, method, and draft storage failures return errors without acknowledging changes or starting work', async t => {
  const f = await application(t);
  assert.equal((await f.api('/api/codex/models', { method: 'POST', body: { model: EXACT_MODEL } })).status, 200);
  const created = await f.api('/api/methods', { method: 'POST', body: definition() }); assert.equal(created.status, 201);
  await withBlockedFile(path.join(f.dataDir, 'providers.json'), async () => {
    expectError(await f.api('/api/codex/models', { method: 'POST', body: { model: REVIEW_MODEL } }));
    const models = await f.api('/api/codex/models'); assert.equal(models.status, 200); assert.deepEqual(models.data.customModels, [EXACT_MODEL]);
    assert.equal((await f.api('/api/status')).data.defaultModelSelection, DEFAULT_MODEL);
  });
  await withBlockedFile(path.join(f.dataDir, 'methods.json'), async () => {
    expectError(await f.api(`/api/methods/${created.data.id}`, { method: 'PUT', body: { expectedRevision: 1, name: 'Unacknowledged method edit' } }));
    assert.deepEqual((await f.api(`/api/methods/${created.data.id}`)).data, created.data);
    assert.equal((await f.api('/api/methods')).data.status.healthy, false);
  });
  await withBlockedFile(path.join(f.dataDir, 'projects.json'), async () => {
    expectError(await f.api(`/api/methods/${created.data.id}/use`, { method: 'POST', body: projectOptions(f.cwd) }));
    const projects = await f.api('/api/projects'); assert.equal(projects.status, 200); assert.deepEqual(projects.data.projects, []); assert.equal(projects.data.status.healthy, false);
    await f.noExecution();
  });
  assert.deepEqual(JSON.parse(await readFile(path.join(f.dataDir, 'providers.json'), 'utf8')).customCodexModels, [EXACT_MODEL]);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.dataDir, 'projects.json'), 'utf8')).projects, []);
  await f.noExecution();
  // Recovery is an explicit new client request after the storage obstruction is
  // removed. It also leaves the fixture stores healthy for ordinary shutdown.
  assert.equal((await f.api('/api/codex/models', { method: 'POST', body: { model: REVIEW_MODEL } })).status, 200);
  assert.equal((await f.api('/api/codex/models', { method: 'DELETE', body: { model: REVIEW_MODEL } })).status, 200);
  const edited = await f.api(`/api/methods/${created.data.id}`, { method: 'PUT', body: { expectedRevision: 1, name: 'Explicit recovered edit' } }); assert.equal(edited.status, 200);
  const retry = await f.api(`/api/methods/${created.data.id}/use`, { method: 'POST', body: projectOptions(f.cwd) }); assert.equal(retry.status, 201); assert.equal(retry.data.status, 'draft');
  assert.equal((await f.api('/api/methods')).data.status.healthy, true); assert.equal((await f.api('/api/projects')).data.status.healthy, true);
  await f.noExecution();
});
