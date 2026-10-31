import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createHarnessServer } from '../server.mjs';
import { RemoteAccessManager } from '../lib/remote-access.mjs';
import { createRemoteTransportFixture } from './fixtures/remote-transport.mjs';

class Runtime extends EventEmitter {
  agentCalls = 0;
  status() { return { connected: false, authenticated: false, models: [] }; }
  async start() { return this.status(); } async close() {}
  async runAgent() { this.agentCalls++; throw Error('Connector management must not invoke a model.'); }
}
async function fixture(t, { prepare, serverOptions = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-connector-http-')), dataDir = path.join(root, 'data'); await fs.mkdir(dataDir);
  await prepare?.(dataDir);
  const transport = createRemoteTransportFixture(), remoteAccess = new RemoteAccessManager({ dataDir, transport: transport.transport, defaultHttpsPort: 8443 });
  const desktop = new EventEmitter(); desktop.status = () => ({ available: false, enabled: false }); desktop.setEnabled = async () => desktop.status();
  const runtime = new Runtime();
  const app = await createHarnessServer({ port: 0, dataDir, defaultCwd: path.join(root, 'workspace'), runtime, desktop, remoteAccess, autoAttachDesktop: false, ...serverOptions });
  const url = await app.listen(), home = await fetch(url), cookie = home.headers.get('set-cookie').split(';')[0]; await home.text();
  t.after(async () => { await app.close(); await fs.rm(root, { recursive: true, force: true }); });
  const request = (route, { body, headers = {}, method = body === undefined ? 'GET' : 'POST' } = {}) => fetch(url + route, { method, headers: { Cookie: cookie, ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { root, dataDir, app, runtime, url, request, cookie, transport };
}

const setupRoute = '/api/chatgpt-connector/open-chatgpt';
const pluginUrl = 'https://chatgpt.com/plugins';
const prepareRoute = '/api/chatgpt-connector/prepare';
const checkRoute = '/api/chatgpt-connector/check-connection';
const confirmRoute = '/api/chatgpt-connector/confirm-connection';
const prepareConnection = async f => { const response = await f.request(prepareRoute, { body: { confirmPublic: true } }); assert.equal(response.status, 200, await response.clone().text()); assert.equal((await response.json()).setup.ready, true); };
test('setup identifies missing Tailscale before preparation and reports its error code on failure', async t => {
  const f = await fixture(t, { serverOptions: { connectionStartup: { snapshot: async () => ({ available: true, checks: [{ key: 'tailscale', installed: false, ok: false }] }) } } });
  const state = await (await f.request('/api/chatgpt-connector')).json();
  assert.match(state.setup.checks.find(check => check.key === 'https').detail, /Tailscale is not installed.*sign in/i);
  f.app.remoteAccess.transport.inspect = async () => { throw Object.assign(new Error('Tailscale is not installed on this computer. Install Tailscale, sign in, and then retry ChatGPT connection setup.'), { code: 'REMOTE_TAILSCALE_MISSING', status: 503 }); };
  const response = await f.request(prepareRoute, { body: { confirmPublic: true } });
  assert.equal(response.status, 503);
  const error = await response.json(); assert.equal(error.code, 'REMOTE_TAILSCALE_MISSING'); assert.match(error.error, /Tailscale is not installed/);
  assert.equal(f.app.chatGPTConnector.enabled, false);
});
const turn = () => new Promise(resolve => setImmediate(resolve));
const held = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const rawStatus = (f, route, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request(f.url, { path: route, method: 'POST', headers: { Cookie: f.cookie, 'Content-Type': 'application/json', 'Content-Length': '2', ...headers } }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
  req.once('error', reject); req.end('{}');
});

const connectorGrantIds = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
async function approvedDirectGrants(f) {
  await prepareConnection(f);
  const now = new Date().toISOString(), expiresAt = new Date(Date.now() + 86400000).toISOString();
  const scopes = ['read', 'files:read', 'files:write', 'commands:run', 'browser:read', 'browser:write', 'planning:write'];
  const tokens = ['a', 'b'].map(character => 'blackice_at_' + character.repeat(43));
  // Disposable owner-approved grants exercise real authentication and scope lookup.
  await f.app.chatGPTOAuth.persist(connectorGrantIds.map((id, index) => ({ id, clientId: 'https://chatgpt.com/oauth/client.json', label: 'ChatGPT', resource: f.app.chatGPTConnector.origin + '/mcp/chatgpt', scopes: index ? ['read', 'files:read'] : [...scopes], createdAt: now, expiresAt, lastUsedAt: now, accessTokens: [{ hash: createHash('sha256').update(tokens[index]).digest('hex'), expiresAt }], refresh: { hash: String(index + 1).repeat(64), expiresAt, usedHashes: [] } })));
  return connectorGrantIds.map((id, index) => ({ client: f.app.chatGPTOAuth.getClient(id), token: tokens[index] }));
}
async function connectorResponse(f, grant, name, args) {
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 'fixture-tool', method: 'tools/call', params: { name, arguments: args } });
  const response = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: f.app.remoteAccess.gateway.port, path: '/mcp/chatgpt', method: 'POST', headers: { Host: new URL(f.app.chatGPTConnector.origin).host, Authorization: 'Bearer ' + grant.token, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; }); res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) }));
    });
    req.once('error', reject); req.end(payload);
  });
  return response;
}
async function connectorTool(f, grant, name, args) {
  const response = await connectorResponse(f, grant, name, args);
  assert.equal(response.status, 200); assert.equal(response.body.error, undefined);
  return response.body.result;
}
async function settledConnectorJob(f, grant, jobId) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await connectorTool(f, grant, 'blackice_get_job', { jobId });
    assert.equal(result.isError, false); const job = result.structuredContent;
    if (job.settled) return job;
    assert.notEqual(job.status, 'awaiting_input', 'authorized work must not request local approval');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('The disposable direct action did not settle.');
}

