import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
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
  const oauth = new ChatGPTOAuth({ ...options, dataDir, origin: ORIGIN, now: () => clock, fetcher: async (url, request) => { calls.push({ url, request }); return options.fetcher ? options.fetcher(url, request) : response(); }, onRevoked: ids => revoked.push(...ids) });
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
function protectedStorage() {
  // A real authenticated cipher stands in for Electron's protected OS store.
  const key = randomBytes(32);
  return {
    storageBackend: () => 'dpapi', isEncryptionAvailable: () => true,
    encryptSecret: text => { const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce), sealed = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]); return Buffer.concat([nonce, cipher.getAuthTag(), sealed]).toString('base64'); },
    decryptSecret: text => { const sealed = Buffer.from(text, 'base64'), decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12)); decipher.setAuthTag(sealed.subarray(12, 28)); return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString('utf8'); },
  };
}

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

test('refresh rotates credentials and replay beyond the retry grace revokes the whole family durably', async t => {
  const { oauth, dataDir, revoked, advance } = await setup(t); const value = await grant(oauth);
  const renewed = await refresh(oauth, value.tokens.refresh_token); assert.equal(renewed.status, 200);
  assert.notEqual(renewed.json.refresh_token, value.tokens.refresh_token); assert.notEqual(renewed.json.access_token, value.tokens.access_token);
  const refreshedClient = await oauth.authenticateRequest(bearer(renewed.json.access_token));
  assert.equal(refreshedClient.id, value.client.id); assert.deepEqual(refreshedClient.scopes, value.client.scopes);
  const disk = await fs.readFile(path.join(dataDir, 'chatgpt-oauth.json'), 'utf8'); assert.ok(!disk.includes(value.tokens.refresh_token)); assert.ok(!disk.includes(renewed.json.refresh_token));
  advance(60000);
  const replay = await refresh(oauth, value.tokens.refresh_token); assert.equal(replay.json.error, 'invalid_grant');
  assert.equal(await oauth.authenticateRequest(bearer(renewed.json.access_token)), null); assert.equal(await oauth.authenticateRequest(bearer(value.tokens.access_token)), null); assert.ok(revoked.includes(value.client.id));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, 'chatgpt-oauth.json'), 'utf8')).grants, []);
});

test('more than four refreshes preserve every unexpired access token across restart and prune only expired records', async t => {
  const env = await setup(t), value = await grant(env.oauth, { requestedScopes: SCOPES.join(' '), scopes: SCOPES });
  const tokens = [value.tokens], originalExpiry = env.oauth.grants[0].accessTokens[0].expiresAt;
  for (let index = 0; index < 5; index++) {
    env.advance(1000); const result = await refresh(env.oauth, tokens.at(-1).refresh_token);
    assert.equal(result.status, 200); tokens.push(result.json);
  }
  assert.equal(env.oauth.grants[0].accessTokens.length, 6); assert.equal(env.oauth.grants[0].accessTokens[0].expiresAt, originalExpiry);
  for (const token of tokens) {
    const client = await env.oauth.authenticateRequest(bearer(token.access_token));
    assert.equal(client?.id, value.client.id); assert.deepEqual(client.scopes, SCOPES);
  }
  await env.oauth.close();
  const reopened = await new ChatGPTOAuth({ dataDir: env.dataDir, origin: ORIGIN, now: env.now }).init(); t.after(() => reopened.close());
  assert.equal(reopened.status().healthy, true); assert.equal(reopened.grants[0].accessTokens.length, 6);
  for (const token of tokens) {
    const client = await reopened.authenticateRequest(bearer(token.access_token));
    assert.equal(client?.id, value.client.id); assert.deepEqual(client.scopes, SCOPES);
  }
  env.advance(15 * 60000 - 5000);
  assert.equal(await reopened.authenticateRequest(bearer(tokens[0].access_token)), null);
  for (const token of tokens.slice(1)) assert.equal((await reopened.authenticateRequest(bearer(token.access_token)))?.id, value.client.id);
  const renewed = await refresh(reopened, tokens.at(-1).refresh_token); assert.equal(renewed.status, 200);
  const stored = JSON.parse(await fs.readFile(reopened.file, 'utf8')).grants[0];
  assert.equal(stored.accessTokens.length, 6); assert.ok(stored.accessTokens.every(token => Date.parse(token.expiresAt) > env.now()));
  assert.ok(!stored.accessTokens.some(token => token.expiresAt === originalExpiry)); assert.deepEqual(stored.scopes, SCOPES);
});

