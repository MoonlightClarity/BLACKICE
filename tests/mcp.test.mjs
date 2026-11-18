import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCPClient, ConnectionManager, normalizeConnection } from '../lib/mcp.mjs';
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
const neo=(extra={})=>({id:'browseros-neo',transport:'http',url:'http://127.0.0.1:12345/mcp',...extra});
async function stdioHarness(t,timeoutMs=5000){const dataDir=await mkdtemp(path.join(tmpdir(),'relay-mcp-client-')),clients=[];const create=()=>{const client=new MCPClient({config:normalizeConnection(stdio(dataDir,{timeoutMs})),secrets:{env:{RELAY_MCP_LOG:path.join(dataDir,'events.log')}}});clients.push(client);return client;};t.after(async()=>{await Promise.all(clients.map(c=>c.close()));await rm(dataDir,{recursive:true,force:true});});return {dataDir,create,client:create()};}
const stdio = (dataDir, extra = {}) => ({ id: 'fixture', name: 'Local fixture', transport: 'stdio', command: process.execPath, args: [fixture], cwd: dataDir, ...extra });


test('managed Chrome never triggers a native connection dialog from an unconnected agent call', async t => {
  const { manager } = await managerHarness(t); const config = chromeAutoConnectConnection(); await manager.save(config);
  let calls = 0;
  const client = { config, connected: true, closed: false, tools: [], async start() {}, async call() { calls++; return { content: [{ type: 'text', text: 'local fixture' }] }; }, async close() {} };
  manager.clients.set(config.id, client);
  await assert.rejects(manager.call(config.id, 'list_pages', { browserSetup: true }), { code: 'MCP_BROWSER_DISCONNECTED' }); assert.equal(calls, 0);
  await manager.call(config.id, 'list_pages', {}, { browserSetup: true }); assert.equal(calls, 1);
  await assert.rejects(manager.call(config.id, 'list_pages', {}), { code: 'MCP_BROWSER_DISCONNECTED' }); assert.equal(calls, 1, 'setup call alone must not verify a browser');
});

test('managed Chrome preserves explicit browser choices at the actual gateway and invalidates failed connections', async t => {
  const { manager } = await managerHarness(t); const config = chromeAutoConnectConnection(); await manager.save(config);
  const calls = []; let failed = false;
  const client = { config, connected: true, closed: false, tools: [], async start() {}, async call(name, args) { calls.push({ name, args }); if (failed === 'disconnect') this.connected = false; return failed ? { isError: true, content: [] } : { content: [{ type: 'text', text: 'local fixture' }] }; }, async close() {} };
  manager.clients.set(config.id, client); manager.chromeBrowserClient = client;
  await manager.call(config.id, 'new_page', { url: 'https://example.test/', background: false, isolatedContext: 'requested-profile' });
  await manager.call(config.id, 'select_page', { pageId: 1, bringToFront: true });
  assert.deepEqual(calls, [{ name: 'new_page', args: { url: 'https://example.test/', background: false, isolatedContext: 'requested-profile' } }, { name: 'select_page', args: { pageId: 1, bringToFront: true } }]);
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
  await assert.rejects(manager.save(neo({ headers: { 'Mcp-Session-Id': 'override' } })), /managed/);
  await assert.rejects(manager.save(neo({ headers: { Authorization: 'line\nbreak' } })), /one line/);
  await assert.rejects(manager.save(stdio(dataDir)), /Only specialized browser/);
});

test('real direct stdio handshake pagination ping file write and reconnect',async t=>{
 const {client,dataDir,create}=await stdioHarness(t);await client.start();assert.equal(client.tools.length,6);
 assert.equal((await client.call('add',{a:19,b:23})).content[0].text,'42');
 assert.equal((await client.call('ping_then_echo',{text:'ping acknowledged'})).content[0].text,'ping acknowledged');
 const target=path.join(dataDir,'actual-write.txt');await client.call('write_file',{path:target,content:'verified write'});assert.equal(await readFile(target,'utf8'),'verified write');
 await assert.rejects(client.call('unlisted',{}),/current catalog/);const pid=client.child.pid;await client.close();await until(()=>!alive(pid));
 const next=create();await next.start();assert.equal((await next.call('echo',{text:'Reconnected.'})).content[0].text,'Reconnected.');
});

test('specialized browser vault credentials survive restart without public disclosure',async t=>{
 const secret='private-browser-vault-secret';const {manager,dataDir,cleanupManagers}=await managerHarness(t,vault);
 await manager.save(neo({headers:{Authorization:'Bearer '+secret}}));assert.equal(manager.list()[0].secretStorage,'encrypted');assert.ok(!JSON.stringify(manager.status()).includes(secret));
 assert.ok(!(await readFile(path.join(dataDir,'browser-connections.json'),'utf8')).includes(secret));manager.configs.get('browseros-neo').name='echoed '+secret;assert.ok(!JSON.stringify(manager.status()).includes(secret));
 const restored=await new ConnectionManager({dataDir,...vault}).init();cleanupManagers.push(restored);assert.equal(restored.secrets.get('browseros-neo').headers.Authorization,'Bearer '+secret);
});

