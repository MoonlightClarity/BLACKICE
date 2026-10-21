import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteTransportFixture } from './fixtures/remote-transport.mjs';
import { ownsRemoteRoute, remotePortClaimed, unrelatedRemoteConfig, validateRemoteOwnership } from '../lib/remote-access-tailscale.mjs';

const target = 'http://127.0.0.1:32123';
test('private remote access creates and removes only its dedicated 8443 route', async () => {
  const fixture = createRemoteTransportFixture(), before = fixture.config;
  const enabled = await fixture.transport.enable({ target });
  assert.equal(enabled.origin, `https://${fixture.hostname}:8443`); assert.equal(enabled.ownership.mode, 'private'); assert.ok(ownsRemoteRoute(fixture.config, enabled.ownership));
  assert.deepEqual(unrelatedRemoteConfig(fixture.config), before); assert.ok(!fixture.config.AllowFunnel[`${fixture.hostname}:8443`]);
  assert.ok(fixture.calls.some(args => JSON.stringify(args) === JSON.stringify(['serve', '--bg', '--https=8443', target])));
  await fixture.transport.disable(enabled.ownership); assert.deepEqual(fixture.config, before);
  assert.ok(fixture.calls.every(args => !args.includes('reset') && !args.includes('--https=443')));
});

test('explicit public mode uses Funnel on 8443 and retains the preexisting public 443 routes', async () => {
  const fixture = createRemoteTransportFixture(), before = fixture.config;
  const enabled = await fixture.transport.enable({ target, mode: 'public' });
  assert.equal(fixture.config.AllowFunnel[`${fixture.hostname}:8443`], true); assert.equal(enabled.status.private, false);
  assert.deepEqual(unrelatedRemoteConfig(fixture.config), before);
  await fixture.transport.disable(enabled.ownership); assert.deepEqual(fixture.config, before);
  assert.ok(fixture.calls.some(args => args[0] === 'funnel' && args[1] === '--https=8443' && args[2] === 'off'));
});

test('occupied or unowned routes are refused without a mutating CLI command', async () => {
  for (const publicRoute of [false, true]) {
    const fixture = createRemoteTransportFixture(); const config = fixture.config;
    config.TCP['8443'] = { HTTPS: true }; config.Web[`${fixture.hostname}:8443`] = { Handlers: { '/': { Proxy: target } } }; if (publicRoute) config.AllowFunnel[`${fixture.hostname}:8443`] = true; fixture.setConfig(config);
    await assert.rejects(fixture.transport.enable({ target }), { code: 'REMOTE_PORT_IN_USE' });
    assert.deepEqual(fixture.config, config); assert.ok(fixture.calls.every(args => args.includes('--json')));
  }
});

test('only exact saved ownership authorizes changes and a changed route cannot be removed', async () => {
  const fixture = createRemoteTransportFixture(), enabled = await fixture.transport.enable({ target });
  await fixture.transport.enable({ target, ownership: enabled.ownership });
  const changed = fixture.config; changed.Web[`${fixture.hostname}:8443`].Handlers['/'].Proxy = 'http://127.0.0.1:34567'; fixture.setConfig(changed);
  await assert.rejects(fixture.transport.disable(enabled.ownership), { code: 'REMOTE_ROUTE_CHANGED' }); assert.deepEqual(fixture.config, changed);
});

test('ownership rejects hidden extra handlers and foreground collisions', async () => {
  const fixture = createRemoteTransportFixture(), enabled = await fixture.transport.enable({ target });
  const additional = fixture.config; additional.Web[`${fixture.hostname}:8443`].Handlers['/other'] = { Proxy: 'http://127.0.0.1:9999' };
  assert.equal(ownsRemoteRoute(additional, enabled.ownership), false);
  const foreground = fixture.config; foreground.Foreground = { foreign: { TCP: { '8443': { HTTPS: true } } } };
  assert.equal(ownsRemoteRoute(foreground, enabled.ownership), false); assert.equal(remotePortClaimed({ Foreground: foreground.Foreground }), true);
});

