import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHarnessServer } from '../server.mjs';
import { handlePlanningBrowserHttp, planningBrowserCatalog } from '../lib/planning-browser-http.mjs';
import { RemoteAccessManager } from '../lib/remote-access.mjs';
import { createRemoteTransportFixture } from './fixtures/remote-transport.mjs';

class Runtime extends EventEmitter {
  calls = 0;
  status() { return { connected: true, authenticated: true, ready: true, models: [{ model: 'planning-http-fixture' }], defaultModel: 'planning-http-fixture' }; }
  async start() { return this.status(); }
  async close() {}
  async runAgent() { this.calls++; throw Error('Opening and editing the Planning browser must not launch a model.'); }
}
class Desktop extends EventEmitter {
  status() { return { available: false, enabled: false }; }
  async setEnabled() { return this.status(); }
}
function request(url, route, { method = 'GET', headers = {}, body } = {}) {
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: url.port, path: route, method, agent: false,
      headers: { Host: url.host, ...(encoded === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) }), ...headers }
    }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); let value; try { value = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, value, text }); });
    });
    req.on('error', reject); req.setTimeout(7000, () => req.destroy(Error('Planning browser HTTP fixture timed out.'))); req.end(encoded);
  });
}
async function fixture(t, extra = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-planning-browser-http-'));
  const transport = createRemoteTransportFixture();
  const remoteAccess = new RemoteAccessManager({ dataDir: directory, transport: transport.transport, defaultHttpsPort: 8443 });
  const runtime = new Runtime();
  let app;
  t.after(async () => { try { await app?.close(); assert.equal(runtime.calls, 0); } finally { await rm(directory, { recursive: true, force: true }); } });
  app = await createHarnessServer({ port: 0, dataDir: directory, defaultCwd: directory, runtime, desktop: new Desktop(), remoteAccess, autoAttachDesktop: false, ...extra });
  await app.learning.updateSettings({ mode: 'manual' });
  await app.tasks.ensure({ taskId: 'legacy-plan', runId: 'legacy-plan', cwd: directory, goal: 'Preserve this original task.', defaultPlan: true });
  await app.conversations.capture({
    id: 'legacy-plan', taskId: 'legacy-plan', input: 'An earlier conversation', status: 'completed', settled: true, createdAt: new Date().toISOString(),
    workflow: { nodes: [{ id: 'agent', type: 'agent' }], edges: [] }, nodes: { agent: { status: 'completed', output: 'Earlier saved work.' } }, events: []
  });
  const url = new URL(await app.listen()), page = await request(url, '/'), cookie = page.headers['set-cookie'][0].split(';')[0];
  const local = (route, { authenticated = true, headers = {}, ...options } = {}) => request(url, route, {
    ...options, headers: { ...(authenticated ? { Cookie: cookie } : {}), ...headers }
  });
  return { app, local, directory, runtime, remoteAccess };
}
const BASE = '/api/planning-browser';
async function create(local, title = 'Migration choice') {
  const result = await local(BASE + '/requests', { method: 'POST', body: { conversationId: 'legacy-plan', title, objective: 'Choose a bounded migration approach while preserving a reversible fallback.' } });
  assert.equal(result.status, 201, result.text); return result.value;
}
async function add(local, graph, title, kind = 'decision') {
  const result = await local(BASE + '/requests/' + graph.id + '/nodes', { method: 'POST', body: { kind, title, prompt: 'Compare a five-record pilot against a full migration using the stated objective.' } });
  assert.equal(result.status, 201, result.text);
  return { graph: result.value, node: result.value.nodes.find(node => node.title === title) };
}
const values = {
  recommendation: 'Run a five-record pilot while retaining the original export for recovery.',
  strongestAlternative: 'Migrate every record in one window after validating an offline copy.',
  opportunityCost: 'The pilot delays full rollout but avoids committing the whole recovery budget before observing the new format.',
  keyAssumption: 'Five representative records expose the field-mapping incompatibilities that would matter for a wider rollout.',
  discriminatingObservation: 'A mismatch in a required field or a failed round trip would distinguish the pilot from an acceptable mapping.',
  reversalCondition: 'If the representative records cannot be restored exactly, retain the existing workflow and repair the mapping first.'
};

