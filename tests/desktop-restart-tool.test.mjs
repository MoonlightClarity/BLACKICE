import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { desktopRestartTool } from '../lib/desktop-restart-tool.mjs';

const client = { id: 'restart-owner', kind: 'chatgpt', scopes: ['read', 'commands:run'] };
const held = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const scheduled = ({ requestId, jobId }) => ({ requestId, jobId, status: 'scheduled' });

test('restart tool schema requires one stable request ID and existing command authority', () => {
  const { definition } = desktopRestartTool({ restart: { request() {} }, getJob() {} });
  assert.equal(definition.name, 'blackice_restart'); assert.equal(definition.scope, 'commands:run');
  assert.deepEqual(definition.requiredScopes, ['commands:run']); assert.equal(definition.mutating, true);
  assert.deepEqual(definition.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
  assert.deepEqual(Object.keys(definition.inputSchema.properties), ['requestId', 'force']);
  assert.deepEqual(definition.inputSchema.required, ['requestId']); assert.equal(definition.inputSchema.additionalProperties, false);
  const id = definition.inputSchema.properties.requestId;
  assert.equal(id.minLength, 1); assert.equal(id.maxLength, 120);
  assert.match('restart-20261021:one', new RegExp(id.pattern));
  for (const value of ['', ' restart', 'restart/one', 'a'.repeat(121)]) assert.doesNotMatch(value, new RegExp(id.pattern));
  assert.match(definition.description, /scheduling, not completed restart/);
  assert.match(definition.description, /preserving the current profile and mode/);
  assert.equal(definition.inputSchema.properties.force.type, 'boolean');
  assert.match(definition.description, /active work blocks restart/);
  assert.match(definition.description, /pause automatic queues and stop cancellable work/);
});

test('restart tool returns only its scheduling receipt and defers raw job reads to the controller', async () => {
  const signal = new AbortController().signal, jobId = `direct_${'a'.repeat(64)}`;
  const rawJob = { id: jobId, status: 'succeeded', result: { success: true } };
  const reads = []; let received;
  const tool = desktopRestartTool({
    restart: { request: async value => { received = value; return scheduled(value); } },
    getJob: async id => { reads.push(id); return rawJob; },
  });
  const result = await tool.execute({ requestId: 'scheduled-once' }, { signal, jobId, client });
  assert.deepEqual(Object.keys(received).sort(), ['force', 'jobId', 'ownerId', 'requestId', 'signal', 'waitForReceipt']);
  assert.equal(received.force, false);
  assert.equal(received.requestId, 'scheduled-once'); assert.equal(received.ownerId, client.id);
  assert.equal(received.jobId, jobId); assert.equal(received.signal, signal); assert.deepEqual(reads, []);
  assert.deepEqual(result, { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(scheduled(received)) }] });
  assert.equal(await received.waitForReceipt(), rawJob); assert.deepEqual(reads, [jobId]);
});

test('restart tool preserves controller refusal and cancellation without returning a success receipt', async () => {
  const controller = new AbortController(), jobId = `direct_${'b'.repeat(64)}`;
  const refusal = Object.assign(new Error('Active work prevents restart.'), { code: 'DESKTOP_RESTART_BUSY' });
  const cancelled = Object.assign(new Error('Cancelled.'), { code: 'ABORT_ERR', name: 'AbortError' });
  for (const error of [refusal, cancelled]) {
    let reads = 0;
    const tool = desktopRestartTool({ restart: { request: async ({ signal }) => { assert.equal(signal, controller.signal); throw error; } }, getJob: () => { reads++; } });
    await assert.rejects(tool.execute({ requestId: 'refused-restart' }, { signal: controller.signal, jobId, client }), actual => actual === error);
    assert.equal(reads, 0);
  }
});

async function apiHarness(t, options = {}) {
  // Keep the factory tests usable without loading desktop/browser dependencies.
  const { DirectExecutionAPI } = await import('../lib/direct-execution-api.mjs');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'blackice-restart-tool-')), instances = [];
  const make = overrides => { const api = new DirectExecutionAPI({ dataDir, ...options, ...overrides }); instances.push(api); return api; };
  t.after(async () => { await Promise.allSettled(instances.map(api => api.close())); await rm(dataDir, { recursive: true, force: true }); });
  return { make, dataDir };
}

async function waitJob(api, jobId) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { const value = await api.getJob(jobId, client); if (value.settled) return value; await sleep(5); }
  throw new Error(`Restart job did not settle: ${jobId}`);
}

