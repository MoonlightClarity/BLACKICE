import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConnectionManager, createConnectionToolHandler } from '../lib/mcp.mjs';
import { discoverSignedBrowserEndpoints, nativeBrowserMetadataPaths, registerSignedBrowser, createSignedBrowserIntegration, signedBrowserEndpoint, isSignedBrowserCatalog, signedBrowserInstructions } from '../lib/signed-browser.mjs';

const tools = [
  { name: 'tabs', description: 'Open tabs in the background.', inputSchema: { type: 'object', properties: { action: { enum: ['list', 'new', 'close'] }, url: { type: 'string' } } } },
  { name: 'snapshot', inputSchema: { type: 'object', properties: { page: { type: 'integer' } }, required: ['page'] } },
  { name: 'act', inputSchema: { type: 'object', properties: { page: { type: 'integer' }, kind: { type: 'string' }, ref: { type: 'string' } }, required: ['page', 'kind'] } },
  { name: 'navigate', inputSchema: { type: 'object', properties: { page: { type: 'integer' }, url: { type: 'string' } } } },
];

test('endpoint discovery accepts only explicit local MCP URLs and never exposes credential-bearing values', async () => {
  for (const value of ['https://example.test/mcp', 'http://127.0.0.1:9010/mcp?token=private', 'http://user:private@localhost/mcp', 'file:///private', 'http://127.0.0.1:9010/other']) assert.equal(signedBrowserEndpoint(value), null);
  assert.equal(signedBrowserEndpoint('http://127.0.0.1:9010/mcp'), 'http://127.0.0.1:9010/mcp');
  assert.equal(signedBrowserEndpoint('http://[::1]:9010/mcp'), 'http://[::1]:9010/mcp');
  const config = `api_key = "never-return-this-secret"\n[mcp_servers.unrelated]\nurl="https://unrelated.test/mcp"\n[mcp_servers.browseros-neo]\nurl = "http://127.0.0.1:9010/mcp" # current endpoint\n[mcp_servers.browseros-neo.http_headers]\nAuthorization = "Bearer never-return-this-secret"\n[mcp_servers."BrowserClaw"]\nurl='http://localhost:9011/mcp'\n[mcp_servers."BrowserOS neo"]\nurl='http://localhost:9012/mcp'\nenabled=false\n`;
  const result = await discoverSignedBrowserEndpoints({ env: {}, readFileImpl: async () => config });
  assert.deepEqual(result.endpoints.map(endpoint => endpoint.url), ['http://127.0.0.1:9010/mcp', 'http://localhost:9011/mcp']);
  assert.doesNotMatch(JSON.stringify(result), /never-return|unrelated|Authorization/);
  const bad = await discoverSignedBrowserEndpoints({ env: { RELAY_BROWSEROS_MCP_URL: 'http://user:private@localhost/mcp' }, readFileImpl: () => { throw new Error('Must not read config after explicit override'); } });
  assert.equal(bad.endpoints.length, 0); assert.doesNotMatch(JSON.stringify(bad), /private/);
});

test('discovery honors exact environment URL, bounds config size and tolerates missing configuration', async () => {
  const result = await discoverSignedBrowserEndpoints({ env: { RELAY_SIGNED_BROWSER_MCP_URL: 'http://localhost:9200/mcp' }, readFileImpl: () => { throw new Error('Must not read config'); } });
  assert.deepEqual(result.endpoints, [{ url: 'http://localhost:9200/mcp', source: 'environment' }]);
  const missing = await discoverSignedBrowserEndpoints({ env: {}, readFileImpl: async () => { throw Object.assign(new Error('Private path'), { code: 'ENOENT' }); } });
  assert.deepEqual(missing, { endpoints: [], issues: [] });
  const large = await discoverSignedBrowserEndpoints({ env: {}, readFileImpl: async () => 'x'.repeat(256 * 1024 + 1) });
  assert.equal(large.endpoints.length, 0); assert.match(large.issues[0].reason, /limit/);
});