test('authenticated scoped commands and writes execute directly without a local approval setting', async t => {
  const f = await fixture(t), [grant] = await approvedDirectGrants(f);
  const status = await connectorTool(f, grant, 'blackice_direct_status', { nonce: 'no-local-action-approval' });
  assert.equal(status.isError, false); assert.equal(status.structuredContent.localMutationApproval, false);
  assert.equal(status.structuredContent.connectionId, grant.client.id); assert.deepEqual(status.structuredContent.grantedScopes, grant.client.scopes);
  const listing = await connectorTool(f, grant, 'blackice_run_command', { requestId: 'direct-list-without-approval', command: process.platform === 'win32' ? 'Get-ChildItem -Name' : 'ls', timeoutMs: 10000 });
  assert.equal(listing.isError, false); assert.notEqual(listing.structuredContent.status, 'awaiting_input');
  const command = await settledConnectorJob(f, grant, listing.structuredContent.jobId); assert.equal(command.status, 'succeeded');
  assert.equal(JSON.parse(command.result.text.text).exitCode, 0);
  const request = { requestId: 'direct-write-without-approval', action: 'write', path: 'scoped.txt', text: 'Direct scoped bytes.' };
  const write = await connectorTool(f, grant, 'blackice_workspace_write', request); assert.equal(write.isError, false); assert.notEqual(write.structuredContent.status, 'awaiting_input');
  const written = await settledConnectorJob(f, grant, write.structuredContent.jobId); assert.equal(written.status, 'succeeded');
  assert.equal(await fs.readFile(path.join(f.root, 'workspace', 'scoped.txt'), 'utf8'), request.text);
  const repeated = await connectorTool(f, grant, 'blackice_workspace_write', request); assert.equal(repeated.structuredContent.existing, true); assert.equal(repeated.structuredContent.jobId, written.jobId);
  const management = await (await f.request('/api/chatgpt-connector')).json(); assert.equal(management.pending.jobs.length, 0);
  await assert.rejects(fs.readFile(path.join(f.dataDir, 'direct-approval-policy.json')), { code: 'ENOENT' });
  assert.equal(f.runtime.agentCalls, 0); assert.equal(f.app.engine.listRuns().length, 0);
});

test('direct execution retains OAuth scopes and revocation while accepting explicit file paths', async t => {
  const f = await fixture(t), [grant, readOnly] = await approvedDirectGrants(f);
  const denied = await connectorTool(f, readOnly, 'blackice_workspace_write', { requestId: 'no-write-scope', action: 'write', path: 'denied.txt', text: 'Must not execute.' });
  assert.equal(denied.isError, true); assert.ok(denied._meta['mcp/www_authenticate']);
  await assert.rejects(fs.readFile(path.join(f.root, 'workspace', 'denied.txt')), { code: 'ENOENT' });
  const explicit = await connectorTool(f, grant, 'blackice_workspace_write', { requestId: 'explicit-file-path', action: 'write', path: path.join(f.root, 'outside.txt'), text: 'Explicit authorized path.' });
  assert.equal(explicit.isError, false); const written = await settledConnectorJob(f, grant, explicit.structuredContent.jobId);
  assert.equal(written.status, 'succeeded');
  assert.equal(await fs.readFile(path.join(f.root, 'outside.txt'), 'utf8'), 'Explicit authorized path.');
  await f.app.chatGPTOAuth.revoke(grant.client.id);
  const revoked = await connectorResponse(f, grant, 'blackice_run_command', { requestId: 'revoked-command', command: 'echo forbidden' });
  assert.equal(revoked.status, 401); assert.match(revoked.headers['www-authenticate'], /error="invalid_token"/);
  assert.equal(revoked.body.code, 'CHATGPT_AUTH_REQUIRED'); assert.equal(revoked.body.result, undefined);
  assert.deepEqual(f.app.chatGPTOAuth.getClient(readOnly.client.id).scopes, ['read', 'files:read']);
});

