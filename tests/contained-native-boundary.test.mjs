import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopToolHandler, desktopToolForContainment, DESKTOP_TOOL } from '../lib/desktop-tools.mjs';
import { DesktopController } from '../lib/desktop.mjs';

test('contained mode exposes semantic mutations while retaining native targeting and value validation', async () => {
  const requests = [];
  const desktop = new DesktopController({ platform: 'win32', runner: async request => { requests.push(request); return { text: 'done' }; } });
  desktop.setEnabled(true);
  const handler = createDesktopToolHandler({ desktop, contained: true });
  const call = arguments_ => handler({ name: 'relay_desktop', arguments: arguments_ });
  const ref = 'uia_0123456789ab_1';
  for (const args of [
    { action: 'invoke' }, { action: 'invoke', ref: 'guessed' }, { action: 'invoke', ref, windowId: '123' },
    { action: 'set_value', ref, value: true }, { action: 'set_value', ref, value: 'bad\0value' },
    { action: 'scroll', ref, direction: 'diagonal' }, { action: 'scroll', ref, direction: 'down', amount: 11 },
  ]) await assert.rejects(call(args), { code: 'DESKTOP_VALIDATION' });
  assert.deepEqual(requests, [], 'invalid semantic requests never reach the native helper');
  assert.equal((await call({ action: 'set_value', ref, value: 'authorized edit' })).success, true);
  assert.equal((await call({ action: 'scroll', ref, direction: 'down' })).success, true);
  assert.deepEqual(requests, [
    { action: 'set_value', ref, value: 'authorized edit' },
    { action: 'scroll', ref, direction: 'down', amount: 1, unit: 'large' },
  ]);
  const tool = desktopToolForContainment(true);
  assert.deepEqual(desktopToolForContainment(false), tool);
  assert.deepEqual(tool, DESKTOP_TOOL);
  tool.inputSchema.properties.action.enum.length = 0;
  assert.ok(DESKTOP_TOOL.inputSchema.properties.action.enum.includes('invoke'), 'saved catalogs are independent copies');
});