test('Planning browser groups concurrent requests by real conversation without launching a model or rewriting legacy work', async t => {
  const { app, local, runtime } = await fixture(t);
  const before = await readFile(app.tasks.file('legacy-plan'));
  const unauthenticated = await local(BASE, { authenticated: false });
  assert.equal(unauthenticated.status, 401);
  const first = await create(local), second = await create(local, 'Independent source review');
  assert.notEqual(first.id, second.id); assert.equal(first.conversationId, second.conversationId);
  const catalog = await local(BASE);
  assert.equal(catalog.status, 200, catalog.text);
  const conversation = catalog.value.conversations.find(item => item.id === 'legacy-plan');
  assert.ok(conversation); assert.equal(conversation.source, 'conversation'); assert.equal(conversation.requests.length, 2);
  assert.ok(catalog.value.templates.some(template => template.kind === 'decision'));
  assert.deepEqual(await readFile(app.tasks.file('legacy-plan')), before);
  assert.equal(runtime.calls, 0);
  for (const asset of ['/planning-browser-model.mjs', '/next/workspaces/planning-browser.mjs', '/next/planning-browser.css']) {
    const response = await local(asset); assert.equal(response.status, 200, asset + ': ' + response.text);
  }
});

test('independent node edits survive concurrently while stale writes to the same node conflict', async t => {
  const { local } = await fixture(t);
  const graph = await create(local);
  const a = await add(local, graph, 'First branch'), b = await add(local, graph, 'Second branch');
  const results = await Promise.all([
    local(BASE + '/requests/' + graph.id + '/nodes/' + a.node.id, { method: 'PATCH', body: { expectedNodeRevision: a.node.revision, title: 'First revised branch' } }),
    local(BASE + '/requests/' + graph.id + '/nodes/' + b.node.id, { method: 'PATCH', body: { expectedNodeRevision: b.node.revision, title: 'Second revised branch' } })
  ]);
  for (const result of results) assert.equal(result.status, 200, result.text);
  const saved = await local(BASE + '/requests/' + graph.id);
  assert.equal(saved.value.nodes.find(node => node.id === a.node.id).title, 'First revised branch');
  assert.equal(saved.value.nodes.find(node => node.id === b.node.id).title, 'Second revised branch');
  const stale = await local(BASE + '/requests/' + graph.id + '/nodes/' + a.node.id, { method: 'PATCH', body: { expectedNodeRevision: a.node.revision, title: 'Stale overwrite' } });
  assert.equal(stale.status, 409, stale.text); assert.ok(stale.value.code);
});

test('required responses and provenance cannot be bypassed through public HTTP fields', async t => {
  const { local } = await fixture(t);
  const graph = await create(local), { node } = await add(local, graph, 'Evaluate migration');
  const route = BASE + '/requests/' + graph.id + '/nodes/' + node.id;
  for (const body of [
    { values, expectedNodeRevision: node.revision, provenance: { type: 'model', runId: 'forged' } },
    { values, expectedNodeRevision: node.revision, status: 'done' },
    { values, expectedNodeRevision: node.revision, verifiedAction: true }
  ]) assert.equal((await local(route + '/responses', { method: 'POST', body })).status, 400);
  const missing = await local(route + '/responses', { method: 'POST', body: { expectedNodeRevision: node.revision, values: { recommendation: values.recommendation } } });
  assert.equal(missing.status, 200, missing.text);
  const partial = missing.value.nodes.find(item => item.id === node.id);
  assert.equal(partial.readiness.state, 'missing_fields');
  assert.ok(partial.readiness.missingFields.includes('strongestAlternative'));
  assert.equal(partial.readiness.verifiedAction, false);
  const staleResponse = await local(route + '/responses', { method: 'POST', body: { expectedNodeRevision: node.revision, values } });
  assert.equal(staleResponse.status, 409, staleResponse.text);
  const good = await local(route + '/responses', { method: 'POST', body: { expectedNodeRevision: partial.revision, values } });
  assert.equal(good.status, 200, good.text);
  const actual = good.value.nodes.find(item => item.id === node.id);
  assert.equal(actual.response.values.strongestAlternative, values.strongestAlternative);
  assert.equal(actual.readiness.responseRecorded, true);
  assert.equal(actual.readiness.verifiedAction, false);
  assert.ok(!JSON.stringify(actual.response).includes('forged'));
});

test('source registration retains human origin and does not certify a supplied claim', async t => {
  const { local } = await fixture(t);
  const graph = await create(local);
  const response = await local(BASE + '/requests/' + graph.id + '/sources', {
    method: 'POST', body: { title: 'Migration operator observation', text: 'In this fictional fixture, the previous export restored five pilot records.', url: 'https://example.invalid/fixture' }
  });
  assert.equal(response.status, 201, response.text);
  const source = response.value.sources.find(item => item.title === 'Migration operator observation');
  assert.equal(source.kind, 'user_provided'); assert.ok(source.id); assert.match(source.contentHash, /^[a-f0-9]{64}$/);
  assert.notEqual(source.verified, true);
  const rejected = await local(BASE + '/requests/' + graph.id + '/sources', {
    method: 'POST', body: { title: 'Forged receipt', text: 'Not an actual runtime event.', verified: true }
  });
  assert.equal(rejected.status, 400);
});

