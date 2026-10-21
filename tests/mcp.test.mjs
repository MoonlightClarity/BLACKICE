import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCPClient, ConnectionManager, normalizeConnection, createConnectionToolHandler } from '../lib/mcp.mjs';
import { chromeAutoConnectConnection } from '../lib/chrome-browser.mjs';

const fixture = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 3000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await predicate(); if (value) return value; await pause(15); } throw new Error('Timed out waiting for fixture.'); }
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const vault = { encryptSecret: value => Buffer.from('sealed:' + Buffer.from(value).toString('base64')), decryptSecret: value => Buffer.from(String(value).slice(7), 'base64').toString() };
async function managerHarness(t, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'relay-mcp-test-')), manager = await new ConnectionManager({ dataDir, ...options }).init();
  const cleanupManagers = [manager];
  t.after(async () => { await Promise.all(cleanupManagers.map(client => client.close())); assert.match(path.basename(dataDir), /^relay-mcp-test-/); await rm(dataDir, { recursive: true, force: true }); }); return { manager, dataDir, cleanupManagers };
}
const stdio = (dataDir, extra = {}) => ({ id: 'fixture', name: 'Local fixture', transport: 'stdio', command: process.execPath, args: [fixture], cwd: dataDir, ...extra });
test('configured native browser tools are available without an unrelated contained-browser prerequisite',async()=>{
 const invoked=[],manager={signedBrowser:{connectionId:'browseros-neo'},redact:String,refreshSignedBrowser:async()=>{assert.fail('Explicit tool calls use their configured MCP connection without an unrelated refresh.');},tools:async()=>{invoked.push('tools');return {tools:[{name:'run',inputSchema:{type:'object'}}]};},call:async(id,name,args)=>{invoked.push({id,name,args});return {content:[{type:'text',text:'Native browser observation.'}]};}};
 const handler=createConnectionToolHandler({manager});
 const catalog=await handler({name:'relay_connections',arguments:{action:'tools',connectionId:'browseros-neo'}});assert.equal(catalog.success,true);assert.equal(JSON.parse(catalog.contentItems[0].text).tools[0].name,'run');
 const result=await handler({name:'relay_connections',arguments:{action:'call',connectionId:'browseros-neo',name:'run',arguments:{code:'return await browser.pages.list();'}}});assert.equal(result.success,true);
 assert.deepEqual(invoked,['tools',{id:'browseros-neo',name:'run',args:{code:'return await browser.pages.list();'}}]);
});

test('managed Chrome never triggers a native connection dialog from an unconnected agent call', async t => {
  const { manager } = await managerHarness(t); const config = chromeAutoConnectConnection(); await manager.save(config);
  let calls = 0;
  const client = { config, connected: true, closed: false, tools: [], async start() {}, async call() { calls++; return { content: [{ type: 'text', text: 'local fixture' }] }; }, async close() {} };
  manager.clients.set(config.id, client);
  await assert.rejects(manager.call(config.id, 'list_pages', { browserSetup: true }), { code: 'MCP_BROWSER_DISCONNECTED' }); assert.equal(calls, 0);
  await manager.call(config.id, 'list_pages', {}, { browserSetup: true }); assert.equal(calls, 1);
  await assert.rejects(manager.call(config.id, 'list_pages', {}), { code: 'MCP_BROWSER_DISCONNECTED' }); assert.equal(calls, 1, 'setup call alone must not verify a browser');
});

test('managed Chrome applies background behavior at the actual gateway and invalidates failed connections', async t => {
  const { manager } = await managerHarness(t); const config = chromeAutoConnectConnection(); await manager.save(config);
  const calls = []; let failed = false;
  const client = { config, connected: true, closed: false, tools: [], async start() {}, async call(name, args) { calls.push({ name, args }); if (failed === 'disconnect') this.connected = false; return failed ? { isError: true, content: [] } : { content: [{ type: 'text', text: 'local fixture' }] }; }, async close() {} };
  manager.clients.set(config.id, client); manager.chromeBrowserClient = client;
  await manager.call(config.id, 'new_page', { url: 'https://example.test/', background: false, isolatedContext: 'wrong-profile' });
  await manager.call(config.id, 'select_page', { pageId: 1, bringToFront: true });
  assert.deepEqual(calls, [{ name: 'new_page', args: { url: 'https://example.test/', background: true } }, { name: 'select_page', args: { pageId: 1, bringToFront: false } }]);
  client.connected = false;
  await assert.rejects(manager.call(config.id, 'list_pages', {}), { code: 'MCP_BROWSER_DISCONNECTED' }); assert.equal(calls.length, 2, 'a lost MCP process must not silently restart and prompt Chrome');
  client.connected = true;
  failed = 'tool-error'; await manager.call(config.id, 'click', { uid: 'stale' }); assert.equal(manager.chromeBrowserClient, client, 'ordinary tool errors must allow fresh inspection without reconnecting');
  failed = false; await manager.call(config.id, 'take_snapshot', {});
  failed = 'disconnect'; await manager.call(config.id, 'take_snapshot', {}); assert.equal(manager.chromeBrowserClient, null);
  await assert.rejects(manager.call(config.id, 'list_pages', {}), { code: 'MCP_BROWSER_DISCONNECTED' }); assert.equal(calls.length, 5);
});