test('the global access-token budget rejects new issuance without disabling grants and recovers after expiry', async t => {
  const env = await setup(t), first = await grant(env.oauth, { requestedScopes: SCOPES.join(' '), scopes: SCOPES }), second = await grant(env.oauth, { requestedScopes: SCOPES.join(' '), scopes: SCOPES });
  const seeded = structuredClone(env.oauth.grants), expiresAt = new Date(env.now() + 1000).toISOString();
  for (const grant of seeded) for (let index = 0; index < 1023; index++) grant.accessTokens.push({ hash: createHash('sha256').update(`capacity-${grant.id}-${index}`).digest('hex'), expiresAt });
  await env.oauth.persist(seeded);
  assert.equal(env.oauth.grants.reduce((count, grant) => count + grant.accessTokens.length, 0), 2048);
  const reopened = await new ChatGPTOAuth({ dataDir: env.dataDir, origin: ORIGIN, now: env.now }).init();
  t.after(() => reopened.close()); assert.equal(reopened.status().healthy, true);
  for (const value of [first, second]) assert.equal((await reopened.authenticateRequest(bearer(value.tokens.access_token)))?.id, value.client.id);
  await reopened.close();
  const before = await fs.readFile(env.oauth.file, 'utf8'), originalRefresh = env.oauth.grants.map(grant => structuredClone(grant.refresh));
  for (const value of [first, second]) {
    const result = await refresh(env.oauth, value.tokens.refresh_token);
    assert.equal(result.status, 503); assert.equal(result.json.error, 'temporarily_unavailable'); assert.equal(result.json.access_token, undefined);
  }
  const pending = await approveAndCode(env.oauth), blocked = await exchange(env.oauth, pending.code);
  assert.equal(blocked.status, 503); assert.equal(blocked.json.error, 'temporarily_unavailable'); assert.equal(blocked.json.access_token, undefined);
  assert.equal(env.oauth.status().healthy, true); assert.equal(env.oauth.refreshRetries.size, 0); assert.deepEqual(env.revoked, []);
  assert.deepEqual(env.oauth.grants.map(grant => grant.refresh), originalRefresh); assert.equal(await fs.readFile(env.oauth.file, 'utf8'), before);
  for (const value of [first, second]) {
    const client = await env.oauth.authenticateRequest(bearer(value.tokens.access_token));
    assert.equal(client?.id, value.client.id); assert.deepEqual(client.scopes, SCOPES);
  }
  env.advance(1000);
  assert.equal((await refresh(env.oauth, first.tokens.refresh_token)).status, 200);
  const stored = JSON.parse(await fs.readFile(env.oauth.file, 'utf8')).grants;
  assert.equal(stored.reduce((count, grant) => count + grant.accessTokens.length, 0), 3);
  assert.equal(stored.find(grant => grant.id === second.client.id).accessTokens.length, 1);
  assert.equal((await exchange(env.oauth, pending.code)).status, 200); assert.equal(env.oauth.status().healthy, true); assert.deepEqual(env.revoked, []);
  for (const value of [first, second]) assert.equal((await env.oauth.authenticateRequest(bearer(value.tokens.access_token)))?.id, value.client.id);
});

test('loader bounds access-token records across grants instead of allowing the budget once per grant', async t => {
  const env = await setup(t); await grant(env.oauth); await grant(env.oauth);
  const seeded = structuredClone(env.oauth.grants), expiresAt = new Date(env.now() + 1000).toISOString();
  for (let index = 0; index < 2047; index++) seeded[index % seeded.length].accessTokens.push({ hash: createHash('sha256').update(`invalid-capacity-${index}`).digest('hex'), expiresAt });
  assert.ok(seeded.every(grant => grant.accessTokens.length < 2048));
  const oversized = JSON.stringify({ schema: 1, grants: seeded }, null, 2) + '\n';
  await env.oauth.close(); await fs.writeFile(env.oauth.file, oversized);
  const reopened = await new ChatGPTOAuth({ dataDir: env.dataDir, origin: ORIGIN, now: env.now }).init(); t.after(() => reopened.close());
  assert.equal(reopened.status().healthy, false); assert.equal(await fs.readFile(reopened.file, 'utf8'), oversized);
});

