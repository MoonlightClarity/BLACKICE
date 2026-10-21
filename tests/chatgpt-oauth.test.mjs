import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { ChatGPTOAuth, CHATGPT_OAUTH_CLIENT_ID as CLIENT, CHATGPT_OAUTH_REDIRECT as REDIRECT, CHATGPT_OAUTH_SCOPES as SCOPES } from '../lib/chatgpt-oauth.mjs';

const ORIGIN = 'https://owned.example';
const RESOURCE = ORIGIN + '/mcp/chatgpt';
const VERIFIER = 'a'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const metadata = (overrides = {}) => ({ client_id: CLIENT, client_name: 'ChatGPT', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'private_key_jwt', token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'], jwks_uri: 'https://chatgpt.com/oauth/jwks.json', response_types: ['code'], grant_types: ['authorization_code', 'refresh_token'], ...overrides });
const response = (value = metadata(), headers = {}) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json', ...headers } });
const authorization = (overrides = {}) => ({ response_type: 'code', client_id: CLIENT, redirect_uri: REDIRECT, code_challenge: CHALLENGE, code_challenge_method: 'S256', resource: RESOURCE, scope: 'read', state: 'owned-state-123', ...overrides });
const bearer = token => ({ headers: { authorization: `Bearer ${token}` }, rawHeaders: ['Authorization', `Bearer ${token}`] });

async function setup(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-oauth-'));
  let clock = Date.UTC(2026, 9, 20); const calls = [], revoked = [];
  const oauth = new ChatGPTOAuth({ dataDir, origin: ORIGIN, now: () => clock, fetcher: async (url, request) => { calls.push({ url, request }); return options.fetcher ? options.fetcher(url, request) : response(); }, onRevoked: ids => revoked.push(...ids) });
  await oauth.init();
  t.after(async () => { await oauth.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { oauth, dataDir, calls, revoked, advance: ms => { clock += ms; }, now: () => clock };
}

async function route(oauth, method, url, { form, raw, headers = {}, enabled = true } = {}) {
  const body = raw !== undefined ? raw : form ? new URLSearchParams(form).toString() : '';
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  req.method = method; req.url = url; req.headers = { ...(form || raw !== undefined ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...headers };
  req.rawHeaders = Object.entries(req.headers).flat();
  const result = { status: null, headers: {}, body: '' };
  const res = { destroyed: false, writeHead(status, values) { result.status = status; for (const [key, value] of Object.entries(values || {})) result.headers[key.toLowerCase()] = value; }, setHeader(key, value) { result.headers[key.toLowerCase()] = value; }, end(value = '') { result.body += value; } };
  await oauth.handle(req, res, { enabled });
  if (String(result.headers['content-type']).startsWith('application/json')) result.json = JSON.parse(result.body);
  return result;
}
async function begin(oauth, overrides = {}) {
  const result = await route(oauth, 'GET', '/chatgpt/oauth/authorize?' + new URLSearchParams(authorization(overrides)));
  assert.equal(result.status, 200, result.body);
  const id = result.body.match(/data-request="([a-f0-9-]+)"/)[1];
  const cookie = [].concat(result.headers['set-cookie']).find(value => value.startsWith(oauth.cookieName(id) + '=') && !value.includes('Max-Age=0')).split(';')[0];
  return { id, cookie, result };
}
async function approveAndCode(oauth, options = {}) {
  const request = await begin(oauth, { scope: options.requestedScopes || 'read', ...options.authorization });
  await oauth.approve(request.id, options.scopes ? { scopes: options.scopes } : {});
  const poll = await route(oauth, 'GET', '/chatgpt/oauth/pending/' + request.id, { headers: { cookie: request.cookie } });
  assert.equal(poll.status, 200, poll.body);
  const callback = new URL(poll.json.redirect);
  assert.equal(callback.origin + callback.pathname, REDIRECT);
  assert.equal(callback.searchParams.get('iss'), ORIGIN);
  const code = callback.searchParams.get('code'); assert.ok(code);
  return { ...request, callback, code };
}
function exchange(oauth, code, overrides = {}) {
  return route(oauth, 'POST', '/chatgpt/oauth/token', { form: { grant_type: 'authorization_code', client_id: CLIENT, code, code_verifier: VERIFIER, redirect_uri: REDIRECT, resource: RESOURCE, ...overrides } });
}
async function grant(oauth, options = {}) {
  const issued = await approveAndCode(oauth, options), exchanged = await exchange(oauth, issued.code);
  assert.equal(exchanged.status, 200, exchanged.body);
  const client = await oauth.authenticateRequest(bearer(exchanged.json.access_token));
  assert.ok(client);
  return { ...issued, tokens: exchanged.json, client };
}
function refresh(oauth, token, overrides = {}) { return route(oauth, 'POST', '/chatgpt/oauth/token', { form: { grant_type: 'refresh_token', client_id: CLIENT, refresh_token: token, resource: RESOURCE, ...overrides } }); }

test('metadata binds the exact resource, issuer, S256 and current public CIMD client', async t => {
  const { oauth, calls } = await setup(t);
  for (const url of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp/chatgpt']) {
    const result = await route(oauth, 'GET', url, { enabled: false });
    assert.equal(result.status, 200); assert.equal(result.json.resource, RESOURCE); assert.deepEqual(result.json.authorization_servers, [ORIGIN]); assert.deepEqual(result.json.scopes_supported, SCOPES);
  }
  const result = await route(oauth, 'GET', '/.well-known/oauth-authorization-server');
  assert.equal(result.json.issuer, ORIGIN); assert.equal(result.json.authorization_endpoint, ORIGIN + '/chatgpt/oauth/authorize');
  assert.deepEqual(result.json.code_challenge_methods_supported, ['S256']); assert.deepEqual(result.json.token_endpoint_auth_methods_supported, ['none']);
  assert.equal(result.json.authorization_response_iss_parameter_supported, true); assert.equal(result.json.client_id_metadata_document_supported, true); assert.equal(result.json.registration_endpoint, undefined);
  assert.equal(calls.length, 0); assert.deepEqual(oauth.status().defaultScopes, ['read']);
  assert.match(oauth.challenge(['commands:run']), /scope="read commands:run"/);
  assert.match(oauth.challenge(), /error="invalid_token", error_description="Connect or reconnect BLACKICE to continue\."/);
  assert.match(oauth.challenge(['files:read'], 'insufficient_scope'), /error="insufficient_scope", error_description="Reconnect BLACKICE and approve the requested permissions to continue\."/);
  assert.match(oauth.challenge([], 'untrusted\r\nvalue'), /error="invalid_token"/);
  assert.doesNotMatch(oauth.challenge([], 'untrusted\r\nvalue'), /[\r\n]/);
  assert.throws(() => oauth.setOrigin('http://owned.example')); assert.throws(() => oauth.setOrigin(ORIGIN + '/'));
});

test('untrusted client URLs and redirects are rejected before any metadata fetch', async t => {
  const { oauth, calls } = await setup(t);
  for (const fields of [{ client_id: 'http://127.0.0.1/private' }, { client_id: 'https://chatgpt.com/oauth/legacy/client.json' }, { client_id: CLIENT + '?x=1' }, { redirect_uri: REDIRECT + '/extra' }, { redirect_uri: 'https://attacker.example/callback' }]) {
    const result = await route(oauth, 'GET', '/chatgpt/oauth/authorize?' + new URLSearchParams(authorization(fields)));
    assert.equal(result.status, 400); assert.equal(result.json.error, 'invalid_client'); assert.equal(result.headers.location, undefined);
  }
  assert.equal(calls.length, 0); assert.equal(oauth.pending().length, 0);
});

test('CIMD fetch is pinned, credential-free, redirect-free and strictly verified', async t => {
  const { oauth, calls } = await setup(t);
  await begin(oauth);
  assert.equal(calls.length, 1); assert.equal(calls[0].url, CLIENT); assert.equal(calls[0].request.redirect, 'error'); assert.equal(calls[0].request.credentials, 'omit'); assert.ok(calls[0].request.signal);
  for (const invalid of [metadata({ client_id: 'https://attacker.example/client.json' }), metadata({ redirect_uris: ['https://attacker.example/callback'] }), metadata({ token_endpoint_auth_methods_supported: ['private_key_jwt'] }), metadata({ token_endpoint_auth_methods_supported: ['none', 42] }), metadata({ token_endpoint_auth_methods_supported: null, token_endpoint_auth_method: 'none' })]) {
    oauth.clientCache = null; oauth.fetcher = async () => response(invalid);
    const result = await route(oauth, 'GET', '/chatgpt/oauth/authorize?' + new URLSearchParams(authorization()));
    assert.equal(result.status, 400); assert.equal(result.json.error, 'invalid_client'); assert.equal(result.headers.location, undefined);
  }
  oauth.fetcher = async () => new Response('x'.repeat(32769), { headers: { 'Content-Type': 'application/json' } });
  assert.equal((await route(oauth, 'GET', '/chatgpt/oauth/authorize?' + new URLSearchParams(authorization()))).json.error, 'invalid_client');
});

test('CIMD method intersection supports actual plural metadata and legacy none-only clients', async t => {
  const { oauth, calls } = await setup(t);
  await begin(oauth); assert.equal(calls.length, 1); assert.deepEqual(oauth.metadata('/.well-known/oauth-authorization-server').token_endpoint_auth_methods_supported, ['none']);
  oauth.clientCache = null; oauth.fetcher = async () => response(metadata({ token_endpoint_auth_methods_supported: undefined, token_endpoint_auth_method: 'none' }));
  await begin(oauth, { state: 'legacy-none' });
  oauth.clientCache = null; oauth.fetcher = async () => response(metadata({ token_endpoint_auth_methods_supported: undefined }));
  const noIntersection = await route(oauth, 'GET', '/chatgpt/oauth/authorize?' + new URLSearchParams(authorization({ state: 'private-only' })));
  assert.equal(noIntersection.json.error, 'invalid_client');
  assert.equal((await route(oauth, 'POST', '/chatgpt/oauth/token', { form: { grant_type: 'authorization_code', client_id: CLIENT, client_assertion: 'not-advertised', code: 'unused' } })).json.error, 'invalid_client');
});

test('owner approval defaults to read and callback carries exact state and issuer', async t => {
  const { oauth, dataDir } = await setup(t);
  const value = await grant(oauth, { requestedScopes: 'read files:read commands:run' });
  assert.deepEqual(value.client.scopes, ['read']); assert.equal(value.tokens.scope, 'read');
  assert.equal(value.callback.searchParams.get('state'), 'owned-state-123'); assert.equal(value.callback.searchParams.get('iss'), ORIGIN);
  assert.match(value.result.headers['set-cookie'], /Secure; HttpOnly; SameSite=Strict/);
  assert.match(value.result.headers['content-security-policy'], /script-src 'self'/); assert.doesNotMatch(value.result.body, /<script[^>]*>[^<]/);
  assert.ok(value.result.body.includes('/chatgpt/oauth/consent.js')); assert.ok(!value.result.body.includes(value.cookie.split('=')[1]));
  const disk = await fs.readFile(path.join(dataDir, 'chatgpt-oauth.json'), 'utf8');
  for (const secret of [value.tokens.access_token, value.tokens.refresh_token, value.code, value.cookie.split('=')[1]]) assert.ok(!disk.includes(secret));
  assert.ok(!disk.includes('owned-state-123')); assert.match(disk, /"hash": "[a-f0-9]{64}"/);
  assert.deepEqual(oauth.status().grants[0].scopes, ['read']);
  const script = await route(oauth, 'GET', '/chatgpt/oauth/consent.js'); assert.match(script.body, /location\.replace/); assert.match(script.body, /credentials:'same-origin'/);
});

test('owner may approve only requested known scopes and snapshots cannot enlarge a grant', async t => {
  const { oauth } = await setup(t);
  const request = await begin(oauth, { scope: 'read files:read commands:run' });
  await assert.rejects(oauth.approve(request.id, { scopes: ['read', 'files:write'] }), /requested BLACKICE permissions/);
  await assert.rejects(oauth.approve(request.id, { scopes: ['commands:run'] }), /including read/);
  await oauth.approve(request.id, { scopes: ['read', 'commands:run'] });
  const poll = await route(oauth, 'GET', '/chatgpt/oauth/pending/' + request.id, { headers: { cookie: request.cookie } });
  const tokens = (await exchange(oauth, new URL(poll.json.redirect).searchParams.get('code'))).json;
  const client = await oauth.authenticateRequest(bearer(tokens.access_token)); assert.deepEqual(client.scopes, ['read', 'commands:run']);
  client.scopes.push('files:write'); assert.equal(oauth.isAuthorized(client, { requiredScopes: ['files:write'] }), false);
});

test('request IDs do not authorize polling; browser nonce and same origin are required', async t => {
  const { oauth } = await setup(t); const request = await begin(oauth); await oauth.approve(request.id);
  for (const headers of [{}, { cookie: request.cookie.replace(/.$/, 'x') }, { cookie: request.cookie + '; ' + request.cookie }, { cookie: request.cookie, origin: 'https://attacker.example' }]) {
    const result = await route(oauth, 'GET', '/chatgpt/oauth/pending/' + request.id, { headers }); assert.equal(result.status, 403); assert.equal(result.json.redirect, undefined);
  }
  const good = await route(oauth, 'GET', '/chatgpt/oauth/pending/' + request.id, { headers: { cookie: request.cookie, origin: ORIGIN } }); assert.ok(good.json.redirect);
  const again = await route(oauth, 'GET', '/chatgpt/oauth/pending/' + request.id, { headers: { cookie: request.cookie } }); assert.equal(again.json.redirect, good.json.redirect);
});

test('local rejection automatically returns an issuer-bound error and has no public approval route', async t => {
  const { oauth } = await setup(t); const request = await begin(oauth); await oauth.reject(request.id);
  const result = await route(oauth, 'GET', '/chatgpt/oauth/pending/' + request.id, { headers: { cookie: request.cookie } });
  const callback = new URL(result.json.redirect); assert.equal(callback.origin + callback.pathname, REDIRECT); assert.equal(callback.searchParams.get('error'), 'access_denied'); assert.equal(callback.searchParams.get('iss'), ORIGIN); assert.equal(callback.searchParams.get('state'), 'owned-state-123');
  assert.equal((await route(oauth, 'POST', '/chatgpt/oauth/approve', { form: { requestId: request.id, scope: 'commands:run' } })).status, 404);
  assert.deepEqual(oauth.status().grants, []);
});

test('validated authorization errors include issuer; PKCE and exact resource are mandatory', async t => {
  const { oauth } = await setup(t);
  for (const fields of [{ code_challenge_method: 'plain' }, { code_challenge: 'short' }, { resource: ORIGIN + '/mcp' }, { scope: 'read admin' }, { response_type: 'token' }, { state: '' }]) {
    const result = await route(oauth, 'GET', '/chatgpt/oauth/authorize?' + new URLSearchParams(authorization(fields)));
    assert.equal(result.status, 302); const callback = new URL(result.headers.location); assert.equal(callback.searchParams.get('iss'), ORIGIN); assert.ok(callback.searchParams.get('error'));
  }
  assert.equal(oauth.pending().length, 0);
});

test('wrong verifier, redirect and resource do not exchange or consume the code', async t => {
  const { oauth } = await setup(t); const issued = await approveAndCode(oauth);
  for (const change of [{ code_verifier: 'b'.repeat(64) }, { redirect_uri: REDIRECT + '?extra=1' }, { resource: 'https://other.example/mcp/chatgpt' }, { client_id: 'https://other.example/client.json' }]) assert.equal((await exchange(oauth, issued.code, change)).status, 400);
  assert.equal(oauth.status().grants.length, 0);
  assert.equal((await exchange(oauth, issued.code)).status, 200);
});

test('authorization-code replay revokes the issued grant instead of minting another', async t => {
  const { oauth, revoked } = await setup(t); const value = await grant(oauth);
  const replay = await exchange(oauth, value.code); assert.equal(replay.status, 400); assert.equal(replay.json.error, 'invalid_grant');
  assert.equal(await oauth.authenticateRequest(bearer(value.tokens.access_token)), null); assert.ok(revoked.includes(value.client.id)); assert.equal(oauth.status().grants.length, 0);
});

test('reloading authorization after exchange starts a new owner decision and preserves the live grant', async t => {
  const { oauth, revoked } = await setup(t), original = await grant(oauth);
  const reload = await route(oauth, 'GET', '/chatgpt/oauth/authorize?' + new URLSearchParams(authorization()), { headers: { cookie: original.cookie } });
  assert.equal(reload.status, 200);
  const id = reload.body.match(/data-request="([a-f0-9-]+)"/)[1]; assert.notEqual(id, original.id);
  const cookie = [].concat(reload.headers['set-cookie']).find(value => value.startsWith(oauth.cookieName(id) + '=') && !value.includes('Max-Age=0')).split(';')[0];
  let poll = await route(oauth, 'GET', '/chatgpt/oauth/pending/' + id, { headers: { cookie } });
  assert.deepEqual(poll.json, { status: 'pending', expiresAt: null }); assert.equal(oauth.status().grants.length, 1);
  assert.equal((await oauth.authenticateRequest(bearer(original.tokens.access_token))).id, original.client.id); assert.deepEqual(revoked, []);
  await oauth.approve(id);
  poll = await route(oauth, 'GET', '/chatgpt/oauth/pending/' + id, { headers: { cookie } });
  const code = new URL(poll.json.redirect).searchParams.get('code'); assert.notEqual(code, original.code);
  const exchanged = await exchange(oauth, code); assert.equal(exchanged.status, 200);
  assert.ok(await oauth.authenticateRequest(bearer(exchanged.json.access_token))); assert.ok(await oauth.authenticateRequest(bearer(original.tokens.access_token))); assert.deepEqual(revoked, []);
});

test('reloading approved authorization before exchange retains its original usable code', async t => {
  const { oauth } = await setup(t), issued = await approveAndCode(oauth);
  const reload = await route(oauth, 'GET', '/chatgpt/oauth/authorize?' + new URLSearchParams(authorization()), { headers: { cookie: issued.cookie } });
  assert.equal(reload.status, 200); assert.match(reload.body, new RegExp(issued.id)); assert.equal(reload.headers['set-cookie'], undefined);
  const poll = await route(oauth, 'GET', '/chatgpt/oauth/pending/' + issued.id, { headers: { cookie: issued.cookie } });
  assert.equal(new URL(poll.json.redirect).searchParams.get('code'), issued.code); assert.equal((await exchange(oauth, issued.code)).status, 200);
});

test('refresh rotates credentials and replay revokes the whole family durably', async t => {
  const { oauth, dataDir, revoked } = await setup(t); const value = await grant(oauth);
  const renewed = await refresh(oauth, value.tokens.refresh_token); assert.equal(renewed.status, 200);
  assert.notEqual(renewed.json.refresh_token, value.tokens.refresh_token); assert.notEqual(renewed.json.access_token, value.tokens.access_token);
  const refreshedClient = await oauth.authenticateRequest(bearer(renewed.json.access_token));
  assert.equal(refreshedClient.id, value.client.id); assert.deepEqual(refreshedClient.scopes, value.client.scopes);
  const disk = await fs.readFile(path.join(dataDir, 'chatgpt-oauth.json'), 'utf8'); assert.ok(!disk.includes(value.tokens.refresh_token)); assert.ok(!disk.includes(renewed.json.refresh_token));
  const replay = await refresh(oauth, value.tokens.refresh_token); assert.equal(replay.json.error, 'invalid_grant');
  assert.equal(await oauth.authenticateRequest(bearer(renewed.json.access_token)), null); assert.equal(await oauth.authenticateRequest(bearer(value.tokens.access_token)), null); assert.ok(revoked.includes(value.client.id));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, 'chatgpt-oauth.json'), 'utf8')).grants, []);
});

test('concurrent refresh cannot leave two live token families', async t => {
  const { oauth } = await setup(t); const value = await grant(oauth);
  const results = await Promise.all([refresh(oauth, value.tokens.refresh_token), refresh(oauth, value.tokens.refresh_token)]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 400]);
  assert.equal(oauth.getClient(value.client.id), null); assert.equal(await oauth.authenticateRequest(bearer(results.find(result => result.status === 200).json.access_token)), null);
});