test('readback notices changes to unrelated Tailscale services', async () => {
  const fixture = createRemoteTransportFixture(), run = fixture.transport.run;
  fixture.transport.run = async args => { const value = await run(args); if (args.includes('--bg')) { const changed = fixture.config; changed.Web[`${fixture.hostname}:443`].Handlers['/'].Proxy = 'http://127.0.0.1:7777'; fixture.setConfig(changed); } return value; };
  await assert.rejects(fixture.transport.enable({ target }), { code: 'REMOTE_ROUTE_VERIFICATION' });
});

test('offline Tailscale and invalid network targets fail without exposure', async () => {
  const fixture = createRemoteTransportFixture({ online: false }); await assert.rejects(fixture.transport.enable({ target }), { code: 'REMOTE_TAILSCALE_OFFLINE' });
  assert.ok(fixture.calls.every(args => args.includes('--json')));
  for (const value of ['http://0.0.0.0:32123', 'http://127.0.0.1:32123/path', 'https://127.0.0.1:32123', 'http://user:secret@127.0.0.1:32123']) assert.throws(() => validateRemoteOwnership({ hostname: fixture.hostname, httpsPort: 8443, target: value, mode: 'private' }), { code: 'REMOTE_OWNERSHIP_INVALID' });
  assert.throws(() => validateRemoteOwnership({ hostname: fixture.hostname, httpsPort: 444, target, mode: 'private' }), { code: 'REMOTE_OWNERSHIP_INVALID' });
});

function standardFixture({ shared = true, publicPaths = true } = {}) {
  const fixture = createRemoteTransportFixture({ config: shared ? undefined : {} });
  if (shared) { const config = fixture.config; delete config.Web[`${fixture.hostname}:443`].Handlers['/']; if (!publicPaths) delete config.AllowFunnel[`${fixture.hostname}:443`]; fixture.setConfig(config); }
  return fixture;
}

test('explicit standard HTTPS owns only root and preserves Vision and unrelated8443 routes', async () => {
  const fixture = standardFixture(), config = fixture.config;
  config.TCP['8443'] = { HTTPS: true }; config.Web[`${fixture.hostname}:8443`] = { Handlers: { '/': { Proxy: 'http://127.0.0.1:9876' } } }; fixture.setConfig(config);
  const before = fixture.config, enabled = await fixture.transport.enable({ target, mode: 'public', httpsPort: 443 });
  assert.equal(enabled.origin, `https://${fixture.hostname}`); assert.equal(enabled.ownership.httpsPort, 443); assert.equal(enabled.status.httpsPort, 443);
  assert.ok(ownsRemoteRoute(fixture.config, enabled.ownership)); assert.equal(remotePortClaimed(before, 443), false); assert.equal(remotePortClaimed(fixture.config, 443), true);
  assert.deepEqual(unrelatedRemoteConfig(fixture.config, enabled.ownership), before);
  assert.ok(fixture.calls.some(args => JSON.stringify(args) === JSON.stringify(['funnel', '--bg', '--https=443', '--set-path=/', target])));
  const count = fixture.calls.filter(args => args.includes('--bg')).length; await fixture.transport.enable({ target, mode: 'public', httpsPort: 443, ownership: enabled.ownership }); assert.equal(fixture.calls.filter(args => args.includes('--bg')).length, count);
  await fixture.transport.disable(enabled.ownership); assert.deepEqual(fixture.config, before);
  assert.ok(fixture.calls.some(args => JSON.stringify(args) === JSON.stringify(['funnel', '--https=443', '--set-path=/', 'off'])));
  assert.ok(fixture.calls.every(args => !args.includes('off') || args.includes('--set-path=/')));
});

test('standard HTTPS never adopts an unowned root even when its target matches', async () => {
  for (const sameTarget of [false, true]) {
    const fixture = createRemoteTransportFixture();
    if (sameTarget) { const config = fixture.config; config.Web[`${fixture.hostname}:443`].Handlers['/'].Proxy = target; fixture.setConfig(config); }
    const before = fixture.config; await assert.rejects(fixture.transport.enable({ target, mode: 'public', httpsPort: 443 }), { code: 'REMOTE_PORT_IN_USE' });
    assert.deepEqual(fixture.config, before); assert.ok(fixture.calls.every(args => args.includes('--json')));
  }
});

