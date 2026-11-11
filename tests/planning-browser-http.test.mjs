import {planningModuleTemplate} from '../public/planning-browser-model.mjs';
import {responseCycleStage,RESPONSE_CYCLE_STAGES} from '../public/response-cycle-model.mjs';
import {fixtureUserAgency} from './fixture-user-agency.mjs';
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
import { WindowsWorkbench } from '../lib/windows-workbench.mjs';
import { WorkbenchGuestBridge } from '../lib/workbench-guest-bridge.mjs';
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
  const workbenchCalls={probes:0,commands:0};
  // Keep the real HTTP, Workbench and guest-file contracts. Only the OS
  // boundary is deterministic: this unit fixture must not query a user's VM.
  const workbench=new WindowsWorkbench({dataDir:directory,sharedRoot:directory,
    probe:async()=>{workbenchCalls.probes++;return {
      windows:true,edition:'Windows 11 Pro fixture',hostName:'FIXTUREHOST',
      logicalProcessors:8,totalMemoryMiB:16384,freeMemoryMiB:12000,freeDiskGiB:100,
      hypervisorPresent:true,hyperVModuleInstalled:true,hyperVFeatureEnabled:true,
      vmServiceRunning:true,vmQueryAuthorized:true,processElevated:false,
      vmExists:false,vmState:'NotInstalled',shareExists:false,sharePath:''
    }},
    command:async()=>{workbenchCalls.commands++;throw Error('HTTP fixtures must not execute host commands.');},
    mediaInspector:async()=>{throw Error('This owned fixture has no installation media.');},
    guestBridgeFactory:({sharedRoot})=>{assert.equal(path.resolve(sharedRoot),path.resolve(directory));return new WorkbenchGuestBridge({sharedRoot});}
  });
  let app;
  t.after(async () => { try { await app?.close(); assert.equal(runtime.calls, 0); assert.equal(workbenchCalls.commands,0); } finally { await rm(directory, { recursive: true, force: true }); } });
  app = await createHarnessServer({ port: 0, dataDir: directory, defaultCwd: directory, runtime, desktop: new Desktop(), remoteAccess, workbench, autoAttachDesktop: false, ...extra });
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


test('Workbench repeatable app-sync endpoints expose history and reject any installation before guest pairing',async t=>{
  const {local}=await fixture(t);
  const empty=await local('/api/workbench/app-sync');
  assert.equal(empty.status,200);
  assert.equal(empty.value.currentSnapshot,null);
  assert.deepEqual(empty.value.runs,[]);
  const start=await local('/api/workbench/app-sync/start',{method:'POST',body:{}});
  assert.equal(start.status,409,start.text);
  const repeat=await local('/api/workbench/app-sync/rebatch',{method:'POST',body:{}});
  assert.equal(repeat.status,409,repeat.text);
  const fake=await local('/api/workbench/app-sync/runs/00000000000000000000000000000000');
  assert.equal(fake.status,404);
  const ui=await local('/next/workspaces/workbench.mjs');
  assert.equal(ui.status,200);
  for(const element of ['wb-apps-scan','wb-apps-rebatch','wb-apps-retry'])
    assert.ok(ui.text.includes(element),element);
});
test('Workbench guest endpoints never execute a host app when no interactive Windows guest is paired',async t=>{
  const {local,runtime}=await fixture(t);
  const initial=await local('/api/workbench');
  assert.equal(initial.status,200);
  const unpaired=await local('/api/workbench/pair',{method:'POST',body:{}});
  assert.equal(unpaired.status,409);
  const refused=await local('/api/workbench/guest-command',{method:'POST',
    body:{kind:'launch',args:{appPath:'C:\\Windows\\System32\\notepad.exe'}}});
  assert.equal(refused.status,409);
  const noMedia=await local('/api/workbench/provision',{method:'POST',body:{}});
  assert.equal(noMedia.status,409);
  const missingFrame=await local('/api/workbench/frame/00000000000000000000000000000000');
  assert.equal(missingFrame.status,404);
  const agent=await local('/api/workbench/prepare-agent',{method:'POST',body:{}});
  assert.equal(agent.status,200,agent.text);
  assert.equal(agent.value.prepared,true);
  const after=await local('/api/workbench');
  assert.equal(after.status,200);
  assert.equal(after.value.canRunNativeApps,false);
  assert.equal(after.value.config.folders[0].guestMountVerified,false);
  assert.equal(runtime.calls,0,'Workbench setup must not invoke a model or job-search operation.');
});

