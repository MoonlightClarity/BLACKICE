import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { ChatGPTConnector } from '../lib/chatgpt-connector.mjs';
import { DirectExecutionAPI, DIRECT_EXECUTION_SCOPES } from '../lib/direct-execution-api.mjs';
import { ChatGPTPlanningAPI } from '../lib/chatgpt-planning.mjs';
import { chatGPTFileImportTool } from '../lib/chatgpt-file-import.mjs';
import { desktopRestartTool } from '../lib/desktop-restart-tool.mjs';
import { createDirectBrowserCredentialTools } from '../lib/browser-credential-tools.mjs';
import { createDirectConnectedBrowserTools, createDirectBrowserProfileTools } from '../lib/connected-browser-tools.mjs';

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

test('a pending native restart keeps authenticated receipt reads and cancellation available without admitting new work', async t => {
  const { connector, execution, setClient, setClosing, calls } = await fixture(t);
  const definitions = new DirectExecutionAPI({ dataDir: path.dirname(connector.file) });
  execution.tools = () => definitions.tools();
  const original = JSON.stringify((await post(connector, rpc('tools/list'))).json().result.tools);
  const fingerprint = connector.catalogStatus();
  let pending = true; connector.isRestartPending = () => pending; setClosing(true);
  assert.equal(JSON.stringify((await post(connector, rpc('tools/list'))).json().result.tools), original);
  assert.deepEqual(connector.catalogStatus(), fingerprint);
  const controls = ['blackice_direct_status', 'blackice_get_job', 'blackice_list_jobs', 'blackice_cancel_job'];
  for (const name of controls) {
    const missing = (await post(connector, rpc('tools/call', { name, arguments: {} }))).json().result;
    assert.equal(missing.isError, true); assert.ok(missing._meta['mcp/www_authenticate']);
  }
  assert.deepEqual(calls, []);
  setClient({ id: 'pending-restart-owner', scopes: [...DIRECT_EXECUTION_SCOPES] });
  for (const name of controls) {
    const response = await post(connector, rpc('tools/call', { name, arguments: { jobId: 'owned-job' } }));
    assert.equal(response.statusCode, 200); assert.equal(response.json().result.isError, false, name);
  }
  assert.deepEqual(calls.map(call => call.name), controls);
  const mutation = await post(connector, rpc('tools/call', { name: 'blackice_run_command', arguments: { requestId: 'blocked-command', command: 'must not execute' } }));
  assert.equal(mutation.statusCode, 503); assert.equal(calls.length, controls.length);
  setClient(null);
  const expired = await post(connector, rpc('tools/call', { name: 'blackice_cancel_job', arguments: { jobId: 'owned-job' } }), { authorization: 'Bearer expired-fixture-token' });
  assert.equal(expired.statusCode, 401); assert.equal(calls.length, controls.length);
  setClient({ id: 'pending-restart-owner', scopes: [...DIRECT_EXECUTION_SCOPES] });
  pending = false;
  for (const name of controls) assert.equal((await post(connector, rpc('tools/call', { name, arguments: {} }))).statusCode, 503);
  assert.equal(calls.length, controls.length); assert.deepEqual(connector.catalogStatus(), fingerprint);
});