test('credential capacity checks exact persisted bytes and never disable a valid store on overflow', async t => {
  const env = await setup(t), value = await grant(env.oauth), maximum = 8 * 1024 * 1024;
  const original = await fs.readFile(env.oauth.file, 'utf8'), candidate = structuredClone(env.oauth.grants), originalCreatedAt = candidate[0].createdAt;
  const padding = maximum - Buffer.byteLength(JSON.stringify({ schema: 1, grants: candidate }, null, 2) + '\n');
  // Extra fractional-second zeros preserve a valid timestamp while exercising the exact byte boundary.
  candidate[0].createdAt = originalCreatedAt.slice(0, -1) + '0'.repeat(padding) + 'Z';
  assert.equal(Date.parse(candidate[0].createdAt), Date.parse(originalCreatedAt));
  const over = structuredClone(candidate); over[0].createdAt = over[0].createdAt.slice(0, -1) + '0Z';
  assert.ok(Buffer.byteLength(JSON.stringify({ schema: 1, grants: over })) < maximum);
  assert.equal(Buffer.byteLength(JSON.stringify({ schema: 1, grants: over }, null, 2) + '\n'), maximum + 1);
  await assert.rejects(env.oauth.persist(over), error => error.status === 503 && error.oauthError === 'temporarily_unavailable');
  assert.equal(env.oauth.status().healthy, true); assert.deepEqual(env.revoked, []); assert.equal(env.oauth.grants[0].createdAt, originalCreatedAt);
  assert.equal(await fs.readFile(env.oauth.file, 'utf8'), original); assert.equal((await env.oauth.authenticateRequest(bearer(value.tokens.access_token)))?.id, value.client.id);
  await env.oauth.persist(candidate);
  const persisted = await fs.readFile(env.oauth.file, 'utf8'); assert.equal(Buffer.byteLength(persisted), maximum);
  assert.equal(persisted, JSON.stringify({ schema: 1, grants: candidate }, null, 2) + '\n');
  await env.oauth.close();
  const reopened = await new ChatGPTOAuth({ dataDir: env.dataDir, origin: ORIGIN, now: env.now }).init(); t.after(() => reopened.close());
  assert.equal(reopened.status().healthy, true); assert.equal((await reopened.authenticateRequest(bearer(value.tokens.access_token)))?.id, value.client.id);
});

test('concurrent refresh retries share the same live replacement without revoking the grant', async t => {
  const { oauth, revoked } = await setup(t); const value = await grant(oauth);
  const results = await Promise.all(Array.from({ length: 12 }, () => refresh(oauth, value.tokens.refresh_token)));
  assert.ok(results.every(result => result.status === 200));
  for (const result of results) assert.deepEqual(result.json, results[0].json);
  assert.equal(oauth.getClient(value.client.id).id, value.client.id); assert.ok(await oauth.authenticateRequest(bearer(results[0].json.access_token)));
  assert.equal(oauth.grants[0].refresh.usedHashes.length, 1); assert.equal(oauth.grants[0].accessTokens.length, 2); assert.deepEqual(revoked, []);
});

test('lost refresh response is recoverable for 60 seconds without extending token or grant expiry', async t => {
  const { oauth, advance, revoked } = await setup(t), value = await grant(oauth), originalExpiry = oauth.grants[0].expiresAt;
  const first = await refresh(oauth, value.tokens.refresh_token); advance(59000);
  const retry = await refresh(oauth, value.tokens.refresh_token);
  assert.equal(retry.status, 200); assert.equal(retry.json.access_token, first.json.access_token); assert.equal(retry.json.refresh_token, first.json.refresh_token);
  assert.equal(retry.json.expires_in, first.json.expires_in - 59); assert.equal(oauth.grants[0].expiresAt, originalExpiry);
  assert.equal(oauth.grants[0].refresh.usedHashes.length, 1); assert.deepEqual(revoked, []);
  advance(1000); assert.equal((await refresh(oauth, value.tokens.refresh_token)).json.error, 'invalid_grant'); assert.equal(oauth.getClient(value.client.id), null);
});

