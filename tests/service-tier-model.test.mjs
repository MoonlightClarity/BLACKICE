import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceTierSupport } from '../public/service-tier-model.mjs';
import nativeLuna from './fixtures/native-luna-speed-catalog.json' with { type: 'json' };

test('captured native Luna metadata advertises Fast using the upstream priority tier', () => {
  const status = { defaultModel: nativeLuna.id, models: [nativeLuna] };
  assert.equal(serviceTierSupport(status, 'default', 'fast').available, true);
  assert.equal(serviceTierSupport(status, nativeLuna.id, 'fast').available, true);
  assert.equal(serviceTierSupport(status, 'default', 'fast').verified, true);
});

test('Fast requires the exact advertised native tier and stays separate from effort', () => {
  const status = { defaultModel: 'luna', models: [{ id: 'luna', serviceTiers: [{ id: 'fast' }], supportedReasoningEfforts: ['max'] }] };
  assert.equal(serviceTierSupport(status, 'default', 'fast').available, true);
  assert.equal(serviceTierSupport(status, 'luna', 'fast').available, true);
  assert.equal(serviceTierSupport({ defaultModel: 'gpt-6-luna', models: [{ id: 'gpt-6-luna', supportedReasoningEfforts: ['max'] }] }, 'default', 'fast').available, false);
  assert.equal(serviceTierSupport({ models: [{ id: 'luna', serviceTiers: [{ id: 'priority' }] }] }, 'luna', 'fast').available, true);
  assert.equal(serviceTierSupport(status, 'luna', 'priority').available, false);
});

test('additionalSpeedTiers is a fallback only when serviceTiers is absent', () => {
  assert.equal(serviceTierSupport({ models: [{ id: 'native', additionalSpeedTiers: ['fast'] }] }, 'native', 'fast').available, true);
  assert.equal(serviceTierSupport({ models: [{ id: 'native', serviceTiers: [], additionalSpeedTiers: ['fast'] }] }, 'native', 'fast').available, false);
  assert.equal(serviceTierSupport({ models: [{ id: 'native', serviceTiers: null, additionalSpeedTiers: ['fast'] }] }, 'native', 'fast').available, false);
  assert.equal(serviceTierSupport({ models: [{ id: 'native', additionalSpeedTiers: ['priority'] }] }, 'native', 'fast').available, false);
  assert.equal(serviceTierSupport({}, 'unknown', 'fast').verified, false);
});

test('foreign routes cannot claim Fast and Standard remains available', () => {
  const status = { defaultModel: 'remote::model', models: [{ id: 'remote::model', serviceTiers: ['fast'], providerId: 'remote' }, { id: 'foreign', providerId: 'remote', serviceTiers: ['fast'] }] };
  assert.equal(serviceTierSupport(status, 'default', 'fast').available, false);
  assert.equal(serviceTierSupport(status, 'foreign', 'fast').available, false);
  const priority = { ...nativeLuna, id: 'remote::priority', providerId: 'remote' };
  assert.equal(serviceTierSupport({ defaultModel: priority.id, models: [priority] }, 'default', 'fast').available, false);
  assert.equal(serviceTierSupport({ models: [{ ...nativeLuna, id: 'foreign-priority', providerId: 'remote' }] }, 'foreign-priority', 'fast').available, false);
  for (const tier of [undefined, null, 'default']) assert.equal(serviceTierSupport(status, 'default', tier).available, true);
});
