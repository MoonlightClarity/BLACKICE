import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { RemoteAvailabilityResponder, readAvailabilityGrant, processPresence } from '../lib/remote-availability.mjs';
import { RemoteAvailabilityHost, availabilityControl } from '../lib/remote-availability-host.mjs';
import { RemoteAccessManager } from '../lib/remote-access.mjs';

const origin = 'https://fixture.example.ts.net', token = 'blackice_at_' + 'a'.repeat(43);
const connectionId = '11111111-1111-4111-8111-111111111111';
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

async function fixture(t, { presence = () => true } = {}) {
  const p = await profile(), responder = new RemoteAvailabilityResponder({ ...p, origin, presence });
  await responder.listen(); responder.configure(app());
  t.after(async () => { await responder.close(); await fs.rm(p.dataDir, { recursive: true, force: true }); });
  return { ...p, responder, port: responder.port };
}

function send(port, request, { headers = {}, endpoint = '/mcp/chatgpt', method = 'POST' } = {}) {
  const body = typeof request === 'string' ? request : JSON.stringify(request);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: endpoint, method, headers: { Host: new URL(origin).host, Authorization: 'Bearer ' + token, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers } }, res => {
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

test('offline OAuth refresh reports temporarily unavailable without modifying grants', async t => {
  const f = await fixture(t, { presence: () => false });
  const before = await fs.readFile(path.join(f.dataDir, 'chatgpt-oauth.json'));
  const r = await send(f.port, 'grant_type=refresh_token&refresh_token=fixture', { endpoint: '/chatgpt/oauth/token', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(r.status, 503); assert.equal(r.body.error, 'temporarily_unavailable'); assert.match(r.body.error_description, /BLACKICE is closed/);
  assert.deepEqual(await fs.readFile(path.join(f.dataDir, 'chatgpt-oauth.json')), before);
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