test('refresh can attenuate permissions but never enlarge them or change resource', async t => {
  const { oauth } = await setup(t); const value = await grant(oauth, { requestedScopes: 'read commands:run', scopes: ['read', 'commands:run'] });
  assert.equal((await refresh(oauth, value.tokens.refresh_token, { scope: 'read files:write' })).json.error, 'invalid_scope');
  assert.equal((await refresh(oauth, value.tokens.refresh_token, { resource: 'https://other.example/mcp/chatgpt' })).json.error, 'invalid_target');
  const result = await refresh(oauth, value.tokens.refresh_token, { scope: 'read' }); assert.equal(result.status, 200); assert.equal(result.json.scope, 'read');
  assert.equal(oauth.isAuthorized(value.client, { requiredScopes: ['commands:run'] }), false); assert.deepEqual((await oauth.authenticateRequest(bearer(value.tokens.access_token))).scopes, ['read']);
});

test('access expiry and absolute grant expiry fail closed', async t => {
  const { oauth, advance } = await setup(t); const value = await grant(oauth);
  advance(15 * 60000 + 1); assert.equal(await oauth.authenticateRequest(bearer(value.tokens.access_token)), null);
  const renewed = await refresh(oauth, value.tokens.refresh_token); assert.equal(renewed.status, 200);
  advance(30 * 86400000); assert.equal(oauth.getClient(value.client.id), null); assert.equal((await refresh(oauth, renewed.json.refresh_token)).json.error, 'invalid_grant');
});