test('API enforces restart scope and exact schema before admitting any job', async t => {
  const { make } = await apiHarness(t); let calls = 0, api;
  const restart = { request: async value => { calls++; return scheduled(value); } };
  api = make({ additionalTools: [desktopRestartTool({ restart, getJob: id => api.jobs.get(id) })] });
  const read = { ...client, scopes: ['read'] };
  assert.equal(api.tools(read).some(tool => tool.name === 'blackice_restart'), false);
  assert.equal(api.tools(client).some(tool => tool.name === 'blackice_restart'), true);
  await assert.rejects(api.call('blackice_restart', { requestId: 'read-denied' }, read), { code: 'DIRECT_SCOPE_REQUIRED', scope: 'commands:run' });
  for (const args of [{}, { requestId: '' }, { requestId: 'bad/id' }, { requestId: 'a'.repeat(121) }, ...['approved', 'approval', 'override'].map(key => ({ requestId: `extra-${key}`, [key]: true })), ...[null, 'true', 1].map(force => ({ requestId: 'invalid-force', force }))]) {
    await assert.rejects(api.call('blackice_restart', args, client), { code: 'DIRECT_REQUEST_INVALID' });
  }
  assert.equal(calls, 0); assert.equal((await api.status(client)).jobs.total, 0);
  const standalone = make();
  assert.equal(standalone.tools(client).some(tool => tool.name === 'blackice_restart'), false);
  await assert.rejects(standalone.call('blackice_restart', { requestId: 'standalone' }, client), { code: 'DIRECT_TOOL_UNKNOWN' });
});

test('API force restart forwards an explicit choice and retries the exact same request once', async t => {
  const started = held(), release = held(); t.after(() => release.resolve());
  const { make } = await apiHarness(t);
  let calls = 0, received, api;
  const restart = { request: async value => { calls++; received = value; started.resolve(); await release.promise; return { ...scheduled(value), force: value.force }; } };
  api = make({ additionalTools: [desktopRestartTool({ restart, getJob: id => api.jobs.get(id) })] });
  const args = { requestId: 'force-restart-once', force: true };
  const first = await api.call('blackice_restart', args, client);
  await started.promise;
  assert.equal(received.force, true);
  const same = await api.call('blackice_restart', args, client);
  assert.equal(same.existing, true); assert.equal(same.jobId, first.jobId); assert.equal(calls, 1);
  await assert.rejects(api.call('blackice_restart', { ...args, force: false }, client), { code: 'DIRECT_REQUEST_CONFLICT' });
  release.resolve();
  const done = await waitJob(api, first.jobId);
  assert.equal(done.status, 'succeeded');
  assert.equal(JSON.parse(done.result.text.text).force, true);
});

test('API saves a restart scheduling receipt and identical retries never execute again across reopen', async t => {
  const started = held(), release = held(); t.after(() => release.resolve());
  const { make } = await apiHarness(t);
  let calls = 0, received, api;
  const restart = { request: async value => { calls++; received = value; started.resolve(); await release.promise; return scheduled(value); } };
  api = make({ additionalTools: [desktopRestartTool({ restart, getJob: id => api.jobs.get(id) })] });
  const args = { requestId: 'durable-restart' }, first = await api.call('blackice_restart', args, client);
  await started.promise;
  const retry = await api.call('blackice_restart', args, client);
  assert.equal(retry.existing, true); assert.equal(retry.jobId, first.jobId); assert.equal(calls, 1);
  assert.equal((await received.waitForReceipt()).status, 'running');
  release.resolve(); const done = await waitJob(api, first.jobId);
  assert.equal(done.status, 'succeeded'); assert.equal(done.interaction, null);
  assert.deepEqual(JSON.parse(done.result.text.text), scheduled({ requestId: args.requestId, jobId: first.jobId }));
  const raw = await received.waitForReceipt();
  assert.equal(raw.status, 'succeeded'); assert.equal(raw.result.contentItems[0].text, done.result.text.text);
  assert.equal((await api.call('blackice_restart', args, client)).existing, true); assert.equal(calls, 1);
  await api.close();
  let reopened;
  reopened = make({ additionalTools: [desktopRestartTool({ restart, getJob: id => reopened.jobs.get(id) })] });
  const persisted = await reopened.call('blackice_restart', args, client);
  assert.equal(persisted.existing, true); assert.equal(persisted.jobId, first.jobId); assert.equal(persisted.status, 'succeeded');
  assert.equal((await reopened.getJob(first.jobId, client)).result.text.text, done.result.text.text); assert.equal(calls, 1);
});

test('API restart status exposes only coarse fields except for a currently authorized owned receipt', async t => {
  const { make } = await apiHarness(t), seen = [];
  const receipt = { id: 'restart-receipt-one', requestId: 'status-owned', jobId: `direct_${'c'.repeat(64)}`, ownerId: client.id, status: 'completed', origin: { profileDir: '/private/profile' } };
  const snapshot = { available: true, provider: 'electron', status: 'completed', receipt, error: { code: 'PRIVATE', message: 'private details' }, unexpected: '/private/other' };
  const api = make({ restartStatus: value => { seen.push(value); return snapshot; } });
  const coarse = { available: true, provider: 'electron', status: 'completed' }, read = { ...client, scopes: ['read'] };
  assert.deepEqual((await api.status(read)).restart, coarse);
  assert.deepEqual((await api.status({ ...client, id: 'another-owner' })).restart, coarse);
  assert.deepEqual((await api.status()).restart, coarse);
  const owned = (await api.call('blackice_direct_status', {}, client)).restart;
  assert.deepEqual(owned, { ...coarse, receipt });
  owned.receipt.origin.profileDir = 'changed by reader'; assert.equal(receipt.origin.profileDir, '/private/profile');
  assert.deepEqual(seen, [
    { ownerId: client.id, canRestart: false }, { ownerId: 'another-owner', canRestart: true },
    { ownerId: undefined, canRestart: false }, { ownerId: client.id, canRestart: true },
  ]);
  await api.close(); const standalone = make();
  assert.equal(Object.hasOwn(await standalone.status(client), 'restart'), false);
});