test('every advertised definition mirrors OAuth metadata without changing scopes, annotations or catalog stability', async t => {
  const { connector, execution, calls } = await fixture(t);
  const unavailable = () => assert.fail('Catalog inspection must not execute an adapter.');
  const definitions = new DirectExecutionAPI({ dataDir: path.dirname(connector.file), additionalTools: [
    chatGPTFileImportTool({ directory: path.join(path.dirname(connector.file), 'unused-imports') }),
    ...createDirectConnectedBrowserTools({ manager: {}, connectChrome: unavailable }),
    ...createDirectBrowserProfileTools({ profiles: {}, manager: {} }),
    desktopRestartTool({ restart: { request: unavailable }, getJob: unavailable }),
    ...createDirectBrowserCredentialTools({ vault: {}, browser: {}, reauthorize: unavailable }),
  ] });
  definitions.definitions.get('blackice_run_command')._meta = { 'fixture/preserved': 'existing metadata' };
  execution.tools = () => definitions.tools(); connector.planning = new ChatGPTPlanningAPI({});
  const source = [...execution.tools(), ...connector.planning.tools()];
  const advertised = (await post(connector, rpc('tools/list'))).json().result.tools;
  assert.equal(advertised.length, source.length);
  for (const [index, tool] of advertised.entries()) {
    const { scope, requiredScope, requiredScopes, scopes, ...definition } = source[index];
    const expected = [{ type: 'oauth2', scopes: [...new Set(['read', ...(requiredScopes || scopes || [scope || requiredScope || 'read'])])] }];
    assert.deepEqual(tool.securitySchemes, expected, tool.name);
    assert.deepEqual(tool._meta.securitySchemes, expected, tool.name);
    assert.deepEqual(tool.annotations, definition.annotations, tool.name);
    assert.deepEqual(tool.inputSchema, definition.inputSchema, tool.name);
    for (const [key, value] of Object.entries(definition._meta || {})) assert.deepEqual(tool._meta[key], value, tool.name);
    assert.equal(tool._meta['openai/toolInvocation/invoking'], 'Contacting BLACKICE');
    assert.equal(tool._meta['openai/toolInvocation/invoked'], 'Action status received');
  }
  const serialized = JSON.stringify(advertised), fingerprint = connector.catalogStatus();
  for (let i = 0; i < 3; i++) { assert.equal(JSON.stringify(connector.tools()), serialized); assert.deepEqual(connector.catalogStatus(), fingerprint); }
  advertised[0]._meta.securitySchemes[0].scopes.push('caller-mutation');
  assert.deepEqual(advertised[0].securitySchemes, [{ type: 'oauth2', scopes: ['read'] }]);
  assert.equal(JSON.stringify(connector.tools()), serialized); assert.deepEqual(connector.catalogStatus(), fingerprint);
  assert.deepEqual(calls, []);
});

