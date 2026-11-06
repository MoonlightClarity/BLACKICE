import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProvider } from '../lib/provider-store.mjs';
import { providerEndpointURL } from '../lib/provider-endpoints.mjs';
import {
  PROVIDER_PRESETS, PROVIDER_CATALOG_REVIEWED_AT, getProviderPreset, providerRequiresApiKey,
} from '../public/provider-catalog.mjs';

test('supported hosted presets route through the documented protocol and preserve provider-specific base paths', () => {
  const expected = [
    ['kilo', 'https://ai-gateway.kilo.ai/api/v1/chat/completions'],
    ['pollinations', 'https://gen.pollinations.ai/v1/chat/completions'],
    ['groq', 'https://api.groq.com/openai/v1/chat/completions'],
    ['cerebras', 'https://api.cerebras.ai/v1/chat/completions'],
    ['gemini', 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'],
    ['nvidia', 'https://integrate.api.nvidia.com/v1/chat/completions'],
    ['huggingface', 'https://router.huggingface.co/v1/chat/completions'],
    ['deepinfra', 'https://api.deepinfra.com/v1/openai/chat/completions'],
  ];
  for (const [preset, endpoint] of expected) {
    const connection = normalizeProvider({ id: 'new_' + preset, preset });
    assert.equal(connection.type, 'compatible', preset);
    assert.equal(providerEndpointURL(connection, 'chat/completions').href, endpoint, preset);
    assert.equal(providerRequiresApiKey(connection), true, preset + ' generation needs an account key');
  }
  assert.equal(normalizeProvider({ id: 'native_openai', preset: 'openai' }).type, 'openai');
  assert.equal(normalizeProvider({ id: 'native_claude', preset: 'anthropic' }).type, 'anthropic');
});

test('public catalog access does not waive generation authentication or silently impose free-model filters', () => {
  for (const preset of ['kilo', 'pollinations', 'openrouter', 'nvidia', 'huggingface', 'deepinfra']) {
    const template = getProviderPreset(preset);
    const connection = normalizeProvider({ id: 'public_' + preset, preset });
    assert.equal(template.catalogAuthentication, 'public', preset);
    assert.equal(providerRequiresApiKey(connection), true, preset);
    assert.notEqual(template.anonymous, true, preset);
    assert.notEqual(template.freeOnly, true, preset);
  }
  const free = normalizeProvider({ id: 'limited_kilo', preset: 'kilo_free' });
  assert.equal(providerRequiresApiKey(free), false);
  assert.equal(getProviderPreset('kilo_free').freeOnly, true);
  assert.match(getProviderPreset('kilo_free').authNote, /limited|rate/i);
  assert.equal(providerRequiresApiKey({ preset: 'compatible', type: 'compatible', baseUrl: 'https://openrouter.ai/api/v1' }), true);
});

test('current Pollinations has rich catalog discovery while legacy saved routes remain addressable but hidden', () => {
  const current = getProviderPreset('pollinations');
  assert.equal(current.catalogStrategy, 'pollinations-text');
  assert.equal(new URL(current.catalogEndpoint, current.baseUrl).href, 'https://gen.pollinations.ai/text/models');
  assert.match(current.authNote, /sk_/);
  assert.match(current.authNote, /pk_/);

  const legacy = getProviderPreset('pollinations_classic');
  assert.equal(legacy.hidden, true);
  assert.equal(legacy.deprecated, true);
  assert.equal(legacy.replacementId, current.id);
  assert.equal(PROVIDER_PRESETS.filter(preset => !preset.hidden && !preset.deprecated).includes(legacy), false);
  const saved = normalizeProvider({
    id: 'old_pollinations', preset: 'pollinations_classic', name: 'My saved Classic',
    models: [{ id: 'previous-model' }],
  });
  assert.equal(saved.name, 'My saved Classic');
  assert.equal(saved.preset, 'pollinations_classic');
  assert.equal(saved.models[0].id, 'previous-model');
  assert.equal(providerRequiresApiKey(saved), false);
  assert.equal(providerEndpointURL(saved, 'models').href, 'https://text.pollinations.ai/models');
  assert.equal(providerEndpointURL(saved, 'chat/completions').href, 'https://text.pollinations.ai/openai');
});

test('local and custom endpoints retain optional credentials and manual discovery support', () => {
  for (const preset of ['ollama', 'lmstudio', 'compatible']) {
    const config = normalizeProvider({
      id: 'local_' + preset, preset,
      ...(preset === 'compatible' ? { baseUrl: 'http://127.0.0.1:8901/v1' } : {}),
    });
    assert.equal(providerRequiresApiKey(config), false, preset);
    assert.equal(getProviderPreset(preset).catalogAuthentication, 'optional', preset);
  }
  assert.equal(getProviderPreset('compatible').catalogStrategy, 'manual-or-models');
  assert.match(getProviderPreset('lmstudio').authNote, /authentication|token/i);
});

test('selectable provider documentation is dated and separate from credentials and volatile model lists', () => {
  const strategies = new Set(['openai-models', 'anthropic-models', 'pollinations-text', 'local-openai-models', 'manual-or-models']);
  assert.equal(new Set(PROVIDER_PRESETS.map(preset => preset.id)).size, PROVIDER_PRESETS.length);
  assert.match(PROVIDER_CATALOG_REVIEWED_AT, /^\d{4}-\d{2}-\d{2}$/);
  for (const preset of PROVIDER_PRESETS) {
    assert.equal(Object.hasOwn(preset, 'apiKey'), false, preset.id);
    assert.equal(Object.hasOwn(preset, 'models'), false, preset.id);
    assert.ok(strategies.has(preset.catalogStrategy), preset.id);
    if (preset.id === 'compatible') continue;
    assert.equal(preset.reviewedAt, PROVIDER_CATALOG_REVIEWED_AT, preset.id);
    assert.equal(new URL(preset.docsUrl).protocol, 'https:', preset.id);
    assert.ok(preset.sourceUrls.length > 0, preset.id);
    assert.ok(preset.sourceUrls.every(url => new URL(url).protocol === 'https:'), preset.id);
    if (preset.requiresApiKey) assert.equal(new URL(preset.keyUrl).protocol, 'https:', preset.id);
  }
});