test('a delayed retry of a recent superseded token never revokes the current family', async t => {
  const { oauth, revoked } = await setup(t), initial = await grant(oauth);
  const first = await refresh(oauth, initial.tokens.refresh_token), second = await refresh(oauth, first.json.refresh_token);
  const delayed = await refresh(oauth, initial.tokens.refresh_token);
  assert.equal(delayed.status, 400); assert.equal(delayed.json.error, 'invalid_grant'); assert.match(delayed.json.error_description, /superseded/);
  assert.ok(await oauth.authenticateRequest(bearer(second.json.access_token))); assert.equal(oauth.getClient(initial.client.id).id, initial.client.id); assert.deepEqual(revoked, []);
  assert.deepEqual((await refresh(oauth, first.json.refresh_token)).json, second.json);
});

test('retry receipts bind exact requested scope and resource without revoking a valid connection on mismatch', async t => {
  const { oauth, revoked } = await setup(t), value = await grant(oauth, { requestedScopes: 'read commands:run', scopes: ['read', 'commands:run'] });
  const first = await refresh(oauth, value.tokens.refresh_token, { scope: 'read' }); assert.equal(first.status, 200);
  assert.deepEqual((await refresh(oauth, value.tokens.refresh_token, { scope: 'read' })).json, first.json);
  assert.equal((await refresh(oauth, value.tokens.refresh_token)).json.error, 'invalid_request');
  assert.equal((await refresh(oauth, value.tokens.refresh_token, { scope: 'read commands:run' })).json.error, 'invalid_request');
  assert.equal((await refresh(oauth, value.tokens.refresh_token, { resource: 'https://other.example/mcp/chatgpt', scope: 'read' })).json.error, 'invalid_target');
  assert.equal((await refresh(oauth, value.tokens.refresh_token, { client_id: 'https://other.example/client.json', scope: 'read' })).json.error, 'invalid_client');
  assert.deepEqual((await oauth.authenticateRequest(bearer(first.json.access_token))).scopes, ['read']); assert.deepEqual(revoked, []);
});

test('protected retry receipts survive restart while grant records remain hash-only', async t => {
  const protection = protectedStorage(), env = await setup(t, protection), value = await grant(env.oauth);
  const renewed = await refresh(env.oauth, value.tokens.refresh_token);
  const grantText = await fs.readFile(env.oauth.file, 'utf8'), retryText = await fs.readFile(env.oauth.retryFile, 'utf8');
  for (const secret of [value.tokens.access_token, value.tokens.refresh_token, renewed.json.access_token, renewed.json.refresh_token]) { assert.ok(!grantText.includes(secret)); assert.ok(!retryText.includes(secret)); }
  assert.deepEqual(Object.keys(JSON.parse(grantText).grants[0].refresh).sort(), ['expiresAt', 'hash', 'usedHashes']);
  assert.equal(JSON.parse(retryText).encoding, 'string'); env.advance(10000); await env.oauth.close();
  const reopened = await new ChatGPTOAuth({ dataDir: env.dataDir, origin: ORIGIN, now: env.now, ...protection }).init(); t.after(() => reopened.close());
  const retry = await refresh(reopened, value.tokens.refresh_token);
  assert.equal(retry.status, 200); assert.equal(retry.json.access_token, renewed.json.access_token); assert.equal(retry.json.refresh_token, renewed.json.refresh_token); assert.equal(retry.json.expires_in, renewed.json.expires_in - 10);
  assert.equal(reopened.getClient(value.client.id).id, value.client.id); assert.equal(reopened.status().refreshRetry.persistence, 'protected');
});

test('superseded-token tombstones survive protected restart and cannot invalidate the latest token', async t => {
  const protection = protectedStorage(), env = await setup(t, protection), value = await grant(env.oauth);
  const first = await refresh(env.oauth, value.tokens.refresh_token), second = await refresh(env.oauth, first.json.refresh_token); await env.oauth.close();
  const reopened = await new ChatGPTOAuth({ dataDir: env.dataDir, origin: ORIGIN, now: env.now, ...protection }).init(); t.after(() => reopened.close());
  assert.equal((await refresh(reopened, value.tokens.refresh_token)).json.error, 'invalid_grant');
  assert.ok(reopened.getClient(value.client.id)); assert.ok(await reopened.authenticateRequest(bearer(second.json.access_token)));
  assert.deepEqual((await refresh(reopened, first.json.refresh_token)).json, second.json);
});