test('Workbench tab and host capability API are available before Hyper-V provisioning, with revisioned shared-folder settings',async t=>{
  const {local,runtime}=await fixture(t);
  const anonymous=await local('/api/workbench',{authenticated:false});
  assert.equal(anonymous.status,401);
  const first=await local('/api/workbench');
  assert.equal(first.status,200,first.text);
  assert.equal(first.value.backend,'hyper-v');
  assert.equal(first.value.guest.displayReady,false);
  assert.equal(first.value.canRunNativeApps,false,'A VM that is running is not proof of a connected desktop.');
  assert.equal(first.value.config.folders[0].readWrite,true);
  for(const [uri,marker] of [
    ['/next/workspaces/workbench.mjs','createWorkbenchWorkspace'],
    ['/next/workbench.css','.next-workbench'],
  ]){
    const response=await local(uri);
    assert.equal(response.status,200,uri+': '+response.text.slice(0,200));
    assert.match(response.text,new RegExp(marker.replaceAll('.','\\.')));
  }
  assert.equal(first.value.resources.mode,'adaptive');
  assert.equal(Object.hasOwn(first.value.config,'profile'),false);
  const changed=await local('/api/workbench/config',{method:'POST',
    body:{expectedRevision:first.value.config.revision,mediaPath:'C:\\Installers\\Win11.iso'}});
  assert.equal(changed.status,200,changed.text);
  assert.equal(changed.value.config.mediaPath,'C:\\Installers\\Win11.iso');
  assert.equal(changed.value.config.revision,first.value.config.revision+1);
  const stale=await local('/api/workbench/config',{method:'POST',
    body:{expectedRevision:first.value.config.revision,mediaPath:'C:\\Different.iso'}});
  assert.equal(stale.status,409,stale.text);
  const unwanted=await local('/api/workbench/config',{method:'POST',
    body:{expectedRevision:changed.value.config.revision,profile:'intensive'}});
  assert.equal(unwanted.status,400,'Manual tuning profiles must no longer be accepted.');
  assert.equal((await local('/api/workbench')).value.config.mediaPath,'C:\\Installers\\Win11.iso');
  assert.equal(runtime.calls,0,'Workbench readiness never launches an agent.');
});

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
    async start() { assert.fail('Maintenance must not start a worker.'); }, async cancel() { assert.fail('Maintenance must not cancel an individual worker.'); },
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
    ['/planning-program-xml.mjs', 'parsePlanningProgramXml'],
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

