import test from 'node:test';
import assert from 'node:assert/strict';
import { executeConnectedBrowser } from '../lib/mcp.mjs';

test('configured Neo screenshot uses its native schema without a contained-browser prerequisite', async () => {
  const calls = [], manager = {
    signedBrowser: { connectionId: 'neo-task', available: true, background: true },
    redact: String, list:()=>[{id:'neo-task',name:'BrowserOS Neo',enabled:true}], clients:new Map([['neo-task',{tools:[{name:'screenshot'}]}]]),
    refreshSignedBrowser: async () => { calls.push('refresh'); return { available: true }; },
    connect: async () => ({tools:[{name:'screenshot'}]}),
    call: async (id, name, args) => { calls.push({ id, name, args }); return { content: [{ type: 'image', mimeType: 'image/png', data: 'native-fixture-pixels' }] }; },
  };
  const gateway = (request=>executeConnectedBrowser({manager,...request}));
  for (const args of [{ page: 7, format: 'png' }, { page: 7, fullPage: true }]) {
    const result = await gateway({ action: 'call', connectionId: 'neo-task', name: 'screenshot', arguments: args });
    assert.equal(result.success, true); assert.equal(result.contentItems[0].imageUrl, 'data:image/png;base64,native-fixture-pixels');
  }
  assert.deepEqual(calls, [
    { id: 'neo-task', name: 'screenshot', args: { page: 7, format: 'png' } },
    { id: 'neo-task', name: 'screenshot', args: { page: 7, fullPage: true } },
  ], 'native screenshots are forwarded once without a contained-browser or window-focus gate');
});
