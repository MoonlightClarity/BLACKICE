import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ChatGPTConnector } from '../lib/chatgpt-connector.mjs';

class Response {
  headers = {}; body = ''; statusCode = 0; destroyed = false;
  setHeader(key, value) { this.headers[key.toLowerCase()] = value; }
  writeHead(status, headers = {}) { this.statusCode = status; for (const [key, value] of Object.entries(headers)) this.setHeader(key, value); }
  end(value = '') { this.body += value; }
  json() { return JSON.parse(this.body); }
}
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-chatgpt-transport-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls = [], revoked = [];
  const execution = {
    tools: () => [{ name: 'blackice_direct_status', scope: 'read', requiredScopes: ['read'], description: 'Read', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }, { name: 'blackice_browser_upload', scope: 'browser:write', requiredScopes: ['browser:write', 'files:read'], description: 'Upload', inputSchema: { type: 'object' } }],
    status: async () => ({ direct: true, providerTurns: false }),
    call: async (name, args, client) => { calls.push({ name, args, client }); return { app: 'BLACKICE', modelStarted: false, nonce: args.nonce }; },
    close: async () => {},
  };
  let client = null;
  const oauth = { setOrigin() {}, matches: value => value.startsWith('/.well-known/'), status: () => ({ grants: [] }), revokeAll: async () => revoked.push(true), authenticateRequest: async () => client,
    challenge: scopes => `Bearer resource_metadata="https://owned.example/.well-known/oauth-protected-resource", error="invalid_token", scope="${scopes.join(' ')}"`, handle: async (_req, res) => { res.writeHead(200); res.end('{}'); } };
  let closing = false;
  const connector = await new ChatGPTConnector({ dataDir: directory, execution, planning: { tools: () => [], call: async () => { throw Error('Unexpected planning call.'); } }, oauth, version: '2.33.0', isClosing: () => closing }).init();
  connector.setOrigin('https://owned.example'); await connector.setEnabled(true);
  return { connector, calls, revoked, oauth, execution, setClosing: value => { closing = value; }, setClient: value => { client = value; } };
}
async function post(connector, payload, headers = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(payload))]); Object.assign(req, { method: 'POST', url: '/mcp/chatgpt', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...headers } });
  const res = new Response(); await connector.handle(req, res); return res;
}
const rpc = (method, params = {}, id = 'request-one') => ({ jsonrpc: '2.0', id, method, params });

test('public discovery advertises exact OAuth scopes but never executes a user tool', async t => {
  const { connector, calls } = await fixture(t);
  const result = (await post(connector, rpc('tools/list'))).json().result;
  assert.equal(result.tools.length, 2); assert.deepEqual(result.tools[1].securitySchemes, [{ type: 'oauth2', scopes: ['read', 'browser:write', 'files:read'] }]);
  assert.equal(Object.hasOwn(result.tools[1], 'scope'), false); assert.equal(Object.hasOwn(result.tools[1], 'requiredScopes'), false);
  const unauthenticated = (await post(connector, rpc('tools/call', { name: 'blackice_direct_status', arguments: { nonce: 'proof-one' } }))).json();
  assert.equal(unauthenticated.result.isError, true); assert.match(unauthenticated.result._meta['mcp/www_authenticate'][0], /resource_metadata=/); assert.deepEqual(calls, []);
});

test('unauthenticated GET discovery probes return the OAuth metadata challenge without starting a stream or tool', async t => {
  const { connector, oauth, calls, setClient, setClosing } = await fixture(t);
  let authentications = 0;
  const authenticate = oauth.authenticateRequest;
  oauth.authenticateRequest = async req => { authentications++; return authenticate(req); };
  const get = async (headers = {}, url = '/mcp/chatgpt') => {
    const res = new Response(); await connector.handle({ method: 'GET', url, headers }, res); return res;
  };
  const missing = await get();
  assert.equal(missing.statusCode, 401);
  assert.match(missing.headers['www-authenticate'], /^Bearer resource_metadata="https:\/\/owned\.example\/\.well-known\/oauth-protected-resource"/);
  assert.match(missing.headers['www-authenticate'], /scope="read"/);
  assert.equal(authentications, 1); assert.deepEqual(calls, []);
  setClient({ id: 'approved-connection', scopes: ['read'] });
  const authenticated = await get({ authorization: 'Bearer owned-test-token' });
  assert.equal(authenticated.statusCode, 405); assert.equal(authenticated.headers.allow, 'POST');
  assert.equal(authenticated.headers['www-authenticate'], undefined);
  const crossOrigin = await get({ origin: 'https://attacker.example' });
  assert.equal(crossOrigin.statusCode, 403); assert.equal(authentications, 2);
  assert.equal((await get({}, '/mcp/chatgpt?unexpected=true')).statusCode, 405); assert.equal(authentications, 2);
  setClosing(true); assert.equal((await get()).statusCode, 503); assert.equal(authentications, 2);
  assert.deepEqual(calls, []); assert.equal((await connector.status()).lastAuthenticatedToolCall, null);
});

