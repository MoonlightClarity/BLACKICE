import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConnectionManager, connectedBrowserIdentity, createConnectionToolHandler, executeConnectedBrowser } from '../lib/mcp.mjs';
import { chromeAutoConnectConnection, isChromeBrowserConnection } from '../lib/chrome-browser.mjs';

const schema = { type: 'object', properties: { code: { type: 'string' } }, additionalProperties: true };
const neoTools = [
  { name: 'tabs', description: 'List native browser pages.', inputSchema: schema },
  { name: 'run', description: 'BrowserOS neo SDK: browser.pages.list() and browser.cdp().', inputSchema: schema },
  { name: 'screenshot', description: 'Capture the selected native page, including fullPage when requested.', inputSchema: schema },
  { name: 'request_human_help', description: 'Native browser interaction.', inputSchema: schema },
];
const chromeTools = ['list_pages', 'new_page', 'select_page', 'take_snapshot'].map(name => ({ name, description: name, inputSchema: schema }));
async function harness(t, { catalog = neoTools, onCall } = {}) {
  const calls = [], directory = await mkdtemp(path.join(tmpdir(), 'blackice-connected-browser-'));
  const server = createServer(async (request, response) => {
    if (request.method === 'DELETE') { response.writeHead(204).end(); return; }
    let body = ''; for await (const chunk of request) body += chunk;
    const message = JSON.parse(body); calls.push(message);
    if (!Object.hasOwn(message, 'id')) { response.writeHead(202).end(); return; }
    let result;
    if (message.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'native-browser-fixture' } };
    else if (message.method === 'tools/list') result = { tools: catalog };
    else if (message.method === 'tools/call') result = onCall ? await onCall(message.params, response) : { content: [{ type: 'text', text: 'Observed native fixture page.' }] };
    if (!response.writableEnded && result !== undefined) response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const manager = await new ConnectionManager({ dataDir: directory }).init();
  t.after(async () => { await manager.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const config = { id: 'native-browser', name: 'Native fixture', transport: 'http', url: `http://127.0.0.1:${server.address().port}/mcp`, timeoutMs: 1000 };
  await manager.save(config);
  return { manager, calls, directory, config };
}
const callsToTools = calls => calls.filter(item => item.method === 'tools/call');

test('browser inventory is metadata only and distinguishes attached Chrome from a connected tool process', async t => {
  const { manager, calls } = await harness(t);
  const chrome = chromeAutoConnectConnection(); await manager.save(chrome);
  const profile = { ...chrome, id: 'browser-profile-0123456789abcdef', name: 'Chrome · copied profile', args: ['-y', 'chrome-devtools-mcp@latest', '--executablePath=C:/Chrome/chrome.exe', '--userDataDir=C:/Imported/fixture'] };
  await manager.save(profile);
  manager.clients.set(chrome.id, { connected: true, closed: false, tools: chromeTools, async close() {} });
  const result = await executeConnectedBrowser({ manager, action: 'connections' });
  assert.equal(result.success, true); assert.equal(calls.length, 0);
  const { connections } = JSON.parse(result.contentItems[0].text);
  assert.equal(connections.length, 2);
  assert.equal(connections[0].connected, true); assert.equal(connections[0].available, false); assert.equal(connections[0].accountAuthenticated, 'unknown');
  assert.equal(connections[1].mode, 'imported-profile'); assert.equal(connections[1].adapter, 'chrome-devtools');
  assert.doesNotMatch(JSON.stringify(result), /C:\/Chrome|C:\/Imported/);
  assert.equal(manager.list().find(item => item.id === chrome.id).agentAvailable, true);
});

test('native aliases are identified from actual discovery and retain the complete SDK schemas', async t => {
  const { manager, config, calls } = await harness(t);
  assert.equal(connectedBrowserIdentity(manager, config.id), null);
  const tools = await executeConnectedBrowser({ manager, action: 'tools', connectionId: config.id });
  assert.equal(tools.success, true); assert.equal(tools.receipt.browser, 'neo'); assert.equal(tools.receipt.actionDispatched, false);
  const catalog = JSON.parse(tools.contentItems[0].text);
  assert.deepEqual(catalog.tools.map(tool => tool.name), neoTools.map(tool => tool.name));
  assert.deepEqual(catalog.tools.find(tool => tool.name === 'run').inputSchema, schema);
  const args = { code: 'return await browser.pages.list();', anyNativeOption: true };
  const result = await executeConnectedBrowser({ manager, action: 'call', connectionId: config.id, name: 'run', arguments: args });
  assert.equal(result.success, true); assert.equal(result.receipt.actionDispatched, true); assert.equal(result.receipt.outcome, 'completed');
  assert.deepEqual(callsToTools(calls).map(item => item.params), [{ name: 'run', arguments: args }]);
  assert.equal(JSON.parse(result.contentItems.at(-1).text).connectedBrowser.browser, 'neo');
});

test('task agents use the same configured native gateway without a contained-browser gate', async t => {
  const { manager, config, calls } = await harness(t);
  await manager.save({ ...config, name: 'BrowserOS Neo' });
  const handler = createConnectionToolHandler({ manager });
  const catalog = await handler({ name: 'relay_connections', arguments: { action: 'tools', connectionId: config.id } });
  assert.equal(catalog.success, true); assert.equal(catalog.receipt.browser, 'neo');
  const result = await handler({ name: 'relay_connections', arguments: { action: 'call', connectionId: config.id, name: 'request_human_help', arguments: {} } });
  assert.equal(result.success, true); assert.equal(result.receipt.actionDispatched, true); assert.equal(callsToTools(calls).length, 1);
});

test('unknown tools, disabled configurations and nonbrowser connections are rejected before action dispatch', async t => {
  const { manager, config, calls } = await harness(t);
  const absent = await executeConnectedBrowser({ manager, action: 'call', connectionId: config.id, name: 'invented_tool', arguments: {} });
  assert.equal(absent.success, false); assert.equal(absent.receipt.code, 'MCP_TOOL_NOT_FOUND'); assert.equal(absent.receipt.actionDispatched, false);
  await manager.save({ ...config, enabled: false });
  const disabled = await executeConnectedBrowser({ manager, action: 'call', connectionId: config.id, name: 'run', arguments: {} });
  assert.equal(disabled.success, false); assert.equal(disabled.receipt.actionDispatched, false);
  assert.equal(manager.list()[0].agentAvailable, false); assert.equal(callsToTools(calls).length, 0);
  const other = await harness(t, { catalog: [{ name: 'echo', description: 'Generic service.', inputSchema: schema }] });
  const unknown = await executeConnectedBrowser({ manager: other.manager, action: 'call', connectionId: other.config.id, name: 'echo', arguments: {} });
  assert.equal(unknown.success, false); assert.equal(unknown.receipt.code, 'MCP_BROWSER_UNRECOGNIZED'); assert.equal(callsToTools(other.calls).length, 0);
});

test('native errors and failed transport after dispatch retain truthful receipts without replay', async t => {
  const { manager, config, calls } = await harness(t, { onCall: async ({ name }, response) => {
    if (name === 'run') return { isError: true, content: [{ type: 'text', text: 'Native challenge needs user interaction.' }] };
    response.writeHead(503).end('fixture unavailable');
  } });
  const result = await executeConnectedBrowser({ manager, action: 'call', connectionId: config.id, name: 'run', arguments: {} });
  assert.equal(result.success, false); assert.equal(result.receipt.outcome, 'tool-error'); assert.equal(result.receipt.actionDispatched, true);
  const uncertain = await executeConnectedBrowser({ manager, action: 'call', connectionId: config.id, name: 'tabs', arguments: {} });
  assert.equal(uncertain.success, false); assert.equal(uncertain.receipt.outcome, 'unknown'); assert.equal(uncertain.receipt.actionDispatched, true);
  assert.equal(callsToTools(calls).length, 2);
});

test('cancellation after native dispatch throws an uncertain receipt and never retries', async t => {
  const controller = new AbortController();
  const { manager, config, calls } = await harness(t, { onCall: async () => { controller.abort(); return { content: [{ type: 'text', text: 'Already accepted.' }] }; } });
  await assert.rejects(executeConnectedBrowser({ manager, action: 'call', connectionId: config.id, name: 'run', arguments: {}, signal: controller.signal }), error => {
    assert.equal(error.name, 'AbortError'); assert.equal(error.receipt.actionDispatched, true); assert.equal(error.receipt.outcome, 'unknown'); return true;
  });
  assert.equal(callsToTools(calls).length, 1);
});

test('existing Chrome attach remains explicit and imported profiles use their own native session', async t => {
  const { manager } = await harness(t);
  const config = chromeAutoConnectConnection(); await manager.save(config);
  const calls = [];
  const client = { connected: true, closed: false, tools: chromeTools, async start() {}, async close() {}, async call(name, args, options) { options.onDispatch?.(); calls.push({ name, args }); return { content: [{ type: 'text', text: 'Private fixture tab title and URL.' }] }; } };
  manager.clients.set(config.id, client);
  const blocked = await executeConnectedBrowser({ manager, action: 'call', connectionId: config.id, name: 'list_pages', arguments: {} });
  assert.equal(blocked.success, false); assert.equal(blocked.receipt.code, 'MCP_BROWSER_DISCONNECTED'); assert.equal(blocked.receipt.actionDispatched, false); assert.equal(calls.length, 0);
  const connected = await executeConnectedBrowser({ manager, action: 'connect_chrome' });
  assert.equal(connected.success, true); assert.equal(connected.receipt.outcome, 'connected'); assert.equal(connected.receipt.actionDispatched, true);
  assert.doesNotMatch(JSON.stringify(connected), /Private fixture tab/); assert.equal(JSON.parse(connected.contentItems[0].text).accountAuthenticated, 'unknown');
  const opened = await executeConnectedBrowser({ manager, action: 'call', connectionId: config.id, name: 'new_page', arguments: { url: 'https://example.test/', isolatedContext: 'fresh', background: false } });
  assert.equal(opened.success, true); assert.deepEqual(calls.at(-1), { name: 'new_page', args: { url: 'https://example.test/', isolatedContext: 'fresh', background: false } });
  client.connected = false;
  const disconnected = await executeConnectedBrowser({ manager, action: 'call', connectionId: config.id, name: 'list_pages' });
  assert.equal(disconnected.success, false); assert.equal(disconnected.receipt.actionDispatched, false); assert.equal(calls.length, 2);
  const profile = { ...config, id: 'browser-profile-0123456789abcdef', args: ['-y', 'chrome-devtools-mcp@latest', '--executablePath=C:/Native/chrome.exe', '--userDataDir=C:/Imported/fixture'] };
  await manager.save(profile); const imported = { ...client, connected: true }; manager.clients.set(profile.id, imported);
  const profileCall = await executeConnectedBrowser({ manager, action: 'call', connectionId: profile.id, name: 'select_page', arguments: { pageId: 3, bringToFront: true } });
  assert.equal(profileCall.success, true); assert.equal(profileCall.receipt.mode, 'imported-profile'); assert.deepEqual(calls.at(-1), { name: 'select_page', args: { pageId: 3, bringToFront: true } });
  assert.equal(isChromeBrowserConnection(profile), true); assert.deepEqual(manager.configs.get(profile.id).args, profile.args);
});

test('connected browser image export shares exact-byte validation, receipt and no-overwrite behavior', async t => {
  const { deflateSync } = await import('node:zlib');
  const crc = bytes => { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value & 1 ? value >>> 1 ^ 0xedb88320 : value >>> 1; } return (value ^ 0xffffffff) >>> 0; };
  const chunk = (name, bytes) => { const result = Buffer.alloc(bytes.length + 12); result.writeUInt32BE(bytes.length); result.write(name, 4); bytes.copy(result, 8); result.writeUInt32BE(crc(result.subarray(4, -4)), result.length - 4); return result; };
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  const image = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0))]);
  const { manager, config, calls, directory } = await harness(t, { onCall: async () => ({ content: [{ type: 'image', mimeType: 'image/png', data: image.toString('base64') }] }) });
  const destination = path.join(directory, 'screenshot.png');
  const result = await executeConnectedBrowser({ manager, action: 'call', connectionId: config.id, name: 'screenshot', arguments: { page: 7, fullPage: true }, imageOutputPath: destination });
  assert.equal(result.success, true); assert.equal(result.receipt.savedImage.path, destination); assert.equal(result.receipt.savedImage.bytes, image.length); assert.deepEqual(await readFile(destination), image);
  assert.equal(result.contentItems[0].imageUrl, `data:image/png;base64,${image.toString('base64')}`);
  await writeFile(destination, 'preserve the caller file');
  const blocked = await executeConnectedBrowser({ manager, action: 'call', connectionId: config.id, name: 'screenshot', imageOutputPath: destination });
  assert.equal(blocked.success, false); assert.equal(blocked.receipt.actionDispatched, false); assert.equal(callsToTools(calls).length, 1); assert.equal(await readFile(destination, 'utf8'), 'preserve the caller file');
});