test('connection configuration rejects malformed destinations, credential URLs and managed headers', async t => {
  for (const input of [{ id: '../bad', command: 'node' }, { id: 'test', transport: 'bad' }, { id: 'test', command: 'node', cwd: 'relative' }, { id: 'test', command: 'node', args: [null] }, { id: 'test', transport: 'http', url: 'http://user:secret@example.test/mcp' }, { id: 'test', transport: 'http', url: 'https://example.test/mcp?token=secret' }, { id: 'test', command: 'node', timeoutMs: 999 }]) assert.throws(() => normalizeConnection(input));
  const { manager, dataDir } = await managerHarness(t);
  await assert.rejects(manager.save(stdio(dataDir, { headers: { 'Mcp-Session-Id': 'override' } })), /managed/);
  await assert.rejects(manager.save(stdio(dataDir, { headers: { Authorization: 'line\nbreak' } })), /one line/);
});

test('real stdio handshake, pagination, server ping and actual file write use the discovered catalog', async t => {
  const { manager, dataDir } = await managerHarness(t); await manager.save(stdio(dataDir));
  const client = await manager.connect('fixture'); assert.equal(client.connected, true); assert.equal(client.tools.length, 6);
  const catalog = await manager.tools('fixture', { query: 'add' }); assert.equal(catalog.tools.length, 1); assert.equal(catalog.tools[0].name, 'add');
  assert.equal((await manager.call('fixture', 'add', { a: 19, b: 23 })).content[0].text, '42');
  assert.equal((await manager.call('fixture', 'ping_then_echo', { text: 'ping acknowledged' })).content[0].text, 'ping acknowledged');
  const target = path.join(dataDir, 'actual-write.txt'); await manager.call('fixture', 'write_file', { path: target, content: 'Real fixture write\nverified.' }); assert.equal(await readFile(target, 'utf8'), 'Real fixture write\nverified.');
  await assert.rejects(manager.call('fixture', 'unlisted', {}), /current catalog/); assert.equal(manager.status().connections[0].busy, 0);
  const pid = client.child.pid; await manager.disconnect('fixture'); await until(() => !alive(pid)); assert.equal(manager.status().connected, 0);
  assert.equal((await manager.call('fixture', 'echo', { text: 'Reconnected.' })).content[0].text, 'Reconnected.');
});

test('credentials use the OS-vault adapter, stay redacted in public data and survive restart', async t => {
  const secret = 'secret-quoted-"-slash-\\-long-test-value';
  const { manager, dataDir, cleanupManagers } = await managerHarness(t, vault); const saved = await manager.save(stdio(dataDir, { env: { RELAY_MCP_SECRET: secret } }));
  assert.equal(saved.secretStorage, 'encrypted'); assert.ok(!JSON.stringify(saved).includes('secret-quoted')); assert.ok(!JSON.stringify(manager.status()).includes('secret-quoted'));
  const raw = await readFile(path.join(dataDir, 'connections.json'), 'utf8'); assert.ok(!raw.includes('RELAY_MCP_SECRET')); assert.ok(!raw.includes(JSON.stringify(secret).slice(1, -1)));
  manager.configs.get('fixture').name = 'A service echoed ' + secret; assert.ok(!JSON.stringify(manager.status()).includes('secret-quoted'));
  const restored = await new ConnectionManager({ dataDir, ...vault }).init(); cleanupManagers.push(restored); assert.equal(restored.secrets.get('fixture').env.RELAY_MCP_SECRET, secret);
  const handler = createConnectionToolHandler({ manager: restored }); const result = await handler({ name: 'relay_connections', arguments: { action: 'call', connectionId: 'fixture', name: 'environment', arguments: {} } }); assert.equal(result.success, true); assert.equal(result.contentItems[0].text, '[redacted]');
});

