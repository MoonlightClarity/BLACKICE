import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { ChatGPTOAuth, CHATGPT_OAUTH_CLIENT_ID, CHATGPT_OAUTH_REDIRECT } from '../lib/chatgpt-oauth.mjs';
import {
  OAUTH_CLIENT_AUTH_METHODS, MAX_REGISTERED_OAUTH_CLIENTS, createRegisteredOAuthClient,
  validateRegisteredOAuthClients, findRegisteredOAuthClient, parseOAuthClientAuthentication,
  verifyRegisteredOAuthClientAuthentication,
} from '../lib/mcp-oauth-clients.mjs';

const ORIGIN = 'https://blackice.example';
const RESOURCE = ORIGIN + '/mcp/chatgpt';
const REDIRECT = 'https://mistral.example/oauth/callback';
const VERIFIER = 'd'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const metadata = (method = 'none', overrides = {}) => ({
  client_name: 'Mistral fixture', redirect_uris: [REDIRECT], token_endpoint_auth_method: method,
  grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], ...overrides,
});
const bearer = token => ({ headers: { authorization: 'Bearer ' + token }, rawHeaders: ['Authorization', 'Bearer ' + token] });

async function setup(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-dcr-'));
  let clock = Date.UTC(2026, 10, 3); const fetches = [];
  const now = () => clock;
  const oauth = await new ChatGPTOAuth({ dataDir, origin: ORIGIN, now, fetcher: async url => {
    fetches.push(url);
    return new Response(JSON.stringify({ client_id: CHATGPT_OAUTH_CLIENT_ID, client_name: 'ChatGPT', redirect_uris: [CHATGPT_OAUTH_REDIRECT], token_endpoint_auth_method: 'none', response_types: ['code'], grant_types: ['authorization_code', 'refresh_token'] }), { headers: { 'Content-Type': 'application/json' } });
  } }).init();
  t.after(async () => { await oauth.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { oauth, dataDir, now, fetches, advance: ms => { clock += ms; } };
}

async function route(oauth, method, url, { json, form, raw, headers = {}, enabled = true } = {}) {
  const text = raw !== undefined ? raw : json !== undefined ? JSON.stringify(json) : form !== undefined ? new URLSearchParams(form).toString() : '';
  const req = Readable.from(text ? [Buffer.from(text)] : []);
  Object.assign(req, { method, url, headers: { ...(json !== undefined ? { 'content-type': 'application/json' } : form !== undefined ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...headers } });
  req.rawHeaders = Object.entries(req.headers).flat();
  const result = { status: null, headers: {}, body: '' };
  const res = { destroyed: false, writeHead(status, values) { result.status = status; for (const [key, value] of Object.entries(values || {})) result.headers[key.toLowerCase()] = value; }, setHeader(key, value) { result.headers[key.toLowerCase()] = value; }, end(value = '') { result.body += value; } };
  await oauth.handle(req, res, { enabled });
  if (String(result.headers['content-type']).startsWith('application/json')) result.json = JSON.parse(result.body);
  return result;
}

async function register(oauth, method = 'none', overrides = {}) {
  const result = await route(oauth, 'POST', '/chatgpt/oauth/register', { json: metadata(method, overrides) });
  assert.equal(result.status, 201, result.body);
  return result.json;
}

function auth(registration, form) {
  const result = { form: { client_id: registration.client_id, ...form } };
  if (registration.token_endpoint_auth_method === 'client_secret_post') result.form.client_secret = registration.client_secret;
  if (registration.token_endpoint_auth_method === 'client_secret_basic') {
    delete result.form.client_id;
    result.headers = { authorization: 'Basic ' + Buffer.from(encodeURIComponent(registration.client_id) + ':' + encodeURIComponent(registration.client_secret)).toString('base64') };
  }
  return result;
}

async function begin(oauth, registration, { scope = 'read files:read', ...overrides } = {}) {
  const params = { response_type: 'code', client_id: registration.client_id, redirect_uri: registration.redirect_uris[0], code_challenge: CHALLENGE, code_challenge_method: 'S256', resource: RESOURCE, state: 'dcr-fixture-state', ...(scope === null ? {} : { scope }), ...overrides };
  const result = await route(oauth, 'GET', '/chatgpt/oauth/authorize?' + new URLSearchParams(params));
  assert.equal(result.status, 200, result.body);
  const id = result.body.match(/data-request="([a-f0-9-]+)"/)[1];
  const cookie = [].concat(result.headers['set-cookie']).find(value => value.startsWith(oauth.cookieName(id) + '=') && !value.includes('Max-Age=0')).split(';')[0];
  return { id, cookie, result };
}

async function code(oauth, registration, options = {}) {
  const request = await begin(oauth, registration, options);
  const requested = oauth.pending().find(item => item.id === request.id).scopes;
  await oauth.approve(request.id, { scopes: options.approvedScopes || requested });
  const polled = await route(oauth, 'GET', '/chatgpt/oauth/pending/' + request.id, { headers: { cookie: request.cookie } });
  assert.equal(polled.status, 200, polled.body);
  const callback = new URL(polled.json.redirect);
  assert.equal(callback.origin + callback.pathname, registration.redirect_uris[0]);
  assert.equal(callback.searchParams.get('state'), 'dcr-fixture-state');
  assert.equal(callback.searchParams.get('iss'), ORIGIN);
  return { ...request, code: callback.searchParams.get('code') };
}

async function exchange(oauth, registration, issued, overrides = {}) {
  return route(oauth, 'POST', '/chatgpt/oauth/token', auth(registration, { grant_type: 'authorization_code', code: issued.code, code_verifier: VERIFIER, redirect_uri: registration.redirect_uris[0], resource: RESOURCE, ...overrides }));
}

async function grant(oauth, registration, options = {}) {
  const issued = await code(oauth, registration, options), response = await exchange(oauth, registration, issued);
  assert.equal(response.status, 200, response.body);
  const client = await oauth.authenticateRequest(bearer(response.json.access_token));
  assert.ok(client);
  return { ...issued, tokens: response.json, client };
}

const legacy = { client_id: CHATGPT_OAUTH_CLIENT_ID, redirect_uris: [CHATGPT_OAUTH_REDIRECT], token_endpoint_auth_method: 'none' };

test('registration generates its own identity, hashes secrets, ignores unknown metadata and validates persisted clients', () => {
  for (const method of OAUTH_CLIENT_AUTH_METHODS) {
    const { client, response } = createRegisteredOAuthClient(metadata(method, { client_id: CHATGPT_OAUTH_CLIENT_ID, client_uri: 'https://unfetched.example', application_type: 'web', vendor_extension: { ignored: true } }));
    assert.match(response.client_id, /^blackice_client_[A-Za-z0-9_-]{43}$/);
    assert.notEqual(response.client_id, CHATGPT_OAUTH_CLIENT_ID);
    assert.equal(response.token_endpoint_auth_method, method);
    assert.deepEqual(response.grant_types, ['authorization_code', 'refresh_token']);
    assert.equal(response.vendor_extension, undefined);
    const checked = validateRegisteredOAuthClients([client]);
    assert.equal(findRegisteredOAuthClient(checked, client.clientId).clientName, 'Mistral fixture');
    checked[0].redirectUris.push('https://changed.example/callback'); assert.equal(client.redirectUris.length, 1);
    if (method === 'none') { assert.equal(client.clientSecretHash, null); assert.equal(response.client_secret, undefined); }
    else { assert.equal(client.clientSecretHash, createHash('sha256').update(response.client_secret).digest('hex')); assert.equal(response.client_secret_expires_at, 0); assert.equal(JSON.stringify(client).includes(response.client_secret), false); }
    assert.throws(() => validateRegisteredOAuthClients([client, client]));
    assert.throws(() => validateRegisteredOAuthClients([{ ...client, clientSecretHash: method === 'none' ? 'a'.repeat(64) : null }]));
  }
  const defaults = createRegisteredOAuthClient({ redirect_uris: [REDIRECT] }).response;
  assert.equal(defaults.token_endpoint_auth_method, 'client_secret_basic'); assert.ok(defaults.client_secret);
  for (const redirect of ['http://mistral.example/callback', 'https://name:secret@mistral.example/callback', REDIRECT + '#fragment', REDIRECT + '#', 'javascript:alert(1)']) assert.throws(() => createRegisteredOAuthClient(metadata('none', { redirect_uris: [redirect] })));
  assert.throws(() => createRegisteredOAuthClient(metadata('none', { grant_types: ['client_credentials'] })));
  assert.throws(() => createRegisteredOAuthClient(metadata('private_key_jwt')));
  assert.throws(() => createRegisteredOAuthClient(metadata('none', { client_name: 'bad\nname' })));
});

test('client authentication enforces each registered method and rejects mixed, duplicate and mismatched credentials', () => {
  for (const method of OAUTH_CLIENT_AUTH_METHODS) {
    const { client, response } = createRegisteredOAuthClient(metadata(method));
    const request = auth(response, {}), req = { headers: request.headers || {}, rawHeaders: Object.entries(request.headers || {}).flat() };
    const parsed = parseOAuthClientAuthentication(request.form, req);
    assert.equal(verifyRegisteredOAuthClientAuthentication(client, parsed), client);
    if (method !== 'none') assert.throws(() => verifyRegisteredOAuthClientAuthentication(client, { ...parsed, clientSecret: 'wrong' }), error => error.oauthError === 'invalid_client');
    assert.throws(() => verifyRegisteredOAuthClientAuthentication(client, { ...parsed, method: method === 'none' ? 'client_secret_post' : 'none' }), error => error.oauthError === 'invalid_client');
    if (method === 'client_secret_basic') {
      assert.equal(parseOAuthClientAuthentication({ client_id: response.client_id }, req).clientId, response.client_id);
      assert.throws(() => parseOAuthClientAuthentication({ client_id: 'another-client' }, req));
      assert.throws(() => parseOAuthClientAuthentication({ client_secret: response.client_secret }, req));
      assert.throws(() => parseOAuthClientAuthentication({}, { ...req, rawHeaders: [...req.rawHeaders, ...req.rawHeaders] }));
    }
  }
  assert.throws(() => parseOAuthClientAuthentication({}, { headers: { authorization: 'Basic abc' } }));
  assert.throws(() => parseOAuthClientAuthentication({ client_id: 'known', client_assertion: 'unsupported' }));
});

test('registered public, Basic and POST clients complete owner-approved OAuth and keep their grant through refresh', async t => {
  for (const method of OAUTH_CLIENT_AUTH_METHODS) await t.test(method, async t => {
    const { oauth, dataDir, fetches } = await setup(t);
    const registration = await register(oauth, method);
    assert.equal(oauth.pending().length, 0); assert.equal(oauth.status().grants.length, 0);
    const initial = await grant(oauth, registration);
    assert.equal(initial.client.kind, 'mcp'); assert.equal(initial.client.label, 'Mistral fixture');
    assert.deepEqual(initial.client.scopes, ['read', 'files:read']); assert.deepEqual(fetches, []);
    const refreshed = await route(oauth, 'POST', '/chatgpt/oauth/token', auth(registration, { grant_type: 'refresh_token', refresh_token: initial.tokens.refresh_token, resource: RESOURCE }));
    assert.equal(refreshed.status, 200, refreshed.body);
    assert.equal((await oauth.authenticateRequest(bearer(refreshed.json.access_token))).id, initial.client.id);
    const disk = await fs.readFile(path.join(dataDir, 'chatgpt-oauth.json'), 'utf8');
    for (const secret of [registration.client_secret, initial.code, initial.tokens.access_token, initial.tokens.refresh_token, refreshed.json.refresh_token].filter(Boolean)) assert.equal(disk.includes(secret), false);
    if (registration.client_secret) assert.equal(JSON.stringify(oauth.status()).includes(registration.client_secret), false);
    const revoked = await route(oauth, 'POST', '/chatgpt/oauth/revoke', auth(registration, { token: refreshed.json.refresh_token }));
    assert.equal(revoked.status, 200); assert.equal(await oauth.authenticateRequest(bearer(refreshed.json.access_token)), null);
  });
});

test('first DCR registration preserves schema-1 ChatGPT grants exactly and both clients survive schema-2 restart', async t => {
  const env = await setup(t), { oauth, dataDir, now } = env;
  const existing = await grant(oauth, legacy);
  const before = JSON.parse(await fs.readFile(oauth.file, 'utf8'));
  assert.equal(before.schema, 1); assert.equal(before.clients, undefined);
  const registration = await register(oauth, 'client_secret_post');
  const migrated = JSON.parse(await fs.readFile(oauth.file, 'utf8'));
  assert.equal(migrated.schema, 2); assert.equal(migrated.clients.length, 1); assert.deepEqual(migrated.grants, before.grants);
  const second = await grant(oauth, registration);
  assert.equal((await oauth.authenticateRequest(bearer(existing.tokens.access_token))).id, existing.client.id);
  await oauth.close();
  const reopened = await new ChatGPTOAuth({ dataDir, origin: ORIGIN, now }).init(); t.after(() => reopened.close());
  assert.equal(reopened.status().healthy, true);
  assert.equal((await reopened.authenticateRequest(bearer(existing.tokens.access_token))).id, existing.client.id);
  assert.equal((await reopened.authenticateRequest(bearer(second.tokens.access_token))).id, second.client.id);
  for (const [clientRegistration, value] of [[legacy, existing], [registration, second]]) {
    const result = await route(reopened, 'POST', '/chatgpt/oauth/token', auth(clientRegistration, { grant_type: 'refresh_token', refresh_token: value.tokens.refresh_token, resource: RESOURCE }));
    assert.equal(result.status, 200, result.body);
    assert.equal((await reopened.authenticateRequest(bearer(result.json.access_token))).id, value.client.id);
  }
  assert.equal((await reopened.authenticateRequest(bearer(existing.tokens.access_token))).id, existing.client.id);
});

test('DCR authorization-code and refresh bindings reject wrong clients, secrets, redirects, resources and verifiers without consuming valid state', async t => {
  const { oauth } = await setup(t);
  const registration = await register(oauth, 'client_secret_basic'), other = await register(oauth, 'client_secret_basic');
  const issued = await code(oauth, registration);
  const wrongSecret = await exchange(oauth, { ...registration, client_secret: 'wrong' }, issued);
  assert.equal(wrongSecret.status, 401); assert.equal(wrongSecret.json.error, 'invalid_client'); assert.match(wrongSecret.headers['www-authenticate'], /^Basic /);
  for (const [clientRegistration, changes, expected] of [
    [other, {}, 'invalid_grant'],
    [registration, { redirect_uri: 'https://other.example/callback' }, 'invalid_grant'],
    [registration, { resource: ORIGIN + '/mcp' }, 'invalid_target'],
    [registration, { code_verifier: 'x'.repeat(64) }, 'invalid_grant'],
  ]) assert.equal((await exchange(oauth, clientRegistration, issued, changes)).json.error, expected);
  const good = await exchange(oauth, registration, issued); assert.equal(good.status, 200, good.body);
  const identity = (await oauth.authenticateRequest(bearer(good.json.access_token))).id;
  const wrongRefresh = await route(oauth, 'POST', '/chatgpt/oauth/token', auth(other, { grant_type: 'refresh_token', refresh_token: good.json.refresh_token, resource: RESOURCE }));
  assert.equal(wrongRefresh.json.error, 'invalid_grant'); assert.ok(oauth.getClient(identity));
  const rightRefresh = await route(oauth, 'POST', '/chatgpt/oauth/token', auth(registration, { grant_type: 'refresh_token', refresh_token: good.json.refresh_token, resource: RESOURCE }));
  assert.equal(rightRefresh.status, 200); assert.equal((await oauth.authenticateRequest(bearer(rightRefresh.json.access_token))).id, identity);
});

test('DCR keeps read-only default and browser-bound owner consent, and displays the actual client origin', async t => {
  const { oauth, fetches } = await setup(t), registration = await register(oauth, 'none', { client_name: '<Mistral & client>' });
  const request = await begin(oauth, registration, { scope: null });
  const pending = oauth.pending()[0];
  assert.equal(pending.clientLabel, '<Mistral & client>'); assert.equal(pending.clientOrigin, 'https://mistral.example'); assert.deepEqual(pending.scopes, ['read']);
  assert.match(request.result.body, /&lt;Mistral &amp; client&gt;/); assert.ok(!request.result.body.includes('<Mistral & client>'));
  const waiting = await route(oauth, 'GET', '/chatgpt/oauth/pending/' + request.id, { headers: { cookie: request.cookie } });
  assert.equal(waiting.json.redirect, undefined); assert.equal(oauth.grants.length, 0);
  await assert.rejects(oauth.approve(request.id, { scopes: ['read', 'files:read'] }), error => error.oauthError === 'invalid_scope');
  const unbound = await route(oauth, 'GET', '/chatgpt/oauth/pending/' + request.id); assert.equal(unbound.status, 403);
  const redirectAttempt = await route(oauth, 'GET', '/chatgpt/oauth/authorize?' + new URLSearchParams({ response_type: 'code', client_id: registration.client_id, redirect_uri: 'https://attacker.example/callback', code_challenge: CHALLENGE, code_challenge_method: 'S256', resource: RESOURCE, state: 'other' }));
  assert.equal(redirectAttempt.json.error, 'invalid_client'); assert.equal(oauth.pending().length, 1); assert.deepEqual(fetches, []);
});

test('registration requires valid bounded JSON and an enabled connector, and never changes the fixed ChatGPT identity', async t => {
  const { oauth } = await setup(t);
  for (const options of [{ json: metadata(), enabled: false }, { raw: '{', headers: { 'content-type': 'application/json' } }, { json: metadata('none', { redirect_uris: ['http://invalid.example/callback'] }) }, { raw: 'x'.repeat(32769), headers: { 'content-type': 'application/json' } }]) {
    const result = await route(oauth, 'POST', '/chatgpt/oauth/register', options);
    assert.ok(result.status >= 400); assert.equal(oauth.clients.length, 0); assert.equal(oauth.grants.length, 0);
  }
  const registration = await register(oauth, 'client_secret_post', { client_name: 'ChatGPT', client_id: CHATGPT_OAUTH_CLIENT_ID });
  assert.notEqual(registration.client_id, CHATGPT_OAUTH_CLIENT_ID);
  const independent = await grant(oauth, registration); assert.equal(independent.client.kind, 'mcp');
  const wrongMethod = await route(oauth, 'POST', '/chatgpt/oauth/token', { form: { grant_type: 'refresh_token', client_id: CHATGPT_OAUTH_CLIENT_ID, client_secret: registration.client_secret, refresh_token: independent.tokens.refresh_token } });
  assert.equal(wrongMethod.json.error, 'invalid_client');
});

test('concurrent registration and legacy refresh preserve both the committed registry and original grant identity', async t => {
  const { oauth } = await setup(t), existing = await grant(oauth, legacy);
  const [registered, refreshed] = await Promise.all([
    register(oauth, 'none'),
    route(oauth, 'POST', '/chatgpt/oauth/token', auth(legacy, { grant_type: 'refresh_token', refresh_token: existing.tokens.refresh_token, resource: RESOURCE })),
  ]);
  assert.equal(refreshed.status, 200);
  const disk = JSON.parse(await fs.readFile(oauth.file, 'utf8'));
  assert.equal(disk.clients[0].clientId, registered.client_id); assert.equal(disk.grants[0].id, existing.client.id);
  assert.equal((await oauth.authenticateRequest(bearer(refreshed.json.access_token))).id, existing.client.id);
});

test('registered-client capacity leaves existing ChatGPT access and registry intact', async t => {
  const { oauth, advance } = await setup(t), existing = await grant(oauth, legacy);
  for (let index = 0; index < MAX_REGISTERED_OAUTH_CLIENTS; index++) {
    if (index && index % 20 === 0) advance(60001);
    await register(oauth, 'none', { client_name: 'Client ' + index });
  }
  const before = await fs.readFile(oauth.file, 'utf8');
  const rejected = await route(oauth, 'POST', '/chatgpt/oauth/register', { json: metadata() });
  assert.equal(rejected.status, 429); assert.equal(oauth.status().healthy, true);
  assert.equal(await fs.readFile(oauth.file, 'utf8'), before);
  assert.equal((await oauth.authenticateRequest(bearer(existing.tokens.access_token))).id, existing.client.id);
});