test('ordinary restart retains hashed grants while local revocation persists', async t => {
  const env = await setup(t), value = await grant(env.oauth); await env.oauth.close();
  assert.equal(env.oauth.getClient(value.client.id), null); assert.deepEqual(env.revoked, []);
  const reopened = await new ChatGPTOAuth({ dataDir: env.dataDir, origin: ORIGIN, now: env.now }).init();
  t.after(() => reopened.close()); assert.equal((await reopened.authenticateRequest(bearer(value.tokens.access_token))).id, value.client.id);
  await reopened.revoke(value.client.id); await reopened.close();
  const final = await new ChatGPTOAuth({ dataDir: env.dataDir, origin: ORIGIN, now: env.now }).init();
  t.after(() => final.close()); assert.equal(await final.authenticateRequest(bearer(value.tokens.access_token)), null); assert.equal(final.status().grants.length, 0);
});

test('malformed persisted state stays untouched and disables all authorization', async t => {
  const { oauth, dataDir } = await setup(t); await oauth.close();
  const file = path.join(dataDir, 'chatgpt-oauth.json'), original = '{broken-but-preserved'; await fs.writeFile(file, original);
  const broken = await new ChatGPTOAuth({ dataDir, origin: ORIGIN }).init(); t.after(() => broken.close());
  assert.equal(broken.status().healthy, false); assert.equal(broken.getClient('not-a-grant'), null);
  assert.equal((await route(broken, 'GET', '/chatgpt/oauth/authorize?' + new URLSearchParams(authorization()))).status, 503);
  assert.equal(await fs.readFile(file, 'utf8'), original);
});

