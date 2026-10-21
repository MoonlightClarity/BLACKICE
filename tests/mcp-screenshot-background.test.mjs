import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionToolHandler } from '../lib/mcp.mjs';

for (const containedBrowser of [false, true]) test(`configured Neo screenshot uses its native schema, contained=${containedBrowser}`, async () => {
  const calls = [], manager = {
    signedBrowser: { connectionId: 'neo-task', available: true, background: true },
    redact: String,
    refreshSignedBrowser: async () => { calls.push('refresh'); return { available: true }; },
    connect: async () => { calls.push('connect'); },
    call: async (id, name, args) => { calls.push({ id, name, args }); return { content: [{ type: 'image', mimeType: 'image/png', data: 'native-fixture-pixels' }] }; },
  };
  const gateway = createConnectionToolHandler({ manager, containedBrowser });
  for (const args of [{ page: 7, format: 'png' }, { page: 7, fullPage: true }]) {
    const result = await gateway({ name: 'relay_connections', arguments: { action: 'call', connectionId: 'neo-task', name: 'screenshot', arguments: args } });
    assert.equal(result.success, true); assert.equal(result.contentItems[0].imageUrl, 'data:image/png;base64,native-fixture-pixels');
  }
  assert.deepEqual(calls, [
    { id: 'neo-task', name: 'screenshot', args: { page: 7, format: 'png' } },
    { id: 'neo-task', name: 'screenshot', args: { page: 7, fullPage: true } },
  ], 'native screenshots are forwarded once without a contained-browser or window-focus gate');
});