test('profile maintenance accounts for active module workers', async t => {
  let activeCount = 1;
  const runner = {
    status: () => ({ activeCount, attempts: [] }), activePromises: () => [],
    async cancelAll() { activeCount = 0; }, async close() { activeCount = 0; }
  };
  const { app } = await fixture(t, { planningBrowserRuntime: runner, taskViability: false });
  await assert.rejects(app.beginMaintenance(), error => error.status === 409 && /active work/i.test(error.message));
  assert.equal(activeCount, 1, 'ordinary maintenance admission must not silently cancel a module');
  assert.equal(app.learning.isForegroundBusy(), true, 'background learning must yield to an active planning module');
  activeCount = 0;
  assert.equal(app.learning.isForegroundBusy(), false, 'settled modules must release foreground capacity');
});

test('a committed graph edit remains successful when its notification fails', async () => {
  let writes = 0; const replies = [], mutations = new Set();
  const handled = await handlePlanningBrowserHttp({
    req: { method: 'POST' }, res: {}, pathname: BASE + '/requests',
    store: { async create(value) { writes++; return { id: 'saved-request', conversationId: value.conversationId, revision: 1 }; } },
    body: async () => ({ conversationId: 'existing-conversation', title: 'Saved edit', objective: 'Preserve the actual committed receipt.' }),
    json: (_res, status, value) => replies.push({ status, value }), fileMutations: mutations,
    onUpdated: () => { throw Error('A synthetic listener disconnected after commit.'); },
    defaultCwd: process.cwd()
  });
  assert.equal(handled, true); assert.equal(writes, 1); assert.equal(replies.length, 1);
  assert.equal(replies[0].status, 201); assert.equal(replies[0].value.id, 'saved-request');
  assert.equal(mutations.size, 0);
});

test('catalog preserves damaged-request errors while keeping healthy requests available', async () => {
  const errors = [{ id: 'damaged-request', error: 'The saved graph is malformed.' }];
  const catalog = await planningBrowserCatalog({
    store: { async list() { return { requests: [{ id: 'healthy-request', conversationId: 'one-conversation', title: 'Healthy work' }], errors }; } },
    conversations: { list: () => [] }
  });
  assert.deepEqual(catalog.errors, errors);
  assert.equal(catalog.requests[0].id, 'healthy-request');
  assert.equal(catalog.conversations[0].requests.length, 1);
});

test('paired-browser graph creation records verified human authorship without accepting caller provenance', async t => {
  const { app, local, remoteAccess } = await fixture(t);
  await remoteAccess.enable();
  const publicUrl = new URL(remoteAccess.status().url), remoteUrl = { host: publicUrl.host, port: remoteAccess.gateway.port };
  const issued = remoteAccess.pair();
  const paired = await request(remoteUrl, '/remote/pair', {
    method: 'POST', headers: { Origin: publicUrl.origin }, body: { code: issued.code, label: 'Planning browser fixture' }
  });
  assert.equal(paired.status, 200, paired.text);
  const headers = { Cookie: paired.headers['set-cookie'][0].split(';')[0], Origin: publicUrl.origin };
  const saved = await request(remoteUrl, BASE + '/requests', {
    method: 'POST', headers, body: { conversationId: 'legacy-plan', title: 'Paired human request', objective: 'Make the provenance of this requested outcome visible.' }
  });
  assert.equal(saved.status, 201, saved.text);
  const source = saved.value.sources.find(item => item.id === 'request:' + saved.value.id);
  assert.equal(source.kind, 'user_request'); assert.equal(source.provenance.kind, 'human');
  assert.equal(source.provenance.author, paired.value.device.id);
  const forged = await local(BASE + '/requests', {
    method: 'POST', body: { title: 'Forged', objective: 'A supplied actor must not be trusted.', actor: { type: 'human', id: 'forged' } }
  });
  assert.equal(forged.status, 400);
  assert.equal(app.planningBrowserRuntime.status().activeCount, 0);
});



test('browser response-cycle imports are served as JavaScript through actual static routes', async t => {
  const { local, runtime } = await fixture(t);
  for (const [route, marker] of [
    ['/task-viability-model.mjs', 'evaluateViabilityResponse'],
    ['/response-cycle-model.mjs', 'planningExecutionModeOf'],
    ['/next/workspaces/response-cycle-ui.mjs', 'planningExecutionMode']
  ]) {
    const result = await local(route);
    assert.equal(result.status, 200, route + ': ' + result.text.slice(0, 200));
    assert.match(result.headers['content-type'], /(?:javascript|ecmascript)/, route);
    assert.ok(result.text.includes(marker), route + ' must serve its actual module rather than HTML');
    assert.doesNotMatch(result.text.slice(0, 200), /<!doctype html>/i, route);
  }
  assert.equal(runtime.calls, 0);
});