test('revocation blocks dispatch synchronously before its durable write finishes', async t => {
  const { oauth, revoked } = await setup(t), value = await grant(oauth);
  let release; const gate = new Promise(resolve => { release = resolve; }), persist = oauth.persist.bind(oauth);
  oauth.persist = async grants => { await gate; return persist(grants); };
  const revoking = oauth.revoke(value.client.id);
  assert.equal(oauth.getClient(value.client.id), null); assert.equal(oauth.isAuthorized(value.client), false); assert.ok(revoked.includes(value.client.id));
  release(); await revoking;
});

test('disable or origin changes invalidate a metadata fetch already in flight', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const { oauth } = await setup(t, { fetcher: () => gate });
  const pending = route(oauth, 'GET', '/chatgpt/oauth/authorize?' + new URLSearchParams(authorization()));
  await Promise.resolve(); await oauth.revokeAll(); release(response());
  const result = await pending; assert.equal(result.status, 409); assert.equal(oauth.pending().length, 0);
  const value = await grant(oauth); oauth.setOrigin('https://another-owned.example'); assert.equal(oauth.getClient(value.client.id), null); await oauth.tail;
  assert.equal(oauth.status().grants.length, 0); assert.equal(oauth.metadata('/.well-known/oauth-protected-resource').resource, 'https://another-owned.example/mcp/chatgpt');
});

