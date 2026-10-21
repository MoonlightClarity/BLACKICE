import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RemoteAccessManager } from '../lib/remote-access.mjs';
import { createRemoteTransportFixture } from './fixtures/remote-transport.mjs';

async function fixture(t, { config = {}, saved } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-standard-https-'));
  const transport = createRemoteTransportFixture({ config });
  const file = path.join(dataDir, 'remote-access.json');
  if (saved) await fs.writeFile(file, JSON.stringify(saved));
  const manager = await new RemoteAccessManager({ dataDir, transport: transport.transport }).init();
  t.after(async () => { await manager.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  await manager.attach({ origin: 'http://127.0.0.1:32123', sessionCookie: `relay_session_32123=${'a'.repeat(64)}` });
  return { manager, transport, dataDir, file };
}

test('new BLACKICE profiles prepare canonical standard HTTPS and resume it after restart', async t => {
  const first = await fixture(t);
  assert.equal(first.manager.status().transport.httpsPort, 443);
  const ready = await first.manager.enable({ mode: 'public', confirmPublic: true });
  assert.equal(ready.url, `https://${first.transport.hostname}`);
  assert.equal(first.manager.gateway.publicUrl.host, first.transport.hostname);
  const saved = JSON.parse(await fs.readFile(first.file, 'utf8'));
  assert.equal(saved.httpsPort, 443); assert.equal(saved.ownership.httpsPort, 443);
  await first.manager.close();
  const reopened = await new RemoteAccessManager({ dataDir: first.dataDir, transport: first.transport.transport }).init();
  t.after(() => reopened.close());
  await reopened.attach({ origin: 'http://127.0.0.1:32123', sessionCookie: `relay_session_32123=${'b'.repeat(64)}` });
  assert.equal(reopened.status().enabled, true); assert.equal(reopened.status().url, ready.url);
});

test('standard HTTPS native ownership preserves another public application through start and close', async t => {
  const hostname = 'blackice-fixture.tailtest.ts.net', host = `${hostname}:443`;
  const before = { TCP: { '443': { HTTPS: true } }, Web: { [host]: { Handlers: { '/vision': { Proxy: 'http://127.0.0.1:8790' } } } }, AllowFunnel: { [host]: true } };
  const { manager, transport } = await fixture(t, { config: before });
  await manager.enable({ mode: 'public', confirmPublic: true });
  assert.deepEqual(transport.config.Web[host].Handlers['/vision'], before.Web[host].Handlers['/vision']);
  await manager.close(); assert.deepEqual(transport.config, before);
});

test('an occupied standard HTTPS root is never adopted by preparation', async t => {
  const hostname = 'blackice-fixture.tailtest.ts.net', host = `${hostname}:443`;
  const before = { TCP: { '443': { HTTPS: true } }, Web: { [host]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:8787' } } } }, AllowFunnel: { [host]: true } };
  const { manager, transport } = await fixture(t, { config: before });
  await assert.rejects(manager.enable({ mode: 'public', confirmPublic: true }), { code: 'REMOTE_PORT_IN_USE' });
  assert.deepEqual(transport.config, before); assert.equal(manager.status().enabled, false);
  assert.ok(transport.calls.every(args => args.includes('--json')));
});

test('old saved settings retain their legacy port without silently moving the connection', async t => {
  const { manager, file } = await fixture(t, { saved: { schema: 1, enabled: false, mode: 'private', publicApproved: false, gatewayPort: 0, ownership: null } });
  const ready = await manager.enable();
  assert.equal(ready.transport.httpsPort, 8443); assert.match(ready.url, /:8443$/);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).httpsPort, 8443);
});

test('unsupported saved ports and inconsistent route ownership fail closed without replacing settings', async t => {
  for (const saved of [
    { schema: 1, enabled: false, mode: 'private', publicApproved: false, httpsPort: 8080, gatewayPort: 0, ownership: null },
    { schema: 1, enabled: false, mode: 'private', publicApproved: false, httpsPort: null, gatewayPort: 0, ownership: null },
    { schema: 1, enabled: true, mode: 'public', publicApproved: true, httpsPort: 443, gatewayPort: 32124, ownership: { hostname: 'blackice-fixture.tailtest.ts.net', httpsPort: 8443, target: 'http://127.0.0.1:32124', mode: 'public' } }
  ]) {
    const { manager, file, transport } = await fixture(t, { saved });
    assert.equal(manager.status().available, false); assert.equal(manager.status().enabled, false);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), saved); assert.deepEqual(transport.calls, []);
  }
});
