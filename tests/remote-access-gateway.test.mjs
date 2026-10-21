import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { RemoteAccessManager } from '../lib/remote-access.mjs';
import { REMOTE_COOKIE, machineRemotePath, forwardedIdentityPath } from '../lib/remote-access-gateway.mjs';
import { createRemoteTransportFixture } from './fixtures/remote-transport.mjs';

async function fixture(t, { enabled = true, now = Date.now } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-remote-gateway-')), transport = createRemoteTransportFixture(), requests = [];
  let manager;
  const backend = http.createServer((req, res) => {
    const client = forwardedIdentityPath(new URL(req.url, 'http://127.0.0.1').pathname, req.method, 'browser') ? manager.authorizeForward(req) : null;
    const replay = manager.authorizeForward(req); requests.push({ url: req.url, method: req.method, headers: { ...req.headers }, client, replay });
    if (req.url === '/api/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Set-Cookie': 'private_should_not_escape=1' }); res.write('data: ready\n\n'); return; }
    req.resume(); res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'private_should_not_escape=1' }); res.end(JSON.stringify({ ok: true, client, replay }));
  });
  t.after(async () => { await manager?.close(); backend.closeAllConnections(); if (backend.listening) await new Promise(resolve => backend.close(resolve)); await fs.rm(dataDir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { backend.once('error', reject); backend.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${backend.address().port}`, localCookie = `relay_session_${backend.address().port}=${'a'.repeat(64)}`;
  manager = await new RemoteAccessManager({ dataDir, transport: transport.transport, now, defaultHttpsPort: 8443 }).init(); await manager.attach({ origin, sessionCookie: localCookie });
  if (enabled) await manager.enable();
  function request(route, { method = 'GET', headers = {}, body } = {}) {
    const encoded = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: manager.gateway.port, path: route, method, headers: { Host: new URL(manager.status().url).host, ...(encoded !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) } : {}), ...headers } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => { const text = Buffer.concat(chunks).toString(); let value; try { value = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, text, value }); }); res.on('error', reject);
      }); req.setTimeout(3000, () => req.destroy(new Error('Request timed out.'))); req.on('error', reject); req.end(encoded);
    });
  }
  async function browser(label = 'QA browser') { const issued = manager.pair(); const result = await request('/remote/pair', { method: 'POST', headers: { Origin: manager.status().url }, body: { code: issued.code, label } }); assert.equal(result.status, 200); return { cookie: result.headers['set-cookie'][0].split(';')[0], result, device: result.value.device, issued }; }
  return { manager, transport, requests, backend, origin, localCookie, dataDir, request, browser };
}

test('remote access defaults to disabled without invoking Tailscale or issuing credentials', async t => {
  const { manager, transport } = await fixture(t, { enabled: false }); assert.equal(manager.status().enabled, false); assert.equal(manager.gateway, null); assert.deepEqual(transport.calls, []); assert.deepEqual(manager.status().devices, []);
  assert.throws(() => manager.pair(), { code: 'REMOTE_NOT_ENABLED' }); await assert.rejects(manager.createAgent({ label: 'Agent' }), { code: 'REMOTE_NOT_ENABLED' });
});

test('the separate ChatGPT endpoint keeps exact host checks and receives no local UI authority', async t => {
  const { manager, request, requests } = await fixture(t);
  const calls = [];
  manager.attachConnector({ setOrigin(origin) { calls.push({ origin }); }, matches(pathname) { return pathname === '/mcp/chatgpt'; }, async handle(req, res) {
    calls.push({ headers: { ...req.headers } }); req.resume(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"connector":true}');
  } });
  assert.equal((await request('/mcp/chatgpt', { method: 'POST', body: {} })).status, 200);
  assert.equal(calls.length, 2); assert.equal(calls[1].headers.cookie, undefined); assert.equal(calls[1].headers['x-blackice-forward'], undefined); assert.deepEqual(requests, []);
  assert.equal((await request('/mcp/chatgpt', { method: 'POST', headers: { Host: 'wrong.example' }, body: {} })).status, 403); assert.equal(calls.length, 2);
});

test('connector discovery trace records only fixed routing metadata, including guarded rejections', async t => {
  let now = Date.parse('2026-10-20T12:00:00Z');
  const { manager, request, requests } = await fixture(t, { now: () => now });
  const paths = ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp/chatgpt', '/.well-known/oauth-authorization-server', '/mcp/chatgpt'];
  manager.attachConnector({ setOrigin() {}, matches: pathname => paths.includes(pathname), async handle(req, res) {
    req.resume(); res.writeHead(req.method === 'POST' ? 401 : 200, { 'Content-Type': 'application/json' }); res.end('{}');
  } });
  assert.deepEqual(manager.connectorDiscovery(), []);
  const cases = [
    [paths[0], 'GET', { 'Tailscale-Funnel-Request': '?1' }, 'rootPRM', 200, true],
    [paths[1], 'HEAD', {}, 'pathPRM', 200, false],
    [paths[2], 'GET', { 'Tailscale-Funnel-Request': '?0' }, 'ASmetadata', 200, false],
    [paths[3], 'POST', { 'Tailscale-Funnel-Request': '?1' }, 'exactMCP', 401, true],
    [paths[3], 'GET', { Host: 'wrong.example', 'Tailscale-Funnel-Request': '?1' }, 'exactMCP', 403, true],
    [paths[3], 'OPTIONS', {}, 'exactMCP', 405, false],
    [paths[3], 'DELETE', {}, 'exactMCP', 200, false],
  ];
  const expected = [];
  for (const [route, method, headers, path, statusCode, funnel] of cases) {
    const response = await request(route + '?private_query_marker=private_value_marker', { method, headers: { Authorization: 'Bearer private_auth_marker', Cookie: 'private_cookie_marker=private_value_marker', ...headers }, ...(method === 'POST' ? { body: { private_body_marker: 'private_value_marker' } } : {}) });
    assert.equal(response.status, statusCode);
    expected.push({ at: new Date(now).toISOString(), path, method: ['GET', 'POST', 'HEAD', 'OPTIONS'].includes(method) ? method : 'other', statusCode, funnel }); now += 1000;
  }
  assert.deepEqual(manager.connectorDiscovery(), expected);
  assert.doesNotMatch(JSON.stringify(manager.connectorDiscovery()), /private_|wrong\.example|oauth-protected-resource|\/mcp\/chatgpt/);
  assert.deepEqual(requests, []);
  for (const route of ['/', '/remote/session', '/chatgpt/oauth/token', '/mcp/chatgpt/extra', '/.well-known/oauth-protected-resource/other', '/api/remote-access', '/mcp/%2fchatgpt']) await request(route);
  assert.deepEqual(manager.connectorDiscovery(), expected);
  assert.equal(Object.hasOwn(manager.status(), 'discoveryRequests'), false);
});

test('connector discovery trace is capped, defensively copied, and forgotten with the gateway', async t => {
  let now = Date.parse('2026-10-20T12:00:00Z');
  const { manager, request } = await fixture(t, { now: () => now });
  manager.attachConnector({ setOrigin() {}, async setEnabled() {}, matches: pathname => pathname === '/mcp/chatgpt', async handle(req, res) { req.resume(); res.writeHead(401); res.end(); } });
  for (let index = 0; index < 40; index++) { now += 1000; assert.equal((await request('/mcp/chatgpt')).status, 401); }
  const trace = manager.connectorDiscovery(); assert.equal(trace.length, 32);
  assert.equal(trace[0].at, '2026-10-20T12:00:09.000Z'); assert.equal(trace.at(-1).at, '2026-10-20T12:00:40.000Z');
  trace[0].path = 'changed'; trace.pop(); trace.push({ private_marker: true });
  assert.equal(manager.connectorDiscovery().length, 32); assert.equal(manager.connectorDiscovery()[0].path, 'exactMCP');
  const gateway = manager.gateway; await manager.disable();
  assert.deepEqual(gateway.connectorDiscovery(), []); assert.deepEqual(manager.connectorDiscovery(), []);
  await manager.enable(); assert.notEqual(manager.gateway, gateway); assert.deepEqual(manager.connectorDiscovery(), []);
  manager.gateway.now = () => NaN;
  assert.equal((await request('/mcp/chatgpt')).status, 401); assert.deepEqual(manager.connectorDiscovery(), []);
});

test('paired remote browsers cannot approve ChatGPT grants or direct execution actions', async t => {
  const { request, browser, requests } = await fixture(t), { cookie } = await browser();
  for (const endpoint of ['/api/chatgpt-connector', '/api/chatgpt-connector/authorize', '/api/chatgpt-connector/jobs/direct_one/approve']) {
    const response = await request(endpoint, { headers: { Cookie: cookie } }); assert.equal(response.status, 403, endpoint);
  }
  assert.deepEqual(requests, []);
});

test('disable and revoke all also disables the ChatGPT connector', async t => {
  const { manager } = await fixture(t), states = [];
  manager.attachConnector({ setOrigin() {}, matches: () => false, handle() {}, async setEnabled(value) { states.push(value); } });
  await manager.disable(); assert.deepEqual(states, [false]); assert.equal(manager.status().enabled, false);
});

test('unpaired requests only receive a pairing page and never the local session', async t => {
  const { request, requests, localCookie } = await fixture(t);
  const root = await request('/'); assert.equal(root.status, 200); assert.match(root.text, /Pair this device/); assert.equal(root.headers['set-cookie'], undefined); assert.ok(!root.text.includes(localCookie));
  assert.equal((await request('/api/status')).status, 401); assert.equal(requests.length, 0);
  const crossSiteNavigation = await request('/', { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' } }); assert.equal(crossSiteNavigation.status, 200);
});

test('pairing sets a host-only secure HTTP-only strict cookie and consumes the code', async t => {
  const { browser, manager, request, requests, localCookie } = await fixture(t), paired = await browser();
  const cookie = paired.result.headers['set-cookie'][0]; assert.ok(cookie.startsWith(REMOTE_COOKIE + '='));
  for (const flag of ['Path=/', 'Secure', 'HttpOnly', 'SameSite=Strict', 'Max-Age=']) assert.ok(cookie.includes(flag)); assert.ok(!cookie.includes('Domain='));
  assert.equal((await request('/remote/pair', { method: 'POST', headers: { Origin: manager.status().url }, body: { code: paired.issued.code, label: 'Replay' } })).status, 401);
  const result = await request('/api/status', { headers: { Cookie: paired.cookie, 'X-Blackice-Remote': '0', 'X-Blackice-Forward': 'forged', 'X-Forwarded-Host': 'evil.example', 'Tailscale-User-Login': 'spoof@example.test' } });
  assert.equal(result.status, 200); assert.equal(result.headers['set-cookie'], undefined); const forwarded = requests.at(-1).headers;
  assert.equal(forwarded.cookie, localCookie); assert.equal(forwarded['x-blackice-remote'], '1'); assert.equal(forwarded['x-blackice-forward'], undefined); assert.equal(forwarded['x-forwarded-host'], undefined); assert.equal(forwarded['tailscale-user-login'], undefined);
});

test('exact Host and Origin rules reject cross-site writes and ambiguous paths', async t => {
  const { request, browser, manager, requests } = await fixture(t), paired = await browser();
  for (const headers of [{ Host: '127.0.0.1:8443' }, { Origin: 'https://other.example' }, { 'Sec-Fetch-Site': 'same-site' }, { 'Sec-Fetch-Site': 'cross-site' }]) assert.equal((await request('/api/status', { headers: { Cookie: paired.cookie, ...headers } })).status, 403);
  assert.equal((await request('/api/runs', { method: 'POST', headers: { Cookie: paired.cookie }, body: {} })).status, 403);
  assert.equal((await request('/api/runs', { method: 'POST', headers: { Cookie: paired.cookie, Origin: manager.status().url }, body: {} })).status, 200);
  for (const route of ['//evil.example/api/status', 'http://evil.example/api/status', '/api/%2fremote-access', '/api/%252fremote-access', '/api/%00status', '/api/%ZZ']) assert.equal((await request(route, { headers: { Cookie: paired.cookie } })).status, 400, route);
  assert.equal(requests.length, 1);
});

test('a paired browser can configure server-side providers but cannot manage host-only access or shutdown', async t => {
  const { request, browser, manager } = await fixture(t), paired = await browser(), headers = { Cookie: paired.cookie, Origin: manager.status().url };
  for (const route of ['/api/remote-access/create-agent', '/api/remote-access/revoke', '/api/remote-access/enable', '/api/remote-access/disable', '/api/shutdown', '/api/profile/restore', '/api/maintenance', '/api/desktop/background', '/api/desktop/show', '/api/browser/chrome/connect', '/api/browser/neo/import', '/api/email/config', '/api/email/oauth/begin', '/api/email/oauth/cancel', '/api/email/oauth/disconnect']) assert.equal((await request(route, { method: 'POST', headers, body: {} })).status, 403, route);
  for (const route of ['/api/providers', '/api/connections', '/api/email/action', '/api/email/drafts', '/api/runs', '/api/planning/plans']) assert.equal((await request(route, { method: 'POST', headers, body: {} })).status, 200, route);
  for (const route of ['/api/email/config', '/api/email/oauth/config']) assert.equal((await request(route, { method: 'PUT', headers, body: {} })).status, 403, route);
  for (const route of ['/api/email', '/api/email/oauth/status']) assert.equal((await request(route, { headers })).status, 200, route);
  const metadata = await request('/api/remote-access', { headers }); assert.equal(metadata.value.localManagement, false); assert.equal(metadata.value.client, 'remote'); assert.equal(metadata.value.device.id, paired.device.id); assert.equal(metadata.value.devices, undefined); assert.equal(metadata.value.gateway, undefined);
});

test('agent bearer credentials cannot bypass scoped APIs through legacy routes or browser cookies', async t => {
  const { request, manager } = await fixture(t), issued = await manager.createAgent({ label: 'Read-only agent', scopes: ['read'] }), headers = { Authorization: 'Bearer ' + issued.token };
  for (const route of ['/', '/app.js', '/api/status', '/api/runs', '/api/providers', '/api/remote-access', '/api/agentish', '/mcp/other']) assert.equal((await request(route, { headers })).status, 403, route);
  assert.equal((await request('/api/agent/status', { headers: { Cookie: `${REMOTE_COOKIE}=${issued.token}` } })).status, 401);
  const result = await request('/api/agent/status', { headers }); assert.equal(result.status, 200); assert.equal(result.value.client.id, issued.device.id); assert.equal(result.value.client.kind, 'agent'); assert.deepEqual(result.value.client.scopes, ['read']); assert.equal(result.value.replay, null);
  const session = await request('/remote/session', { headers }); assert.equal(session.value.clientKind, 'agent'); assert.equal(session.value.localManagement, false);
});

test('MCP preserves its protocol headers while network clients cannot supply forwarding identity', async t => {
  const { request, browser, manager, requests } = await fixture(t), paired = await browser();
  const agent = await manager.createAgent({ label: 'Other agent', scopes: ['read'] });
  const stolenShape = manager.forwardCredential({ method: 'POST', path: '/mcp', client: agent.device });
  const result = await request('/mcp', { method: 'POST', headers: { Cookie: paired.cookie, Origin: manager.status().url, 'X-Blackice-Forward': stolenShape, 'Mcp-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'status', Accept: 'application/json, text/event-stream' }, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  assert.equal(result.status, 200); assert.equal(result.value.client.kind, 'browser'); assert.equal(result.value.client.id, paired.device.id); assert.notEqual(result.value.client.id, agent.device.id); assert.equal(result.value.replay, null);
  const forwarded = requests.at(-1).headers; assert.notEqual(forwarded['x-blackice-forward'], stolenShape); assert.equal(forwarded['mcp-protocol-version'], '2026-07-28'); assert.equal(forwarded['mcp-method'], 'tools/call'); assert.equal(forwarded['mcp-name'], 'status');
  const machine = await request('/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + agent.token }, body: {} }); assert.equal(machine.status, 200);
  assert.equal((await request('/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + agent.token, Origin: 'https://evil.example' }, body: {} })).status, 403);
  assert.equal((await request('/mcp', { headers: { Authorization: 'Bearer invalid', Cookie: paired.cookie } })).status, 401);
  assert.equal(requests.at(-1).headers.authorization, undefined);
});

test('forwarding capabilities are one-use, bound to request path/method, and revoked with their device', async t => {
  let now = Date.now(); const { manager } = await fixture(t, { now: () => now }), issued = await manager.createAgent({ label: 'Agent' });
  const mint = () => manager.forwardCredential({ method: 'POST', path: '/mcp', client: issued.device });
  const req = token => ({ method: 'POST', url: '/mcp', headers: { host: manager.target.host, origin: manager.target.origin, 'x-blackice-remote': '1', 'x-blackice-forward': token }, socket: { remoteAddress: '127.0.0.1' } });
  const token = mint(); assert.equal(manager.authorizeForward({ ...req(token), url: '/api/agent/status' }), null); assert.equal(manager.authorizeForward(req(token)), null);
  const timed = mint(); now += 15001; assert.equal(manager.authorizeForward(req(timed)), null);
  const valid = mint(); assert.equal(manager.authorizeForward(req(valid)).id, issued.device.id); assert.equal(manager.authorizeForward(req(valid)), null);
  const revoked = mint(); await manager.revoke(issued.device.id); assert.equal(manager.authorizeForward(req(revoked)), null);
  assert.equal(manager.authorizeForward(req('x'.repeat(43))), null);
});

test('paired human plan edits carry verified provenance without broadening the agent route allowlist', async t => {
  const { manager, browser, request, requests } = await fixture(t), paired = await browser('Plan reviewer'), agent = await manager.createAgent({ label: 'Cloud agent', scopes: ['read', 'planning:write'] });
  const route = '/api/tasks/task_fixture/plan/edit', headers = { Cookie: paired.cookie, Origin: manager.status().url, 'X-Blackice-Forward': 'x'.repeat(43), 'X-Blackice-Client-Id': agent.device.id };
  const edited = await request(route, { method: 'POST', headers, body: {} }); assert.equal(edited.status, 200); assert.equal(edited.value.client.id, paired.device.id); assert.equal(edited.value.client.kind, 'browser'); assert.equal(edited.value.client.label, 'Plan reviewer'); assert.equal(edited.value.replay, null); assert.equal(requests.at(-1).headers['x-blackice-client-id'], undefined);
  assert.equal((await request(route, { method: 'GET', headers })).value.client, null);
  assert.equal((await request('/api/tasks/task_fixture/plan', { method: 'POST', headers, body: {} })).value.client, null);
  assert.equal((await request(route, { method: 'POST', headers: { Authorization: 'Bearer ' + agent.token }, body: {} })).status, 403);
  assert.throws(() => manager.forwardCredential({ method: 'POST', path: route, client: agent.device }), { code: 'REMOTE_CREDENTIAL_REQUIRED' });
});

test('presence creation and release forward the paired human identity without accepting machine impersonation', async t => {
  const { manager, browser, request } = await fixture(t), paired = await browser('Plan editor');
  const route = '/api/tasks/task_fixture/plan/presence', headers = { Cookie: paired.cookie, Origin: manager.status().url };
  for (const method of ['POST', 'DELETE']) {
    const response = await request(route, { method, headers, body: { editorId: 'editor-one', ...(method === 'POST' ? { stepId: null } : {}) } });
    assert.equal(response.status, 200); assert.equal(response.value.client.id, paired.device.id); assert.equal(response.value.client.kind, 'browser'); assert.equal(response.value.replay, null);
  }
  for (const scopes of [['read'], ['read', 'planning:write']]) {
    const agent = await manager.createAgent({ label: 'Outside automation', scopes });
    for (const method of ['POST', 'DELETE']) {
      const response = await request(route, { method, headers: { Authorization: 'Bearer ' + agent.token }, body: { editorId: 'spoof' } });
      assert.equal(response.status, 403); assert.equal(response.value.code, 'REMOTE_AGENT_ROUTE_REQUIRED');
      assert.throws(() => manager.forwardCredential({ method, path: route, client: agent.device }), { code: 'REMOTE_CREDENTIAL_REQUIRED' });
    }
  }
});

test('revoking a browser terminates its already-open event stream', async t => {
  const { manager, browser } = await fixture(t), paired = await browser();
  const stream = await new Promise((resolve, reject) => { const req = http.get({ hostname: '127.0.0.1', port: manager.gateway.port, path: '/api/events', headers: { Host: new URL(manager.status().url).host, Cookie: paired.cookie } }, res => resolve({ req, res })); req.on('error', reject); });
  stream.res.on('error', () => {}); await once(stream.res, 'data'); const closed = new Promise(resolve => stream.res.once('close', resolve)); await manager.revoke(paired.device.id);
  await Promise.race([closed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Revoked stream stayed open.')), 2000); timer.unref(); })]); assert.equal(manager.gateway.requests.size, 0);
});

test('public exposure requires local confirmation and disable revokes every client', async t => {
  const { manager, transport, browser } = await fixture(t); const paired = await browser(); const agent = await manager.createAgent({ label: 'Agent' });
  await assert.rejects(manager.enable({ mode: 'public' }), { code: 'REMOTE_PUBLIC_CONFIRMATION' }); assert.equal(manager.status().mode, 'private'); assert.ok(!transport.calls.some(args => args[0] === 'funnel'));
  await manager.enable({ mode: 'public', confirmPublic: true }); assert.equal(manager.status().mode, 'public'); assert.equal(manager.status().enabled, true); assert.ok(manager.sessions.getClient(paired.device.id));
  await manager.disable(); assert.equal(manager.status().enabled, false); assert.equal(manager.gateway, null); assert.deepEqual(manager.status().devices, []); assert.equal(manager.sessions.authenticate(agent.token, 'agent'), null);
  assert.ok(!transport.config.TCP['8443']); assert.ok(transport.config.AllowFunnel[`${transport.hostname}:443`]);
});

test('failed route removal leaves a rejecting listener until the owner can clean up', async t => {
  const { manager, transport, request, browser } = await fixture(t), paired = await browser(), original = transport.transport.disable.bind(transport.transport);
  transport.transport.disable = async () => { throw Object.assign(new Error('Tailscale is unavailable.'), { code: 'REMOTE_TAILSCALE_COMMAND' }); };
  const status = await manager.disable(); assert.equal(status.enabled, false); assert.equal(status.gateway.listening, true); assert.equal(status.gateway.accepting, false);
  assert.equal((await request('/api/status', { headers: { Cookie: paired.cookie } })).status, 503); assert.deepEqual(manager.status().devices, []);
  transport.transport.disable = original; await manager.disable(); assert.equal(manager.gateway, null);
});

test('malformed remote configuration does not prevent the local app from attaching', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-remote-config-')); t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const file = path.join(dataDir, 'remote-access.json'), original = '{broken'; await fs.writeFile(file, original);
  const manager = await new RemoteAccessManager({ dataDir, transport: createRemoteTransportFixture().transport, defaultHttpsPort: 8443 }).init(); t.after(() => manager.close());
  const status = await manager.attach({ origin: 'http://127.0.0.1:32123', sessionCookie: `relay_session_32123=${'b'.repeat(64)}` }); assert.equal(status.available, false); assert.equal(status.state, 'error'); assert.equal(status.enabled, false); assert.equal(await fs.readFile(file, 'utf8'), original);
});

test('graceful shutdown preserves credential hashes and enabled mode for the same-profile restart', async t => {
  const first = await fixture(t), issued = await first.manager.createAgent({ label: 'Persistent agent', scopes: ['read', 'planning:write'] });
  await first.manager.close(); assert.ok(!first.transport.config.TCP['8443']);
  const manager = await new RemoteAccessManager({ dataDir: first.dataDir, transport: first.transport.transport, defaultHttpsPort: 8443 }).init(); t.after(() => manager.close());
  await manager.attach({ origin: first.origin, sessionCookie: first.localCookie }); assert.equal(manager.status().enabled, true); assert.deepEqual(manager.sessions.authenticate(issued.token, 'agent').scopes, ['read', 'planning:write']);
  assert.ok(!JSON.stringify(manager.status()).includes(issued.token));
});