test('expired access receives HTTP 401 and refreshing the same grant preserves a running job and its retry receipt', async t => {
  const f = await fixture(t), [grant] = await approvedDirectGrants(f), oauth = f.app.chatGPTOAuth, api = f.app.directExecution;
  let clock = Date.now(); oauth.now = () => clock;
  const stored = structuredClone(oauth.grants.find(value => value.id === grant.client.id));
  const credentials = oauth.mint(stored, []);
  await oauth.persist(oauth.grants.map(value => value.id === stored.id ? stored : value));
  grant.token = credentials.access_token;
  const started = held(), release = held(), originalPrepare = api.prepare.bind(api);
  const request = { requestId: 'survives-access-refresh', action: 'write', path: 'after-refresh.txt', text: 'One admitted write survives access-token renewal.' };
  let dispatches = 0;
  t.mock.method(api, 'prepare', async (...args) => {
    const prepared = await originalPrepare(...args);
    if (args[0].requestId !== request.requestId) return prepared;
    const waiting = async () => { started.resolve(); await release.promise; dispatches++; return prepared(); };
    waiting.dispatchesAction = prepared.dispatchesAction;
    return waiting;
  });
  try {
    const admitted = await connectorTool(f, grant, 'blackice_workspace_write', request);
    assert.equal(admitted.isError, false);
    await started.promise;
    const jobId = admitted.structuredContent.jobId, active = api.active.get(jobId);
    assert.ok(active); assert.equal((await api.getJob(jobId, grant.client)).status, 'running');
    clock += credentials.expires_in * 1000 + 1;
    const expired = await connectorResponse(f, grant, 'blackice_get_job', { jobId });
    assert.equal(expired.status, 401); assert.match(expired.headers['www-authenticate'], /error="invalid_token"/);
    assert.match(expired.headers['www-authenticate'], /resource_metadata=/);
    assert.equal(expired.body.code, 'CHATGPT_AUTH_REQUIRED'); assert.equal(expired.body.result, undefined);
    assert.equal(oauth.getClient(grant.client.id).id, grant.client.id);
    assert.equal(active.controller.signal.aborted, false); assert.equal(dispatches, 0);
    const renewed = await oauth.token({ grant_type: 'refresh_token', client_id: stored.clientId, refresh_token: credentials.refresh_token, resource: stored.resource }, oauth.epoch);
    grant.token = renewed.access_token;
    const ongoing = await connectorTool(f, grant, 'blackice_get_job', { jobId });
    assert.equal(ongoing.isError, false); assert.equal(ongoing.structuredContent.status, 'running');
    assert.equal(active.controller.signal.aborted, false);
    assert.deepEqual(oauth.getClient(grant.client.id).scopes, grant.client.scopes);
    release.resolve();
    const finished = await settledConnectorJob(f, grant, jobId);
    assert.equal(finished.status, 'succeeded'); assert.equal(dispatches, 1);
    assert.equal(await fs.readFile(path.join(f.root, 'workspace', request.path), 'utf8'), request.text);
    const retried = await connectorTool(f, grant, 'blackice_workspace_write', request);
    assert.equal(retried.structuredContent.existing, true); assert.equal(retried.structuredContent.jobId, jobId);
    assert.equal(dispatches, 1);
    const diagnostics = (await f.app.chatGPTConnector.status()).authDiagnostics;
    assert.equal(diagnostics.invalidBearerChallenges, 1); assert.equal(diagnostics.authorizationLostChallenges, 0);
    assert.equal(f.runtime.agentCalls, 0);
  } finally { release.resolve(); }
});

