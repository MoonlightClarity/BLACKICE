import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { RemoteAvailabilityResponder, readAvailabilityGrant, processPresence, REMOTE_AVAILABILITY_VERSION } from '../lib/remote-availability.mjs';
import { RemoteAvailabilityHost, availabilityControl } from '../lib/remote-availability-host.mjs';
import { RemoteAccessManager } from '../lib/remote-access.mjs';

const origin = 'https://fixture.example.ts.net', token = 'blackice_at_' + 'a'.repeat(43);
const connectionId = '11111111-1111-4111-8111-111111111111';
const registeredConnectionId = '22222222-2222-4222-8222-222222222222';
const registeredClientId = 'blackice_client_' + 'c'.repeat(43), registeredToken = 'blackice_at_' + 'm'.repeat(43);
const tools = [
  { name: 'blackice_direct_status', inputSchema: { type: 'object' }, securitySchemes: [{ type: 'oauth2', scopes: ['read'] }] },
  { name: 'blackice_run_command', inputSchema: { type: 'object' }, securitySchemes: [{ type: 'oauth2', scopes: ['read', 'commands:run'] }] },
];
const app = (overrides = {}) => ({ pid: process.pid, state: 'ready', target: 'http://127.0.0.1:1', enabled: true, tools, version: 'test', ...overrides });

async function profile() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-availability-test-'));
  const value = { schema: 1, grants: [{ id: connectionId, clientId: 'https://chatgpt.com/oauth/client.json', resource: origin + '/mcp/chatgpt', scopes: ['read', 'commands:run'], expiresAt: new Date(Date.now() + 86400000).toISOString(), accessTokens: [{ hash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 60000).toISOString() }] }] };
  await Promise.all([
    fs.writeFile(path.join(dataDir, 'chatgpt-oauth.json'), JSON.stringify(value)),
    fs.writeFile(path.join(dataDir, 'remote-access.json'), JSON.stringify({ enabled: true })),
    fs.writeFile(path.join(dataDir, 'chatgpt-connector.json'), JSON.stringify({ version: 1, enabled: true })),
  ]);
  return { dataDir, value };
}

function registeredState(legacy, method = 'none') {
  const value = structuredClone(legacy);
  value.schema = 2;
  value.clients = [{
    clientId: registeredClientId, clientName: 'Mistral Le Chat',
    redirectUris: ['https://chat.mistral.ai/oauth/callback'],
    tokenEndpointAuthMethod: method,
    clientSecretHash: method === 'none' ? null : createHash('sha256').update('disposable-test-secret').digest('hex'),
    createdAt: new Date(Date.now() - 1000).toISOString(),
  }];
  value.grants.push({
    ...structuredClone(value.grants[0]), id: registeredConnectionId, clientId: registeredClientId, label: 'Mistral Le Chat',
    accessTokens: [{ hash: createHash('sha256').update(registeredToken).digest('hex'), expiresAt: new Date(Date.now() + 60000).toISOString() }],
  });
  return value;
}

async function legacyWorker(dataDir, responderVersion) {
  const file = path.join(dataDir, 'legacy-availability-worker.mjs');
  await fs.writeFile(file, [
    'import { RemoteAvailabilityResponder } from ' + JSON.stringify(new URL('../lib/remote-availability.mjs', import.meta.url).href) + ';',
    'const status = RemoteAvailabilityResponder.prototype.status;',
    'RemoteAvailabilityResponder.prototype.status = function (...args) { const value = status.apply(this, args); ' + (responderVersion === undefined ? 'delete value.responderVersion;' : 'value.responderVersion = ' + JSON.stringify(responderVersion) + ';') + ' return value; };',
    'await import(' + JSON.stringify(new URL('../lib/remote-availability-worker.mjs', import.meta.url).href) + ');',
  ].join('\n'));
  return file;
}

async function fixture(t, { presence = () => true } = {}) {
  const p = await profile(), responder = new RemoteAvailabilityResponder({ ...p, origin, presence });
  await responder.listen(); responder.configure(app());
  t.after(async () => { await responder.close(); await fs.rm(p.dataDir, { recursive: true, force: true }); });
  return { ...p, responder, port: responder.port };
}

function send(port, request, { headers = {}, endpoint = '/mcp/chatgpt', method = 'POST' } = {}) {
  const body = typeof request === 'string' ? request : JSON.stringify(request);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: endpoint, method, headers: Object.fromEntries(Object.entries({ Host: new URL(origin).host, Authorization: 'Bearer ' + token, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers }).filter(([, value]) => value !== undefined)) }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); try { resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null }); } catch (error) { reject(error); } });
    }); req.on('error', reject); req.end(body);
  });
}
const call = (name, args = {}) => ({ jsonrpc: '2.0', id: 'fixture-request', method: 'tools/call', params: { name, arguments: args } });

test('offline status preserves same grant, nonce, and explicit no-execution outcome', async t => {
  const f = await fixture(t, { presence: () => false });
  const before = await fs.readFile(path.join(f.dataDir, 'chatgpt-oauth.json'));
  const response = await send(f.port, call('blackice_direct_status', { nonce: 'fixture.1' }));
  assert.equal(response.status, 200); assert.equal(response.body.id, 'fixture-request');
  const value = response.body.result.structuredContent;
  assert.equal(value.state, 'closed'); assert.equal(value.available, false); assert.equal(value.nonce, 'fixture.1');
  assert.equal(value.connectionId, connectionId); assert.equal(value.modelStarted, false); assert.equal(value.providerTurns, false);
  assert.deepEqual(value.action, { admitted: false, outcome: 'not-started', automaticReplay: false });
  const mutation = await send(f.port, call('blackice_run_command', { requestId: 'keep-this-id', command: 'must not run' }));
  assert.equal(mutation.body.result.isError, true); assert.equal(mutation.body.result.structuredContent.code, 'BLACKICE_CLOSED');
  assert.deepEqual(await fs.readFile(path.join(f.dataDir, 'chatgpt-oauth.json')), before);
  assert.equal(JSON.stringify(response).includes(token), false);
});


