import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHarnessServer } from '../server.mjs';
import { recordFixturePlan } from './fixture-task-plan.mjs';

class Runtime extends EventEmitter {
  prompts = [];
  status() { return { connected: true, authenticated: true, defaultModel: 'fixture' }; }
  async start() { return this.status(); }
  async runAgent(options) { await recordFixturePlan(options); this.prompts.push(options.prompt); return { output: 'Actual fixture result.', threadId: 'signed-browser-fixture' }; }
  async close() {}
}

test('legacy native discovery preserves its manual connection while an ordinary task completes without native browser admission', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-browser-server-'));
  const methods = [];
  const tools = ['tabs', 'snapshot', 'act', 'navigate'].map(name => ({ name, description: 'Fixture browser tool.', inputSchema: { type: 'object', properties: { action: { type: 'string' }, page: { type: 'integer' }, kind: { type: 'string' }, url: { type: 'string' } } } }));
  const mcp = createServer(async (request, response) => {
    if (request.method === 'DELETE') { response.writeHead(200).end(); return; }
    let body = ''; for await (const chunk of request) body += chunk;
    const message = JSON.parse(body); methods.push(message.method);
    if (!Object.hasOwn(message, 'id')) { response.writeHead(202).end(); return; }
    const result = message.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'BrowserOS neo', version: 'fixture' } } : message.method === 'tools/list' ? { tools } : { content: [{ type: 'text', text: 'No open pages.' }] };
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise(resolve => mcp.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${mcp.address().port}/mcp`, runtime = new Runtime();
  const app = await createHarnessServer({ runtime, dataDir: path.join(directory, 'data'), defaultCwd: path.join(directory, 'workspace'), port: 0, signedBrowser: true, signedBrowserOptions: { endpoints: [{ url: endpoint }] }, startSignedBrowser: () => { assert.fail('A connected browser must not be launched again'); } });
  const url = await app.listen();
  t.after(async () => { await app.close(); mcp.closeAllConnections(); await new Promise(resolve => mcp.close(resolve)); assert.match(path.basename(directory), /^relay-browser-server-/); await rm(directory, { recursive: true, force: true }); });
  const landing = await fetch(url), cookie = landing.headers.get('set-cookie').split(';')[0]; await landing.text();
  const request = (route, body) => fetch(url + route, { headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
  const status = await (await request('/api/browser/status')).json();
  assert.equal(status.signedBrowser.available, true); assert.equal(status.signedBrowser.accountAuthenticated, null);
  assert.equal(status.signedBrowser.endpoint, endpoint); assert.equal(status.signedBrowser.reusesBrowserSession, true);
  assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'initialize', 'notifications/initialized', 'tools/list', 'tools/call'], 'status validates the browser link before persisting it and checks the adopted connection');
  assert.equal((await request('/api/browser/reconnect', {})).status, 200);
  const started=await request('/api/browser/start', {});assert.equal(started.status,503);assert.match((await started.json()).error,/cannot verify its background focus policy/);
  assert.equal(app.connections.configs.get('browseros-neo').url,endpoint);assert.equal(app.connections.clients.get('browseros-neo').connected,true,'unsupported policy keeps the existing tool connection intact');assert.equal(app.connections.signedBrowser.backgroundWindow.ready,false);assert.equal(app.connections.signedBrowser.backgroundWindow.supported,false);
  const graph = { id: 'browser-prompt', name: 'Browser prompt', nodes: [{ id: 'input', type: 'input', name: 'Task' }, { id: 'agent', type: 'agent', name: 'Agent', prompt: 'Inspect the website', sandbox: 'read-only' }, { id: 'output', type: 'output', name: 'Result' }], edges: [{ id: 'a', source: 'input', target: 'agent' }, { id: 'b', source: 'agent', target: 'output' }], settings: { maxParallel: 1 } };
  const run = app.engine.startRun({ workflow: graph, input: 'Check the actual account state.' });
  await app.engine.executions.get(run.id);
  assert.equal(app.engine.getRun(run.id).status,'completed','an ordinary model turn can still finish without native browser admission');
  assert.doesNotMatch(runtime.prompts[0], /EXISTING BROWSER SESSION/,'an unverifiable native session is not advertised as usable');
  assert.equal(methods.filter(method => method === 'tools/call').length, 4, 'Discovery and explicit reconnect/start only read the browser inventory');
});