test('restart guidance describes force only when the discovered tool supports it', async t => {
  const { connector } = await fixture(t);
  const definition = desktopRestartTool({ restart: { request() {} }, getJob() {} }).definition;
  const withForce = connector.instructions({ get: name => name === 'blackice_restart' ? { definition } : undefined });
  assert.match(withForce, /force: true only when the user explicitly requests a forced restart/);
  assert.match(withForce, /pauses automatic queues and stops cancellable work/);
  assert.match(withForce, /different intents and need different request IDs/);
  const legacy = structuredClone(definition); delete legacy.inputSchema.properties.force;
  assert.doesNotMatch(connector.instructions({ get: () => ({ definition: legacy }) }), /force: true/);
  assert.doesNotMatch(connector.instructions({ get: () => undefined }), /force: true/);
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

test('the actual direct/planning catalog is stable across nonce probes, status, auth challenges and refreshed credentials', async t => {
  const { connector, execution, setClient, calls } = await fixture(t);
  // Real public definitions with a transport-only executor: no native action,
  // command, browser, credential store or remote service is accessed.
  const definitions = new DirectExecutionAPI({ dataDir: path.dirname(connector.file) });
  execution.tools = () => definitions.tools(); connector.planning = new ChatGPTPlanningAPI({});
  const list = async headers => (await post(connector, rpc('tools/list'), headers)).json().result.tools;
  const original = await list(), serialized = JSON.stringify(original);
  const expected = { sha256: createHash('sha256').update(serialized).digest('hex'), toolCount: original.length, serverVersion: '2.33.0' };
  const sameGrant = { id: 'stable-fixture-grant', scopes: [...DIRECT_EXECUTION_SCOPES] };
  for (const nonce of ['first-fixture-probe', 'second-fixture-probe']) {
    setClient(sameGrant);
    const result = (await post(connector, rpc('tools/call', { name: 'blackice_direct_status', arguments: { nonce } }), { authorization: 'Bearer valid-fixture-credential' })).json().result;
    assert.equal(result.isError, false); assert.equal(result.structuredContent.nonce, nonce);
    assert.deepEqual(result.structuredContent.toolCatalog, expected);
    assert.deepEqual((await connector.status()).toolCatalog, expected);
    assert.equal(JSON.stringify(await list()), serialized);
  }
  const beforeChallenge = calls.length;
  setClient(null);
  assert.equal((await post(connector, rpc('tools/call', { name: 'blackice_direct_status' }), { authorization: 'Bearer expired-fixture-credential' })).statusCode, 401);
  setClient({ ...sameGrant, scopes: ['read'] });
  const missingScope = (await post(connector, rpc('tools/call', { name: 'blackice_browser_upload', arguments: {} }))).json().result;
  assert.equal(missingScope.isError, true); assert.ok(missingScope._meta['mcp/www_authenticate']);
  assert.equal(calls.length, beforeChallenge, 'diagnostics do not admit unauthorized work');
  assert.equal(JSON.stringify(await list()), serialized, 'the public catalog does not shrink with a grant');
  setClient(sameGrant);
  const refreshed = (await post(connector, rpc('tools/call', { name: 'blackice_direct_status', arguments: { nonce: 'after-fixture-refresh' } }), { authorization: 'Bearer refreshed-fixture-credential' })).json().result;
  assert.deepEqual(refreshed.structuredContent.toolCatalog, expected);
  original[0].description = 'caller mutation'; original[0].securitySchemes[0].scopes.push('invented');
  assert.equal(JSON.stringify(await list()), serialized, 'returned catalog objects cannot mutate later advertisements');
  assert.deepEqual(connector.catalogStatus(), expected);
});

test('catalog diagnostics detect an actual definition change without changing tool annotations or scopes', async t => {
  const { connector, execution } = await fixture(t);
  const definitions = new DirectExecutionAPI({ dataDir: path.dirname(connector.file) });
  execution.tools = () => definitions.tools();
  const first = connector.catalogStatus();
  const command = definitions.definitions.get('blackice_run_command');
  assert.deepEqual(command.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true });
  assert.deepEqual(command.requiredScopes, ['commands:run']);
  command.description += ' Fixture catalog revision.';
  const second = connector.catalogStatus();
  assert.notEqual(second.sha256, first.sha256); assert.equal(second.toolCount, first.toolCount);
  const advertised = connector.tools().find(tool => tool.name === 'blackice_run_command');
  assert.deepEqual(advertised.annotations, command.annotations);
  assert.deepEqual(advertised.securitySchemes, [{ type: 'oauth2', scopes: ['read', 'commands:run'] }]);
  assert.equal(Object.hasOwn(advertised, 'toolCatalog'), false, 'the diagnostic fingerprint is never added to public definitions');
});

test('invalid supplied bearer credentials receive HTTP 401 without invoking linking UI or admitting an action', async t => {
  const { connector, calls, setClient } = await fixture(t);
  const secret = 'blackice_at_' + 'fixture_invalid_credential'.padEnd(43, 'x');
  const response = await post(connector, rpc('tools/call', { name: 'blackice_direct_status', arguments: { nonce: 'private-fixture-argument' } }), { authorization: 'Bearer ' + secret });
  assert.equal(response.statusCode, 401); assert.match(response.headers['www-authenticate'], /error="invalid_token"/); assert.match(response.headers['www-authenticate'], /resource_metadata=/);
  assert.equal(response.json().code, 'CHATGPT_AUTH_REQUIRED'); assert.equal(response.json().result, undefined); assert.deepEqual(calls, []);
  const status = await connector.status();
  assert.equal(status.authDiagnostics.invalidBearerChallenges, 1); assert.equal(status.authDiagnostics.linkingChallenges, 0);
  assert.deepEqual(Object.keys(status.authDiagnostics.lastChallenge).sort(), ['at', 'kind', 'method', 'statusCode', 'tool']);
  assert.equal(status.authDiagnostics.lastChallenge.tool, 'blackice_direct_status');
  assert.ok(!JSON.stringify(status).includes(secret)); assert.ok(!JSON.stringify(status).includes('private-fixture-argument'));
  status.authDiagnostics.lastChallenge.kind = 'caller-mutation'; assert.equal((await connector.status()).authDiagnostics.lastChallenge.kind, 'invalidBearerChallenges');
  setClient({ id: 'same-grant', scopes: ['read'] });
  const refreshed = await post(connector, rpc('tools/call', { name: 'blackice_direct_status', arguments: { nonce: 'after-refresh' } }), { authorization: 'Bearer replacement-fixture' });
  assert.equal(refreshed.statusCode, 200); assert.equal(refreshed.json().result.isError, false); assert.equal(calls.length, 1); assert.equal(calls[0].client.id, 'same-grant');
});

test('revocation between authentication and admission gets an HTTP challenge without executing', async t => {
  const { connector, oauth, setClient, calls } = await fixture(t);
  setClient({ id: 'fixture-revoked-grant', scopes: ['read'] });
  oauth.getClient = () => null;
  const response = await post(connector, rpc('tools/call', { name: 'blackice_direct_status' }), { authorization: 'Bearer fixture' });
  assert.equal(response.statusCode, 401); assert.equal(response.json().code, 'CHATGPT_ACCESS_REVOKED'); assert.match(response.headers['www-authenticate'], /invalid_token/); assert.deepEqual(calls, []);
  assert.equal((await connector.status()).authDiagnostics.authorizationLostChallenges, 1);
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
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, current ? 'CHATGPT_SCOPE_REQUIRED' : 'CHATGPT_ACCESS_REVOKED');
    assert.ok(result._meta['mcp/www_authenticate']);
  }
  assert.deepEqual(calls, []);
});