test('duplicate parameters, oversized forms and client secrets do not issue tokens', async t => {
  const { oauth } = await setup(t); const value = await approveAndCode(oauth);
  const duplicate = await route(oauth, 'POST', '/chatgpt/oauth/token', { raw: 'grant_type=authorization_code&grant_type=refresh_token' }); assert.equal(duplicate.json.error, 'invalid_request');
  const large = await route(oauth, 'POST', '/chatgpt/oauth/token', { raw: 'x=' + 'x'.repeat(17000) }); assert.equal(large.status, 413);
  assert.equal((await exchange(oauth, value.code, { client_secret: 'not-accepted' })).json.error, 'invalid_client');
  const basic = await route(oauth, 'POST', '/chatgpt/oauth/token', { form: { grant_type: 'authorization_code' }, headers: { authorization: 'Basic abc' } }); assert.equal(basic.json.error, 'invalid_client');
  assert.equal((await exchange(oauth, value.code)).status, 200);
});

test('bearer authentication rejects duplicates, cookies and unknown token types', async t => {
  const { oauth } = await setup(t); const value = await grant(oauth);
  assert.equal(await oauth.authenticateRequest({ headers: { cookie: 'access_token=' + value.tokens.access_token }, rawHeaders: [] }), null);
  assert.equal(await oauth.authenticateRequest(bearer(value.tokens.refresh_token)), null);
  const duplicate = bearer(value.tokens.access_token); duplicate.rawHeaders.push('authorization', duplicate.headers.authorization);
  assert.equal(await oauth.authenticateRequest(duplicate), null);
});

test('owner rejection after code exchange also revokes the resulting grant', async t => {
  const { oauth, advance } = await setup(t); const value = await grant(oauth); advance(2 * 60000); oauth.prune(); await oauth.reject(value.id);
  assert.equal(oauth.getClient(value.client.id), null); assert.equal(await oauth.authenticateRequest(bearer(value.tokens.access_token)), null);
});

test('changed owned origin across a restart revokes old resource grants durably', async t => {
  const env = await setup(t), value = await grant(env.oauth); await env.oauth.close();
  const changed = await new ChatGPTOAuth({ dataDir: env.dataDir, origin: 'https://changed-owned.example', now: env.now }).init();
  t.after(() => changed.close()); assert.equal(changed.status().healthy, true); assert.equal(changed.getClient(value.client.id), null);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(env.dataDir, 'chatgpt-oauth.json'), 'utf8')).grants, []);
  changed.setOrigin(ORIGIN); await changed.tail; assert.equal(await changed.authenticateRequest(bearer(value.tokens.access_token)), null);
});

test('credential write failure preserves the conflicting target and returns no token', async t => {
  const { oauth, dataDir } = await setup(t), issued = await approveAndCode(oauth);
  const target = path.join(dataDir, 'chatgpt-oauth.json'); await fs.mkdir(target); await fs.writeFile(path.join(target, 'owned-marker'), 'preserve');
  const result = await exchange(oauth, issued.code); assert.equal(result.status, 503); assert.equal(result.json.access_token, undefined); assert.equal(oauth.status().healthy, false);
  assert.equal(await fs.readFile(path.join(target, 'owned-marker'), 'utf8'), 'preserve');
});

test('disabled connector creates no approval request and no metadata network request', async t => {
  const { oauth, calls } = await setup(t);
  const result = await route(oauth, 'GET', '/chatgpt/oauth/authorize?' + new URLSearchParams(authorization()), { enabled: false });
  assert.equal(result.status, 503); assert.equal(oauth.pending().length, 0); assert.equal(calls.length, 0);
});

test('authorization reload keeps the same nonce-bound request and pending count is bounded', async t => {
  const { oauth } = await setup(t), first = await begin(oauth);
  const reload = await route(oauth, 'GET', '/chatgpt/oauth/authorize?' + new URLSearchParams(authorization()), { headers: { cookie: first.cookie } });
  assert.equal(reload.status, 200); assert.match(reload.body, new RegExp(first.id)); assert.equal(oauth.pending().length, 1);
  for (let i = 1; i < 16; i++) await begin(oauth, { state: 'bounded-' + i });
  const full = await route(oauth, 'GET', '/chatgpt/oauth/authorize?' + new URLSearchParams(authorization({ state: 'over-capacity' })));
  assert.equal(full.status, 302); assert.equal(new URL(full.headers.location).searchParams.get('error'), 'temporarily_unavailable'); assert.equal(oauth.pending().length, 16);
});

test('OAuth revocation recognizes token possession but never reveals unknown tokens', async t => {
  const { oauth } = await setup(t), value = await grant(oauth);
  const unknown = await route(oauth, 'POST', '/chatgpt/oauth/revoke', { form: { client_id: CLIENT, token: 'unknown' } }); assert.equal(unknown.status, 200); assert.ok(oauth.getClient(value.client.id));
  const revoked = await route(oauth, 'POST', '/chatgpt/oauth/revoke', { form: { client_id: CLIENT, token: value.tokens.refresh_token, token_type_hint: 'refresh_token' } });
  assert.equal(revoked.status, 200); assert.equal(oauth.getClient(value.client.id), null);
});

test('pending owner approval survives a year without weakening browser binding or scopes', async t => {
  const { oauth, advance } = await setup(t), request = await begin(oauth, { scope: 'read commands:run' });
  assert.equal(oauth.pending()[0].expiresAt, null);
  assert.doesNotMatch(request.result.headers['set-cookie'], /Max-Age|Expires=/i);
  assert.match(request.result.headers['set-cookie'], /Path=\/chatgpt\/oauth\/; Secure; HttpOnly; SameSite=Strict$/);
  advance(365 * 86400000); oauth.prune();
  assert.equal(oauth.pending()[0].id, request.id);
  const missingBrowser = await route(oauth, 'GET', '/chatgpt/oauth/pending/' + request.id);
  assert.equal(missingBrowser.status, 403);
  const pending = await route(oauth, 'GET', '/chatgpt/oauth/pending/' + request.id, { headers: { cookie: request.cookie } });
  assert.deepEqual(pending.json, { status: 'pending', expiresAt: null });
  await assert.rejects(oauth.approve(request.id, { scopes: ['read', 'files:write'] }), /requested BLACKICE permissions/);
  await oauth.approve(request.id, { scopes: ['read', 'commands:run'] });
  const poll = await route(oauth, 'GET', '/chatgpt/oauth/pending/' + request.id, { headers: { cookie: request.cookie } });
  const code = new URL(poll.json.redirect).searchParams.get('code');
  const exchanged = await exchange(oauth, code);
  assert.equal(exchanged.status, 200); assert.equal(exchanged.json.scope, 'read commands:run');
  assert.equal(exchanged.json.expires_in, 15 * 60);
});