async function harness(t, { catalog = tools, hang = false, inventory, hangInventory = false, hangDelete = false } = {}) {
  const calls = [], dataDir = await mkdtemp(path.join(tmpdir(), 'relay-signed-browser-'));
  let sessionCount = 0, expireOnMethod = null;
  const server = createServer(async (request, response) => {
    if (request.method === 'DELETE') { if (hangDelete) return; response.writeHead(200); response.end(); return; }
    let text = ''; for await (const chunk of request) text += chunk;
    const message = JSON.parse(text); calls.push(message);
    if (message.method === expireOnMethod && request.headers['mcp-session-id']) {
      expireOnMethod = null; response.writeHead(404); response.end(); return;
    }
    if (hang) return;
    if (hangInventory && message.method === 'tools/call') return;
    if (!Object.hasOwn(message, 'id')) { response.writeHead(202); response.end(); return; }
    const result = message.method === 'initialize' ? { protocolVersion: '2025-06-18', serverInfo: { name: 'BrowserOS neo', version: 'test' }, capabilities: { tools: {} } }
      : message.method === 'tools/list' ? { tools: catalog }
      : inventory === undefined ? { content: [{ type: 'text', text: 'Actual existing browser tab listing.' }], structuredContent: { pages: [{ page: 42, url: 'https://example.test/', title: 'Existing profile' }] } } : typeof inventory === 'function' ? inventory(message) : inventory;
    response.writeHead(200, { 'Content-Type': 'application/json', ...(message.method === 'initialize' ? { 'Mcp-Session-Id': `fixture-${++sessionCount}` } : {}) }); response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const manager = await new ConnectionManager({ dataDir }).init();
  t.after(async () => { await manager.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  return { manager, calls, url: `http://127.0.0.1:${server.address().port}/mcp`, expireNext: method => { expireOnMethod = method; } };
}

test('real MCP registration discovers the existing browser without opening, navigating or focusing a tab', async t => {
  const { manager, calls, url } = await harness(t);
  const status = await registerSignedBrowser({ connections: manager, endpoints: [{ url }] });
  assert.equal(status.available, true); assert.equal(status.reusesBrowserSession, true); assert.equal(status.accountAuthenticated, null);
  assert.equal(status.catalogConnected, true); assert.equal(status.browserConnected, true);
  assert.deepEqual(calls.map(call => call.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  assert.deepEqual(calls.at(-1).params, { name: 'tabs', arguments: { action: 'list' } });
  assert.doesNotMatch(JSON.stringify(status), /example\.test|Existing profile/);
  assert.equal(manager.list()[0].url, url); assert.equal(manager.list()[0].timeoutMs, 30000);
  const gateway = createConnectionToolHandler({ manager });
  const catalog = await gateway({ name: 'relay_connections', arguments: { action: 'tools', connectionId: status.connectionId, query: 'tabs' } });
  assert.equal(catalog.success, true); assert.equal(catalog.receipt.browser, 'neo'); assert.deepEqual(JSON.parse(catalog.contentItems[0].text).tools.map(tool => tool.name), ['tabs']);
  const listing = await gateway({ name: 'relay_connections', arguments: { action: 'call', connectionId: status.connectionId, name: 'tabs', arguments: { action: 'list' } } });
  assert.equal(listing.success, true); assert.equal(listing.receipt.actionDispatched, true); assert.equal(listing.receipt.outcome, 'completed');
  assert.equal(calls.length, 9, 'discovery reuses the real catalog and one explicit native action reaches the transport');
  assert.equal(manager.list()[0].agentAvailable, true); assert.equal(manager.list()[0].agentUnavailableReason, undefined);
  assert.deepEqual(calls.at(-1).params, { name: 'tabs', arguments: { action: 'list' } });
  assert.match(signedBrowserInstructions(status), /connectionId "browseros-neo"/);
  assert.match(signedBrowserInstructions(status), /does not mean every site is signed in/);
});

test('registration preserves conflicting and user-disabled settings and reuses matching connection IDs', async t => {
  const { manager, calls, url } = await harness(t);
  await manager.save({ id: 'browseros-neo', transport: 'http', url, enabled: false });
  const disabled = await registerSignedBrowser({ connections: manager, endpoints: [{ url }] });
  assert.match(disabled.reason, /disabled/); assert.equal(calls.length, 0); assert.equal(manager.list()[0].enabled, false);
  const conflict = await registerSignedBrowser({ connections: manager, endpoints: [{ url: 'http://127.0.0.1:12345/mcp' }] });
  assert.match(conflict.reason, /preserved/); assert.equal(manager.list()[0].url, url);
  await manager.remove('browseros-neo');
  await manager.save({ id: 'my-browser', transport: 'http', url });
  const reused = await registerSignedBrowser({ connections: manager, endpoints: [{ url }] });
  assert.equal(reused.connectionId, 'my-browser'); assert.equal(manager.list().length, 1);
});

test('a reachable unrelated MCP server is not reported as the authenticated browser', async t => {
  const { manager, calls, url } = await harness(t, { catalog: [{ name: 'tabs', inputSchema: { type: 'object' } }] });
  assert.equal(isSignedBrowserCatalog(tools), true);
  const status = await registerSignedBrowser({ connections: manager, endpoints: [{ url }] });
  assert.equal(status.available, false); assert.equal(status.reusesBrowserSession, false); assert.match(status.reason, /expected BrowserOS/);
  assert.deepEqual(manager.list(), []); // Unverified service is never persisted as BrowserOS.
  assert.equal(calls.some(call => call.method === 'tools/call'), false); assert.equal(signedBrowserInstructions(status), '');
});

test('an unresponsive endpoint cannot hold startup beyond the bounded discovery deadline', async t => {
  const { manager, url } = await harness(t, { hang: true });
  const start = Date.now();
  const status = await registerSignedBrowser({ connections: manager, endpoints: [{ url }], timeoutMs: 120 });
  assert.equal(status.available, false); assert.equal(status.reusesBrowserSession, false); assert.match(status.reason, /not reachable/);
  assert.ok(Date.now() - start < 1500);
  assert.deepEqual(manager.list(), []); // Discovery retries from native metadata; unreachable endpoints are not trusted settings.
});

test('a reachable sidecar with a failed browser inventory never claims a usable browser or exposes page details', async t => {
  const { manager, calls, url } = await harness(t, { inventory: { isError: true, content: [{ type: 'text', text: 'browser link lost; private https://secret.example/account and token=private-value' }] } });
  const status = await registerSignedBrowser({ connections: manager, endpoints: [{ url }] });
  assert.equal(status.available, false); assert.equal(status.reusesBrowserSession, false);
  assert.equal(status.catalogConnected, true); assert.equal(status.browserConnected, false);
  assert.deepEqual(manager.list(), [], 'A disconnected sidecar must not become the saved browser endpoint.');
  assert.match(status.reason, /tools are connected.*browser link is unavailable/i);
  assert.doesNotMatch(JSON.stringify(status), /secret\.example|private-value|browser link lost|content|structuredContent/);
  assert.equal(signedBrowserInstructions(status), '');
  assert.deepEqual(calls.filter(call => call.method === 'tools/call').map(call => call.params), [{ name: 'tabs', arguments: { action: 'list' } }]);
});

test('catalog-shaped tool output is not a successful browser readiness response', async t => {
  const { manager, url } = await harness(t, { inventory: { tools } });
  const status = await registerSignedBrowser({ connections: manager, endpoints: [{ url }] });
  assert.equal(status.available, false); assert.equal(status.catalogConnected, true); assert.equal(status.browserConnected, false);
});

test('a browser inventory timeout is bounded and preserves the sidecar distinction', async t => {
  const { manager, url } = await harness(t, { hangInventory: true });
  const start = Date.now();
  const status = await registerSignedBrowser({ connections: manager, endpoints: [{ url }], timeoutMs: 120 });
  assert.equal(status.available, false); assert.equal(status.catalogConnected, true); assert.equal(status.browserConnected, false);
  assert.match(status.reason, /readiness deadline/); assert.ok(Date.now() - start < 1500);
});

test('cancelling a live browser inventory does not report the browser as connected', async t => {
  const controller = new AbortController();
  const { manager, calls, url } = await harness(t, { inventory: () => { controller.abort(); return { content: [] }; } });
  const status = await registerSignedBrowser({ connections: manager, endpoints: [{ url }], signal: controller.signal });
  assert.deepEqual(calls.filter(call => call.method === 'tools/call').map(call => call.params), [{ name: 'tabs', arguments: { action: 'list' } }]); assert.equal(status.available, false); assert.equal(status.browserConnected, false);
  assert.equal(status.reusesBrowserSession, false); assert.match(status.reason, /cancelled/);
});

test('readiness uses a supported read-only inventory and accepts a valid empty listing', async t => {
  const catalog = [...tools.map(tool => tool.name === 'tabs' ? { ...tool, inputSchema: { type: 'object', properties: { action: { enum: ['new', 'close'] } } } } : tool), { name: 'windows', inputSchema: { type: 'object', properties: { action: { enum: ['list', 'create', 'close'] } } } }];
  const { manager, calls, url } = await harness(t, { catalog, inventory: { content: [], structuredContent: { windows: [] } } });
  const status = await registerSignedBrowser({ connections: manager, endpoints: [{ url }] });
  assert.equal(status.available, true); assert.equal(status.browserConnected, true);
  assert.deepEqual(calls.filter(call => call.method === 'tools/call').map(call => call.params), [{ name: 'windows', arguments: { action: 'list' } }, { name: 'windows', arguments: { action: 'list' } }]);
});

test('registration tries another native endpoint when the first catalog has a disconnected browser', async t => {
  const stale = await harness(t, { inventory: { isError: true, content: [{ type: 'text', text: 'Disconnected browser.' }] } });
  const actual = await harness(t);
  const status = await registerSignedBrowser({ connections: actual.manager, endpoints: [{ url: stale.url, source: 'browseros-runtime' }, { url: actual.url, source: 'browseros-config' }] });
  assert.equal(status.available, true); assert.equal(status.endpoint, actual.url); assert.equal(status.browserConnected, true);
  assert.equal(stale.calls.filter(call => call.method === 'tools/call').length, 1);
  assert.equal(actual.calls.filter(call => call.method === 'tools/call').length, 2);
});

test('a stalled stale proxy cannot consume the live native endpoint discovery budget', async t => {
  const stale = await harness(t, { hangInventory: true, hangDelete: true });
  const actual = await harness(t);
  const startedAt = Date.now();
  const status = await registerSignedBrowser({ connections: actual.manager, timeoutMs: 1000, endpoints: [{ url: stale.url, source: 'browseros-runtime' }, { url: actual.url, source: 'browseros-config' }] });
  assert.equal(status.available, true); assert.equal(status.endpoint, actual.url);
  assert.equal(status.browserConnected, true);
  assert.ok(Date.now() - startedAt < 2000, 'Discovery remains bounded while leaving the live fallback time to answer.');
  assert.equal(stale.calls.filter(call => call.method === 'tools/call').length, 1);
  assert.equal(actual.calls.filter(call => call.method === 'tools/call').length, 2);
});

test('a disconnected discovered sidecar preserves the saved live native endpoint for fallback', async t => {
  const stale = await harness(t, { inventory: { isError: true, content: [{ type: 'text', text: 'Browser disconnected.' }] } });
  const actual = await harness(t);
  await actual.manager.save({ id: 'browseros-neo', name: 'BrowserOS neo', transport: 'http', url: actual.url });
  const status = await registerSignedBrowser({ connections: actual.manager, endpoints: [{ url: stale.url, source: 'browseros-runtime' }, { url: actual.url, source: 'browseros-config' }] });
  assert.equal(status.available, true); assert.equal(status.endpoint, actual.url);
  assert.equal(actual.manager.list()[0].url, actual.url);
  assert.equal(stale.calls.filter(call => call.method === 'initialize').length, 1, 'The disconnected candidate stays a temporary probe.');
  assert.equal(actual.calls.filter(call => call.method === 'tools/call').length, 1);
});

for (const expiresAt of ['tools/list', 'tools/call']) test(`a restarted sidecar renews an expired session during ${expiresAt} in the same refresh`, async t => {
  const { manager, calls, url, expireNext } = await harness(t);
  const integration = createSignedBrowserIntegration({ connections: manager, prepareWindowImpl:async()=>({ready:true,policyVerified:true,created:false}), endpoints: [{ url }], startBrowser: () => assert.fail('A live sidecar with an expired session must not trigger another browser launch.') });
  t.after(() => integration.close());
  assert.equal((await integration.refresh()).available, true);
  const previousCalls = calls.length;
  expireNext(expiresAt);
  const recovered = await integration.refresh({ startIfNeeded: true });
  assert.equal(recovered.available, true); assert.equal(recovered.browserConnected, true);
  const reconnectCalls = calls.slice(previousCalls);
  assert.equal(reconnectCalls.filter(call => call.method === 'initialize').length, 1);
  assert.deepEqual(reconnectCalls.filter(call => call.method === 'tools/call').map(call => call.params), Array.from({ length: expiresAt === 'tools/call' ? 2 : 1 }, () => ({ name: 'tabs', arguments: { action: 'list' } })));
  assert.ok(reconnectCalls.every(call => !['publish', 'act', 'navigate'].includes(call.params?.name)), 'Automatic session renewal only repeats catalog and inventory reads.');
});

test('catalog-only readiness allows the supported task startup path but discovery alone never starts it', async t => {
  let browserReady = false, starts = 0;
  const { manager, calls, url } = await harness(t, { inventory: () => ({ content: [{ type: 'text', text: browserReady ? 'No open pages.' : 'Browser link lost.' }], isError: !browserReady }) });
  const integration = createSignedBrowserIntegration({ connections: manager, prepareWindowImpl:async()=>({ready:true,policyVerified:true,created:false}), endpoints: [{ url }], retryDelayMs: 1, startBrowser: async () => { starts++; browserReady = true; return { started: true, running: true }; } });
  t.after(() => integration.close());
  const discovery = await integration.refresh();
  assert.equal(discovery.available, false); assert.equal(discovery.catalogConnected, true); assert.equal(starts, 0);
  const ready = await integration.refresh({ startIfNeeded: true });
  assert.equal(starts, 1); assert.equal(ready.available, true); assert.equal(ready.browserConnected, true);
  assert.ok(calls.filter(call => call.method === 'tools/call').length >= 3);
  assert.ok(calls.filter(call => call.method === 'tools/call').every(call => call.params.name === 'tabs' && call.params.arguments.action === 'list'));
});

test('cancelled discovery does not add a connection or read configuration', async () => {
  const controller = new AbortController(); controller.abort();
  const status = await registerSignedBrowser({ signal: controller.signal, connections: { save: () => { throw new Error('Must not save'); } }, readFileImpl: () => { throw new Error('Must not read'); } });
  assert.equal(status.available, false); assert.match(status.reason, /cancelled/);
});

const missingFile = () => { throw Object.assign(new Error('Missing metadata'), { code: 'ENOENT' }); };
const neoCatalog = [...tools, { name: 'run', inputSchema: { type: 'object', properties: { code: { type: 'string' }, timeout: { type: 'number' } }, required: ['code'] } }, { name: 'name_session', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } }];

test('native BrowserOS discovery uses its own proxy/runtime metadata without any Codex configuration', async () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local', USERPROFILE: 'C:\\Users\\test', CODEX_HOME: 'C:\\NoCodex' };
  const stamps = nativeBrowserMetadataPaths({ env, platform: 'win32' });
  assert.equal(stamps.length, 3);
  const reads = [];
  const result = await discoverSignedBrowserEndpoints({ env, platform: 'win32', readFileImpl: async file => {
    reads.push(file);
    if (file === stamps[0].path) return JSON.stringify({ url: 'http://127.0.0.1:9010', private: 'metadata-only-secret' });
    if (file === stamps[1].path) return JSON.stringify({ ports: { cdp: 9110, proxy: 9010, server: 9211 }, directories: { private: 'metadata-only-secret' } });
    return missingFile();
  } });
  assert.deepEqual(result.endpoints, [{ url: 'http://127.0.0.1:9010/mcp', source: 'browseros-runtime' }, { url: 'http://127.0.0.1:9211/mcp', source: 'browseros-config' }]);
  assert.doesNotMatch(JSON.stringify(result), /metadata-only-secret|9110|directories/);
  assert.equal(reads.length, 4);
  assert.ok(reads.every(file => file.endsWith('runtime.json') || file.endsWith('config.json') || file.endsWith('config.toml')));
  assert.doesNotMatch(reads.join('\n'), /Cookies|Login Data|Preferences|sqlite/);
});

test('native discovery rejects malicious or oversized stamps, bounds ports and preserves legacy fallback', async () => {
  const paths = [{ path: 'runtime', kind: 'runtime' }, { path: 'config', kind: 'config' }];
  for (const runtime of ['http://evil.test:9000', 'http://localhost:9000?token=secret', 'http://user:secret@localhost:9000']) {
    const result = await discoverSignedBrowserEndpoints({ env: {}, metadataPaths: paths, configPath: 'codex', readFileImpl: async file => {
      if (file === 'runtime') return JSON.stringify({ url: runtime });
      if (file === 'config') return JSON.stringify({ ports: { proxy: 65536, server: -10, cdp: 9110 } });
      return '[mcp_servers.browseros-neo]\nurl="http://localhost:9012/mcp"';
    } });
    assert.deepEqual(result.endpoints, [{ url: 'http://localhost:9012/mcp', source: 'codex-config' }]);
    assert.doesNotMatch(JSON.stringify(result), /secret|evil|9110/);
  }
  const huge = await discoverSignedBrowserEndpoints({ env: {}, metadataPaths: [paths[0]], readFileImpl: async () => 'x'.repeat(256 * 1024 + 1) });
  assert.equal(huge.endpoints.length, 0); assert.match(huge.issues[0].reason, /limit/);
  const fallback = await discoverSignedBrowserEndpoints({ env: {}, metadataPaths: [paths[1]], configPath: 'codex', readFileImpl: async file => file === 'config' ? '{}' : missingFile() });
  assert.deepEqual(fallback.endpoints, [{ url: 'http://127.0.0.1:9200/mcp', source: 'browseros-config' }]);
});

test('native registration retries a stale endpoint and discovers a modern Neo run catalog', async t => {
  const unrelated = await harness(t, { catalog: [{ name: 'tabs', inputSchema: { type: 'object' } }] });
  const actual = await harness(t, { catalog: neoCatalog });
  const status = await registerSignedBrowser({ connections: actual.manager, endpoints: [{ url: unrelated.url, source: 'browseros-runtime' }, { url: actual.url, source: 'browseros-config' }] });
  assert.equal(status.available, true); assert.equal(status.nativeIntegration, true); assert.equal(status.catalogKind, 'neo-run'); assert.equal(status.endpointSource, 'browseros-config');
  assert.equal(actual.manager.list().length, 1); assert.equal(actual.manager.list()[0].url, actual.url);
  assert.equal(unrelated.calls.some(call => call.method === 'tools/call'), false); assert.deepEqual(actual.calls.filter(call => call.method === 'tools/call').map(call => call.params), [{ name: 'tabs', arguments: { action: 'list' } }, { name: 'tabs', arguments: { action: 'list' } }]);
  const instructions = signedBrowserInstructions(status);
  assert.match(instructions, /Reuse the browser and profile requested by the user/); assert.match(instructions, /authorized post or edit/); assert.match(instructions, /name_session/); assert.match(instructions, /actual tool schemas/); assert.match(instructions, /run, raw CDP, full-page capture/);
  assert.match(instructions, /full-page capture when relevant and supported/); assert.match(instructions, /focus and visibility do not establish native desktop foreground/); assert.match(instructions, /failed screenshot is never a reason to publish/); assert.doesNotMatch(instructions, /finite background interface|fullPage:false|do not call BrowserOS request_human_help/);
  const runOnly = neoCatalog.filter(tool => tool.name !== 'navigate');
  assert.equal(isSignedBrowserCatalog(runOnly), true);
  assert.equal(isSignedBrowserCatalog([{ name: 'run', inputSchema: { type: 'object', properties: { code: { type: 'string' } } } }]), false);
});

test('a verified native port change replaces only Relay managed settings without credentials', async t => {
  const { manager, url } = await harness(t, { catalog: neoCatalog });
  await manager.save({ id: 'browseros-neo', name: 'BrowserOS neo', transport: 'http', url: 'http://127.0.0.1:11/mcp' });
  const moved = await registerSignedBrowser({ connections: manager, endpoints: [{ url, source: 'browseros-runtime' }] });
  assert.equal(moved.available, true); assert.equal(manager.list()[0].url, url);
  await manager.save({ id: 'browseros-neo', name: 'My explicit browser', transport: 'http', url: 'http://127.0.0.1:12/mcp' });
  const preserved = await registerSignedBrowser({ connections: manager, endpoints: [{ url, source: 'browseros-runtime' }] });
  assert.equal(preserved.available, false); assert.match(preserved.reason, /preserved/); assert.equal(manager.list()[0].url, 'http://127.0.0.1:12/mcp');
});

test('native connection honors cancellation during a real MCP handshake and never trusts the unfinished endpoint', async t => {
  const { manager, url } = await harness(t, { hang: true });
  const controller = new AbortController();
  const pending = registerSignedBrowser({ connections: manager, endpoints: [{ url, source: 'browseros-runtime' }], signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  const status = await pending;
  assert.equal(status.available, false); assert.match(status.reason, /cancelled/); assert.deepEqual(manager.list(), []);
});

test('native integration is lazy, shares reconnects, escalates a concurrent web task and detects disconnects', async () => {
  let discoveryCount = 0, startCount = 0, release;
  const first = new Promise(resolve => { release = resolve; });
  const manager = { clients: new Map() };
  const integration = createSignedBrowserIntegration({ connections: manager, retryDelayMs: 1, prepareWindowImpl:async()=>({ready:true,policyVerified:true,created:false}),
    registerImpl: async () => { discoveryCount++; if (discoveryCount === 1) { await first; return { available: false, reason: 'Not running.' }; } manager.clients.set('browseros-neo', { connected: true, closed: false }); return { available: true, reusesBrowserSession: true, connectionId: 'browseros-neo' }; },
    startBrowser: async () => { startCount++; return { started: true, running: true }; },
  });
  assert.equal(discoveryCount, 0); assert.equal(startCount, 0);
  const startup = integration.refresh(), web = integration.refresh({ startIfNeeded: true });
  assert.notEqual(startup, web, 'each caller owns its cancellable wait'); assert.equal(integration.status().discovering, true);
  release(); assert.equal((await web).available, true); assert.equal(startCount, 1); assert.equal(discoveryCount, 2);
  manager.clients.get('browseros-neo').closed = true;
  assert.equal(integration.status().available, false); assert.match(integration.status().reason, /reconnects/);
  await integration.close(); assert.match((await integration.refresh()).reason, /cancelled/);
});

test('native browser availability remains verified when background window readiness is unavailable', async () => {
  let backgroundReady = false;
  const manager = { clients: new Map([['browseros-neo', { connected: true, closed: false }]]) };
  const connected = { available: true, catalogConnected: true, browserConnected: true, reusesBrowserSession: true, connectionId: 'browseros-neo', reason: 'Native browser connection verified.' };
  const integration = createSignedBrowserIntegration({ connections: manager,
    registerImpl: async () => ({ ...connected }),
    prepareWindowImpl: async () => backgroundReady ? { ready: true, policyVerified: true, created: false } : { ready: false, policyVerified: false, created: false, code: 'FOCUS_POLICY_DISABLED', reason: 'Native background focus preference is disabled.' },
    startBrowser: () => assert.fail('A working native browser must not be started again.'),
  });
  try {
    const status = await integration.refresh({ startIfNeeded: true });
    for (const key of ['available', 'catalogConnected', 'browserConnected', 'reusesBrowserSession']) assert.equal(status[key], true, key);
    assert.equal(status.reason, connected.reason);
    assert.equal(status.backgroundReady, false); assert.equal(status.backgroundReason, 'Native background focus preference is disabled.');
    assert.equal(status.backgroundWindow.code, 'FOCUS_POLICY_DISABLED'); assert.equal(status.backgroundWindow.ready, false);
    assert.equal(integration.status().available, true);
    backgroundReady = true;
    const ready = await integration.refresh({ startIfNeeded: true });
    assert.equal(ready.available, true); assert.equal(ready.backgroundReady, true); assert.equal(ready.backgroundReason, null);
  } finally { await integration.close(); }
});

test('closing native integration aborts pending discovery without launching a browser', async () => {
  let startCount = 0;
  const integration = createSignedBrowserIntegration({ startBrowser: () => { startCount++; }, registerImpl: async ({ signal }) => new Promise(resolve => signal.addEventListener('abort', () => resolve({ available: false, reason: 'Browser discovery was cancelled.' }), { once: true })) });
  const pending = integration.refresh({ startIfNeeded: true });
  await integration.close(); assert.equal((await pending).available, false); assert.equal(startCount, 0);
});

test('native startup waits for actual sidecar readiness beyond five immediate endpoint misses', async () => {
  let probes = 0;
  const integration = createSignedBrowserIntegration({ prepareWindowImpl:async()=>({ready:true,policyVerified:true,created:false}), retryDelayMs: 1, startupTimeoutMs: 2000, startBrowser: async () => ({ started: true }), registerImpl: async () => ({ available: ++probes > 7, reason: 'Not ready.' }) });
  const status = await integration.refresh({ startIfNeeded: true });
  assert.equal(status.available, true); assert.equal(probes, 8);
  await integration.close();
});

test('native readiness wait stops promptly when cancelled or the readiness deadline is reached', async () => {
  const integration = createSignedBrowserIntegration({ retryDelayMs: 1, startupTimeoutMs: 100, startBrowser: async () => ({ started: true }), registerImpl: async () => ({ available: false, reason: 'Not ready.' }) });
  const start = Date.now(), unavailable = await integration.refresh({ startIfNeeded: true });
  assert.equal(unavailable.available, false); assert.match(unavailable.reason, /not ready yet/); assert.ok(Date.now() - start < 1000);
  const controller = new AbortController();
  const pending = integration.refresh({ signal: controller.signal, startIfNeeded: true });
  controller.abort(); assert.match((await pending).reason, /cancelled/);
  await integration.close();
});