test('removing local action approvals preserves legacy pending and cancelled receipts without replay', async t => {
  const f = await fixture(t), [grant] = await approvedDirectGrants(f);
  const request = { action: 'write', path: 'legacy-pending.txt', text: 'Must remain unexecuted.' };
  const admitted = await f.app.directExecution.jobs.admit({ ownerId: grant.client.id, requestId: 'legacy-pending', tool: 'blackice_workspace_write', arguments: request, requiredScopes: ['files:write'], client: grant.client, mutating: true, interaction: { id: 'input_legacy', kind: 'approval', message: 'Historical approval request.' } });
  const pendingBefore = await f.app.directExecution.getJob(admitted.job.id, grant.client);
  const retry = await connectorTool(f, grant, 'blackice_workspace_write', { requestId: 'legacy-pending', ...request });
  assert.equal(retry.structuredContent.existing, true); assert.equal(retry.structuredContent.status, 'awaiting_input');
  assert.deepEqual(await f.app.directExecution.getJob(admitted.job.id, grant.client), pendingBefore);
  for (const route of ['/api/chatgpt-connector/action-policy', '/api/chatgpt-connector/approve-action']) assert.equal((await f.request(route, { body: { id: grant.client.id, mode: 'automatic' } })).status, 404);
  const cancelled = await connectorTool(f, grant, 'blackice_cancel_job', { jobId: admitted.job.id }); assert.equal(cancelled.structuredContent.status, 'cancelled');
  const cancelledBefore = await f.app.directExecution.getJob(admitted.job.id, grant.client);
  const cancelledRetry = await connectorTool(f, grant, 'blackice_workspace_write', { requestId: 'legacy-pending', ...request });
  assert.equal(cancelledRetry.structuredContent.status, 'cancelled'); assert.equal(cancelledRetry.structuredContent.jobId, admitted.job.id);
  assert.deepEqual(await f.app.directExecution.getJob(admitted.job.id, grant.client), cancelledBefore);
  await assert.rejects(fs.readFile(path.join(f.root, 'workspace', request.path)), { code: 'ENOENT' });
});
test('connector management requires host session and public HTTPS before enable; disable revokes access', async t => {
  const f = await fixture(t);
  for (const file of ['/chatgpt-connector-ui.mjs', '/chatgpt-connector.css']) {
    const response = await fetch(f.url + file);
    assert.equal(response.status, 200, `The Settings dependency ${file} must be served.`);
    assert.ok((await response.text()).length > 100);
  }
  assert.equal((await fetch(f.url + '/api/chatgpt-connector')).status, 401);
  assert.equal((await f.request('/api/chatgpt-connector', { headers: { 'x-blackice-remote': '1' } })).status, 403);
  assert.equal((await f.request('/api/chatgpt-connector/enable', { body: {} })).status, 409);
  await f.app.remoteAccess.enable({ mode: 'private' });
  assert.equal((await f.request('/api/chatgpt-connector/enable', { body: {} })).status, 409);
  await f.app.remoteAccess.enable({ mode: 'public', confirmPublic: true });
  const enabled = await f.request('/api/chatgpt-connector/enable', { body: {} }); assert.equal(enabled.status, 200);
  const state = await enabled.json(); assert.equal(state.enabled, true); assert.match(state.endpoint, /^https:\/\/.+\/mcp\/chatgpt$/); assert.equal(state.modelCalls, false); assert.equal(state.chatSurfaceVerification, 'not-recorded');
  assert.equal((await f.request('/api/chatgpt-connector/approve-access', { body: { id: 'unknown', scopes: ['commands:run'], approveEverything: true } })).status, 400);
  assert.equal((await f.request('/api/chatgpt-connector/disable', { body: {} })).status, 200); assert.equal(f.app.chatGPTConnector.enabled, false);
  assert.equal(f.app.engine.listRuns().length, 0);
});

test('connector mutations stop during profile maintenance and unknown host authority is never accepted', async t => {
  const f = await fixture(t);
  await f.app.beginMaintenance();
  assert.equal((await f.request('/api/chatgpt-connector/cancel-action', { body: { id: 'direct_unknown' } })).status, 503);
  assert.equal((await f.request('/api/chatgpt-connector')).status, 200);
  f.app.endMaintenance();
  assert.equal((await f.request('/api/chatgpt-connector/enable', { body: {}, headers: { Origin: 'https://attacker.invalid' } })).status, 403);
  assert.equal((await f.request('/api/chatgpt-connector/reject-action', { body: { id: '../profile', interactionId: 'input_unknown' } })).status, 400);
});

test('corrupt optional OAuth storage preserves ordinary host status and existing bytes', async t => {
  const damaged = '{existing-but-incomplete';
  const f = await fixture(t, { prepare: dataDir => fs.writeFile(path.join(dataDir, 'chatgpt-oauth.json'), damaged) });
  assert.equal((await f.request('/api/status')).status, 200);
  const state = await (await f.request('/api/chatgpt-connector')).json(); assert.equal(state.oauth.healthy, false); assert.equal(state.oauth.grants.length, 0);
  assert.equal(await fs.readFile(path.join(f.dataDir, 'chatgpt-oauth.json'), 'utf8'), damaged);
});