test('offline MCP challenges every unauthenticated POST before content and protocol parsing', async t => {
  const f = await fixture(t, { presence: () => false }), file = path.join(f.dataDir, 'chatgpt-oauth.json');
  const before = await fs.readFile(file);
  const requests = [
    { jsonrpc: '2.0', id: 'initialize', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture-client', version: '1' } } },
    { jsonrpc: '2.0', id: 'list', method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 'ping', method: 'ping' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 'discover', method: 'server/discover', params: {} },
    call('blackice_direct_status'), '{bad JSON', '',
  ];
  for (const authorization of [undefined, '', 'Bearer invalid', 'Bearer blackice_at_' + 'z'.repeat(43)]) {
    for (const request of requests) {
      const response = await send(f.port, request, { headers: { Authorization: authorization, Accept: undefined, 'Content-Type': undefined, 'MCP-Protocol-Version': 'unrecognized-fixture-version' } });
      assert.equal(response.status, 401);
      assert.equal(response.body.code, 'CHATGPT_AUTH_REQUIRED');
      assert.ok(response.headers['www-authenticate'].includes('resource_metadata="' + origin + '/.well-known/oauth-protected-resource/mcp/chatgpt"'));
      assert.equal(response.body.result, undefined);
    }
  }
  assert.equal((await send(f.port, '', { method: 'GET', headers: { Authorization: undefined } })).status, 405);
  for (const endpoint of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp/chatgpt', '/.well-known/oauth-authorization-server']) {
    assert.equal((await send(f.port, '', { endpoint, method: 'GET', headers: { Authorization: undefined } })).status, 200);
  }
  for (const request of requests.slice(0, 3)) assert.equal((await send(f.port, request)).status, 200);
  assert.equal((await send(f.port, call('blackice_direct_status'))).body.result.structuredContent.connectionId, connectionId);
  assert.deepEqual(await fs.readFile(file), before);
  await fs.writeFile(path.join(f.dataDir, 'chatgpt-connector.json'), JSON.stringify({ version: 1, enabled: false }));
  const disabled = await send(f.port, '', { headers: { Authorization: undefined, 'Content-Type': undefined } });
  assert.equal(disabled.status, 503); assert.equal(disabled.body.code, 'CHATGPT_CONNECTOR_DISABLED');
  assert.equal(disabled.headers['www-authenticate'], undefined);
});

test('the live responder forwards unknown credentials without parsing so the application can challenge first', async t => {
  const f = await fixture(t), received = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received.push({ body: Buffer.concat(chunks).toString(), authorization: req.headers.authorization, contentType: req.headers['content-type'] });
    res.setHeader('WWW-Authenticate', 'Bearer resource_metadata="' + origin + '/.well-known/oauth-protected-resource/mcp/chatgpt"');
    res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ fromApplication: true }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  f.responder.configure(app({ target: 'http://127.0.0.1:' + upstream.address().port }));
  for (const authorization of [undefined, 'Bearer invalid', 'Bearer blackice_at_' + 'z'.repeat(43)]) {
    const response = await send(f.port, 'unparsed-fixture-body', { headers: { Authorization: authorization, Accept: undefined, 'Content-Type': 'text/plain', 'MCP-Protocol-Version': 'unrecognized-fixture-version' } });
    assert.equal(response.status, 401); assert.equal(response.body.fromApplication, true);
    assert.ok(response.headers['www-authenticate'].includes('resource_metadata='));
    assert.deepEqual(received.at(-1), { body: 'unparsed-fixture-body', authorization, contentType: 'text/plain' });
  }
  // A damaged disk snapshot must not replace the live application's authority.
  await fs.writeFile(path.join(f.dataDir, 'chatgpt-oauth.json'), '{broken');
  const response = await send(f.port, 'unparsed-fixture-body', { headers: { 'Content-Type': 'text/plain' } });
  assert.equal(response.status, 401); assert.equal(response.body.fromApplication, true);
  assert.equal(received.length, 4);
});

