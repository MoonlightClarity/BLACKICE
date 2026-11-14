import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeAutonomyModelAllowlist, requireAutonomyModel} from '../lib/autonomy-model-allowlist.mjs';

const catalog = [
  {id: 'codex::coding-model', model: 'codex::coding-model'},
  {id: 'free::vision-model', model: 'free::vision-model'},
  {id: 'premium::large-model', model: 'premium::large-model'},
];
const allowlist = ['codex::coding-model', 'free::vision-model'];

test('exact explicit IDs, deduplicated in stable order', () => {
  assert.deepEqual(normalizeAutonomyModelAllowlist(['free::vision-model', 'free::vision-model'], {catalog}),
    ['free::vision-model']);
  for (const value of [[], ['*'], ['default'], ['free::*'], ['free::vision-model '], ['unlisted']]) {
    assert.throws(() => normalizeAutonomyModelAllowlist(value, {catalog}));
  }
});

test('allowed coordinator continuation and worker use exact models', () => {
  assert.equal(requireAutonomyModel({allowlist, requestedModel: 'free::vision-model', catalog}), 'free::vision-model');
  assert.equal(requireAutonomyModel({allowlist, inheritedModel: 'codex::coding-model', catalog}), 'codex::coding-model');
});

test('quota-sensitive non-whitelisted model never launches, even when requested explicitly', () => {
  assert.throws(() => requireAutonomyModel({
    allowlist, requestedModel: 'premium::large-model', inheritedModel: 'codex::coding-model', catalog
  }), error => error.code === 'AUTONOMY_MODEL_NOT_ALLOWED');
});

test('default-model changes cannot expand the allowlist', () => {
  assert.throws(() => requireAutonomyModel({
    allowlist, requestedModel: 'default', defaultModel: 'premium::large-model', catalog
  }));
  assert.equal(requireAutonomyModel({
    allowlist, requestedModel: 'default', defaultModel: 'free::vision-model', catalog
  }), 'free::vision-model');
});

test('missing configured providers fail closed without capability assumptions', () => {
  assert.throws(() => requireAutonomyModel({
    allowlist, requestedModel: 'codex::coding-model',
    catalog: catalog.filter(item => item.id !== 'codex::coding-model')
  }), error => error.code === 'AUTONOMY_MODEL_UNAVAILABLE');
});

test('model capability labels do not create hardcoded compatibility vetoes', () => {
  assert.equal(requireAutonomyModel({allowlist, requestedModel: 'codex::coding-model'}), 'codex::coding-model');
  assert.equal(requireAutonomyModel({allowlist, requestedModel: 'free::vision-model'}), 'free::vision-model');
});
