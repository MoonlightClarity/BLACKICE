import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';

class NativeBrowserFixtureRuntime extends EventEmitter {
  status() { return { connected: true, authenticated: true, defaultModel: 'fixture', activeTurns: 0 }; }
  async start() { return this.status(); }
  async close() {}
}
async function appFixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'relay-native-http-'));
  const app = await createHarnessServer({ runtime: new NativeBrowserFixtureRuntime(), port: 0, dataDir: path.join(root, 'data'), defaultCwd: path.join(root, 'workspace'), ...options });
  const url = await app.listen(), response = await fetch(url), cookie = response.headers.get('set-cookie').split(';')[0];
  await response.text();
  t.after(async () => { await app.close(); assert.match(path.basename(root), /^relay-native-http-/); await rm(root, { recursive: true, force: true }); });
  const request = async (route, method = 'GET') => {
    const response = await fetch(`${url}${route}`, { method, headers: { Cookie: cookie, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) }, ...(method === 'POST' ? { body: '{}' } : {}) });
    return { status: response.status, data: await response.json() };
  };
  return { app, request };
}
const nativeTools = [
  { name: 'tabs', inputSchema: { type: 'object', properties: { action: { type: 'string' } } } },
  { name: 'snapshot', inputSchema: { type: 'object', properties: { page: { type: 'integer' } } } },
  { name: 'act', inputSchema: { type: 'object', properties: { page: { type: 'integer' }, kind: { type: 'string' } } } },
  { name: 'run', inputSchema: { type: 'object', properties: { code: { type: 'string' } } } },
];

test('native HTTP startup remains responsive during discovery and shutdown cancels the pending probe', async t => {
  let cancelled = false;
  const { app, request } = await appFixture(t, { signedBrowser: true, signedBrowserOptions: { registerImpl: async ({ signal }) => new Promise(resolve => {
    signal.addEventListener('abort', () => { cancelled = true; resolve({ available: false, reason: 'Browser discovery was cancelled.' }); }, { once: true });
  }) } });
  const status = await request('/api/browser/status');
  assert.equal(status.status, 200); assert.equal(status.data.signedBrowser.discovering, true);
  assert.equal((await request('/api/status')).status, 200);
  const start = Date.now(); await app.close();
  assert.equal(cancelled, true); assert.ok(Date.now() - start < 2000);
});

test('native start endpoint uses shared readiness discovery for an already running browser and delayed MCP sidecar', async t => {
  let started = false, startupCalls = 0, readinessMisses = 0, browserActions = 0;
  const server = http.createServer(async (request, response) => {
    if (request.method === 'DELETE') { response.writeHead(200); response.end(); return; }
    let text = ''; for await (const part of request) text += part;
    const message = JSON.parse(text);
    if (!started || readinessMisses++ < 7) { response.writeHead(503); response.end(); return; }
    if (message.method === 'tools/call') browserActions++;
    if (!Object.hasOwn(message, 'id')) { response.writeHead(202); response.end(); return; }
    const result = message.method === 'initialize' ? { protocolVersion: '2025-06-18', serverInfo: { name: 'BrowserOS neo', version: 'fixture' }, capabilities: { tools: {} } } : message.method === 'tools/list' ? { tools: nativeTools } : { content: [{ type: 'text', text: 'No open pages.' }] };
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const { request } = await appFixture(t, {
    signedBrowser: true,
    signedBrowserOptions: { endpoints: [{ url: `http://127.0.0.1:${server.address().port}/mcp`, source: 'browseros-runtime' }], retryDelayMs: 1, startupTimeoutMs: 2000, prepareWindowImpl:async()=>({ready:true,policyVerified:true,created:false}) },
    startSignedBrowser: async () => { startupCalls++; started = true; return { started: false, running: true, installed: true }; },
  });
  const status = await request('/api/browser/start', 'POST');
  assert.equal(status.status, 200); assert.equal(status.data.signedBrowser.available, true); assert.equal(status.data.signedBrowser.catalogKind, 'neo-run');
  assert.equal(startupCalls, 1); assert.ok(readinessMisses > 7); assert.equal(browserActions, 2, 'The temporary candidate and adopted connection both pass read-only inventory checks.');
  const reads = await request('/api/browser/status'); assert.equal(reads.data.signedBrowser.available, true); assert.equal(startupCalls, 1);
});

test('native start reports specific readiness failures and never starts from a source-only server', async t => {
  let starts = 0;
  const source = await appFixture(t, { startSignedBrowser: () => { starts++; return { started: true }; } });
  assert.equal((await source.request('/api/browser/start', 'POST')).status, 400); assert.equal(starts, 0);
  const desktop = await appFixture(t, { signedBrowser: true, signedBrowserOptions: { endpoints: [] }, startSignedBrowser: async () => ({ installed: false, started: false, reason: 'BrowserOS neo is not installed.' }) });
  const result = await desktop.request('/api/browser/start', 'POST');
  assert.equal(result.status, 503); assert.equal(result.data.error, 'BrowserOS neo is not installed.');
});