test('approved but unpolled authorization has no timer and its code gets the original 90 seconds when issued', async t => {
  const { oauth, advance } = await setup(t), request = await begin(oauth);
  await oauth.approve(request.id); advance(365 * 86400000); oauth.prune();
  const poll = await route(oauth, 'GET', '/chatgpt/oauth/pending/' + request.id, { headers: { cookie: request.cookie } });
  assert.equal(poll.status, 200); const code = new URL(poll.json.redirect).searchParams.get('code');
  assert.match(code, /^blackice_code_[A-Za-z0-9_-]{43}$/);
  advance(89999); assert.equal((await exchange(oauth, code)).status, 200);
});

test('code expiry stays 90 seconds after delayed approval and cannot be replaced by polling', async t => {
  const { oauth, advance } = await setup(t), request = await begin(oauth);
  advance(365 * 86400000); await oauth.approve(request.id);
  let poll = await route(oauth, 'GET', '/chatgpt/oauth/pending/' + request.id, { headers: { cookie: request.cookie } });
  const code = new URL(poll.json.redirect).searchParams.get('code');
  advance(90000); assert.equal((await exchange(oauth, code)).json.error, 'invalid_grant');
  poll = await route(oauth, 'GET', '/chatgpt/oauth/pending/' + request.id, { headers: { cookie: request.cookie } });
  assert.equal(new URL(poll.json.redirect).searchParams.get('error'), 'access_denied');
  assert.equal(new URL(poll.json.redirect).searchParams.has('code'), false);
});

test('authorization reload still reuses its browser-bound pending request after a year', async t => {
  const { oauth, advance } = await setup(t), first = await begin(oauth);
  advance(365 * 86400000);
  const reload = await route(oauth, 'GET', '/chatgpt/oauth/authorize?' + new URLSearchParams(authorization()), { headers: { cookie: first.cookie } });
  assert.equal(reload.status, 200); assert.match(reload.body, new RegExp(first.id));
  assert.equal(reload.headers['set-cookie'], undefined); assert.equal(oauth.requests.size, 1);
});

test('browser polling continues after a year and still returns only the server-approved redirect', async t => {
  const { oauth } = await setup(t), script = await route(oauth, 'GET', '/chatgpt/oauth/consent.js');
  let clock = 0, calls = 0, destination = null; const scheduled = [], status = { textContent: '' };
  const redirect = REDIRECT + '?code=synthetic&state=synthetic&iss=' + encodeURIComponent(ORIGIN);
  const context = {
    document: { getElementById: () => status, body: { dataset: { request: 'synthetic-request' } } },
    Date: { now: () => clock }, location: { replace: value => { destination = value; } },
    fetch: async (url, options) => { calls++; assert.equal(url, '/chatgpt/oauth/pending/synthetic-request'); assert.equal(options.credentials, 'same-origin'); return { ok: true, json: async () => calls < 3 ? { status: 'pending', expiresAt: null } : { redirect } }; },
    setTimeout: (callback, delay) => { scheduled.push(callback); assert.ok(delay === 1000 || delay === 2000); }
  };
  runInNewContext(script.body, context); await new Promise(setImmediate); assert.equal(calls, 1);
  clock += 365 * 86400000; scheduled.shift()(); await new Promise(setImmediate); assert.equal(calls, 2); assert.equal(destination, null);
  scheduled.shift()(); await new Promise(setImmediate); assert.equal(destination, redirect); assert.equal(scheduled.length, 0);
});

test('sixteen undecided requests remain bounded until the local owner declines one', async t => {
  const { oauth, advance } = await setup(t), originals = [];
  for (let i = 0; i < 16; i++) originals.push(await begin(oauth, { state: 'owner-decides-' + i }));
  advance(365 * 86400000); oauth.prune(); assert.equal(oauth.pending().length, 16);
  let full = await route(oauth, 'GET', '/chatgpt/oauth/authorize?' + new URLSearchParams(authorization({ state: 'over-capacity' })));
  assert.equal(new URL(full.headers.location).searchParams.get('error'), 'temporarily_unavailable'); assert.equal(oauth.requests.size, 16);
  await oauth.reject(originals[4].id); const replacement = await begin(oauth, { state: 'owner-freed-slot' });
  assert.equal(oauth.requests.size, 16); assert.equal(oauth.pending().length, 16); assert.equal(oauth.requests.has(originals[4].id), false);
  for (const request of originals.filter((_, i) => i !== 4)) assert.equal(oauth.requests.has(request.id), true);
  assert.equal(oauth.requests.has(replacement.id), true);
});

test('capacity reclaims declined records before the oldest approved unpolled window and preserves every undecided request', async t => {
  const { oauth } = await setup(t), approved = await begin(oauth, { state: 'reviewed-first' }); await oauth.approve(approved.id);
  const declined = await begin(oauth, { state: 'reviewed-second' }); await oauth.reject(declined.id);
  const undecided = []; for (let i = 0; i < 14; i++) undecided.push(await begin(oauth, { state: 'undecided-' + i }));
  await begin(oauth, { state: 'replace-terminal-first' }); assert.equal(oauth.requests.has(declined.id), false); assert.equal(oauth.requests.has(approved.id), true);
  await begin(oauth, { state: 'replace-reviewed-next' }); assert.equal(oauth.requests.has(approved.id), false); assert.equal(oauth.requests.size, 16);
  for (const request of undecided) assert.equal(oauth.requests.has(request.id), true);
  assert.equal((await route(oauth, 'GET', '/chatgpt/oauth/pending/' + approved.id, { headers: { cookie: approved.cookie } })).status, 403);
});

test('capacity reclaims expired-code records before approved unpolled windows without extending code validity', async t => {
  const { oauth, advance } = await setup(t), waiting = await begin(oauth, { state: 'approved-unpolled' }); await oauth.approve(waiting.id);
  const expired = await approveAndCode(oauth, { authorization: { state: 'issued-code' } });
  for (let i = 0; i < 14; i++) await begin(oauth, { state: 'keep-pending-' + i });
  advance(90001); await begin(oauth, { state: 'replacement-for-expired-code' });
  assert.equal(oauth.requests.has(expired.id), false); assert.equal(oauth.requests.has(waiting.id), true); assert.equal(oauth.requests.size, 16);
  assert.equal((await exchange(oauth, expired.code)).json.error, 'invalid_grant');
});