test('plain-server credentials are session-only and removing before explicit init preserves other saved connections', async t => {
  const { manager, dataDir } = await managerHarness(t); await manager.save(stdio(dataDir, { env: { RELAY_MCP_SECRET: 'session-only-key-value' } }));
  await manager.save({ id: 'second', transport: 'http', url: 'http://127.0.0.1:12345/mcp' });
  assert.equal(manager.list()[0].secretStorage, 'session'); assert.ok(!(await readFile(path.join(dataDir, 'connections.json'), 'utf8')).includes('session-only-key-value'));
  const restored = new ConnectionManager({ dataDir }); t.after(() => restored.close()); await restored.remove('second'); assert.equal(restored.list().length, 1); assert.equal(restored.list()[0].id, 'fixture'); assert.equal(restored.secrets.has('fixture'), false);
});

test('stdio cancellation kills the server and its child process, and the next call reconnects', async t => {
  const { manager, dataDir } = await managerHarness(t); const log = path.join(dataDir, 'events.log'); await manager.save(stdio(dataDir, { env: { RELAY_MCP_LOG: log } }));
  const controller = new AbortController(), pending = manager.call('fixture', 'wait', { spawnChild: true }, { signal: controller.signal }); pending.catch(() => {});
  const worker = await until(async () => { try { return (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)).find(entry => entry.workerPid); } catch { return null; } });
  const parent = manager.clients.get('fixture').child.pid; assert.ok(alive(parent)); assert.ok(alive(worker.workerPid)); controller.abort(); await assert.rejects(pending, { code: 'ABORT_ERR', name: 'AbortError' });
  await until(() => !alive(parent) && !alive(worker.workerPid)); assert.equal(manager.status().connections[0].busy, 0); assert.equal((await manager.call('fixture', 'add', { a: 1, b: 2 })).content[0].text, '3');
});

test('a broken stdio pipe retires the client and its process tree before reconnecting', async t => {
  const { manager, dataDir } = await managerHarness(t); const log = path.join(dataDir, 'broken-pipe.log');
  await manager.save(stdio(dataDir, { env: { RELAY_MCP_LOG: log } }));
  const pending = manager.call('fixture', 'wait', { spawnChild: true }); pending.catch(() => {});
  const worker = await until(async () => { try { return (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)).find(entry => entry.workerPid); } catch { return null; } });
  const client = manager.clients.get('fixture'), pid = client.child.pid;
  client.child.stdin.emit('error', new Error('Fixture pipe failure.'));
  await assert.rejects(pending, /MCP server stopped/);
  assert.equal(client.closed, true, 'a damaged transport must never be reused');
  await client.closePromise; await until(() => !alive(pid) && !alive(worker.workerPid));
  assert.equal((await manager.call('fixture', 'echo', { text: 'New connection.' })).content[0].text, 'New connection.');
  assert.notEqual(manager.clients.get('fixture'), client);
});

test('reconnecting waits for a retired client to release its owned process', async t => {
  const { manager, dataDir } = await managerHarness(t); await manager.save(stdio(dataDir));
  const release = deferred(); let cleaned = false, started = false;
  t.after(() => release.resolve());
  manager.clients.set('fixture', { closed: true, connected: false, tools: [], closePromise: release.promise.then(() => { cleaned = true; }), async close() { release.resolve(); } });
  manager.spawnImpl = () => { started = true; assert.equal(cleaned, true, 'the replacement must wait for process cleanup'); throw new Error('Fixture launch stopped.'); };
  const reconnect = manager.connect('fixture'); reconnect.catch(() => {});
  await pause(30); assert.equal(started, false);
  release.resolve(); await assert.rejects(reconnect, /Fixture launch stopped/); assert.equal(started, true);
});

test('tool timeout and application shutdown close real stdio work without leaking pending requests', async t => {
  const { manager, dataDir } = await managerHarness(t); await manager.save(stdio(dataDir, { timeoutMs: 1000 }));
  await assert.rejects(manager.call('fixture', 'wait', {}), { code: 'MCP_TIMEOUT' });
  const client = await manager.connect('fixture'), pending = manager.call('fixture', 'wait', {}); pending.catch(() => {});
  await until(() => client.pending.size > 0); const pid = client.child.pid; await manager.close(); await assert.rejects(pending, { code: 'ABORT_ERR' }); assert.equal(client.pending.size, 0); await until(() => !alive(pid)); await assert.rejects(manager.connect('fixture'), /shutting down/);
});

