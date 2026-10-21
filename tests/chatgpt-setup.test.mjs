import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ChatGPTSetup } from '../lib/chatgpt-setup.mjs';

const origin = 'https://another-computer.example';
const endpoint = origin + '/mcp/chatgpt';
const timestamp = '2026-10-20T15:00:00.000Z';
async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-setup-'));
  const state = { available: true, enabled: true, endpoint, oauth: { healthy: true, ready: true, grants: [], requests: [] }, lastAuthenticatedToolCall: null };
  const remote = { enabled: true, mode: 'public', state: 'ready', url: origin };
  const connector = { status: async () => structuredClone(state) }, remoteAccess = { status: () => structuredClone(remote) };
  const setup = await new ChatGPTSetup({ dataDir, connector, remoteAccess, ...options }).init();
  t.after(async () => { await setup.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { setup, state, remote, dataDir, connector, remoteAccess };
}
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
function validFetch(calls) {
  return async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/.well-known/oauth-protected-resource/mcp/chatgpt')) return json({ resource: endpoint, authorization_servers: [origin] });
    if (url.endsWith('/.well-known/oauth-authorization-server')) return json({ issuer: origin, authorization_endpoint: origin + '/chatgpt/oauth/authorize', token_endpoint: origin + '/chatgpt/oauth/token', client_id_metadata_document_supported: true, code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
    return json({ jsonrpc: '2.0', id: 'blackice-setup-catalog', result: { tools: [{ name: 'blackice_direct_status', securitySchemes: [{ type: 'oauth2', scopes: ['read'] }] }] } });
  };
}

test('onboarding uses this host’s address and does not contact the network during polling', async t => {
  const calls = [], f = await fixture(t, { fetchImpl: validFetch(calls) });
  const first = await f.setup.snapshot(), second = await f.setup.snapshot();
  assert.equal(first.ready, true); assert.equal(first.stage, 'register');
  assert.equal(first.serverUrl, endpoint); assert.equal(first.chatGPTUrl, 'https://chatgpt.com/plugins');
  assert.equal(first.verification.nonce, second.verification.nonce);
  assert.match(first.verification.prompt, new RegExp(first.verification.nonce));
  assert.match(first.verification.prompt, /Do not use another connector/);
  assert.deepEqual(calls, []);
  assert.doesNotMatch(JSON.stringify(first), /plugins_6ad|tail56a102|Owner login/);
});

test('local readiness requires healthy storage and an enabled public owned route', async t => {
  const f = await fixture(t);
  for (const change of [() => { f.remote.mode = 'private'; }, () => { f.remote.mode = 'public'; f.remote.state = 'error'; }, () => { f.remote.state = 'ready'; f.remote.url = 'https://other.example'; }, () => { f.remote.url = origin; f.state.enabled = false; }, () => { f.state.enabled = true; f.state.oauth.ready = false; }, () => { f.state.oauth.ready = true; f.state.available = false; }]) {
    change(); const value = await f.setup.snapshot(); assert.equal(value.ready, false); assert.equal(value.stage, 'prepare');
    await assert.rejects(f.setup.check(), /Prepare this computer/);
  }
});

test('only a matching authenticated status receipt from an active grant enables user confirmation', async t => {
  const f = await fixture(t), initial = await f.setup.snapshot(), nonce = initial.verification.nonce;
  f.state.oauth.grants = [{ id: 'grant_one', scopes: ['read'] }];
  for (const receipt of [null, { tool: 'blackice_direct_status', nonce: 'different', clientId: 'grant_one', at: timestamp }, { tool: 'blackice_get_job', nonce, clientId: 'grant_one', at: timestamp }, { tool: 'blackice_direct_status', nonce, clientId: 'revoked', at: timestamp }]) {
    f.state.lastAuthenticatedToolCall = receipt;
    await assert.rejects(f.setup.confirm(nonce), /matching BLACKICE status/);
  }
  f.state.lastAuthenticatedToolCall = { tool: 'blackice_direct_status', nonce, clientId: 'grant_one', at: timestamp };
  assert.equal((await f.setup.snapshot()).stage, 'received');
  await assert.rejects(f.setup.confirm('wrong'), /matching BLACKICE status/);
  const confirmed = await f.setup.confirm(nonce); assert.equal(confirmed.stage, 'confirmed'); assert.ok(confirmed.verification.confirmedAt);
  // Later ordinary tool calls do not erase the explicit onboarding receipt.
  f.state.lastAuthenticatedToolCall = { tool: 'blackice_get_job', clientId: 'grant_one', at: timestamp };
  assert.equal((await f.setup.snapshot()).stage, 'confirmed');
});

test('confirmation survives restart but cannot survive revocation or an origin change', async t => {
  const f = await fixture(t), nonce = (await f.setup.snapshot()).verification.nonce;
  f.state.oauth.grants = [{ id: 'grant_one', scopes: ['read'] }];
  f.state.lastAuthenticatedToolCall = { tool: 'blackice_direct_status', nonce, clientId: 'grant_one', at: timestamp };
  await f.setup.confirm(nonce); await f.setup.close(); f.state.lastAuthenticatedToolCall = null;
  const resumed = await new ChatGPTSetup({ dataDir: f.dataDir, connector: f.connector, remoteAccess: f.remoteAccess }).init(); t.after(() => resumed.close());
  assert.equal((await resumed.snapshot()).stage, 'confirmed');
  f.state.oauth.grants = [];
  const revoked = await resumed.snapshot(); assert.equal(revoked.stage, 'register'); assert.notEqual(revoked.verification.nonce, nonce); assert.equal(revoked.verification.confirmedAt, undefined);
  const oldNonce = revoked.verification.nonce;
  f.remote.url = 'https://new-host.example:8443'; f.state.endpoint = f.remote.url + '/mcp/chatgpt';
  assert.notEqual((await resumed.snapshot()).verification.nonce, oldNonce);
  const stored = await fs.readFile(path.join(f.dataDir, 'chatgpt-setup.json'), 'utf8');
  assert.doesNotMatch(stored, /access_token|refresh_token|authorization_code|password|cookie/i);
});

test('moving this computer from 8443 to standard HTTPS resets its old connection evidence', async t => {
  const f = await fixture(t), previousOrigin = origin + ':8443';
  f.remote.url = previousOrigin; f.state.endpoint = previousOrigin + '/mcp/chatgpt';
  const previous = await f.setup.snapshot(), nonce = previous.verification.nonce;
  f.state.oauth.grants = [{ id: 'previous-port-grant', scopes: ['read'] }];
  f.state.lastAuthenticatedToolCall = { tool: 'blackice_direct_status', nonce, clientId: 'previous-port-grant', at: timestamp };
  assert.equal((await f.setup.confirm(nonce)).stage, 'confirmed');
  // OAuth invalidates the old resource-bound grant when the owned origin changes.
  f.remote.url = origin; f.state.endpoint = endpoint; f.state.oauth.grants = []; f.state.lastAuthenticatedToolCall = null;
  const migrated = await f.setup.snapshot();
  assert.equal(migrated.ready, true); assert.equal(migrated.stage, 'register'); assert.equal(migrated.serverUrl, endpoint);
  assert.notEqual(migrated.verification.nonce, nonce);
  assert.equal(migrated.verification.receivedAt, undefined); assert.equal(migrated.verification.confirmedAt, undefined);
  await assert.rejects(f.setup.confirm(nonce), /matching BLACKICE status/);
  const stored = JSON.parse(await fs.readFile(path.join(f.dataDir, 'chatgpt-setup.json'), 'utf8'));
  assert.equal(stored.serverUrl, endpoint); assert.equal(stored.received, null); assert.equal(stored.confirmedAt, null);
});

test('the authenticated receipt observer captures a nonce even when another tool finishes before polling', async t => {
  const f = await fixture(t), nonce = (await f.setup.snapshot()).verification.nonce;
  f.state.oauth.grants = [{ id: 'grant_one', scopes: ['read'] }];
  await f.setup.record({ tool: 'blackice_direct_status', nonce, clientId: 'grant_one', at: timestamp });
  f.state.lastAuthenticatedToolCall = { tool: 'blackice_get_job', clientId: 'grant_one', at: timestamp };
  assert.equal((await f.setup.snapshot()).stage, 'received');
  assert.equal((await f.setup.confirm(nonce)).stage, 'confirmed');
});

test('public checks are bounded discovery-only requests with no credentials or model turn', async t => {
  const calls = [], f = await fixture(t, { fetchImpl: validFetch(calls) });
  const result = await f.setup.check(); assert.equal(result.diagnostics.ok, true); assert.equal(result.stage, 'register');
  assert.equal(calls.length, 3); assert.ok(calls.every(call => call.url.startsWith(origin + '/') && call.options.credentials === 'omit' && call.options.redirect === 'error' && !call.options.headers.Authorization));
  assert.deepEqual(JSON.parse(calls.find(call => call.options.method === 'POST').options.body), { jsonrpc: '2.0', id: 'blackice-setup-catalog', method: 'tools/list', params: {} });
  assert.equal(result.verification.receivedAt, undefined); assert.equal(result.verification.confirmedAt, undefined);
  assert.match(result.diagnostics.limitation, /Only a matching result shown in ChatGPT/);
});

test('wrong OAuth issuer, redirects, and oversized responses cannot pass diagnostics or confirm a chat', async t => {
  const f = await fixture(t, { fetchImpl: async () => json({ resource: endpoint, authorization_servers: [origin], issuer: 'https://attacker.example' }) });
  const result = await f.setup.check(); assert.equal(result.diagnostics.ok, false); assert.equal(result.diagnostics.checks.find(check => check.key === 'oauth').ok, false);
  f.setup.fetchImpl = async () => new Response('x'.repeat(65537), { headers: { 'Content-Type': 'application/json' } });
  assert.ok((await f.setup.check()).diagnostics.checks.every(check => !check.ok));
  f.setup.fetchImpl = async () => ({ ok: true, url: 'https://attacker.example', headers: new Headers({ 'Content-Type': 'application/json' }) });
  assert.ok((await f.setup.check()).diagnostics.checks.every(check => !check.ok));
});

test('concurrent checks coalesce and closing aborts the network check without authorizing anything', async t => {
  let calls = 0, enter; const entered = new Promise(resolve => { enter = resolve; });
  const f = await fixture(t, { fetchImpl: async (url, { signal }) => { calls++; enter(); return new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(Error('Stopped')), { once: true }); }); } });
  const first = f.setup.check(), second = f.setup.check(); assert.equal(first, second);
  await entered; await f.setup.close(); assert.equal(calls, 3);
  assert.equal((await first).diagnostics.ok, false); assert.equal(f.state.oauth.grants.length, 0);
  await assert.rejects(f.setup.confirm('anything'), /closing/);
});

test('damaged optional setup history is preserved without touching OAuth state', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.dataDir, 'chatgpt-setup.json'), '{broken');
  await fs.writeFile(path.join(f.dataDir, 'chatgpt-oauth.json'), 'leave-auth-alone');
  const repaired = await new ChatGPTSetup({ dataDir: f.dataDir, connector: f.connector, remoteAccess: f.remoteAccess }).init(); t.after(() => repaired.close());
  const snapshot = await repaired.snapshot(); assert.match(snapshot.recoveryNotice, /history was preserved/);
  const backup = (await fs.readdir(f.dataDir)).find(name => name.startsWith('chatgpt-setup.json.unreadable-'));
  assert.equal(await fs.readFile(path.join(f.dataDir, backup), 'utf8'), '{broken');
  assert.equal(await fs.readFile(path.join(f.dataDir, 'chatgpt-oauth.json'), 'utf8'), 'leave-auth-alone');
});