test('reclaiming a completed request preserves authorization-code replay revocation', async t => {
  const { oauth } = await setup(t), completed = await grant(oauth);
  for (let i = 0; i < 15; i++) await begin(oauth, { state: 'pending-after-completed-' + i });
  await begin(oauth, { state: 'replacement-for-completed' });
  assert.equal(oauth.requests.has(completed.id), false); assert.equal(oauth.requests.size, 16);
  assert.ok(await oauth.authenticateRequest(bearer(completed.tokens.access_token)));
  assert.equal((await exchange(oauth, completed.code)).json.error, 'invalid_grant');
  assert.equal(await oauth.authenticateRequest(bearer(completed.tokens.access_token)), null);
});

test('invalid authorization cannot reclaim a reviewed window at the capacity bound', async t => {
  const { oauth } = await setup(t), reviewed = await begin(oauth); await oauth.approve(reviewed.id);
  for (let i = 0; i < 15; i++) await begin(oauth, { state: 'preserve-at-bound-' + i });
  const invalid = await route(oauth, 'GET', '/chatgpt/oauth/authorize?' + new URLSearchParams(authorization({ state: 'invalid-replacement', code_challenge: 'short' })));
  assert.equal(new URL(invalid.headers.location).searchParams.get('error'), 'invalid_request'); assert.equal(oauth.requests.has(reviewed.id), true); assert.equal(oauth.requests.size, 16);
});

test('new authorization leaves other pending windows in the same browser usable indefinitely', async t => {
  const { oauth, advance } = await setup(t), first = await begin(oauth, { state: 'first-browser-window' });
  const secondResult = await route(oauth, 'GET', '/chatgpt/oauth/authorize?' + new URLSearchParams(authorization({ state: 'second-browser-window' })), { headers: { cookie: first.cookie } });
  assert.equal(secondResult.status, 200); const secondId = secondResult.body.match(/data-request="([a-f0-9-]+)"/)[1];
  const cookies = first.cookie + '; ' + secondResult.headers['set-cookie'].split(';')[0];
  assert.notEqual(secondId, first.id); assert.equal(oauth.pending().length, 2); advance(365 * 86400000);
  await oauth.approve(first.id);
  const firstPoll = await route(oauth, 'GET', '/chatgpt/oauth/pending/' + first.id, { headers: { cookie: cookies } }); assert.ok(firstPoll.json.redirect);
  const secondPoll = await route(oauth, 'GET', '/chatgpt/oauth/pending/' + secondId, { headers: { cookie: cookies } }); assert.deepEqual(secondPoll.json, { status: 'pending', expiresAt: null });
  await oauth.approve(secondId); assert.equal((await route(oauth, 'GET', '/chatgpt/oauth/pending/' + secondId, { headers: { cookie: cookies } })).status, 200);
});

test('capacity preserves issued unexchanged codes for their full 90 seconds', async t => {
  const { oauth, advance } = await setup(t), issued = await approveAndCode(oauth);
  for (let i = 0; i < 15; i++) await begin(oauth, { state: 'pending-with-live-code-' + i });
  const full = await route(oauth, 'GET', '/chatgpt/oauth/authorize?' + new URLSearchParams(authorization({ state: 'live-code-must-stay' })));
  assert.equal(new URL(full.headers.location).searchParams.get('error'), 'temporarily_unavailable'); assert.equal(oauth.requests.has(issued.id), true); assert.equal(oauth.codes.size, 1);
  advance(90000); await begin(oauth, { state: 'room-after-code-lifetime' });
  assert.equal(oauth.requests.has(issued.id), false); assert.equal(oauth.requests.size, 16); assert.equal((await exchange(oauth, issued.code)).json.error, 'invalid_grant');
});

function cookieJar(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values, header: () => [...values].map(([name, value]) => name + '=' + value).join('; '),
    apply(result) {
      const cookies = result.headers['set-cookie'];
      for (const cookie of Array.isArray(cookies) ? cookies : cookies ? [cookies] : []) {
        const pair = cookie.split(';')[0], at = pair.indexOf('='), name = pair.slice(0, at);
        if (/; Max-Age=0(?:;|$)/.test(cookie)) values.delete(name); else values.set(name, pair.slice(at + 1));
      }
    }
  };
}

test('repeated local review cycles retire cookies only for reclaimed request IDs and keep another active tab', async t => {
  const { oauth, advance } = await setup(t), lookalike = '__Secure-blackice-oauth-11111111-1111-4111-8111-111111111111-extra';
  const jar = cookieJar({ theme: 'unrelated-browser-preference', [lookalike]: 'unrelated-lookalike' });
  const first = await begin(oauth, { state: 'keep-other-tab' }); jar.apply(first.result);
  let expirations = 0;
  for (let i = 0; i < 48; i++) {
    if (i % 16 === 0) advance(60001);
    // Strict cookies can be absent on a cross-site authorization navigation.
    const result = await route(oauth, 'GET', '/chatgpt/oauth/authorize?' + new URLSearchParams(authorization({ state: 'review-cycle-' + i })), { headers: i % 2 ? {} : { cookie: jar.header() } });
    assert.equal(result.status, 200); const id = result.body.match(/data-request="([a-f0-9-]+)"/)[1];
    const cookies = Array.isArray(result.headers['set-cookie']) ? result.headers['set-cookie'] : [result.headers['set-cookie']];
    for (const cookie of cookies.filter(value => value.includes('Max-Age=0'))) {
      expirations++; const name = cookie.split('=')[0], oldId = name.slice('__Secure-blackice-oauth-'.length);
      assert.equal(oauth.requests.has(oldId), false); assert.notEqual(oldId, first.id);
      assert.match(cookie, /=; Path=\/chatgpt\/oauth\/; Secure; HttpOnly; SameSite=Strict; Max-Age=0$/);
    }
    jar.apply(result); await oauth.reject(id);
    assert.ok(oauth.requests.size <= 16); assert.ok(jar.values.size <= 18);
    assert.equal(jar.values.get('theme'), 'unrelated-browser-preference'); assert.equal(jar.values.get(lookalike), 'unrelated-lookalike');
    assert.equal(jar.values.get(oauth.cookieName(first.id)), first.cookie.split('=')[1]);
  }
  assert.ok(expirations >= 32); advance(365 * 86400000);
  const waiting = await route(oauth, 'GET', '/chatgpt/oauth/pending/' + first.id, { headers: { cookie: jar.header() } }); assert.equal(waiting.json.status, 'pending');
  await oauth.approve(first.id);
  const approved = await route(oauth, 'GET', '/chatgpt/oauth/pending/' + first.id, { headers: { cookie: jar.header() } });
  assert.equal((await exchange(oauth, new URL(approved.json.redirect).searchParams.get('code'))).status, 200);
});