test('an authenticated read echoes the exact request/result pair and uses direct execution', async t => {
  const { connector, setClient, calls } = await fixture(t); setClient({ id: 'grant-one', label: 'ChatGPT', scopes: ['read'] });
  const response = await post(connector, rpc('tools/call', { name: 'blackice_direct_status', arguments: { nonce: 'proof-37' } }, 'matching-id'));
  const value = response.json(); assert.equal(value.id, 'matching-id'); assert.equal(value.result.structuredContent.nonce, 'proof-37'); assert.equal(value.result.structuredContent.modelStarted, false); assert.equal(calls.length, 1);
  const status = await connector.status(); assert.equal(status.actions.providerTurns, false); assert.equal(status.chatSurfaceVerification, 'not-recorded'); assert.equal(status.lastAuthenticatedToolCall.nonce, 'proof-37');
});

test('scope checks, cross-origin requests and disabled connectors block execution', async t => {
  const { connector, setClient, calls, revoked } = await fixture(t); setClient({ id: 'grant-one', scopes: ['read', 'browser:write'] });
  const value = (await post(connector, rpc('tools/call', { name: 'blackice_browser_upload', arguments: {} }))).json(); assert.equal(value.result.isError, true); assert.deepEqual(calls, []);
  assert.equal((await post(connector, rpc('tools/list'), { origin: 'https://attacker.example' })).statusCode, 403);
  await connector.setEnabled(false); assert.equal(revoked.length, 1); assert.equal((await post(connector, rpc('tools/list'))).statusCode, 503); assert.deepEqual(calls, []);
});

test('only successful authenticated tools notify setup and optional receipt failures preserve the actual result', async t => {
  const { connector, setClient } = await fixture(t), receipts = [];
  connector.onAuthenticatedToolCall = async receipt => { receipts.push(receipt); throw Error('Optional setup storage unavailable.'); };
  await post(connector, rpc('tools/list'));
  await post(connector, rpc('tools/call', { name: 'blackice_direct_status', arguments: { nonce: 'not-authorized' } }));
  assert.equal(receipts.length, 0);
  setClient({ id: 'grant-one', scopes: ['read'] });
  const value = (await post(connector, rpc('tools/call', { name: 'blackice_direct_status', arguments: { nonce: 'actual-receipt' } }))).json().result;
  assert.equal(value.isError, false); assert.equal(value.structuredContent.nonce, 'actual-receipt');
  assert.equal(receipts.length, 1); assert.equal(receipts[0].clientId, 'grant-one'); assert.equal(receipts[0].nonce, 'actual-receipt');
});