test('a connector management request held mid-body cannot write after maintenance has drained', async t => {
  const f = await fixture(t);
  await f.app.remoteAccess.enable({ mode: 'public', confirmPublic: true });
  let observed;
  const entered = new Promise(resolve => { observed = resolve; });
  f.app.server.once('request', observed);
  let responseReceived;
  const response = new Promise((resolve, reject) => { responseReceived = { resolve, reject }; });
  const req = http.request(f.url + '/api/chatgpt-connector/enable', { method: 'POST', headers: { Cookie: f.cookie, 'Content-Type': 'application/json', 'Content-Length': '2' } }, res => { res.resume(); res.once('end', () => responseReceived.resolve(res.statusCode)); });
  req.once('error', responseReceived.reject); req.write('{');
  await entered; await f.app.beginMaintenance(); req.end('}');
  assert.equal(await response, 503); assert.equal(f.app.chatGPTConnector.enabled, false);
  await assert.rejects(fs.readFile(path.join(f.dataDir, 'chatgpt-connector.json')), { code: 'ENOENT' });
  f.app.endMaintenance();
});

test('opening prepared setup launches only generic ChatGPT settings after an explicit local POST', async t => {
  let chatModeCalls = 0;
  const obsolete = { openSetup: async () => { chatModeCalls++; throw Error('Retired reverse provider must not open.'); } };
  const opened = [], f = await fixture(t, { serverOptions: { openExternal: async url => { opened.push(url); }, chatMode: obsolete } });
  await prepareConnection(f);
  assert.equal(Object.hasOwn(f.app, 'chatMode'), false);
  const before = await f.app.chatGPTOAuth.status();
  for (let i = 0; i < 2; i++) { const status = await (await f.request('/api/chatgpt-connector')).json(); assert.equal(status.canOpenChatGPT, true); }
  assert.deepEqual(opened, [], 'status reads and polling never launch the browser');
  const response = await f.request(setupRoute, { body: {} }); assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { requested: true, connectionVerified: false }); assert.deepEqual(opened, [pluginUrl]);
  assert.deepEqual(await f.app.chatGPTOAuth.status(), before); assert.equal(f.app.chatGPTConnector.enabled, true);
  assert.equal(chatModeCalls, 0); assert.equal(f.runtime.agentCalls, 0); assert.equal(f.app.engine.listRuns().length, 0);
  assert.equal((await f.app.directExecution.status()).jobs.active, 0);
});