async function httpHarness(t, { mode = 'json', secret = '' } = {}) {
  const requests = [], enteredSlow = deferred(), cancellation = deferred(), pingReplies = new Map(); let session = 0, expireNext = false;
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'DELETE') { requests.push({ method: 'DELETE', headers: request.headers }); response.writeHead(204); return response.end(); }
      let raw = ''; for await (const chunk of request) raw += chunk; const message = JSON.parse(raw); requests.push({ ...message, headers: request.headers });
      const send = result => { const value = { jsonrpc: '2.0', id: message.id, result }; if (mode === 'sse' && message.method !== 'initialize') { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end(': keepalive\r\n\r\nevent: message\r\ndata: ' + JSON.stringify(value) + '\r\n\r\n'); } else { response.writeHead(200, { 'Content-Type': 'application/json', ...(message.method === 'initialize' ? { 'Mcp-Session-Id': 'session-' + ++session } : {}) }); response.end(JSON.stringify(value)); } };
      if (!message.method) { const finish = pingReplies.get(message.id); if (finish) finish(); response.writeHead(202); return response.end(); }
      if (message.method === 'initialize') return send({ protocolVersion: '2025-06-18', serverInfo: { name: 'HTTP fixture', version: '1' }, capabilities: { tools: { listChanged: true } } });
      if (message.method === 'notifications/initialized') { response.writeHead(202); return response.end(); }
      if (message.method === 'notifications/cancelled') { cancellation.resolve(message.params); response.writeHead(202); return response.end(); }
      if (expireNext) { expireNext = false; response.writeHead(404); return response.end(); }
      if (message.method === 'tools/list') return send({ tools: ['echo', 'slow', 'ping', 'error', 'accepted'].map(name => ({ name, description: name === 'error' ? 'Error ' + secret : name, inputSchema: { type: 'object', properties: {}, additionalProperties: true } })) });
      if (message.method !== 'tools/call') { response.writeHead(400); return response.end(); }
      if (message.params.name === 'slow') { enteredSlow.resolve(message.id); return; }
      if (message.params.name === 'accepted') { response.writeHead(202); return response.end(); }
      if (message.params.name === 'error') { response.writeHead(200, { 'Content-Type': 'application/json' }); return response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Service rejected ' + secret + ' and Bearer unrecognized-token' } })); }
      if (message.params.name === 'ping') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        // Same numeric id is legal in the server-to-client direction.
        pingReplies.set(message.id, () => response.end('data: ' + JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'HTTP ping acknowledged' }] } }) + '\n\n'));
        response.write('data: ' + JSON.stringify({ jsonrpc: '2.0', id: message.id, method: 'ping', params: {} }) + '\n\n'); return;
      }
      send({ content: [{ type: 'text', text: message.params.arguments.text || 'HTTP tool complete.' }] });
    } catch (error) { response.writeHead(500); response.end(error.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const result = await managerHarness(t); const url = `http://127.0.0.1:${server.address().port}/mcp`;
  await result.manager.save({ id: 'http', transport: 'http', url, headers: secret ? { Authorization: 'Bearer ' + secret } : {} });
  // Register after manager's cleanup, but explicitly close it first so DELETE can reach the server.
  t.after(async () => { await result.manager.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { ...result, url, requests, enteredSlow, cancellation, expire: () => { expireNext = true; } };
}

for (const mode of ['json', 'sse']) test(`Streamable HTTP ${mode}: initialize, session/version headers, tool calls and session DELETE`, async t => {
  const { manager, requests } = await httpHarness(t, { mode, secret: 'http-private-key-value' }); await manager.connect('http');
  assert.equal((await manager.call('http', 'echo', { text: 'Actual HTTP result.' })).content[0].text, 'Actual HTTP result.');
  assert.equal(requests[0].headers['mcp-session-id'], undefined); assert.equal(requests[0].headers.authorization, 'Bearer http-private-key-value');
  for (const request of requests.slice(1)) { assert.equal(request.headers['mcp-session-id'], 'session-1'); assert.equal(request.headers['mcp-protocol-version'], '2025-06-18'); }
  await manager.close(); assert.equal(requests.at(-1).method, 'DELETE'); assert.equal(requests.at(-1).headers['mcp-session-id'], 'session-1');
});

test('HTTP server-to-client ping gets a separate response POST and a 202 request cannot claim tool success', async t => {
  const { manager, requests } = await httpHarness(t, { mode: 'sse' });
  assert.equal((await manager.call('http', 'ping', {})).content[0].text, 'HTTP ping acknowledged'); assert.ok(requests.some(request => !request.method && request.result));
  await assert.rejects(manager.call('http', 'accepted', {}), { code: 'MCP_PROTOCOL' });
});

test('HTTP cancellation sends notifications/cancelled with the original request id', async t => {
  const { manager, enteredSlow, cancellation } = await httpHarness(t); const controller = new AbortController();
  const pending = manager.call('http', 'slow', {}, { signal: controller.signal }); pending.catch(() => {}); const id = await enteredSlow.promise; controller.abort(); await assert.rejects(pending, { code: 'ABORT_ERR' });
  const notice = await Promise.race([cancellation.promise, pause(3000).then(() => { throw new Error('Cancellation notification missing.'); })]); assert.equal(notice.requestId, id); assert.equal(manager.status().connections[0].busy, 0);
});

test('expired HTTP sessions fail the current action and reinitialize before the next explicit call', async t => {
  const { manager, requests, expire } = await httpHarness(t); await manager.connect('http'); expire(); await assert.rejects(manager.call('http', 'echo', { text: 'not silently retried' }), { code: 'MCP_SESSION_EXPIRED' });
  assert.equal((await manager.call('http', 'echo', { text: 'explicit retry' })).content[0].text, 'explicit retry');
  const initialize = requests.filter(request => request.method === 'initialize'); assert.equal(initialize.length, 2); assert.equal(initialize[1].headers['mcp-session-id'], undefined); assert.equal(requests.at(-1).headers['mcp-session-id'], 'session-2');
});

test('HTTP catalogs and errors redact secrets, and endpoint changes require each credential group explicitly', async t => {
  const secret = 'private-http-redaction-value', { manager, url } = await httpHarness(t, { secret });
  const catalog = await manager.tools('http'); assert.ok(!JSON.stringify(catalog).includes(secret));
  await assert.rejects(manager.call('http', 'error', {}), error => !error.message.includes(secret) && !error.message.includes('unrecognized-token'));
  await assert.rejects(manager.save({ id: 'http', url: url + '-other', env: {} }), /credentials again/);
  await manager.save({ id: 'http', url: url + '-other', env: {}, headers: {} }); assert.equal(manager.list()[0].headerNames.length, 0);
});

test('credential writes and active calls cannot race to replace or close a connection', async t => {
  const encrypting = deferred(), release = deferred(); let delay = false;
  const { manager, dataDir } = await managerHarness(t, { ...vault, encryptSecret: async value => { if (delay) { encrypting.resolve(); await release.promise; } return vault.encryptSecret(value); } });
  await manager.save(stdio(dataDir)); await manager.connect('fixture'); delay = true;
  const saving = manager.save({ id: 'fixture', env: { RELAY_MCP_SECRET: 'new-private-key' } }); await encrypting.promise;
  await assert.rejects(manager.call('fixture', 'add', { a: 1, b: 1 }), { code: 'MCP_BUSY' }); release.resolve(); await saving;
  const controller = new AbortController(), pending = manager.call('fixture', 'wait', {}, { signal: controller.signal }); pending.catch(() => {}); await until(() => manager.clients.get('fixture')?.pending.size > 0);
  await assert.rejects(manager.save({ id: 'fixture', name: 'New name' }), { code: 'MCP_BUSY' }); await assert.rejects(manager.disconnect('fixture'), { code: 'MCP_BUSY' }); controller.abort(); await assert.rejects(pending, { code: 'ABORT_ERR' });
});

test('bounded progressive catalogs retain valid JSON and the gateway returns tool errors and images faithfully', async t => {
  const { manager, dataDir } = await managerHarness(t); await manager.save(stdio(dataDir)); const client = await manager.connect('fixture');
  client.tools = Array.from({ length: 100 }, (_, index) => ({ name: 'tool-' + index, description: 'schema', inputSchema: { type: 'object', properties: { value: { type: 'string', description: 'x'.repeat(2000) } } } }));
  const catalog = await manager.tools('fixture'); assert.equal(catalog.truncated, true); assert.ok(catalog.tools.length < 40); assert.ok(JSON.stringify(catalog).length < 56000); assert.ok(JSON.parse(JSON.stringify(catalog)).tools.length > 0);
  const fake = { list: () => [], redact: text => String(text), call: async () => ({ isError: true, content: [{ type: 'text', text: 'Actual failure.' }, { type: 'image', mimeType: 'image/png', data: 'ZmFrZQ==' }], structuredContent: { verified: false } }) };
  const handler = createConnectionToolHandler({ manager: fake }); const result = await handler({ name: 'relay_connections', arguments: { action: 'call', connectionId: 'test', name: 'observe' } }); assert.equal(result.success, false); assert.equal(result.contentItems[1].type, 'inputImage'); assert.match(result.contentItems.at(-1).text, /verified/);
});

test('connected tools continue beyond 200 calls and preserve an explicitly configured budget', async () => {
  const manager = { list: () => [], redact: value => String(value) }, call = { name: 'relay_connections', arguments: { action: 'connections' } }, handler = createConnectionToolHandler({ manager });
  for (let index = 0; index < 205; index++) assert.equal((await handler(call)).success, true);
  const limited = createConnectionToolHandler({ manager, maxCalls: 2 }); await limited(call); await limited(call); await assert.rejects(limited(call), /configured connected-tool action limit/);
  for (const maxCalls of [0, -1, 1.5, false]) assert.throws(() => createConnectionToolHandler({ manager, maxCalls }), /positive whole number/);
});

test('real HTTP Neo SDK descriptions survive progressive discovery and truncation stays explicit within the response budget', async t => {
  const sdk = 'Neo run SDK contract\n' + 'Browser page operations. '.repeat(480) + '\nTAIL CONTRACT: page.fill(ref, value), page.click(ref), await page.waitForText(text); every page operation uses its owned handle.';
  assert.ok(sdk.length > 3000 && sdk.length < 24000);
  const oversized = 'Oversized server contract\n' + 'y'.repeat(26000) + '\nUNRETURNED END OF CONTRACT';
  const catalog = [
    { name: 'neo_run', description: sdk, inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } },
    { name: 'overflow_contract', description: oversized, inputSchema: { type: 'object', properties: {} } },
    ...Array.from({ length: 4 }, (_, index) => ({ name: `additional_${index}`, description: 'Additional tool instructions. '.repeat(650), inputSchema: { type: 'object', properties: {} } })),
  ];
  const requests = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'DELETE') { response.writeHead(204); response.end(); return; }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const message = JSON.parse(raw); requests.push(message.method);
    if (!Object.hasOwn(message, 'id')) { response.writeHead(202); response.end(); return; }
    const result = message.method === 'initialize' ? { protocolVersion: '2025-06-18', serverInfo: { name: 'Neo SDK fixture', version: '1' }, capabilities: { tools: {} } } : { tools: catalog };
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { manager } = await managerHarness(t);
  t.after(async () => { await manager.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await manager.save({ id: 'neo-sdk', transport: 'http', url: `http://127.0.0.1:${server.address().port}/mcp` });
  const gateway = createConnectionToolHandler({ manager });
  const query = async text => {
    const result = await gateway({ name: 'relay_connections', arguments: { action: 'tools', connectionId: 'neo-sdk', query: text } });
    assert.equal(result.success, true); return JSON.parse(result.contentItems[0].text);
  };
  const run = await query('neo_run');
  assert.equal(run.tools.length, 1); assert.equal(run.tools[0].description, sdk); assert.match(run.tools[0].description, /TAIL CONTRACT.*page\.click/);
  assert.equal(run.tools[0].descriptionTruncated, undefined);
  const overflow = await query('overflow_contract');
  assert.equal(overflow.tools[0].description.length, 24000); assert.equal(overflow.tools[0].descriptionTruncated, true); assert.match(overflow.tools[0].descriptionNote, /exceeds.*limit.*documentation/);
  const all = await query('');
  assert.equal(all.total, catalog.length); assert.equal(all.truncated, true); assert.ok(all.returned < all.matches); assert.match(all.hint, /Narrow query/);
  assert.ok(all.tools.reduce((total, tool) => total + JSON.stringify(tool).length, 0) <= 55000);
  assert.ok(JSON.stringify(all).length < 56000);
  assert.equal(requests.includes('tools/call'), false);
});