test('full XML is exposed through a read-only GET and saved atomically through revision-bound PUT', async t => {
  const { local, runtime } = await fixture(t);
  const graph = await create(local);
  const { graph: withNode, node } = await add(local, graph, 'Compare reversible options');
  const route = BASE + '/requests/' + graph.id + '/program';
  const source = await local(route);
  assert.equal(source.status, 200, source.text);
  assert.equal(source.value.revision, withNode.revision);
  assert.match(source.value.xml, /<planning-program version="1"/);
  const xml = source.value.xml.replace('<title>Compare reversible options</title>', '<title>Compare evidence, not labels</title>');
  const changed = await local(route, { method: 'PUT', body: { expectedRevision: source.value.revision, xml, clientRequestId: 'xml-edit-once' } });
  assert.equal(changed.status, 200, changed.text);
  assert.equal(changed.value.nodes.find(item => item.id === node.id).title, 'Compare evidence, not labels');
  assert.equal(changed.value.revision, withNode.revision + 1);
  const repeated = await local(route, { method: 'PUT', body: { expectedRevision: source.value.revision, xml, clientRequestId: 'xml-edit-once' } });
  assert.equal(repeated.status, 200, repeated.text);
  assert.equal(repeated.value.revision, changed.value.revision);
  const stale = await local(route, { method: 'PUT', body: { expectedRevision: source.value.revision, xml, clientRequestId: 'xml-edit-stale' } });
  assert.equal(stale.status, 409, stale.text);
  const anonymous = await local(route, { method: 'PUT', authenticated: false, body: { expectedRevision: changed.value.revision, xml } });
  assert.equal(anonymous.status, 401, anonymous.text);
  assert.equal((await local(route)).value.revision, changed.value.revision);
  assert.equal(runtime.calls, 0, 'XML planning edits do not silently start models.');
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

test('Planning catalog keeps lifecycle and actual execution status distinct', async () => {
  const result = await planningBrowserCatalog({
    store: { list: async () => ({ requests: [] }) },
    conversations: { list: () => [
      { id: 'idle', state: 'active', status: 'completed', settled: true },
      { id: 'live', state: 'active', status: 'running', settled: false },
      { id: 'old', state: 'archived', status: 'failed', settled: true }
    ] }
  });
  assert.deepEqual(result.conversations.map(({ state, status, settled }) => ({ state, status, settled })), [
    { state: 'active', status: 'completed', settled: true },
    { state: 'active', status: 'running', settled: false },
    { state: 'archived', status: 'failed', settled: true }
  ]);
});

test('host wiring exposes native graph tools and keeps attached direct evidence local to verified readers', async t => {
  const f = await fixture(t), names = f.app.directExecution.tools().map(tool => tool.name);
  assert.ok(names.includes('blackice_planning_module'));
  assert.deepEqual(f.app.engine.nativePlanningTools.catalog.map(tool => tool.name), ['relay_planning_read', 'relay_planning_write', 'relay_planning_module']);
  const provider = await f.app.engine.nativePlanningTools({ taskId: 'legacy-plan', runId: 'native-run', nodeId: 'agent', canWrite: true });
  const snapshot = await provider.handle({ name: 'relay_planning_read', arguments: { requestId: 'native-read', action: 'list' } });
  assert.equal(JSON.parse(snapshot.contentItems[0].text).requests.total, 0);
  let projected = 0;
  f.app.directExecution.planSource.projectAttachedState = async state => {
    projected++;
    return { ...state, directExecution: { version: 1, provenance: 'host-direct-outcome-store', authority: 'evidence-projection-only', canonicalCompletionUnchanged: true, sourceStatus: 'current', measurement: { satisfied: false, confirmed: 0, criteria: [] }, bindings: [], operations: [] } };
  };
  const local = await f.local('/api/tasks/legacy-plan');
  assert.equal(local.status, 200); assert.equal(local.value.directExecution.authority, 'evidence-projection-only'); assert.equal(projected, 1);
  const authorize = f.remoteAccess.authorizeForward.bind(f.remoteAccess);
  f.remoteAccess.authorizeForward = req => req.headers['x-test-remote-reader'] ? { id: 'paired-fixture-reader', kind: 'browser' } : authorize(req);
  const remote = await f.local('/api/tasks/legacy-plan', { headers: { 'x-test-remote-reader': '1', 'x-blackice-remote': '1' } });
  assert.equal(remote.status, 200); assert.equal(remote.value.directExecution, undefined); assert.equal(projected, 1);
  const localList = await f.local('/api/planning'); assert.equal(localList.status, 200, localList.text); assert.ok(projected > 1);
  const afterLocal = projected;
  const remoteList = await f.local('/api/planning', { headers: { 'x-test-remote-reader': '1', 'x-blackice-remote': '1' } }); assert.equal(remoteList.status, 200); assert.equal(projected, afterLocal);
  f.remoteAccess.authorizeForward = () => null;
  for (const route of ['/api/tasks/legacy-plan', '/api/planning']) {
    const expired = await f.local(route, { headers: { 'x-blackice-remote': '1' } });
    assert.equal(expired.value?.directExecution, undefined); assert.equal(projected, afterLocal, 'Expired remote identity must never project local grant evidence.');
    assert.ok([200, 401, 403].includes(expired.status), expired.text);
  }
  f.app.directExecution.planSource.projectAttachedState = async () => { throw Object.assign(new Error('Revoked evidence grant'), { code: 'DIRECT_AUTH_REQUIRED' }); };
  const revoked = await f.local('/api/tasks/legacy-plan'); assert.equal(revoked.status, 200); assert.equal(revoked.value.directExecution, undefined);
});

test('host-context canonical Plan human response round trips through HTTP without execution',async t=>{
 const {app,local,runtime}=await fixture(t,{enableWorkbenchVideo:false});
 const graph=await create(local,'Canonical Plan'),cycleId='http-canonical',stages=Object.fromEntries(RESPONSE_CYCLE_STAGES.map(stage=>[stage.id,cycleId+'-'+stage.id])),nodeId=stages.plan;
 // Only a host-captured canonical cycle source selects this contract shape.
 // No worker or provider invocation is needed to author its human response.
 const configured=await app.planningBrowser.runtimeWriter().configureResponseCycle(graph.id,{
  createCycle:{id:cycleId,title:'Canonical Plan',objective:graph.objective,stageNodeIds:stages,parentCycleId:null,parentStageId:null,depth:0,pipelineVersion:2,planningExecutionMode:'plan_only',state:'pending',acceptanceCriteria:[],sourceIds:null,execution:{required:false,state:'not_required'}},
  sources:[{id:'cycle:execution-contract:'+cycleId,kind:'source',label:'Canonical authoring contract',text:JSON.stringify({taskSchemaVersion:14,contractVersion:2})}]});
 const added={node:configured.nodes.find(node=>node.id===nodeId)};
 const sourceId='request:'+graph.id,fields=planningModuleTemplate('plan',{pipelineVersion:2}).fields,stage=responseCycleStage('plan',{pipelineVersion:2});
 const contract={contractVersion:2,goal:'Read the supplied source and explain the bounded migration choice.',
  criteria:[{id:'inspect',kind:'observation',label:'Inspect source',description:'Read the supplied migration source.',resourceKey:'workspace:fixture'}],
  workItems:[{id:'review',title:'Review source',objective:'Read the supplied source.',owner:'coordinator',resourceKeys:['workspace:fixture'],effects:['observe'],dependsOn:[],criterionIds:['inspect']}],instructions:[]};
 const body={userAgency:fixtureUserAgency(),values:Object.fromEntries(fields.map(field=>[field.id,field.label+': inspect the supplied migration source and preserve the original recovery copy.'])),
  grounding:fields.filter(field=>field.grounding==='required').map(field=>({field:field.id,sourceId})),openQuestions:[],challengeResponses:[],subproblems:[],childResults:[],
  checks:stage.checks.map(check=>({id:check.id,assessment:check.when==='effects'?'not_applicable':'supported',sourceIds:check.grounding==='required'&&check.when!=='effects'?[sourceId]:[],note:'The bounded review preserves the requested outcome and its evidence requirements.'})),contract,expectedNodeRevision:added.node.revision};
 const route=BASE+'/requests/'+graph.id+'/nodes/'+nodeId+'/responses';
 const saved=await local(route,{method:'POST',body});assert.equal(saved.status,200,saved.text);
 const response=saved.value.nodes.find(node=>node.id===nodeId).response;
 assert.equal(response.contract.goal,contract.goal);assert.equal(response.contract.workItems[0].id,'review');assert.equal(response.provenance.kind,'human');assert.equal(response.verifiedAction,false);
 const reread=await local(BASE+'/requests/'+graph.id);assert.equal(reread.status,200,reread.text);
 assert.deepEqual(reread.value.nodes.find(node=>node.id===nodeId).response.contract,response.contract);
 const persisted=await app.planningBrowser.get(graph.id);assert.equal(persisted.attempts.length,0);assert.equal(runtime.calls,0);
 const revision=persisted.nodes.find(node=>node.id===nodeId).revision;
 const invalid=await local(route,{method:'POST',body:{...body,expectedNodeRevision:revision,contract:{...contract,workItems:[{...contract.workItems[0],criterionIds:['missing']}]}}});
 assert.equal(invalid.status,400,invalid.text);assert.equal((await app.planningBrowser.get(graph.id)).revision,persisted.revision);
 const stale=await local(route,{method:'POST',body});assert.equal(stale.status,409,stale.text);
 const independent=await add(local,graph,'Independent Plan','plan');
 const unsupported=await local(BASE+'/requests/'+graph.id+'/nodes/'+independent.node.id+'/responses',{method:'POST',body:{...body,expectedNodeRevision:independent.node.revision}});
 assert.equal(unsupported.status,400,unsupported.text);assert.equal(unsupported.value.code,'RESPONSE_CYCLE_INVALID');
 assert.equal((await app.planningBrowser.get(graph.id)).nodes.find(node=>node.id===independent.node.id).response,null);

});