test('standard HTTPS refuses exposure changes affecting other public or private paths', async () => {
  for (const publicPaths of [false, true]) {
    const fixture = standardFixture({ publicPaths }), before = fixture.config;
    await assert.rejects(fixture.transport.enable({ target, mode: publicPaths ? 'private' : 'public', httpsPort: 443 }), { code: 'REMOTE_PORT_IN_USE' });
    assert.deepEqual(fixture.config, before); assert.ok(fixture.calls.every(args => args.includes('--json')));
  }
});

test('standard HTTPS creates and removes an otherwise unused listener in either exposure mode', async () => {
  for (const mode of ['private', 'public']) {
    const fixture = standardFixture({ shared: false }), enabled = await fixture.transport.enable({ target, mode, httpsPort: 443 });
    assert.ok(ownsRemoteRoute(fixture.config, enabled.ownership)); assert.equal(enabled.origin, `https://${fixture.hostname}`);
    await fixture.transport.disable(enabled.ownership); assert.deepEqual(fixture.config, {});
    assert.deepEqual(await fixture.transport.disable(enabled.ownership), { removed: false, status: (await fixture.transport.inspect({ httpsPort: 443 })).status });
  }
});

test('standard HTTPS refuses foreign hosts, foreground listeners, opaque metadata, and TCP forwarding', async () => {
  const changes = [
    (config, hostname) => { config.Web[`other.tailtest.ts.net:443`] = config.Web[`${hostname}:443`]; delete config.Web[`${hostname}:443`]; },
    config => { config.Foreground = { other: { TCP: { '443': { HTTPS: true } } } }; },
    config => { config.TCP['443'] = { TCPForward: '127.0.0.1:1234' }; },
    (config, hostname) => { config.Web[`${hostname}:443`].Unexpected = true; },
  ];
  for (const change of changes) {
    const fixture = standardFixture(), config = fixture.config; change(config, fixture.hostname); fixture.setConfig(config);
    await assert.rejects(fixture.transport.enable({ target, mode: 'public', httpsPort: 443 }), { code: 'REMOTE_PORT_IN_USE' });
    assert.deepEqual(fixture.config, config); assert.ok(fixture.calls.every(args => args.includes('--json')));
  }
});

test('standard HTTPS readback rejects an unrelated path change during enable or removal', async () => {
  for (const duringDisable of [false, true]) {
    const fixture = standardFixture(); let own;
    if (duringDisable) own = (await fixture.transport.enable({ target, mode: 'public', httpsPort: 443 })).ownership;
    const run = fixture.transport.run;
    fixture.transport.run = async args => { const result = await run(args); if (args.includes(duringDisable ? 'off' : '--bg')) { const config = fixture.config; config.Web[`${fixture.hostname}:443`].Handlers['/vision'].Proxy = 'http://127.0.0.1:9999'; fixture.setConfig(config); } return result; };
    await assert.rejects(duringDisable ? fixture.transport.disable(own) : fixture.transport.enable({ target, mode: 'public', httpsPort: 443 }), { code: 'REMOTE_ROUTE_VERIFICATION' });
  }
});

test('standard HTTPS ownership permits other paths but refuses a replaced root', async () => {
  const fixture = standardFixture(), enabled = await fixture.transport.enable({ target, mode: 'public', httpsPort: 443 });
  const extra = fixture.config; extra.Web[`${fixture.hostname}:443`].Handlers['/other'] = { Proxy: 'http://127.0.0.1:9999' }; fixture.setConfig(extra);
  assert.ok(ownsRemoteRoute(extra, enabled.ownership));
  extra.Web[`${fixture.hostname}:443`].Handlers['/'].Proxy = 'http://127.0.0.1:9998'; fixture.setConfig(extra);
  await assert.rejects(fixture.transport.disable(enabled.ownership), { code: 'REMOTE_ROUTE_CHANGED' }); assert.deepEqual(fixture.config, extra);
});

test('only explicit supported HTTPS ports are accepted before any CLI request', async () => {
  assert.equal(validateRemoteOwnership({ hostname: 'blackice-fixture.tailtest.ts.net', httpsPort: 443, target, mode: 'private' }).httpsPort, 443);
  for (const httpsPort of [80, 444, '443', null]) {
    const fixture = standardFixture({ shared: false }); await assert.rejects(fixture.transport.enable({ target, httpsPort }), { code: 'REMOTE_OWNERSHIP_INVALID' }); assert.deepEqual(fixture.calls, []);
  }
});