test('a valid grant narrowed before dispatch requests the missing scope without invalidating its bearer credential', async t => {
  const { connector, oauth, setClient, calls } = await fixture(t);
  setClient({ id: 'same-grant', scopes: ['read', 'browser:write', 'files:read'] });
  oauth.getClient = async () => ({ id: 'same-grant', scopes: ['read'] });
  oauth.challenge = (scopes, error) => 'Bearer error="' + error + '", scope="' + scopes.join(' ') + '"';
  const response = await post(connector, rpc('tools/call', { name: 'blackice_browser_upload', arguments: {} }), {
    authorization: 'Bearer valid-before-and-after-scope-change',
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['www-authenticate'], undefined);
  const result = response.json().result;
  assert.equal(result.structuredContent.code, 'CHATGPT_SCOPE_REQUIRED');
  assert.match(result._meta['mcp/www_authenticate'][0], /error="insufficient_scope"/);
  assert.deepEqual(calls, []);
  const status = connector.authStatus();
  assert.equal(status.scopeChallenges, 1);
  assert.equal(status.invalidBearerChallenges, 0);
  assert.equal(status.authorizationLostChallenges, 0);
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

test('an action or upstream HTTP permission error does not ask ChatGPT to reconnect BLACKICE', async t => {
  const { connector, execution, setClient } = await fixture(t);
  setClient({ id: 'still-authorized-grant', scopes: ['read'] });
  for (const status of [401, 403]) {
    execution.call = async () => {
      throw Object.assign(Error('The destination website requires its own sign-in.'), {
        status, code: 'DESTINATION_HTTP_ERROR',
      });
    };
    const response = await post(connector, rpc('tools/call', { name: 'blackice_direct_status' }), {
      authorization: 'Bearer still-valid-fixture',
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['www-authenticate'], undefined);
    const result = response.json().result;
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, 'DESTINATION_HTTP_ERROR');
    assert.equal(result._meta?.['mcp/www_authenticate'], undefined);
  }
  const status = await connector.status();
  assert.deepEqual(status.authDiagnostics, {
    invalidBearerChallenges: 0, linkingChallenges: 0, scopeChallenges: 0,
    authorizationLostChallenges: 0, lastChallenge: null,
  });
});

test('direct status exposes sanitized integration diagnostics without changing the advertised catalog', async t => {
  const { connector, setClient } = await fixture(t);
  const catalog = connector.catalogStatus();
  setClient({ id: 'existing-grant', scopes: ['read'] });
  const response = await post(connector, rpc('tools/call', {
    name: 'blackice_direct_status', arguments: { nonce: 'rebuild-status' },
  }), { authorization: 'Bearer private-fixture-value' });
  const result = response.json().result.structuredContent;
  assert.equal(result.integration.implementation, 'direct-connector-v2');
  assert.equal(result.integration.localMutationApproval, false);
  assert.deepEqual(result.toolCatalog, catalog);
  assert.equal(result.authDiagnostics.lastChallenge, null);
  assert.ok(!JSON.stringify(result).includes('private-fixture-value'));
  result.authDiagnostics.linkingChallenges = 100;
  assert.equal(connector.authStatus().linkingChallenges, 0);
  assert.deepEqual(connector.catalogStatus(), catalog);
});

test('a stalled optional setup observer does not delay delivery of a completed action', { timeout: 2000 }, async t => {
  const { connector, setClient } = await fixture(t);
  setClient({ id: 'existing-grant', scopes: ['read'] });
  let release, observed = false;
  const observer = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  connector.onAuthenticatedToolCall = async () => { observed = true; await observer; };
  const response = await post(connector, rpc('tools/call', {
    name: 'blackice_direct_status', arguments: { nonce: 'delivered-before-observer' },
  }));
  assert.equal(observed, true);
  assert.equal(response.json().result.isError, false);
  assert.equal(response.json().result.structuredContent.nonce, 'delivered-before-observer');
  await connector.close();
  release();
});