test('specialized session credentials are not persisted and remove preserves another browser',async t=>{
 const {manager,dataDir}=await managerHarness(t);await manager.save(neo({headers:{Authorization:'Bearer session-only-key-value'}}));await manager.save(chromeAutoConnectConnection());
 assert.equal(manager.list().find(x=>x.id==='browseros-neo').secretStorage,'session');assert.ok(!(await readFile(path.join(dataDir,'browser-connections.json'),'utf8')).includes('session-only-key-value'));
 const restored=new ConnectionManager({dataDir});t.after(()=>restored.close());await restored.remove(chromeAutoConnectConnection().id);assert.equal(restored.list().length,1);assert.equal(restored.list()[0].id,'browseros-neo');assert.equal(restored.secrets.has('browseros-neo'),false);
});

test('direct stdio cancellation releases server and child before new client',async t=>{
 const {client,dataDir,create}=await stdioHarness(t);await client.start();const controller=new AbortController(),pending=client.call('wait',{spawnChild:true},{signal:controller.signal});pending.catch(()=>{});
 const worker=await until(async()=>{try{return (await readFile(path.join(dataDir,'events.log'),'utf8')).split('\n').filter(Boolean).map(JSON.parse).find(x=>x.workerPid);}catch{return null;}});
 const pid=client.child.pid;assert.ok(alive(pid)&&alive(worker.workerPid));
 controller.abort();await assert.rejects(pending,{code:'ABORT_ERR',name:'AbortError'});
 assert.equal(client.closed,true,'transport failure must initiate cleanup automatically');assert.ok(client.closePromise);await client.closePromise;await until(()=>!alive(pid)&&!alive(worker.workerPid));const next=create();await next.start();assert.equal((await next.call('add',{a:1,b:2})).content[0].text,'3');
});

test('direct stdio broken pipe releases server and child before new client',async t=>{
 const {client,dataDir,create}=await stdioHarness(t);await client.start();const controller=new AbortController(),pending=client.call('wait',{spawnChild:true},{signal:controller.signal});pending.catch(()=>{});
 const worker=await until(async()=>{try{return (await readFile(path.join(dataDir,'events.log'),'utf8')).split('\n').filter(Boolean).map(JSON.parse).find(x=>x.workerPid);}catch{return null;}});
 const pid=client.child.pid;assert.ok(alive(pid)&&alive(worker.workerPid));
 client.child.stdin.emit('error',new Error('Fixture pipe failure.'));await assert.rejects(pending,/MCP server stopped/);assert.equal(client.closed,true);
 assert.equal(client.closed,true,'transport failure must initiate cleanup automatically');assert.ok(client.closePromise);await client.closePromise;await until(()=>!alive(pid)&&!alive(worker.workerPid));const next=create();await next.start();assert.equal((await next.call('add',{a:1,b:2})).content[0].text,'3');
});

test('specialized reconnect waits for retired transport cleanup',async t=>{
 const {manager}=await managerHarness(t);await manager.save(neo());const release=deferred();let cleaned=false,started=false;t.after(()=>release.resolve());
 manager.clients.set('browseros-neo',{closed:true,connected:false,tools:[],closePromise:release.promise.then(()=>{cleaned=true;}),async close(){release.resolve();}});
 manager.fetchImpl=async()=>{started=true;assert.equal(cleaned,true);throw Error('Fixture launch stopped.');};const reconnect=manager.connect('browseros-neo');reconnect.catch(()=>{});await pause(30);assert.equal(started,false);release.resolve();await assert.rejects(reconnect,/Fixture launch stopped/);assert.equal(started,true);
});

test('direct stdio timeout and shutdown release real processes and pending work',async t=>{
 const {client,create}=await stdioHarness(t,1000);await client.start();const timedOutPid=client.child.pid;await assert.rejects(client.call('wait',{}),{code:'MCP_TIMEOUT'});assert.equal(client.closed,true);assert.ok(client.closePromise);await client.closePromise;await until(()=>!alive(timedOutPid));
 const next=create();await next.start();const pending=next.call('wait',{});pending.catch(()=>{});await until(()=>next.pending.size>0);const pid=next.child.pid;await next.close();await assert.rejects(pending,{code:'ABORT_ERR'});assert.equal(next.pending.size,0);await until(()=>!alive(pid));await assert.rejects(next.start(),/closed/);
});

async function closeHttpFixture(manager,server){try{await manager?.close();}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}}

test('HTTP fixture closes its real listener even when manager cleanup fails',async()=>{const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));await assert.rejects(closeHttpFixture({close:async()=>{throw Error('cleanup failed');}},server),/cleanup failed/);assert.equal(server.listening,false);});

async function httpHarness(t, { mode = 'json', secret = '', managerOptions = {} } = {}) {
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
  let result;
  t.after(()=>closeHttpFixture(result?.manager,server));
  result = await managerHarness(t,managerOptions); const url = `http://127.0.0.1:${server.address().port}/mcp`;
  await result.manager.save({ id: 'browseros-neo', transport: 'http', url, headers: secret ? { Authorization: 'Bearer ' + secret } : {} });
  return { ...result, url, requests, enteredSlow, cancellation, expire: () => { expireNext = true; } };
}