test('invalid authorization and pending reload do not clear any cookie context', async t => {
  const { oauth } = await setup(t), first = await begin(oauth);
  const staleName = '__Secure-blackice-oauth-22222222-2222-4222-8222-222222222222', jar = cookieJar({ [staleName]: 's'.repeat(43), unrelated: 'keep' }); jar.apply(first.result);
  const before = jar.header();
  const invalid = await route(oauth, 'GET', '/chatgpt/oauth/authorize?' + new URLSearchParams(authorization({ state: 'invalid-cookie-cleanup', code_challenge: 'short' })), { headers: { cookie: before } });
  assert.equal(invalid.status, 302); assert.equal(invalid.headers['set-cookie'], undefined); assert.equal(jar.header(), before);
  const reload = await route(oauth, 'GET', '/chatgpt/oauth/authorize?' + new URLSearchParams(authorization()), { headers: { cookie: before } });
  assert.equal(reload.status, 200); assert.match(reload.body, new RegExp(first.id)); assert.equal(reload.headers['set-cookie'], undefined);
  const fresh = await route(oauth, 'GET', '/chatgpt/oauth/authorize?' + new URLSearchParams(authorization({ state: 'valid-cookie-cleanup' })), { headers: { cookie: before } });
  assert.equal(fresh.status, 200); jar.apply(fresh); assert.equal(jar.values.has(staleName), false); assert.equal(jar.values.get('unrelated'), 'keep'); assert.equal(jar.values.has(oauth.cookieName(first.id)), true);
});

test('successful new authorization preserves approved and live-code cookies along with pending cookies', async t => {
  const { oauth } = await setup(t), pending = await begin(oauth, { state: 'pending-cookie' }), approved = await begin(oauth, { state: 'approved-cookie' }); await oauth.approve(approved.id);
  const issued = await approveAndCode(oauth, { authorization: { state: 'live-code-cookie' } }), jar = cookieJar();
  for (const request of [pending, approved, issued]) jar.apply(request.result);
  const fresh = await route(oauth, 'GET', '/chatgpt/oauth/authorize?' + new URLSearchParams(authorization({ state: 'fresh-cookie' })), { headers: { cookie: jar.header() } });
  assert.equal(fresh.status, 200); const headers = [].concat(fresh.headers['set-cookie']); assert.equal(headers.some(value => value.includes('Max-Age=0')), false); jar.apply(fresh);
  for (const request of [pending, approved, issued]) assert.equal(jar.values.get(oauth.cookieName(request.id)), request.cookie.split('=')[1]);
  assert.equal((await exchange(oauth, issued.code)).status, 200);
});

test('native HTTP response emits separate secure session and retired-cookie headers', async t => {
  const { oauth } = await setup(t), server = createServer((req, res) => { void oauth.handle(req, res, { enabled: true }); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const staleName = '__Secure-blackice-oauth-33333333-3333-4333-8333-333333333333';
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/chatgpt/oauth/authorize?' + new URLSearchParams(authorization()), { headers: { Cookie: staleName + '=' + 's'.repeat(43) + '; unrelated=keep' }, redirect: 'manual' });
  assert.equal(response.status, 200); const cookies = response.headers.getSetCookie(); assert.equal(cookies.length, 2);
  const html = await response.text(), id = html.match(/data-request="([a-f0-9-]+)"/)[1];
  assert.ok(cookies.some(cookie => cookie.startsWith(oauth.cookieName(id) + '=') && !cookie.includes('Max-Age')));
  assert.ok(cookies.includes(staleName + '=; Path=/chatgpt/oauth/; Secure; HttpOnly; SameSite=Strict; Max-Age=0'));
  assert.equal(cookies.some(cookie => cookie.startsWith('unrelated=')), false);
});

test('the first browser-bound poll retires restart leftovers omitted from a cross-site authorize navigation', async t => {
  const { oauth } = await setup(t), request = await begin(oauth), staleName = '__Secure-blackice-oauth-44444444-4444-4444-8444-444444444444';
  const jar = cookieJar({ [staleName]: 's'.repeat(43), unrelated: 'keep' }); jar.apply(request.result);
  assert.equal([].concat(request.result.headers['set-cookie']).some(value => value.includes('Max-Age=0')), false);
  const unauthorized = await route(oauth, 'GET', '/chatgpt/oauth/pending/' + request.id, { headers: { cookie: staleName + '=' + 's'.repeat(43) } });
  assert.equal(unauthorized.status, 403); assert.equal(unauthorized.headers['set-cookie'], undefined);
  const wrongOrigin = await route(oauth, 'GET', '/chatgpt/oauth/pending/' + request.id, { headers: { cookie: jar.header(), origin: 'https://attacker.example' } });
  assert.equal(wrongOrigin.status, 403); assert.equal(wrongOrigin.headers['set-cookie'], undefined);
  const poll = await route(oauth, 'GET', '/chatgpt/oauth/pending/' + request.id, { headers: { cookie: jar.header(), origin: ORIGIN } });
  assert.equal(poll.status, 200); assert.deepEqual(poll.json, { status: 'pending', expiresAt: null });
  assert.deepEqual(poll.headers['set-cookie'], [staleName + '=; Path=/chatgpt/oauth/; Secure; HttpOnly; SameSite=Strict; Max-Age=0']);
  jar.apply(poll); assert.equal(jar.values.has(staleName), false); assert.equal(jar.values.get('unrelated'), 'keep'); assert.equal(jar.values.has(oauth.cookieName(request.id)), true);
  const again = await route(oauth, 'GET', '/chatgpt/oauth/pending/' + request.id, { headers: { cookie: jar.header() } }); assert.equal(again.headers['set-cookie'], undefined);
});