test('offline schema2 preserves registered Mistral and existing ChatGPT grants without writing credentials', async t => {
  const f = await fixture(t, { presence: () => false }), file = path.join(f.dataDir, 'chatgpt-oauth.json');
  for (const method of ['none', 'client_secret_basic', 'client_secret_post']) {
    await fs.writeFile(file, JSON.stringify(registeredState(f.value, method)));
    const before = await fs.readFile(file);
    const [mistral, chatgpt] = await Promise.all([
      send(f.port, call('blackice_direct_status', { nonce: 'mistral.offline' }), { headers: { Authorization: 'Bearer ' + registeredToken } }),
      send(f.port, call('blackice_direct_status', { nonce: 'chatgpt.offline' })),
    ]);
    assert.equal(mistral.status, 200); assert.equal(chatgpt.status, 200);
    assert.equal(mistral.body.result.structuredContent.connectionId, registeredConnectionId);
    assert.equal(chatgpt.body.result.structuredContent.connectionId, connectionId);
    assert.equal(mistral.body.result.structuredContent.nonce, 'mistral.offline');
    assert.equal(chatgpt.body.result.structuredContent.nonce, 'chatgpt.offline');
    for (const response of [mistral, chatgpt]) {
      const state = response.body.result.structuredContent;
      assert.equal(state.state, 'closed'); assert.equal(state.available, false);
      assert.equal(state.modelStarted, false); assert.equal(state.providerTurns, false);
      assert.deepEqual(state.grantedScopes, ['read', 'commands:run']);
      assert.deepEqual(state.action, { admitted: false, outcome: 'not-started', automaticReplay: false });
      assert.equal(JSON.stringify(response).includes(registeredToken), false);
      assert.equal(JSON.stringify(response).includes('clientSecretHash'), false);
    }
    const mutation = await send(f.port, call('blackice_run_command', { requestId: 'same-mistral-request', command: 'must not run' }), { headers: { Authorization: 'Bearer ' + registeredToken } });
    assert.equal(mutation.body.result.isError, true);
    assert.equal(mutation.body.result.structuredContent.connectionId, registeredConnectionId);
    assert.equal(mutation.body.result.structuredContent.code, 'BLACKICE_CLOSED');
    assert.deepEqual(await fs.readFile(file), before);
  }
});

test('offline registered grants require their saved client binding and exact live token scope and resource', async t => {
  const f = await fixture(t, { presence: () => false }), file = path.join(f.dataDir, 'chatgpt-oauth.json');
  const headers = { Authorization: 'Bearer ' + registeredToken };
  for (const mutate of [
    value => { value.clients = []; },
    value => { value.grants[1].clientId = 'blackice_client_' + 'x'.repeat(43); },
    value => { value.grants[1].label = 'Different client'; },
    value => { value.grants[1].resource = 'https://other.example/mcp/chatgpt'; },
    value => { value.grants[1].scopes.push('unknown:scope'); },
    value => { value.grants[1].accessTokens[0].expiresAt = '2000-01-01T00:00:00Z'; },
    value => { value.grants[1].accessTokens[0].expiresAt = new Date(Date.parse(value.grants[1].expiresAt) + 1).toISOString(); },
    value => { value.grants.push({ ...structuredClone(value.grants[1]), id: '33333333-3333-4333-8333-333333333333' }); },
    value => { value.schema = 1; },
  ]) {
    const value = registeredState(f.value); mutate(value); await fs.writeFile(file, JSON.stringify(value));
    const before = await fs.readFile(file);
    assert.equal((await send(f.port, call('blackice_direct_status'), { headers })).status, 401);
    assert.equal((await send(f.port, call('blackice_direct_status'))).status, 200, 'The existing ChatGPT grant remains usable.');
    assert.deepEqual(await fs.readFile(file), before);
  }
});

test('offline malformed registered-client storage is reported unavailable without rewriting it', async t => {
  const f = await fixture(t, { presence: () => false }), file = path.join(f.dataDir, 'chatgpt-oauth.json');
  for (const mutate of [
    value => { delete value.clients; },
    value => { value.clients.push(structuredClone(value.clients[0])); },
    value => { value.clients[0].clientSecretHash = 'not-a-hash'; },
    value => { value.clients[0].redirectUris = ['http://chat.mistral.ai/oauth/callback']; },
  ]) {
    const value = registeredState(f.value, 'client_secret_post'); mutate(value); await fs.writeFile(file, JSON.stringify(value));
    const before = await fs.readFile(file);
    await assert.rejects(readAvailabilityGrant({ headers: { authorization: 'Bearer ' + registeredToken } }, { dataDir: f.dataDir, origin }), { code: 'BLACKICE_CONNECTION_UNAVAILABLE', status: 503 });
    assert.deepEqual(await fs.readFile(file), before);
  }
});