for (const mode of ['json', 'sse']) test(`Streamable HTTP ${mode}: initialize, session/version headers, tool calls and session DELETE`, async t => {
  const { manager, requests } = await httpHarness(t, { mode, secret: 'http-private-key-value' }); await manager.connect('browseros-neo');
  assert.equal((await manager.call('browseros-neo', 'echo', { text: 'Actual HTTP result.' })).content[0].text, 'Actual HTTP result.');
  assert.equal(requests[0].headers['mcp-session-id'], undefined); assert.equal(requests[0].headers.authorization, 'Bearer http-private-key-value');
  for (const request of requests.slice(1)) { assert.equal(request.headers['mcp-session-id'], 'session-1'); assert.equal(request.headers['mcp-protocol-version'], '2025-06-18'); }
  await manager.close(); assert.equal(requests.at(-1).method, 'DELETE'); assert.equal(requests.at(-1).headers['mcp-session-id'], 'session-1');
});

test('HTTP server-to-client ping gets a separate response POST and a 202 request cannot claim tool success', async t => {
  const { manager, requests } = await httpHarness(t, { mode: 'sse' });
  assert.equal((await manager.call('browseros-neo', 'ping', {})).content[0].text, 'HTTP ping acknowledged'); assert.ok(requests.some(request => !request.method && request.result));
  await assert.rejects(manager.call('browseros-neo', 'accepted', {}), { code: 'MCP_PROTOCOL' });
});

test('HTTP cancellation sends notifications/cancelled with the original request id', async t => {
  const { manager, enteredSlow, cancellation } = await httpHarness(t); const controller = new AbortController();
  const pending = manager.call('browseros-neo', 'slow', {}, { signal: controller.signal }); pending.catch(() => {}); const id = await enteredSlow.promise; controller.abort(); await assert.rejects(pending, { code: 'ABORT_ERR' });
  const notice = await Promise.race([cancellation.promise, pause(3000).then(() => { throw new Error('Cancellation notification missing.'); })]); assert.equal(notice.requestId, id); assert.equal(manager.status().connections[0].busy, 0);
});

test('expired HTTP sessions fail the current action and reinitialize before the next explicit call', async t => {
  const { manager, requests, expire } = await httpHarness(t); await manager.connect('browseros-neo'); expire(); await assert.rejects(manager.call('browseros-neo', 'echo', { text: 'not silently retried' }), { code: 'MCP_SESSION_EXPIRED' });
  assert.equal((await manager.call('browseros-neo', 'echo', { text: 'explicit retry' })).content[0].text, 'explicit retry');
  const initialize = requests.filter(request => request.method === 'initialize'); assert.equal(initialize.length, 2); assert.equal(initialize[1].headers['mcp-session-id'], undefined); assert.equal(requests.at(-1).headers['mcp-session-id'], 'session-2');
});

test('HTTP catalogs and errors redact secrets, and endpoint changes require each credential group explicitly', async t => {
  const secret = 'private-http-redaction-value', { manager, url } = await httpHarness(t, { secret });
  const catalog = await manager.tools('browseros-neo'); assert.ok(!JSON.stringify(catalog).includes(secret));
  await assert.rejects(manager.call('browseros-neo', 'error', {}), error => !error.message.includes(secret) && !error.message.includes('unrecognized-token'));
  await assert.rejects(manager.save({ id: 'browseros-neo', url: url + '-other', env: {} }), /credentials again/);
  await manager.save({ id: 'browseros-neo', url: url + '-other', env: {}, headers: {} }); assert.equal(manager.list()[0].headerNames.length, 0);
});

test('specialized credential writes and active HTTP calls cannot race',async t=>{
 const encrypting=deferred(),release=deferred();let delay=false;
 const {manager,enteredSlow}=await httpHarness(t,{managerOptions:{...vault,encryptSecret:async value=>{if(delay){encrypting.resolve();await release.promise;}return vault.encryptSecret(value);}}});
 await manager.connect('browseros-neo');delay=true;const saving=manager.save({id:'browseros-neo',headers:{Authorization:'Bearer new-private-key'}});await encrypting.promise;
 await assert.rejects(manager.call('browseros-neo','echo',{text:'blocked'}),{code:'MCP_BUSY'});release.resolve();await saving;
 const controller=new AbortController(),pending=manager.call('browseros-neo','slow',{}, {signal:controller.signal});pending.catch(()=>{});await enteredSlow.promise;
 await assert.rejects(manager.save({id:'browseros-neo',name:'New name'}),{code:'MCP_BUSY'});await assert.rejects(manager.disconnect('browseros-neo'),{code:'MCP_BUSY'});controller.abort();await assert.rejects(pending,{code:'ABORT_ERR'});
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
  let manager;
  t.after(()=>closeHttpFixture(manager,server));
  ({manager}=await managerHarness(t));
  await manager.save({ id: 'browseros-neo', transport: 'http', url: `http://127.0.0.1:${server.address().port}/mcp` });
  const query = text => manager.tools('browseros-neo',{query:text});
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
