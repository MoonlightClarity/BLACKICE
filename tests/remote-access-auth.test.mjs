import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RemoteSessionStore, REMOTE_SCOPES, validateRemoteScopes } from '../lib/remote-access-auth.mjs';

async function fixture(t, options = {}) { const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-remote-auth-')); const sessions = await new RemoteSessionStore({ dataDir, ...options }).init(); t.after(async () => { await sessions.close(); await fs.rm(dataDir, { recursive: true, force: true }); }); return { sessions, dataDir }; }

test('a pairing code is single-use even when two clients submit concurrently', async t => {
  const { sessions } = await fixture(t); const code = sessions.issuePairing().code;
  assert.match(code, /^(?:[A-F0-9]{4}-){7}[A-F0-9]{4}$/);
  const results = await Promise.allSettled([sessions.pair(code, 'First browser'), sessions.pair(code, 'Second browser')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'REMOTE_PAIRING_INVALID').length, 1);
  assert.equal(sessions.status().pairing.active, false); assert.equal(sessions.status().devices.length, 1);
});

test('pairing expires and stops accepting guesses after eight failed attempts', async t => {
  let now = Date.now(); const { sessions } = await fixture(t, { now: () => now });
  const first = sessions.issuePairing(); now += 300001; await assert.rejects(sessions.pair(first.code), { code: 'REMOTE_PAIRING_INVALID' });
  const second = sessions.issuePairing();
  for (let attempt = 0; attempt < 8; attempt++) await assert.rejects(sessions.pair('wrong code'), { code: 'REMOTE_PAIRING_INVALID' });
  assert.equal(sessions.status().pairing.active, false); await assert.rejects(sessions.pair(second.code), { code: 'REMOTE_PAIRING_INVALID' });
  const third = sessions.issuePairing(); assert.ok((await sessions.pair(third.code)).token);
});

test('credentials persist only as hashes and browser cookies cannot become agent credentials', async t => {
  const { sessions, dataDir } = await fixture(t); const browser = await sessions.pair(sessions.issuePairing().code, 'Laptop');
  const agent = await sessions.createAgent({ label: 'Cloud worker', scopes: ['planning:write', 'read'] });
  assert.match(agent.token, /^blackice_agent_[A-Za-z0-9_-]{43}$/);
  assert.equal(sessions.authenticate(agent.token), null); assert.equal(sessions.authenticate(browser.token, 'agent'), null);
  assert.deepEqual(sessions.authenticate(agent.token, 'agent').scopes, REMOTE_SCOPES);
  assert.deepEqual(sessions.authenticate(browser.token).scopes, REMOTE_SCOPES);
  const stored = await fs.readFile(path.join(dataDir, 'remote-access-devices.json'), 'utf8');
  assert.ok(!stored.includes(browser.token) && !stored.includes(agent.token)); assert.ok(!JSON.stringify(sessions.status()).includes('hash'));
  const reopened = await new RemoteSessionStore({ dataDir }).init(); t.after(() => reopened.close());
  assert.equal(reopened.authenticate(browser.token).kind, 'browser'); assert.equal(reopened.authenticate(agent.token, 'agent').kind, 'agent');
});

test('legacy scope labels are validated but no per-action authorization tier is introduced', async t => {
  const { sessions } = await fixture(t);
  for (const scopes of [[], ['*'], ['read', 'read'], 'read', ['read', 'desktop:write']]) assert.throws(() => validateRemoteScopes(scopes), { code: 'REMOTE_SCOPES_INVALID' }); // Persisted historical scope records remain validated.
  await assert.rejects(sessions.createAgent({ label: 'Bad\nname', scopes: ['read'] }), { code: 'REMOTE_DEVICE_NAME' });
  const issued = await sessions.createAgent({ label: 'Reader', scopes: ['read'] }); issued.device.scopes.push('tasks:write');
  const publicInfo = sessions.status(); publicInfo.devices[0].scopes.push('planning:write');
  assert.deepEqual(sessions.authenticate(issued.token, 'agent').scopes, REMOTE_SCOPES); // Issuance has full agent authority and returned records are copies.
});

test('independent revocation and expiry invalidate only the selected client', async t => {
  let now = Date.now(); const { sessions } = await fixture(t, { now: () => now, sessionLifetimeMs: 1000 });
  const a = await sessions.createAgent({ label: 'A' }), b = await sessions.createAgent({ label: 'B' });
  const revoked = []; sessions.on('revoked', ids => revoked.push(...ids)); await sessions.revoke(a.device.id);
  assert.equal(sessions.authenticate(a.token, 'agent'), null); assert.ok(sessions.authenticate(b.token, 'agent')); assert.deepEqual(revoked, [a.device.id]);
  now += 1001; assert.equal(sessions.authenticate(b.token, 'agent'), null); assert.equal(sessions.getClient(b.device.id), null); assert.deepEqual(sessions.status().devices, []);
});

test('malformed credential storage is preserved and fails closed', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-remote-malformed-')); t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const file = path.join(dataDir, 'remote-access-devices.json'), original = '{"schema":1,"devices":[{"hash":"plaintext"}]}'; await fs.writeFile(file, original);
  await assert.rejects(new RemoteSessionStore({ dataDir }).init(), { code: 'REMOTE_DEVICES_UNREADABLE' }); assert.equal(await fs.readFile(file, 'utf8'), original);
});

test('the client limit counts browsers and agents and revoke-all clears all credentials', async t => {
  const { sessions } = await fixture(t); const tokens = [];
  for (let index = 0; index < 20; index++) tokens.push((await sessions.createAgent({ label: `Agent ${index}` })).token);
  await assert.rejects(sessions.createAgent({ label: 'Overflow' }), { code: 'REMOTE_DEVICE_LIMIT' }); assert.throws(() => sessions.issuePairing(), { code: 'REMOTE_DEVICE_LIMIT' });
  await sessions.revokeAll(); assert.deepEqual(sessions.status().devices, []); for (const token of tokens) assert.equal(sessions.authenticate(token, 'agent'), null);
});