test('an encrypted receipt written before a failed grant commit cannot authorize orphaned replacement tokens', async t => {
  const protection = protectedStorage(), env = await setup(t, protection), value = await grant(env.oauth);
  const persist = env.oauth.persist.bind(env.oauth); let orphaned;
  const save = env.oauth.saveRefreshRetry.bind(env.oauth);
  env.oauth.saveRefreshRetry = async receipt => { orphaned = receipt.tokens; return save(receipt); };
  env.oauth.persist = async () => { throw new Error('Synthetic exit before grant commit'); };
  assert.equal((await refresh(env.oauth, value.tokens.refresh_token)).status, 500);
  env.oauth.persist = persist; await env.oauth.close();
  const reopened = await new ChatGPTOAuth({ dataDir: env.dataDir, origin: ORIGIN, now: env.now, ...protection }).init(); t.after(() => reopened.close());
  assert.equal(reopened.refreshRetries.size, 0); assert.equal(await reopened.authenticateRequest(bearer(orphaned.access_token)), null);
  assert.equal((await refresh(reopened, orphaned.refresh_token)).json.error, 'invalid_grant'); assert.ok(reopened.getClient(value.client.id));
  assert.equal((await refresh(reopened, value.tokens.refresh_token)).status, 200);
});

test('unavailable protected storage is explicitly memory-only and never writes plaintext fallback', async t => {
  const env = await setup(t, { storageBackend: () => 'basic_text', isEncryptionAvailable: () => true, encryptSecret: () => assert.fail('Never use basic_text'), decryptSecret: () => assert.fail('Never use basic_text') });
  const value = await grant(env.oauth), renewed = await refresh(env.oauth, value.tokens.refresh_token);
  assert.equal(renewed.status, 200); assert.equal(env.oauth.status().refreshRetry.persistence, 'memory');
  await assert.rejects(fs.stat(env.oauth.retryFile), { code: 'ENOENT' }); await env.oauth.close();
  const reopened = await new ChatGPTOAuth({ dataDir: env.dataDir, origin: ORIGIN, now: env.now }).init(); t.after(() => reopened.close());
  assert.equal(reopened.refreshRetries.size, 0); assert.ok(await reopened.authenticateRequest(bearer(renewed.json.access_token)));
  // With no protected receipt there is no response recovery after a restart.
  // Normal replay handling remains unchanged; callers need the returned token.
  assert.equal((await refresh(reopened, value.tokens.refresh_token)).json.error, 'invalid_grant');
});

test('a protected receipt write failure leaves the current refresh token valid for retry', async t => {
  const env = await setup(t, protectedStorage()), value = await grant(env.oauth);
  await fs.mkdir(env.oauth.retryFile); await fs.writeFile(path.join(env.oauth.retryFile, 'preserve'), 'marker');
  const failed = await refresh(env.oauth, value.tokens.refresh_token);
  assert.equal(failed.status, 503); assert.equal(failed.json.access_token, undefined); assert.equal(env.oauth.status().healthy, true); assert.ok(env.oauth.getClient(value.client.id)); assert.deepEqual(env.revoked, []);
  assert.equal(await fs.readFile(path.join(env.oauth.retryFile, 'preserve'), 'utf8'), 'marker');
  await fs.rm(env.oauth.retryFile, { recursive: true }); assert.equal((await refresh(env.oauth, value.tokens.refresh_token)).status, 200);
});

test('corrupt optional retry records do not disable existing normal credentials', async t => {
  const protection = protectedStorage(), env = await setup(t, protection), value = await grant(env.oauth);
  const renewed = await refresh(env.oauth, value.tokens.refresh_token); await env.oauth.close();
  await fs.writeFile(env.oauth.retryFile, '{corrupt retry sidecar');
  const reopened = await new ChatGPTOAuth({ dataDir: env.dataDir, origin: ORIGIN, now: env.now, ...protection }).init(); t.after(() => reopened.close());
  assert.equal(reopened.status().healthy, true); assert.match(reopened.status().refreshRetry.recoveryError, /unavailable/);
  assert.ok(await reopened.authenticateRequest(bearer(renewed.json.access_token))); assert.equal((await refresh(reopened, renewed.json.refresh_token)).status, 200);
  assert.equal(reopened.status().refreshRetry.recoveryError, null);
});

