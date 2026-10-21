import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_MODE_MODEL, modelRouteMetadata, recordedResponseRoutes } from '../public/model-routes.mjs';
import { reasoningChoices, reasoningSupport } from '../public/reasoning-model.mjs';

test('retired route metadata overrides obsolete readiness without advertising setup actions', () => {
  const status = { defaultModel: CHAT_MODE_MODEL, chatMode: { available: true, ready: true, state: 'ready' } };
  const metadata = modelRouteMetadata({ id: 'default', available: true, experimental: true, setupAction: 'chat-mode' }, status);
  assert.equal(metadata.retired, true); assert.equal(metadata.available, false); assert.equal(metadata.experimental, undefined);
  assert.equal(metadata.setupAction, undefined); assert.equal(metadata.pendingAttemptId, undefined); assert.equal(metadata.availabilityLabel, 'Retired');
  assert.deepEqual(reasoningChoices(status, 'default', 'high').map(choice => choice.value), ['default']);
  assert.equal(reasoningSupport(status, CHAT_MODE_MODEL, 'high').available, false);
  assert.match(metadata.availabilityReason, /BLACKICE connection from ChatGPT/);
});

test('recorded response routes use actual resolved model or thread receipt, with resolved route taking priority', () => {
  const run = { workflow: { nodes: [{ id: 'a', type: 'agent', name: 'First', model: CHAT_MODE_MODEL }, { id: 'b', type: 'agent', name: 'Second' }] }, nodes: { a: {} }, events: [] };
  assert.deepEqual(recordedResponseRoutes(run), [], 'saved workflow intent is not an actual route receipt');
  run.events.push({ nodeId: 'a', data: { type: 'thread', model: CHAT_MODE_MODEL } }); run.nodes.b = { resolvedModel: CHAT_MODE_MODEL };
  assert.deepEqual(recordedResponseRoutes(run), [{ model: CHAT_MODE_MODEL, label: 'ChatGPT Chat Mode', retired: true, agents: [{ id: 'a', name: 'First' }, { id: 'b', name: 'Second' }] }]);
  run.nodes.a.resolvedModel = 'other::actual'; assert.deepEqual(recordedResponseRoutes(run)[0].agents, [{ id: 'b', name: 'Second' }]);
});