test('offline discovery advertises dynamic registration and the same client authentication methods', async t => {
  const f = await fixture(t, { presence: () => false }), file = path.join(f.dataDir, 'chatgpt-oauth.json');
  const before = await fs.readFile(file);
  const response = await send(f.port, '', { endpoint: '/.well-known/oauth-authorization-server', method: 'GET', headers: { Authorization: '' } });
  assert.equal(response.status, 200);
  assert.equal(response.body.issuer, origin);
  assert.equal(response.body.registration_endpoint, origin + '/chatgpt/oauth/register');
  assert.equal(response.body.token_endpoint, origin + '/chatgpt/oauth/token');
  assert.equal(response.body.revocation_endpoint, origin + '/chatgpt/oauth/revoke');
  assert.deepEqual(response.body.token_endpoint_auth_methods_supported, ['none', 'client_secret_basic', 'client_secret_post']);
  assert.deepEqual(response.body.revocation_endpoint_auth_methods_supported, response.body.token_endpoint_auth_methods_supported);
  assert.equal(response.body.client_id_metadata_document_supported, true);
  assert.deepEqual(response.body.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(await fs.readFile(file), before);
});

test('starting, closing and unreachable require appropriate observed process state', async t => {
  let alive = true;
  const f = await fixture(t, { presence: () => alive });
  for (const [state, expected] of [['starting', 'starting'], ['closing', 'closing'], ['ready', 'unreachable']]) {
    f.responder.configure(app({ state, target: state === 'ready' ? 'http://127.0.0.1:1' : null }));
    const r = await send(f.port, call('blackice_direct_status'));
    assert.equal(r.body.result.structuredContent.state, expected);
  }
  alive = null;
  f.responder.offline('starting');
  assert.equal((await send(f.port, call('blackice_direct_status'))).body.result.structuredContent.state, 'unreachable');
  alive = false;
  assert.equal((await send(f.port, call('blackice_direct_status'))).body.result.structuredContent.state, 'closed');
});

test('a fresh helper reports authenticated startup before the full tool catalog exists', async t => {
  const f = await fixture(t);
  f.responder.configure(app({ state: 'starting', target: null, tools: [] }));
  const r = await send(f.port, call('blackice_direct_status', { nonce: 'first-start' }));
  assert.equal(r.body.result.structuredContent.state, 'starting');
  assert.equal(r.body.result.structuredContent.nonce, 'first-start');
  assert.equal(r.body.result.structuredContent.connectionId, connectionId);
});

test('lifetime disconnect and explicit closing release ownership despite an apparently live reused PID', async t => {
  const f = await fixture(t, { presence: () => true });
  const previousGeneration = f.responder.generation;
  f.responder.disconnected(previousGeneration);
  assert.equal(f.responder.application.target, null);
  assert.equal(f.responder.status().state, 'unreachable');
  f.responder.configure(app({ pid: process.pid + 100, state: 'starting', target: null }));
  f.responder.disconnected(previousGeneration);
  assert.equal(f.responder.status().state, 'starting');
  f.responder.configure(app({ pid: process.pid + 100 }));
  f.responder.offline('closing');
  assert.doesNotThrow(() => f.responder.configure(app({ pid: process.pid + 200, state: 'starting', target: null })));
});

test('live proxy preserves application response, credentials and body exactly once', async t => {
  const f = await fixture(t); let calls = 0;
  const upstream = http.createServer(async (req, res) => {
    calls++; const chunks = []; for await (const chunk of req) chunks.push(chunk);
    assert.equal(req.headers.authorization, 'Bearer ' + token); assert.equal(req.headers.host, new URL(origin).host);
    const request = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Set-Cookie', 'fixture=value');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { fromApplication: true, arguments: request.params.arguments } }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  f.responder.configure(app({ target: `http://127.0.0.1:${upstream.address().port}` }));
  const r = await send(f.port, call('blackice_run_command', { requestId: 'same-id', command: 'fixture' }));
  assert.equal(calls, 1); assert.equal(r.body.result.fromApplication, true); assert.equal(r.body.result.arguments.requestId, 'same-id');
  assert.deepEqual(r.headers['set-cookie'], ['fixture=value']);
});

test('unknown elevated process presence requires the authenticated current lifetime generation', async t => {
  let presence = null, calls = 0;
  const f = await fixture(t, { presence: () => presence });
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) {}
    calls++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ fromApplication: true }));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const target = `http://127.0.0.1:${upstream.address().port}`;
  f.responder.configure(app({ target }));
  const generation = f.responder.generation;
  const invoke = () => send(f.port, call('blackice_run_command', { requestId: 'elevated-fixture', command: 'fixture' }));
  assert.equal((await invoke()).body.result.structuredContent.code, 'BLACKICE_UNREACHABLE');
  assert.equal(f.responder.connected(generation - 1), false);
  assert.equal((await invoke()).body.result.structuredContent.code, 'BLACKICE_UNREACHABLE');
  assert.equal(calls, 0);
  assert.equal(f.responder.connected(generation), true);
  assert.equal((await invoke()).body.fromApplication, true);
  assert.equal(calls, 1);
  assert.throws(() => f.responder.configure(app({ pid: process.pid + 100, target })), { code: 'BLACKICE_PROCESS_ACTIVE' });
  presence = false;
  assert.equal((await invoke()).body.result.structuredContent.code, 'BLACKICE_CLOSED');
  assert.equal(calls, 1);
  presence = null;
  f.responder.disconnected(generation);
  assert.equal(f.responder.application.target, null);
  assert.equal((await invoke()).body.result.structuredContent.code, 'BLACKICE_UNREACHABLE');
  assert.equal(calls, 1);
});

test('new configuration and explicit offline invalidate the old elevated lifetime identity', async t => {
  const f = await fixture(t, { presence: () => null });
  const generation = f.responder.generation;
  f.responder.connected(generation);
  assert.equal(f.responder.applicationPresent(), true);
  f.responder.configure(app());
  assert.equal(f.responder.applicationPresent(), false);
  assert.equal(f.responder.connected(generation), false);
  assert.equal(f.responder.connected(f.responder.generation), true);
  f.responder.disconnected(generation);
  assert.equal(f.responder.applicationPresent(), true);
  f.responder.offline('closing');
  assert.equal(f.responder.applicationPresent(), false);
  assert.equal(f.responder.application.target, null);
});