test('API restart status rechecks command authority before requesting and releasing an owned receipt', async t => {
  let commandAuthorized = false;
  const seen = [], receipt = { ownerId: client.id, requestId: 'private-request', status: 'scheduled' };
  const { make } = await apiHarness(t, { authorizeClient: (_client, { requiredScopes }) => commandAuthorized || !requiredScopes.includes('commands:run') });
  const api = make({ restartStatus: value => { seen.push(value); commandAuthorized = false; return { available: true, provider: 'electron', status: 'scheduled', receipt }; } });
  assert.deepEqual((await api.status(client)).restart, { available: true, provider: 'electron', status: 'scheduled' });
  assert.equal(seen[0].canRestart, false);
  commandAuthorized = true;
  await assert.rejects(api.call('blackice_direct_status', {}, client), { code: 'DIRECT_AUTH_REQUIRED' });
  assert.equal(seen[1].canRestart, true);
});

test('API and desktop controller hand off only after the durable job succeeds and never replay after startup', async t => {
  const { DesktopRestartController } = await import('../desktop/restart.mjs');
  const { make, dataDir } = await apiHarness(t), nativeCalls = [], savedAtNativeCall = [];
  const origin = { pid: 11001, startedAt: '2026-10-21T01:00:00.000Z', profileDir: dataDir, mode: 'background' };
  const next = { ...origin, pid: 11002, startedAt: '2026-10-21T01:01:00.000Z' };
  let jobId, api;
  const observeSavedJob = () => savedAtNativeCall.push(JSON.parse(readFileSync(path.join(dataDir, 'direct-execution-jobs', `${jobId}.json`), 'utf8')));
  const controllerOptions = identity => ({
    profileDir: dataDir, getIdentity: () => identity,
    getLaunchOptions: () => ({ execPath: process.execPath, args: ['--profile-dir', dataDir, '--background'], profileDir: dataDir, mode: identity.mode }),
    checkReady: async () => {}, prepare: async () => {},
    relaunch: options => { observeSavedJob(); nativeCalls.push({ action: 'relaunch', options }); },
    quit: () => { observeSavedJob(); nativeCalls.push({ action: 'quit' }); },
    pollMs: 1, receiptTimeoutMs: 5000,
  });
  const restart = new DesktopRestartController(controllerOptions(origin));
  await restart.init();
  api = make({
    additionalTools: [desktopRestartTool({ restart, getJob: id => api.jobs.get(id) })],
    restartStatus: ({ ownerId, canRestart }) => restart.status({ ownerId: canRestart ? ownerId : undefined }),
  });
  const args = { requestId: 'real-controller-restart' }, admitted = await api.call('blackice_restart', args, client); jobId = admitted.jobId;
  const done = await waitJob(api, jobId), handedOff = await restart.waitForHandoff();
  assert.equal(done.status, 'succeeded'); assert.equal(JSON.parse(done.result.text.text).status, 'scheduled');
  assert.equal(handedOff.status, 'restarting'); assert.deepEqual(nativeCalls.map(value => value.action), ['relaunch', 'quit']);
  assert.equal(savedAtNativeCall.length, 2);
  for (const saved of savedAtNativeCall) {
    assert.equal(saved.id, jobId); assert.equal(saved.status, 'succeeded'); assert.ok(saved.finishedAt);
    assert.equal(JSON.parse(saved.result.contentItems[0].text).status, 'scheduled');
  }
  assert.deepEqual(nativeCalls[0].options, { execPath: process.execPath, args: ['--profile-dir', dataDir, '--background'] });
  await api.close();

  const recovered = new DesktopRestartController(controllerOptions(next));
  await recovered.init(); await recovered.confirmStartup();
  const completed = recovered.status({ ownerId: client.id }).receipt;
  assert.equal(completed.status, 'completed'); assert.equal(completed.requestId, args.requestId); assert.equal(completed.jobId, jobId);
  assert.deepEqual(completed.origin, origin); assert.deepEqual(completed.started, next); assert.ok(completed.completedAt);
  let reopened;
  reopened = make({
    additionalTools: [desktopRestartTool({ restart: recovered, getJob: id => reopened.jobs.get(id) })],
    restartStatus: ({ ownerId, canRestart }) => recovered.status({ ownerId: canRestart ? ownerId : undefined }),
  });
  const replay = await reopened.call('blackice_restart', args, client);
  assert.equal(replay.existing, true); assert.equal(replay.jobId, jobId); assert.equal(replay.status, 'succeeded');
  assert.equal((await reopened.call('blackice_direct_status', {}, client)).restart.receipt.status, 'completed');
  assert.deepEqual(nativeCalls.map(value => value.action), ['relaunch', 'quit']);
  assert.equal(recovered.status({ ownerId: client.id }).receipt.id, completed.id);
});