test('revocation and origin changes during protected encryption cannot commit or return replacement credentials', async t => {
  for (const operation of ['revoke', 'origin']) await t.test(operation, async t => {
    const protection = protectedStorage(), env = await setup(t, protection), value = await grant(env.oauth);
    let enter, release; const entered = new Promise(resolve => { enter = resolve; }), paused = new Promise(resolve => { release = resolve; });
    env.oauth.encryptSecret = async plaintext => { enter(); await paused; return protection.encryptSecret(plaintext); };
    const refreshing = refresh(env.oauth, value.tokens.refresh_token); await entered;
    const revoking = operation === 'revoke' ? env.oauth.revoke(value.client.id) : (env.oauth.setOrigin('https://new.example'), env.oauth.tail);
    release(); const result = await refreshing; await revoking;
    assert.equal(result.status >= 400, true); assert.equal(result.json.access_token, undefined); assert.equal(env.oauth.getClient(value.client.id), null);
    assert.deepEqual(JSON.parse(await fs.readFile(env.oauth.file, 'utf8')).grants, []); assert.equal(env.oauth.refreshRetries.size, 0);
  });
});

test('explicit revocation and expiry cannot be undone by a protected retry receipt', async t => {
  for (const operation of ['revoke', 'expiry']) await t.test(operation, async t => {
    const protection = protectedStorage(), env = await setup(t, protection), value = await grant(env.oauth);
    await refresh(env.oauth, value.tokens.refresh_token);
    if (operation === 'revoke') await env.oauth.revoke(value.client.id); else env.advance(30 * 86400000);
    await env.oauth.close();
    const reopened = await new ChatGPTOAuth({ dataDir: env.dataDir, origin: ORIGIN, now: env.now, ...protection }).init(); t.after(() => reopened.close());
    assert.equal((await refresh(reopened, value.tokens.refresh_token)).json.error, 'invalid_grant'); assert.equal(reopened.getClient(value.client.id), null); assert.equal(reopened.refreshRetries.size, 0);
  });
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

test('token outcome diagnostics distinguish rotation, successful retry and preserved-grant retry failures', async t => {
  const { oauth, now, advance, revoked } = await setup(t);
  assert.deepEqual(oauth.status().tokenDiagnostics, { succeeded: 0, failed: 0, lastFailure: null, recentOutcomes: [] });
  const initial = await grant(oauth, { requestedScopes: SCOPES.join(' '), scopes: [...SCOPES] });
  advance(1000); const first = await refresh(oauth, initial.tokens.refresh_token);
  assert.equal(first.status, 200); assert.deepEqual(Object.keys(first.json).sort(), ['access_token', 'expires_in', 'refresh_token', 'scope', 'token_type']);
  const retry = await refresh(oauth, initial.tokens.refresh_token); assert.deepEqual(retry.json, first.json);
  advance(1000); const second = await refresh(oauth, first.json.refresh_token); assert.equal(second.status, 200);
  advance(1000); const superseded = await refresh(oauth, initial.tokens.refresh_token);
  assert.equal(superseded.status, 400); assert.equal(superseded.json.error, 'invalid_grant'); assert.match(superseded.json.error_description, /superseded/);
  const mismatch = await refresh(oauth, first.json.refresh_token, { scope: 'read' });
  assert.equal(mismatch.status, 400); assert.equal(mismatch.json.error, 'invalid_request');
  assert.deepEqual(oauth.getClient(initial.client.id).scopes, SCOPES); assert.ok(await oauth.authenticateRequest(bearer(second.json.access_token))); assert.deepEqual(revoked, []);
  const diagnostic = oauth.status().tokenDiagnostics;
  assert.equal(diagnostic.succeeded, 4); assert.equal(diagnostic.failed, 2);
  assert.deepEqual(diagnostic.recentOutcomes.map(({ category, statusCode }) => [category, statusCode]), [
    ['authorization_code_issued', 200], ['refresh_rotated', 200], ['refresh_retry_succeeded', 200], ['refresh_rotated', 200], ['refresh_retry_superseded', 400], ['refresh_retry_mismatch', 400],
  ]);
  assert.deepEqual(diagnostic.lastFailure, { at: new Date(now()).toISOString(), statusCode: 400, category: 'refresh_retry_mismatch' });
  advance(60000); const replay = await refresh(oauth, initial.tokens.refresh_token);
  assert.equal(replay.status, 400); assert.equal(oauth.getClient(initial.client.id), null); assert.deepEqual(revoked, [initial.client.id]);
  assert.equal(oauth.status().tokenDiagnostics.lastFailure.category, 'refresh_replay_revoked');
});

test('token outcome diagnostics include pre-token refusals, rate limits and protected-retry failures', async t => {
  const { oauth, now, revoked } = await setup(t, protectedStorage()), initial = await grant(oauth);
  await fs.mkdir(oauth.retryFile);
  const storage = await refresh(oauth, initial.tokens.refresh_token);
  assert.equal(storage.status, 503); assert.equal(storage.json.error, 'temporarily_unavailable');
  assert.equal(oauth.status().tokenDiagnostics.lastFailure.category, 'refresh_retry_storage_unavailable');
  assert.ok(oauth.getClient(initial.client.id)); assert.deepEqual(revoked, []);
  await fs.rm(oauth.retryFile, { recursive: true });
  const renewed = await refresh(oauth, initial.tokens.refresh_token); assert.equal(renewed.status, 200);
  oauth.rates.set('token', { at: now(), count: 120 });
  const limited = await refresh(oauth, renewed.json.refresh_token);
  assert.equal(limited.status, 429); assert.equal(limited.headers['retry-after'], '60'); assert.equal(oauth.status().tokenDiagnostics.lastFailure.category, 'rate_limited');
  for (const [method, options, statusCode, category] of [
    ['GET', {}, 405, 'invalid_request'],
    ['POST', { raw: '{}', headers: { 'content-type': 'application/json' } }, 415, 'invalid_request'],
    ['POST', { headers: { authorization: 'Bearer deliberately-untrusted-header' } }, 400, 'invalid_client'],
    ['POST', { enabled: false }, 503, 'access_denied'],
  ]) {
    const result = await route(oauth, method, '/chatgpt/oauth/token', options);
    assert.equal(result.status, statusCode);
    assert.deepEqual(oauth.status().tokenDiagnostics.lastFailure, { at: new Date(now()).toISOString(), statusCode, category });
  }
  assert.ok(oauth.getClient(initial.client.id)); assert.deepEqual(revoked, []);
  const before = oauth.status().tokenDiagnostics;
  await route(oauth, 'GET', '/.well-known/oauth-authorization-server');
  await route(oauth, 'POST', '/chatgpt/oauth/revoke', { form: { client_id: CLIENT, token: 'unrecognized-revocation-token' } });
  assert.deepEqual(oauth.status().tokenDiagnostics, before);
});

test('token outcome diagnostics are bounded, detached from callers, secret-free and process-local', async t => {
  const env = await setup(t), { oauth } = env, initial = await grant(oauth);
  const marker = 'private-header-body-and-error-marker-48e9fb12';
  const rejected = await route(oauth, 'POST', '/chatgpt/oauth/token', {
    form: { grant_type: 'refresh_token', client_id: CLIENT, refresh_token: initial.tokens.refresh_token, resource: RESOURCE, private_argument: marker },
    headers: { authorization: 'Bearer ' + marker, cookie: marker, 'x-private-marker': marker },
  });
  assert.equal(rejected.status, 400); const failure = oauth.status().tokenDiagnostics.lastFailure;
  let renewed;
  for (let index = 0; index < 40; index++) { renewed = await refresh(oauth, initial.tokens.refresh_token); assert.equal(renewed.status, 200); }
  const diagnostic = oauth.status().tokenDiagnostics, serialized = JSON.stringify(diagnostic);
  assert.equal(diagnostic.succeeded, 41); assert.equal(diagnostic.failed, 1); assert.equal(diagnostic.recentOutcomes.length, 32);
  assert.ok(diagnostic.recentOutcomes.every(item => item.category === 'refresh_retry_succeeded')); assert.deepEqual(diagnostic.lastFailure, failure);
  assert.deepEqual(Object.keys(diagnostic).sort(), ['failed', 'lastFailure', 'recentOutcomes', 'succeeded']);
  for (const outcome of [...diagnostic.recentOutcomes, diagnostic.lastFailure]) assert.deepEqual(Object.keys(outcome).sort(), ['at', 'category', 'statusCode']);
  for (const secret of [marker, initial.code, VERIFIER, initial.client.id, initial.tokens.access_token, initial.tokens.refresh_token, renewed.json.access_token, renewed.json.refresh_token, CLIENT, RESOURCE]) {
    assert.equal(serialized.includes(secret), false); assert.equal(serialized.includes(createHash('sha256').update(secret).digest('hex')), false);
  }
  diagnostic.lastFailure.category = marker; diagnostic.recentOutcomes[0].at = marker; diagnostic.recentOutcomes.length = 0;
  assert.deepEqual(oauth.status().tokenDiagnostics.lastFailure, failure); assert.equal(oauth.status().tokenDiagnostics.recentOutcomes.length, 32);
  const persisted = await fs.readFile(oauth.file, 'utf8'); assert.doesNotMatch(persisted, /tokenDiagnostics|recentOutcomes|lastFailure/);
  await oauth.close();
  const reopened = await new ChatGPTOAuth({ dataDir: env.dataDir, origin: ORIGIN, now: env.now }).init(); t.after(() => reopened.close());
  assert.deepEqual(reopened.status().tokenDiagnostics, { succeeded: 0, failed: 0, lastFailure: null, recentOutcomes: [] });
  assert.equal((await reopened.authenticateRequest(bearer(renewed.json.access_token))).id, initial.client.id);
});

test('token outcome diagnostics discard unknown exception labels and cannot change token responses', async t => {
  const { oauth } = await setup(t), initial = await grant(oauth), original = oauth.token;
  const secret = 'private-exception-category-and-message-0d32f1a4';
  oauth.token = async () => { throw Object.assign(new Error(secret), { oauthError: secret, status: 500 }); };
  const failed = await refresh(oauth, initial.tokens.refresh_token);
  assert.equal(failed.status, 500); assert.equal(failed.json.error, secret);
  assert.equal(oauth.status().tokenDiagnostics.lastFailure.category, 'server_error'); assert.equal(JSON.stringify(oauth.status().tokenDiagnostics).includes(secret), false);
  oauth.token = original;
  const before = oauth.status().tokenDiagnostics;
  oauth.recordTokenOutcome = () => { throw new Error(secret); };
  const renewed = await refresh(oauth, initial.tokens.refresh_token);
  assert.equal(renewed.status, 200); assert.ok(await oauth.authenticateRequest(bearer(renewed.json.access_token))); assert.deepEqual(oauth.status().tokenDiagnostics, before);
});

test('token outcome diagnostics record a committed outcome without claiming its lost response was delivered', async t => {
  const { oauth } = await setup(t), initial = await grant(oauth);
  const form = new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT, refresh_token: initial.tokens.refresh_token, resource: RESOURCE });
  const req = Readable.from([Buffer.from(form.toString())]);
  req.method = 'POST'; req.url = '/chatgpt/oauth/token'; req.headers = { 'content-type': 'application/x-www-form-urlencoded' };
  const res = { destroyed: true, writeHead() { assert.fail('The disconnected client cannot receive headers.'); }, end() { assert.fail('The disconnected client cannot receive a response.'); } };
  await oauth.handle(req, res, { enabled: true });
  assert.equal(oauth.grants[0].refresh.usedHashes.length, 1);
  assert.deepEqual(oauth.status().tokenDiagnostics.recentOutcomes.map(value => [value.category, value.statusCode]), [['authorization_code_issued', 200], ['refresh_rotated', 200]]);
  const recovered = await refresh(oauth, initial.tokens.refresh_token); assert.equal(recovered.status, 200);
  assert.equal(oauth.status().tokenDiagnostics.recentOutcomes.at(-1).category, 'refresh_retry_succeeded');
});