test('lost delivery is reported uncertain and is never replayed', async t => {
  const f = await fixture(t); let calls = 0;
  const upstream = http.createServer(async (req) => { for await (const _chunk of req) {} calls++; req.socket.destroy(); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  f.responder.configure(app({ target: `http://127.0.0.1:${upstream.address().port}` }));
  const r = await send(f.port, call('blackice_run_command', { requestId: 'recover-same-id', command: 'fixture' }));
  assert.equal(calls, 1); assert.equal(r.body.result.isError, true);
  assert.deepEqual(r.body.result.structuredContent.action, { admitted: null, outcome: 'unknown', automaticReplay: false });
  assert.equal(r.body.result.structuredContent.modelStarted, null);
  assert.equal(r.body.result.structuredContent.providerTurns, null);
  assert.equal(r.body.result.structuredContent.responderModelStarted, false);
  assert.match(r.body.result.structuredContent.recovery, /same requestId/);
});

test('offline grant check honors expiration, revocation, resource and existing scopes', async t => {
  const f = await fixture(t, { presence: () => false });
  const grantPath = path.join(f.dataDir, 'chatgpt-oauth.json');
  for (const mutate of [
    value => { value.grants = []; },
    value => { value.grants[0].expiresAt = '2000-01-01T00:00:00Z'; },
    value => { value.grants[0].accessTokens[0].expiresAt = '2000-01-01T00:00:00Z'; },
    value => { value.grants[0].resource = 'https://other.example/mcp/chatgpt'; },
  ]) {
    const value = structuredClone(f.value); mutate(value); await fs.writeFile(grantPath, JSON.stringify(value));
    assert.equal((await send(f.port, call('blackice_direct_status'))).status, 401);
  }
  const value = structuredClone(f.value); value.grants[0].scopes = ['read']; await fs.writeFile(grantPath, JSON.stringify(value));
  const response = await send(f.port, call('blackice_run_command'));
  assert.equal(response.body.result.structuredContent.code, 'CHATGPT_SCOPE_REQUIRED');
  assert.equal((await send(f.port, call('blackice_direct_status'))).status, 200);
  assert.equal(await readAvailabilityGrant({ headers: { authorization: 'Bearer ' + token }, rawHeaders: ['Authorization', 'x', 'Authorization', 'y'] }, { dataDir: f.dataDir, origin }), null);
});

test('offline OAuth registration, refresh and revocation report temporarily unavailable without modifying clients or grants', async t => {
  const f = await fixture(t, { presence: () => false }), file = path.join(f.dataDir, 'chatgpt-oauth.json');
  for (const value of [f.value, registeredState(f.value, 'client_secret_post')]) {
    await fs.writeFile(file, JSON.stringify(value));
    const before = await fs.readFile(file), filesBefore = (await fs.readdir(f.dataDir)).sort();
    for (const endpoint of ['/chatgpt/oauth/register', '/chatgpt/oauth/token', '/chatgpt/oauth/revoke']) {
      const body = endpoint.endsWith('/register') ? { client_name: 'Another client', redirect_uris: ['https://chat.mistral.ai/oauth/callback'] } : 'grant_type=refresh_token&refresh_token=fixture';
      const r = await send(f.port, body, { endpoint, headers: { 'Content-Type': endpoint.endsWith('/register') ? 'application/json' : 'application/x-www-form-urlencoded' } });
      assert.equal(r.status, 503); assert.equal(r.headers['retry-after'], '3');
      assert.equal(r.body.error, 'temporarily_unavailable'); assert.match(r.body.error_description, /BLACKICE is closed/);
      assert.deepEqual(await fs.readFile(file), before);
      assert.deepEqual((await fs.readdir(f.dataDir)).sort(), filesBefore);
    }
  }
});

test('disabled connector, malformed requests and wrong origins do not gain offline access', async t => {
  const f = await fixture(t, { presence: () => false });
  assert.equal((await send(f.port, call('blackice_direct_status'), { headers: { Host: 'other.example' } })).status, 403);
  assert.equal((await send(f.port, call('blackice_direct_status'), { headers: { Origin: 'https://other.example' } })).status, 403);
  assert.equal((await send(f.port, '{bad JSON')).body.error.code, -32700);
  await fs.writeFile(path.join(f.dataDir, 'chatgpt-connector.json'), JSON.stringify({ version: 1, enabled: false }));
  assert.equal((await send(f.port, call('blackice_direct_status'))).body.code, 'CHATGPT_CONNECTOR_DISABLED');
});

test('offline transport retains catalog and supported per-request MCP metadata', async t => {
  const f = await fixture(t, { presence: () => false });
  const list = await send(f.port, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  assert.deepEqual(list.body.result.tools, tools);
  const request = call('blackice_direct_status');
  request.params._meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
  const r = await send(f.port, request, { headers: { 'MCP-Protocol-Version': '2026-07-28', 'MCP-Method': 'tools/call', 'MCP-Name': 'blackice_direct_status' } });
  assert.equal(r.body.result.resultType, 'complete'); assert.equal(r.body.result.structuredContent.state, 'closed');
});

test('detached responder survives application process exit, reattaches and stops explicitly', async t => {
  const p = await profile();
  const host = new RemoteAvailabilityHost({ dataDir: p.dataDir, origin });
  const child = spawn(process.execPath, ['-e', "process.send('ready');process.on('message',()=>process.exit(0));setInterval(()=>{},1000)"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  await once(child, 'message');
  t.after(async () => { if (child.connected) child.send('stop'); await host.stop().catch(() => {}); await fs.rm(p.dataDir, { recursive: true, force: true }); });
  const route = await host.attach(app({ pid: child.pid, state: 'starting', target: null }));
  const firstPid = host.marker.pid;
  assert.equal((await send(host.port, call('blackice_direct_status'))).body.result.structuredContent.state, 'starting');
  const exited = once(child, 'exit'); child.send('stop'); await exited;
  assert.equal((await send(host.port, call('blackice_direct_status'))).body.result.structuredContent.state, 'closed');
  const next = new RemoteAvailabilityHost({ dataDir: p.dataDir, origin, port: host.port });
  assert.equal(await next.attach(app({ state: 'starting', target: null })), route);
  assert.equal(next.marker.pid, firstPid);
  assert.equal((await send(next.port, call('blackice_direct_status'))).body.result.structuredContent.state, 'starting');
  await next.offline('closing');
  assert.equal((await send(next.port, call('blackice_direct_status'))).body.result.structuredContent.state, 'closing');
  await host.stop();
  await assert.rejects(fs.stat(path.join(p.dataDir, 'remote-availability.json')), { code: 'ENOENT' });
});

for (const responderVersion of [undefined, 2, 3, 4, 5]) test('native startup gracefully replaces idle responder ' + (responderVersion ?? 'unversioned') + ' on the same port with both grants intact', async t => {
  const p = await profile(), file = path.join(p.dataDir, 'chatgpt-oauth.json');
  await fs.writeFile(file, JSON.stringify(registeredState(p.value, 'client_secret_post')));
  const before = await fs.readFile(file);
  const legacy = new RemoteAvailabilityHost({ dataDir: p.dataDir, origin, worker: await legacyWorker(p.dataDir, responderVersion) });
  const next = new RemoteAvailabilityHost({ dataDir: p.dataDir, origin });
  t.after(async () => { await next.stop().catch(() => {}); await legacy.stop().catch(() => {}); await fs.rm(p.dataDir, { recursive: true, force: true }); });
  const route = await legacy.attach(app({ state: 'starting', target: null }));
  const legacyPid = legacy.marker.pid, legacyId = legacy.marker.id, port = legacy.port;
  assert.equal((await availabilityControl(legacy.marker, 'ping')).state.responderVersion, responderVersion);
  await legacy.offline('closing');
  assert.equal(await next.attach(app({ state: 'starting', target: null })), route);
  assert.equal(next.port, port); assert.notEqual(next.marker.pid, legacyPid); assert.notEqual(next.marker.id, legacyId);
  assert.equal((await availabilityControl(next.marker, 'ping')).state.responderVersion, REMOTE_AVAILABILITY_VERSION);
  for (const [credential, expectedConnection] of [[token, connectionId], [registeredToken, registeredConnectionId]]) {
    const response = await send(port, call('blackice_direct_status', { nonce: 'after.responder.update' }), { headers: { Authorization: 'Bearer ' + credential } });
    assert.equal(response.status, 200);
    assert.equal(response.body.result.structuredContent.connectionId, expectedConnection);
    assert.equal(response.body.result.structuredContent.nonce, 'after.responder.update');
    assert.equal(response.body.result.structuredContent.state, 'starting');
    assert.equal(response.body.result.structuredContent.responderVersion, REMOTE_AVAILABILITY_VERSION);
  }
  assert.deepEqual(await fs.readFile(file), before);
  for (let attempt = 0; attempt < 100 && processPresence(legacyPid) !== false; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(processPresence(legacyPid), false, 'The old fixture exited through authenticated stop; no process termination is used.');
});

test('a different app cannot replace a legacy responder while its lifetime or proxy target is still attached', async t => {
  const p = await profile(), legacy = new RemoteAvailabilityHost({ dataDir: p.dataDir, origin, worker: await legacyWorker(p.dataDir) });
  const next = new RemoteAvailabilityHost({ dataDir: p.dataDir, origin });
  t.after(async () => { await legacy.stop().catch(() => {}); await fs.rm(p.dataDir, { recursive: true, force: true }); });
  await legacy.attach(app({ state: 'starting', target: null }));
  const markerBefore = await fs.readFile(legacy.markerPath);
  const lifetime = await availabilityControl(legacy.marker, 'ping');
  assert.equal(lifetime.lifetimeConnected, true); assert.equal(lifetime.targetAttached, false);
  await assert.rejects(next.start(), { code: 'REMOTE_AVAILABILITY_UNAVAILABLE' });
  assert.deepEqual(await fs.readFile(legacy.markerPath), markerBefore);
  assert.equal(processPresence(legacy.marker.pid), true);
  await legacy.offline('closing');
  await availabilityControl(legacy.marker, 'configure', app());
  const target = await availabilityControl(legacy.marker, 'ping');
  assert.equal(target.lifetimeConnected, false); assert.equal(target.targetAttached, true);
  await assert.rejects(next.start(), { code: 'REMOTE_AVAILABILITY_UNAVAILABLE' });
  assert.deepEqual(await fs.readFile(legacy.markerPath), markerBefore);
  assert.equal(processPresence(legacy.marker.pid), true);
});

test('remote lifecycle retains the owned responder on close and removes it on explicit disable', async t => {
  const p = await profile(); await fs.unlink(path.join(p.dataDir, 'remote-access.json'));
  let route = {}, removed = 0, liveCalls = 0;
  const hosts = [], managers = [];
  const status = { kind: 'tailscale', available: true, online: true, dnsName: new URL(origin).hostname, httpsPort: 443 };
  const transport = {
    async inspect() { return { config: route, status }; },
    async enable({ target }) { route = { TCP: { '443': { HTTPS: true } }, Web: { [new URL(origin).hostname + ':443']: { Handlers: { '/': { Proxy: target } } } } }; return { status }; },
    async disable() { removed++; route = {}; return { status }; },
  };
  const connector = { enabled: true, version: 'test', tools: () => tools, setOrigin() {}, matches() { return true; }, handle() {}, async setEnabled(value) { this.enabled = value; await fs.writeFile(path.join(p.dataDir, 'chatgpt-connector.json'), JSON.stringify({ version: 1, enabled: value })); } };
  const gatewayFactory = () => {
    const server = http.createServer(async (req, res) => { for await (const _chunk of req) {} liveCalls++; res.end(JSON.stringify({ fromApplication: true })); });
    return { accepting: true, listening: false, port: 0, async listen() { server.listen(0, '127.0.0.1'); await once(server, 'listening'); this.listening = true; this.port = server.address().port; return `http://127.0.0.1:${this.port}`; }, suspend() { this.accepting = false; }, async close() { this.listening = false; await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); } };
  };
  const create = () => { const manager = new RemoteAccessManager({ dataDir: p.dataDir, transport, connector, gatewayFactory, availabilityFactory: options => { const host = new RemoteAvailabilityHost(options); hosts.push(host); return host; } }); managers.push(manager); return manager; };
  t.after(async () => { for (const manager of managers) await manager.close(); for (const host of hosts) await host.stop().catch(() => {}); await fs.rm(p.dataDir, { recursive: true, force: true }); });
  const first = await create().init();
  await first.attach({ origin: 'http://127.0.0.1:54321', sessionCookie: 'relay_session_54321=' + 'b'.repeat(64) });
  await first.enable({ mode: 'private' });
  const stablePort = first.config.gatewayPort, helperPid = first.availability.marker.pid;
  assert.notEqual(first.gateway.port, stablePort);
  assert.equal((await send(stablePort, call('blackice_direct_status'))).body.fromApplication, true);
  await first.close();
  assert.equal(removed, 0); assert.equal((await send(stablePort, call('blackice_direct_status'))).body.result.structuredContent.state, 'closing');
  const next = await create().init();
  assert.equal((await send(stablePort, call('blackice_direct_status'))).body.result.structuredContent.state, 'starting');
  await next.attach({ origin: 'http://127.0.0.1:54322', sessionCookie: 'relay_session_54322=' + 'c'.repeat(64) });
  assert.equal(next.config.gatewayPort, stablePort); assert.equal(next.availability.marker.pid, helperPid);
  assert.equal((await send(stablePort, call('blackice_direct_status'))).body.fromApplication, true);
  assert.equal(liveCalls, 2);
  await next.disable(); assert.equal(removed, 1); assert.equal(next.config.enabled, false);
  await assert.rejects(fs.stat(path.join(p.dataDir, 'remote-availability.json')), { code: 'ENOENT' });
});

test('a crashed fixture helper can be recreated by the same host and cannot wedge explicit stop', async t => {
  const p = await profile(), host = new RemoteAvailabilityHost({ dataDir: p.dataDir, origin });
  t.after(async () => { await host.stop().catch(() => {}); await fs.rm(p.dataDir, { recursive: true, force: true }); });
  const route = await host.attach(app({ state: 'starting', target: null }));
  async function crashOwnedFixture() {
    // This PID was created solely for this disposable test profile; never a real BLACKICE process.
    const pid = host.marker.pid; process.kill(pid);
    for (let attempt = 0; attempt < 100 && processPresence(pid) !== false; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(processPresence(pid), false); return pid;
  }
  const previous = await crashOwnedFixture();
  assert.deepEqual(await Promise.all([host.start(), host.start()]), [route, route]);
  assert.equal(await host.attach(app({ state: 'starting', target: null })), route);
  assert.notEqual(host.marker.pid, previous);
  assert.equal((await send(host.port, call('blackice_direct_status'))).body.result.structuredContent.state, 'starting');
  await crashOwnedFixture();
  await host.stop();
  assert.equal(host.startPromise, null); assert.equal(host.marker, null);
  await assert.rejects(fs.stat(path.join(p.dataDir, 'remote-availability.json')), { code: 'ENOENT' });
});

test('losing the real application lifetime socket removes the stale proxy target', async t => {
  const p = await profile(), host = new RemoteAvailabilityHost({ dataDir: p.dataDir, origin });
  t.after(async () => { await host.stop().catch(() => {}); await fs.rm(p.dataDir, { recursive: true, force: true }); });
  await host.attach(app());
  let control = await availabilityControl(host.marker, 'ping');
  assert.equal(control.targetAttached, true); assert.equal(control.lifetimeConnected, true);
  host.watchRequest.destroy();
  for (let attempt = 0; attempt < 50; attempt++) {
    control = await availabilityControl(host.marker, 'ping');
    if (!control.targetAttached) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(control.targetAttached, false); assert.equal(control.lifetimeConnected, false);
  assert.equal((await send(host.port, call('blackice_direct_status'))).body.result.structuredContent.state, 'unreachable');
});

test('early rejection diagnostics classify exact Mistral origins without relaxing origin policy', async t => {
  const f = await fixture(t, { presence: () => false });
  const before = await fs.readFile(path.join(f.dataDir, 'chatgpt-oauth.json'));
  const cases = [
    ['https://chat.mistral.ai', 'mistral-chat'],
    ['https://mistral.ai', 'mistral-home'],
    ['https://admin.mistral.ai', 'mistral-admin'],
    ['https://chat.mistral.ai.other.example', 'other'],
    ['https://other.example', 'other'],
    ['null', 'other'],
    ['not-an-origin', 'malformed'],
    ['https://chat.mistral.ai/private', 'malformed'],
  ];
  for (const [value, classification] of cases) {
    const response = await send(f.port, '', { method: 'GET', endpoint: '/.well-known/oauth-protected-resource/mcp/chatgpt?private-query',
      headers: { Authorization: undefined, Origin: value } });
    assert.equal(response.status, 403);
    assert.deepEqual(response.body, { error: 'Unrecognized connector origin.' });
    const event = f.responder.earlyRejectionDiagnostics().recent.at(-1);
    assert.deepEqual(Object.keys(event).sort(), ['at', 'endpoint', 'method', 'origin', 'reason', 'statusCode']);
    assert.equal(Number.isNaN(Date.parse(event.at)), false);
    assert.equal(event.reason, 'origin'); assert.equal(event.statusCode, 403);
    assert.equal(event.endpoint, 'resource-path'); assert.equal(event.method, 'GET');
    assert.equal(event.origin, classification);
  }
  for (const value of [undefined, origin]) {
    const response = await send(f.port, call('blackice_direct_status'), { headers: { Origin: value } });
    assert.equal(response.status, 200);
    assert.equal(response.body.result.structuredContent.connectionId, connectionId);
    assert.equal('earlyRejections' in response.body.result.structuredContent, false);
  }
  assert.equal(f.responder.earlyRejectionDiagnostics().total, cases.length);
  assert.deepEqual(await fs.readFile(path.join(f.dataDir, 'chatgpt-oauth.json')), before);
});

test('early rejection diagnostics are bounded, detached, and exclude arbitrary request data', async t => {
  const f = await fixture(t, { presence: () => false });
  const invoke = async overrides => {
    const req = { socket: { remoteAddress: '127.0.0.1' }, method: 'HEAD', url: '/mcp/chatgpt',
      headers: { host: new URL(origin).host }, ...overrides };
    const response = { setHeader() {}, writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
    await f.responder.handle(req, response); return response;
  };
  assert.equal((await invoke({ socket: { remoteAddress: '203.0.113.7' } })).status, 403);
  assert.equal((await invoke({ headers: { host: 'private-host.example', origin } })).status, 403);
  assert.equal((await invoke({ url: '//private-path.example/private-query' })).status, 400);
  let snapshot = f.responder.earlyRejectionDiagnostics();
  assert.deepEqual(snapshot.recent.map(value => [value.reason, value.origin, value.endpoint]), [
    ['source', 'absent', 'mcp'], ['host', 'blackice', 'mcp'], ['path', 'absent', 'invalid'],
  ]);
  for (let index = 0; index < 40; index++) {
    const response = await invoke({ method: 'PRIVATE_METHOD', url: '/private-path?private-query',
      headers: { host: 'private-host.example', origin: 'https://private-origin.example', authorization: 'Bearer ' + token,
        cookie: 'private-cookie', 'x-private-header': 'private-header-value' }, body: 'private-body' });
    assert.equal(response.status, 403);
    assert.deepEqual(response.body, { error: 'Use the configured BLACKICE HTTPS address.' });
  }
  snapshot = f.responder.earlyRejectionDiagnostics();
  assert.equal(snapshot.capacity, 32); assert.equal(snapshot.recent.length, 32); assert.equal(snapshot.total, 43);
  assert.deepEqual(snapshot.counts, { source: 1, host: 41, path: 1, origin: 0 });
  assert.ok(snapshot.recent.every(value => value.method === 'other' && value.endpoint === 'other' && value.origin === 'other'));
  const serialized = JSON.stringify(snapshot);
  for (const secret of [token, 'private-host.example', 'private-path', 'private-query', 'private-origin.example',
    'private-cookie', 'private-header-value', 'private-body', 'PRIVATE_METHOD']) assert.equal(serialized.includes(secret), false);
  snapshot.counts.host = 0; snapshot.recent[0].reason = 'modified'; snapshot.recent.length = 0;
  const next = f.responder.earlyRejectionDiagnostics();
  assert.equal(next.counts.host, 41); assert.equal(next.recent.length, 32); assert.equal(next.recent[0].reason, 'host');
  assert.equal('earlyRejections' in f.responder.status(), false);
});

test('early rejection diagnostics are available only on authenticated local control ping', async t => {
  const p = await profile(), host = new RemoteAvailabilityHost({ dataDir: p.dataDir, origin });
  t.after(async () => { await host.stop().catch(() => {}); await fs.rm(p.dataDir, { recursive: true, force: true }); });
  await host.attach(app({ state: 'starting', target: null }));
  const initial = await availabilityControl(host.marker, 'ping');
  assert.equal(initial.state.responderVersion, 6);
  assert.equal(initial.earlyRejections.total, 0);
  const rejected = await send(host.port, call('blackice_direct_status'), { headers: { Origin: 'https://chat.mistral.ai' } });
  assert.equal(rejected.status, 403); assert.equal('earlyRejections' in rejected.body, false);
  const control = await availabilityControl(host.marker, 'ping');
  assert.equal(control.earlyRejections.total, 1);
  assert.equal(control.earlyRejections.recent[0].origin, 'mistral-chat');
  assert.equal(JSON.stringify(control).includes(host.marker.token), false);
  await assert.rejects(availabilityControl({ ...host.marker, token: 'x'.repeat(43) }, 'ping'), { code: 'REMOTE_AVAILABILITY_UNAVAILABLE' });
  const publicStatus = await send(host.port, call('blackice_direct_status'));
  assert.equal(publicStatus.status, 200); assert.equal('earlyRejections' in publicStatus.body.result.structuredContent, false);
  const lifecycle = await availabilityControl(host.marker, 'configure', app({ state: 'starting', target: null }));
  assert.equal('earlyRejections' in lifecycle, false);
});
