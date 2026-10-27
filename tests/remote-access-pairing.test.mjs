import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RemoteSessionStore, REMOTE_SCOPES } from '../lib/remote-access-auth.mjs';

async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-pairing-grant-'));
  const sessions = await new RemoteSessionStore({ dataDir, ...options }).init();
  t.after(async () => { await sessions.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { sessions, dataDir };
}

test('browser codes remain compatible while agent codes give one unified agent authority', async t => {
  const { sessions } = await fixture(t);
  const browserGrant = sessions.issuePairing();
  assert.equal(browserGrant.kind, 'browser'); assert.deepEqual(browserGrant.scopes, REMOTE_SCOPES);
  const browser = await sessions.pair(browserGrant.code, 'Browser');
  assert.equal(sessions.authenticate(browser.token).kind, 'browser');
  const agentGrant = sessions.issuePairing({ kind: 'agent' });
  assert.deepEqual(agentGrant.scopes, REMOTE_SCOPES);
  const agent = await sessions.pairAgent(agentGrant.code, 'Agent');
  assert.equal(sessions.authenticate(agent.token), null);
  assert.deepEqual(sessions.authenticate(agent.token, 'agent').scopes, REMOTE_SCOPES);
  assert.equal(agent.device.expiresAt, agentGrant.sessionExpiresAt);
});

test('a code cannot cross between browser and agent redemption even with the correct secret', async t => {
  const { sessions } = await fixture(t);
  const browser = sessions.issuePairing();
  await assert.rejects(sessions.pairAgent(browser.code, 'Agent'), { code: 'REMOTE_PAIRING_INVALID' });
  assert.equal(sessions.status().devices.length, 0);
  assert.equal((await sessions.pair(browser.code)).device.kind, 'browser');
  const agent = sessions.issuePairing({ kind: 'agent', scopes: ['tasks:write'] });
  await assert.rejects(sessions.pair(agent.code), { code: 'REMOTE_PAIRING_INVALID' });
  assert.deepEqual((await sessions.pairAgent(agent.code)).device.scopes, REMOTE_SCOPES);
});

test('agent grants pin explicit permissions and expiration before redemption and expose only copies', async t => {
  let now = Date.now(); const { sessions } = await fixture(t, { now: () => now });
  const selected = ['tasks:write', 'read'];
  const issued = sessions.issuePairing({ kind: 'agent', scopes: selected });
  const sessionExpiry = issued.sessionExpiresAt;
  selected.push('planning:write'); issued.scopes.push('planning:write'); sessions.status().pairing.scopes.push('planning:write');
  now += 120000;
  const paired = await sessions.pairAgent(issued.code, 'App builder', { scopes: REMOTE_SCOPES, expiresAt: '2100-01-01T00:00:00Z' });
  assert.deepEqual(paired.device.scopes, REMOTE_SCOPES);
  assert.equal(paired.device.expiresAt, sessionExpiry);
  assert.equal(Date.parse(paired.device.expiresAt), now - 120000 + 30 * 86400000);
  paired.device.scopes.push('planning:write');
  assert.deepEqual(sessions.authenticate(paired.token, 'agent').scopes, REMOTE_SCOPES);
});

test('agent codes are single-use under concurrent redemption and never persist their secret or bearer token', async t => {
  const { sessions, dataDir } = await fixture(t), issued = sessions.issuePairing({ kind: 'agent' });
  const results = await Promise.allSettled([sessions.pairAgent(issued.code, 'First'), sessions.pairAgent(issued.code, 'Second')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'REMOTE_PAIRING_INVALID').length, 1);
  const paired = results.find(result => result.status === 'fulfilled').value;
  const saved = await fs.readFile(path.join(dataDir, 'remote-access-devices.json'), 'utf8');
  assert.ok(!saved.includes(paired.token)); assert.ok(!saved.includes(issued.code)); assert.ok(!saved.includes(issued.code.replaceAll('-', '')));
  assert.equal(JSON.parse(saved).devices.length, 1);
  await assert.rejects(sessions.pairAgent(issued.code), { code: 'REMOTE_PAIRING_INVALID' });
});

test('invalid grants do not replace a valid code and wrong-kind attempts share the guess limit', async t => {
  const { sessions } = await fixture(t), original = sessions.issuePairing({ kind: 'agent' });
  for (const invalid of [{ kind: 'other' }, { kind: null }, null, []]) assert.throws(() => sessions.issuePairing(invalid));
  for (let attempt = 0; attempt < 8; attempt++) await assert.rejects(sessions.pair(original.code), { code: 'REMOTE_PAIRING_INVALID' });
  assert.equal(sessions.status().pairing.active, false);
  await assert.rejects(sessions.pairAgent(original.code), { code: 'REMOTE_PAIRING_INVALID' });
  assert.equal(sessions.status().devices.length, 0);
});

test('agent grants expire and revoke-all cancels outstanding browser or agent codes', async t => {
  let now = Date.now(); const { sessions } = await fixture(t, { now: () => now });
  const expired = sessions.issuePairing({ kind: 'agent' }); now += 300001;
  await assert.rejects(sessions.pairAgent(expired.code), { code: 'REMOTE_PAIRING_INVALID' });
  const cancelled = sessions.issuePairing({ kind: 'agent' }); await sessions.revokeAll();
  await assert.rejects(sessions.pairAgent(cancelled.code), { code: 'REMOTE_PAIRING_INVALID' });
  assert.equal(sessions.status().pairing.active, false);
});