test('MCP modern routing and result metadata agree while legacy initialize stays supported', async t => {
  const { connector } = await fixture(t);
  const legacy = (await post(connector, rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Test', version: '1' } }))).json();
  assert.equal(legacy.result.protocolVersion, '2025-11-25');
  const request = rpc('server/discover', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } });
  const success = (await post(connector, request, { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'server/discover' })).json();
  assert.equal(success.result.resultType, 'complete'); assert.equal(success.result._meta['io.modelcontextprotocol/serverInfo'].name, 'BLACKICE direct execution');
  assert.equal((await post(connector, request, { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call' })).statusCode, 400);
});

test('invalid argument containers and unknown worker tools never reach the execution API', async t => {
  const { connector, calls, setClient } = await fixture(t); setClient({ id: 'grant-one', scopes: ['read'] });
  for (const argumentsValue of [null, false, [], 'text']) assert.equal((await post(connector, rpc('tools/call', { name: 'blackice_direct_status', arguments: argumentsValue }))).statusCode, 400);
  const worker = await post(connector, rpc('tools/call', { name: 'blackice_start_task', arguments: { task: 'hidden worker' } })); assert.equal(worker.statusCode, 400); assert.deepEqual(calls, []);
});

test('revocation and narrowed scopes between authentication and dispatch prevent admission', async t => {
  const { connector, calls, oauth, setClient } = await fixture(t);
  setClient({ id: 'grant-one', scopes: ['read', 'browser:write', 'files:read'] });
  for (const current of [null, { id: 'grant-one', scopes: ['read'] }]) {
    oauth.getClient = async () => current;
    const result = (await post(connector, rpc('tools/call', { name: 'blackice_browser_upload', arguments: {} }))).json().result;
    assert.equal(result.isError, true); assert.equal(result.structuredContent.code, 'CHATGPT_ACCESS_REVOKED');
    assert.ok(result._meta['mcp/www_authenticate']);
  }
  assert.deepEqual(calls, []);
});

test('maintenance blocks OAuth writes and tracks already admitted OAuth work until settled', async t => {
  const { connector, oauth, setClosing } = await fixture(t);
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const admissions = [];
  oauth.handle = async (_req, res, options) => { admissions.push(options.enabled); entered(); await gate; res.writeHead(200); res.end('{}'); };
  const request = { url: '/.well-known/oauth-authorization-server', method: 'GET', headers: {} };
  const first = connector.handle(request, new Response()); await started;
  assert.equal(connector.inflight.size, 1);
  setClosing(true); release(); await first;
  assert.equal(connector.inflight.size, 0);
  await connector.handle(request, new Response());
  assert.deepEqual(admissions, [true, false]);
  assert.equal((await post(connector, rpc('tools/list'))).statusCode, 503);
});

test('close waits for an admitted tool result instead of reporting a lost pending action', async t => {
  const { connector, execution, setClient } = await fixture(t);
  setClient({ id: 'grant-one', scopes: ['read'] });
  let release, entered, closed = false;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  execution.call = async (_name, args) => { entered(); await gate; return { nonce: args.nonce, modelStarted: false }; };
  execution.close = async () => { closed = true; };
  const pending = post(connector, rpc('tools/call', { name: 'blackice_direct_status', arguments: { nonce: 'same-pending-read' } }));
  await started; const closing = connector.close();
  await Promise.resolve(); assert.equal(closed, false); assert.equal(connector.inflight.size, 1);
  assert.equal((await post(connector, rpc('tools/list'))).statusCode, 503);
  release(); const result = await pending; await closing;
  assert.equal(result.json().result.structuredContent.nonce, 'same-pending-read'); assert.equal(closed, true); assert.equal(connector.inflight.size, 0);
  await assert.rejects(connector.setEnabled(true), { code: 'CHATGPT_CONNECTOR_DISABLED' });
});

test('unavailable direct storage remains visible and cannot be advertised as ready', async t => {
  const { connector, execution } = await fixture(t);
  execution.status = async () => ({ available: false, storageError: { code: 'DIRECT_JOB_STORAGE', message: 'Saved jobs need recovery.' } });
  const current = await connector.status(); assert.equal(current.available, false); assert.equal(current.error, 'Saved jobs need recovery.');
  await connector.setEnabled(false);
  await assert.rejects(connector.setEnabled(true), { code: 'CHATGPT_EXECUTION_UNAVAILABLE' });
});

test('a saved result with narrower current access challenges for its actual required permissions', async t => {
  const { connector, execution, setClient } = await fixture(t);
  setClient({ id: 'grant-one', scopes: ['read'] });
  execution.call = async () => { throw Object.assign(Error('This saved receipt requires file access.'), { status: 403, code: 'DIRECT_SCOPE_REQUIRED', requiredScopes: ['read', 'files:read'] }); };
  const result = (await post(connector, rpc('tools/call', { name: 'blackice_direct_status', arguments: {} }))).json().result;
  assert.equal(result.isError, true); assert.match(result._meta['mcp/www_authenticate'][0], /scope="read files:read"/); assert.deepEqual(result.structuredContent.requiredScopes, ['read', 'files:read']);
});
