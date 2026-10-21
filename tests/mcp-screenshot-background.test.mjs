import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionToolHandler } from '../lib/mcp.mjs';

for (const containedBrowser of [false, true]) test(`external Neo screenshot has no agent route, contained=${containedBrowser}`, async () => {
  const calls = [], manager = {
    signedBrowser: { connectionId: 'neo-task', available: true, background: true },
    redact: String,
    refreshSignedBrowser: async () => { calls.push('refresh'); return { available: true }; },
    connect: async () => { calls.push('connect'); },
    call: async () => { calls.push('capture'); },
  };
  const gateway = createConnectionToolHandler({ manager, containedBrowser });
  for (const args of [{ page: 7, format: 'png' }, { page: 7, fullPage: true }, { page: '7' }]) {
    const result = await gateway({ name: 'relay_connections', arguments: { action: 'call', connectionId: 'neo-task', name: 'screenshot', arguments: args } });
    assert.equal(result.success, false); assert.match(result.contentItems[0].text, /External Neo interaction is disabled/);
  }
  assert.deepEqual(calls, [], 'the gateway never enters a native capture broker or prepares a browser');
});