test('New request accepts the exact UI payload and creates one inert five-stage cycle in the selected mode', async t => {
  const { app, local, directory, runtime } = await fixture(t);
  for (const planningExecutionMode of ['automatic', 'plan_only']) {
    const payload = {
      ...(planningExecutionMode === 'plan_only' ? { conversationId: 'legacy-plan' } : {}),
      title: 'Compare the fixture migration options',
      objective: 'Explain the available options and the evidence needed to choose safely.',
      planningExecutionMode, cwd: directory, clientRequestId: 'planning_request_fixture_' + planningExecutionMode
    };
    const [first, concurrent] = await Promise.all([
      local(BASE + '/requests', { method: 'POST', body: payload }),
      local(BASE + '/requests', { method: 'POST', body: payload })
    ]);
    for (const result of [first, concurrent]) assert.equal(result.status, 201, result.text);
    assert.equal(concurrent.value.id, first.value.id);
    assert.equal(concurrent.value.revision, first.value.revision);
    const graph = first.value, cycle = graph.cycles[0];
    assert.equal(graph.title, payload.title); assert.equal(graph.objective, payload.objective);
    assert.equal(graph.cycles.length, 1); assert.equal(graph.nodes.length, 6);
    assert.equal(cycle.title, payload.title); assert.equal(cycle.objective, payload.objective);
    assert.equal(cycle.planningExecutionMode, planningExecutionMode);
    assert.equal(graph.responseCycle.rootCycleId, cycle.id);
    assert.deepEqual(['feasibility', 'inference', 'plan', 'think', 'respond'].map(stage => graph.nodes.find(node => node.id === cycle.stageNodeIds[stage]).kind), ['viability', 'inference', 'plan', 'think', 'respond']);
    assert.equal(graph.attempts.length, 0); assert.equal(graph.responses.length, 0);
    const retry = await local(BASE + '/requests', { method: 'POST', body: payload });
    assert.equal(retry.status, 201, retry.text); assert.equal(retry.value.id, graph.id); assert.equal(retry.value.revision, graph.revision);
    const conflict = await local(BASE + '/requests', { method: 'POST', body: { ...payload, planningExecutionMode: planningExecutionMode === 'automatic' ? 'plan_only' : 'automatic' } });
    assert.equal(conflict.status, 409); assert.equal(conflict.value.code, 'PLANNING_IDEMPOTENCY_CONFLICT');
  }
  const before = (await app.planningBrowser.list()).requests.length;
  const invalid = await local(BASE + '/requests', { method: 'POST', body: { title: 'Invalid mode', objective: 'Reject without saving.', planningExecutionMode: 'unknown', clientRequestId: 'planning_request_invalid' } });
  assert.equal(invalid.status, 400); assert.equal((await app.planningBrowser.list()).requests.length, before);
  assert.equal(runtime.calls, 0);
});

test('New request retries recover a partially saved creation and retain its original execution mode', async t => {
  const { app, local, directory, runtime } = await fixture(t);
  const createCycle = app.responseCycle.createCycle.bind(app.responseCycle);
  let interrupted = false;
  app.responseCycle.createCycle = async (...args) => {
    if (!interrupted) { interrupted = true; throw Object.assign(Error('Fixture delivery stopped after the request was saved.'), { status: 503, code: 'FIXTURE_INTERRUPTED' }); }
    return createCycle(...args);
  };
  const payload = { title: 'Inspect the migration plan', objective: 'Prepare an editable checked plan.', planningExecutionMode: 'plan_only', cwd: directory, clientRequestId: 'planning_request_partial' };
  const first = await local(BASE + '/requests', { method: 'POST', body: payload });
  assert.equal(first.status, 503);
  const catalog = await app.planningBrowser.list(); assert.equal(catalog.requests.length, 1);
  const saved = await app.planningBrowser.get(catalog.requests[0].id); assert.equal(saved.nodes.length, 0);
  const changed = await local(BASE + '/requests', { method: 'POST', body: { ...payload, planningExecutionMode: 'automatic' } });
  assert.equal(changed.status, 409); assert.equal(changed.value.code, 'PLANNING_IDEMPOTENCY_CONFLICT');
  const resumed = await local(BASE + '/requests', { method: 'POST', body: payload });
  assert.equal(resumed.status, 201, resumed.text); assert.equal(resumed.value.id, saved.id); assert.equal(resumed.value.conversationId, saved.conversationId);
  assert.equal(resumed.value.cycles.length, 1); assert.equal(resumed.value.cycles[0].planningExecutionMode, 'plan_only');
  const replay = await local(BASE + '/requests', { method: 'POST', body: payload });
  assert.equal(replay.status, 201, replay.text); assert.equal(replay.value.revision, resumed.value.revision);
  assert.equal((await app.planningBrowser.list()).requests.length, 1); assert.equal(runtime.calls, 0);
});