test('setup requires the existing local session, origin and method guards', async t => {
  const opened = [], f = await fixture(t, { serverOptions: { openExternal: async url => { opened.push(url); } } });
  assert.equal((await fetch(f.url + setupRoute, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  for (const headers of [{ 'x-blackice-remote': '1' }, { Origin: 'https://attacker.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }, { Host: 'unrecognized.invalid' }]) assert.equal(await rawStatus(f, setupRoute, headers), 403);
  for (const method of ['GET', 'PUT', 'DELETE']) assert.equal((await f.request(setupRoute, { method, ...(method === 'GET' ? {} : { body: {} }) })).status, 404);
  assert.deepEqual(opened, []);
});

test('setup rejects arbitrary payloads and query parameters without launching anything', async t => {
  const opened = [], f = await fixture(t, { serverOptions: { openExternal: async url => { opened.push(url); } } });
  for (const body of [null, [], false, 1, 'url', { url: 'https://attacker.invalid' }, { id: 'request' }]) assert.equal((await f.request(setupRoute, { body })).status, 400);
  for (const suffix of ['?url=https://attacker.invalid', '?']) assert.equal(await rawStatus(f, setupRoute + suffix), 400);
  assert.equal((await fetch(f.url + setupRoute, { method: 'POST', headers: { Cookie: f.cookie, 'Content-Type': 'application/json' }, body: '{invalid' })).status, 400);
  assert.equal((await fetch(f.url + setupRoute, { method: 'POST', headers: { Cookie: f.cookie }, body: '{}' })).status, 415);
  assert.deepEqual(opened, []);
});

test('setup capability is false without a host opener and launch failures stay sanitized', async t => {
  const f = await fixture(t); assert.equal((await (await f.request('/api/chatgpt-connector')).json()).canOpenChatGPT, false);
  const unsupported = await f.request(setupRoute, { body: {} }); assert.equal(unsupported.status, 409); assert.match((await unsupported.json()).error, /normal browser/);
  const broken = await fixture(t, { serverOptions: { openExternal: async () => { throw Error('PRIVATE_OPENER_PAYLOAD'); } } });
  await prepareConnection(broken);
  const response = await broken.request(setupRoute, { body: {} }); assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'The normal browser could not be opened. Try again from BLACKICE.' });
  assert.equal(broken.runtime.agentCalls, 0);
});

test('setup rejects maintenance including a request admitted before its body completes', async t => {
  const opened = [], f = await fixture(t, { serverOptions: { openExternal: async url => { opened.push(url); } } });
  const entered = held(); f.app.server.once('request', entered.resolve);
  const response = held(); const req = http.request(f.url + setupRoute, { method: 'POST', headers: { Cookie: f.cookie, 'Content-Type': 'application/json', 'Content-Length': '2' } }, res => { res.resume(); res.once('end', () => response.resolve(res.statusCode)); });
  req.write('{'); await entered.promise; await f.app.beginMaintenance(); req.end('}');
  assert.equal(await response.promise, 503); assert.equal((await f.request(setupRoute, { body: {} })).status, 503); assert.deepEqual(opened, []); f.app.endMaintenance();
});

test('concurrent setup requests coalesce while the host opener is pending', async t => {
  const gate = held(), entered = held(), opened = [];
  const f = await fixture(t, { serverOptions: { openExternal: async url => { opened.push(url); entered.resolve(); await gate.promise; } } });
  await prepareConnection(f);
  const first = f.request(setupRoute, { body: {} }); await entered.promise;
  const secondEntered = held(); f.app.server.once('request', secondEntered.resolve); const second = f.request(setupRoute, { body: {} });
  await secondEntered.promise; await turn(); await turn(); assert.deepEqual(opened, [pluginUrl]); gate.resolve();
  for (const response of await Promise.all([first, second])) { assert.equal(response.status, 200); assert.deepEqual(await response.json(), { requested: true, connectionVerified: false }); }
  assert.deepEqual(opened, [pluginUrl]);
});

test('shutdown drains an admitted setup opener and rejects later launches', async t => {
  const gate = held(), entered = held(), opened = [];
  const f = await fixture(t, { serverOptions: { openExternal: async url => { opened.push(url); entered.resolve(); await gate.promise; } } });
  await prepareConnection(f);
  const first = f.request(setupRoute, { body: {} }); await entered.promise;
  let closed = false; const closing = f.app.close().then(() => { closed = true; }); await turn();
  assert.equal(closed, false); assert.equal((await f.request(setupRoute, { body: {} })).status, 503); assert.deepEqual(opened, [pluginUrl]);
  gate.resolve(); assert.equal((await first).status, 200); await closing; assert.equal(closed, true); assert.deepEqual(opened, [pluginUrl]);
});


const setupStub = (overrides = {}) => ({ tail: Promise.resolve(), async snapshot() { return { ready: false, stage: 'prepare', serverUrl: null }; }, async check() {}, async confirm() {}, async close() {}, ...overrides });

test('preparation requires explicit public confirmation and returns this host endpoint without launching a browser or model', async t => {
  const opened = [], f = await fixture(t, { serverOptions: { openExternal: async url => opened.push(url) } });
  const first = await f.request(prepareRoute, { body: { confirmPublic: false } }); assert.equal(first.status, 409);
  assert.equal(f.app.remoteAccess.status().enabled, false); assert.equal(f.app.chatGPTConnector.enabled, false);
  const notReady = await f.request(setupRoute, { body: {} }); assert.equal(notReady.status, 409); assert.deepEqual(opened, []);
  await f.app.remoteAccess.enable({ mode: 'private' });
  assert.equal((await f.request(prepareRoute, { body: { confirmPublic: false } })).status, 409); assert.equal(f.app.remoteAccess.status().mode, 'private');
  const response = await f.request(prepareRoute, { body: { confirmPublic: true } }); assert.equal(response.status, 200);
  const current = await response.json(); assert.equal(current.setup.ready, true); assert.equal(current.remoteAccess.mode, 'public'); assert.equal(current.enabled, true);
  assert.equal(current.setup.serverUrl, `https://${f.transport.hostname}:8443/mcp/chatgpt`); assert.equal(current.setup.chatGPTUrl, pluginUrl);
  assert.deepEqual(opened, []); assert.equal(f.runtime.agentCalls, 0); assert.equal(f.app.engine.listRuns().length, 0);
});

test('repeated preparation reuses an already enabled route and connector without revoking permissions', async t => {
  const f = await fixture(t); await prepareConnection(f);
  let enables = 0, revocations = 0; const before = await f.app.chatGPTOAuth.status(), config = f.transport.config;
  f.app.chatGPTConnector.setEnabled = async () => { enables++; throw Error('An enabled connector must be retained.'); };
  f.app.chatGPTOAuth.revokeAll = async () => { revocations++; throw Error('Existing authorization must be retained.'); };
  for (let i = 0; i < 2; i++) { const response = await f.request(prepareRoute, { body: { confirmPublic: false } }); assert.equal(response.status, 200); assert.equal((await response.json()).setup.ready, true); }
  assert.equal(enables, 0); assert.equal(revocations, 0); assert.deepEqual(await f.app.chatGPTOAuth.status(), before); assert.deepEqual(f.transport.config, config);
});

test('preparation refreshes a stale route and refuses a changed or unowned public origin', async t => {
  const f = await fixture(t); await prepareConnection(f); const original = f.transport.config;
  const changed = structuredClone(original); changed.Web[`${f.transport.hostname}:8443`].Handlers['/'].Proxy = 'http://127.0.0.1:65530'; f.transport.setConfig(changed);
  const before = f.transport.calls.length;
  assert.equal((await f.request(prepareRoute, { body: { confirmPublic: false } })).status, 409);
  assert.equal(f.app.remoteAccess.status().enabled, false); assert.deepEqual(f.transport.config, changed);
  assert.ok(f.transport.calls.slice(before).every(args => args.includes('status')), 'preparation does not overwrite a changed route');
  f.transport.setConfig(original);
  await f.app.remoteAccess.enable({ mode: 'public', confirmPublic: true });
  const origin = f.app.chatGPTConnector.origin; f.app.chatGPTConnector.origin = 'https://different.example';
  assert.equal((await f.request(prepareRoute, { body: { confirmPublic: false } })).status, 409); f.app.chatGPTConnector.origin = origin;
});

test('same preparation payloads coalesce and a conflicting publication choice cannot inherit consent', async t => {
  const f = await fixture(t), gate = held(), entered = held(), enable = f.app.remoteAccess.enable.bind(f.app.remoteAccess); let enables = 0;
  f.app.remoteAccess.enable = async value => { enables++; entered.resolve(); await gate.promise; return enable(value); };
  const first = f.request(prepareRoute, { body: { confirmPublic: true } }); await entered.promise;
  const secondEntered = held(); f.app.server.once('request', secondEntered.resolve); const second = f.request(prepareRoute, { body: { confirmPublic: true } }); await secondEntered.promise; await turn();
  assert.equal((await f.request(prepareRoute, { body: { confirmPublic: false } })).status, 409); assert.equal(enables, 1);
  gate.resolve(); for (const response of await Promise.all([first, second])) { assert.equal(response.status, 200); assert.equal((await response.json()).setup.ready, true); }
  assert.equal(enables, 1);
});

test('diagnostic and confirmation routes call only the injected setup API and return its snapshot', async t => {
  const calls = [], current = { ready: true, stage: 'test', serverUrl: 'https://fixture.example/mcp/chatgpt' };
  const setup = setupStub({ async snapshot() { return { ...current }; }, async check() { calls.push('check'); current.diagnostics = { checkedAt: '2026-01-01T00:00:00.000Z', checks: [] }; }, async confirm(nonce) { calls.push(['confirm', nonce]); current.stage = 'confirmed'; } });
  const f = await fixture(t, { serverOptions: { chatGPTSetup: setup } }), nonce = 'blackice-connect-11111111-1111-4111-8111-111111111111';
  const checking = await f.request(checkRoute, { body: {} }); assert.equal(checking.status, 200); assert.deepEqual((await checking.json()).setup.diagnostics, current.diagnostics);
  const confirming = await f.request(confirmRoute, { body: { nonce } }); assert.equal(confirming.status, 200); assert.equal((await confirming.json()).setup.stage, 'confirmed');
  assert.deepEqual(calls, ['check', ['confirm', nonce]]); assert.equal(f.runtime.agentCalls, 0); assert.equal(f.app.engine.listRuns().length, 0);
});

test('onboarding actions retain session, local host, origin, method, strict body and query guards', async t => {
  const calls = [], setup = setupStub({ async check() { calls.push('check'); }, async confirm() { calls.push('confirm'); } });
  const f = await fixture(t, { serverOptions: { chatGPTSetup: setup } });
  for (const route of [prepareRoute, checkRoute, confirmRoute]) {
    assert.equal((await fetch(f.url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    for (const headers of [{ 'x-blackice-remote': '1' }, { Origin: 'https://attacker.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }, { Host: 'unrecognized.invalid' }]) assert.equal(await rawStatus(f, route, headers), 403);
    assert.equal((await f.request(route)).status, 404); assert.equal(await rawStatus(f, route + '?'), 400);
    assert.equal((await f.request(route, { body: { unexpected: true } })).status, 400);
  }
  for (const body of [{}, { confirmPublic: 'true' }, { confirmPublic: true, url: 'https://attacker.invalid' }]) assert.equal((await f.request(prepareRoute, { body })).status, 400);
  for (const body of [{}, { nonce: '' }, { nonce: 'bad nonce' }, { nonce: 'a'.repeat(121) }, { nonce: false }]) assert.equal((await f.request(confirmRoute, { body })).status, 400);
  assert.deepEqual(calls, []); assert.equal(f.app.chatGPTConnector.enabled, false);
});

test('onboarding errors preserve the original HTTP failure and never start a model or launch a browser', async t => {
  const opened = [], setup = setupStub({ async check() { throw Object.assign(Error('Fixture readiness is incomplete.'), { status: 409 }); }, async confirm() { throw Object.assign(Error('Fixture nonce has not been received.'), { status: 409 }); } });
  const f = await fixture(t, { serverOptions: { chatGPTSetup: setup, openExternal: async url => opened.push(url) } });
  assert.equal((await f.request(checkRoute, { body: {} })).status, 409);
  assert.equal((await f.request(confirmRoute, { body: { nonce: 'blackice-connect-11111111-1111-4111-8111-111111111111' } })).status, 409);
  assert.equal((await f.request(setupRoute, { body: {} })).status, 409); assert.deepEqual(opened, []); assert.equal(f.runtime.agentCalls, 0);
  const unavailable = await fixture(t, { serverOptions: { remoteAccess: false, chatGPTSetup: setupStub() } });
  assert.equal((await unavailable.request(prepareRoute, { body: { confirmPublic: true } })).status, 503);
});

test('maintenance drains setup writes and blocks all new onboarding operations', async t => {
  const pendingWrite = held(), setup = setupStub({ tail: pendingWrite.promise }), f = await fixture(t, { serverOptions: { chatGPTSetup: setup } });
  let drained = false; const maintenance = f.app.beginMaintenance().then(() => { drained = true; }); await turn(); assert.equal(drained, false);
  for (const route of [prepareRoute, checkRoute, confirmRoute]) assert.equal((await f.request(route, { body: {} })).status, 503);
  assert.equal((await f.request('/api/chatgpt-connector')).status, 200); pendingWrite.resolve(); await maintenance; assert.equal(drained, true); f.app.endMaintenance();
});

test('shutdown closes setup before connector teardown and drains an admitted connection check', async t => {
  const gate = held(), entered = held(), events = [], setup = setupStub({ async check() { entered.resolve(); await gate.promise; }, async close() { events.push('setup'); } });
  const f = await fixture(t, { serverOptions: { chatGPTSetup: setup } }), connectorClose = f.app.chatGPTConnector.close.bind(f.app.chatGPTConnector);
  f.app.chatGPTConnector.close = async () => { events.push('connector'); return connectorClose(); };
  const checking = f.request(checkRoute, { body: {} }); await entered.promise; let drained = false;
  const closing = f.app.close().then(() => { drained = true; }); await turn(); assert.equal(drained, false);
  assert.equal((await f.request(checkRoute, { body: {} })).status, 503); gate.resolve(); assert.equal((await checking).status, 200); await closing;
  assert.equal(drained, true); assert.deepEqual(events, ['setup', 'connector']);
});


test('authenticated tool receipt capture is wired after setup and an optional write failure is contained', async t => {
  const receipts = [], receipt = { tool: 'blackice_direct_status', clientId: 'fixture_client', at: '2026-01-01T00:00:00.000Z', nonce: 'fixture-nonce' };
  const f = await fixture(t, { serverOptions: { chatGPTSetup: setupStub({ async record(value) { receipts.push(value); } }) } });
  await f.app.chatGPTConnector.onAuthenticatedToolCall(receipt); assert.deepEqual(receipts, [receipt]);
  f.app.connectorSetup.record = async () => { throw Error('Optional setup history could not be saved.'); };
  await assert.doesNotReject(f.app.chatGPTConnector.onAuthenticatedToolCall(receipt)); assert.equal(f.runtime.agentCalls, 0);
  const withoutObserver = await fixture(t, { serverOptions: { chatGPTSetup: setupStub() } });
  await assert.doesNotReject(withoutObserver.app.chatGPTConnector.onAuthenticatedToolCall(receipt));
});
