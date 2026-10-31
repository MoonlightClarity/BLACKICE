import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_SORTS, browseModels, groupModels, modelProvider, modelIsFree } from '../public/model-browser.mjs';
import { providerModelMetadata, zeroPricedFreeVariant } from '../lib/provider-model-metadata.mjs';

const providers = [{ id: 'router', name: 'Research endpoint' }, { id: 'local_api', name: 'Local models' }];
const ids = models => models.map(model => model.id ?? model.model ?? model.value);

test('provider grouping uses explicit connection IDs, qualified IDs, defaults, and native Codex without rewriting IDs', () => {
  assert.deepEqual(modelProvider({ id: 'router::vendor/model' }, { providers }), { id: 'router', label: 'Research endpoint' });
  assert.deepEqual(modelProvider({ value: 'local_api::x' }, { providers }), { id: 'local_api', label: 'Local models' });
  assert.deepEqual(modelProvider({ model: 'native-model' }), { id: 'codex', label: 'Codex' });
  assert.deepEqual(modelProvider({ id: 'plain' }, { defaultProviderId: 'custom', defaultLabel: 'Custom endpoint' }), { id: 'custom', label: 'Custom endpoint' });
  assert.deepEqual(modelProvider({ id: 'router::x', providerId: 'local_api' }, { providers }), { id: 'local_api', label: 'Local models' });
  const frozen = Object.freeze({ id: 'router::vendor/model', displayName: 'Original' });
  assert.strictEqual(groupModels([frozen], { providers })[0].models[0], frozen);
  assert.equal(frozen.id, 'router::vendor/model');
});

test('search combines case-insensitive words across names, model IDs and provider labels; context minimum excludes unknown values', () => {
  const first = Object.freeze({ id: 'router::acme/alpha', displayName: 'Alpha Research', contextWindowTokens: 100000 });
  const second = Object.freeze({ id: 'router::acme/beta', displayName: 'Beta', contextWindowTokens: 32768 });
  const third = Object.freeze({ id: 'local_api::alpha', displayName: 'Alpha Local' });
  const models = Object.freeze([first, second, third]);
  assert.deepEqual(browseModels(models, { providers, query: 'RESEARCH acme ALPHA' }), [first]);
  assert.deepEqual(browseModels(models, { providers, query: 'local alpha' }), [third]);
  assert.deepEqual(browseModels(models, { minContextTokens: 32768 }), [first, second]);
  assert.deepEqual(browseModels(models, { minContextTokens: 32769 }), [first]);
  assert.deepEqual(ids(models), ['router::acme/alpha', 'router::acme/beta', 'local_api::alpha']);
  assert.strictEqual(browseModels(models, { query: 'beta' })[0], second);
});

test('context and output sorting keeps unknown, unsafe and malformed capacities last in both directions', () => {
  assert.deepEqual(MODEL_SORTS.map(item => item.id), ['name', 'context-desc', 'context-asc', 'output-desc']);
  const models = Object.freeze([
    Object.freeze({ id: 'unknown', displayName: 'A unknown' }),
    Object.freeze({ id: 'large', displayName: 'Large', contextWindowTokens: 1000000, maxOutputTokens: 8192 }),
    Object.freeze({ id: 'small', displayName: 'Small', contextWindowTokens: 4096, maxOutputTokens: 16384 }),
    Object.freeze({ id: 'string', displayName: 'B string', contextWindowTokens: '2000000', maxOutputTokens: '20000' }),
    Object.freeze({ id: 'unsafe', displayName: 'C unsafe', contextWindowTokens: Number.MAX_SAFE_INTEGER + 1, maxOutputTokens: Infinity }),
    Object.freeze({ id: 'zero', displayName: 'D zero', contextWindowTokens: 0, maxOutputTokens: -1 }),
  ]);
  assert.deepEqual(ids(browseModels(models, { sort: 'context-desc' })), ['large', 'small', 'unknown', 'string', 'unsafe', 'zero']);
  assert.deepEqual(ids(browseModels(models, { sort: 'context-asc' })), ['small', 'large', 'unknown', 'string', 'unsafe', 'zero']);
  assert.deepEqual(ids(browseModels(models, { sort: 'output-desc' })), ['small', 'large', 'unknown', 'string', 'unsafe', 'zero']);
  assert.deepEqual(ids(models), ['unknown', 'large', 'small', 'string', 'unsafe', 'zero']);
  assert.deepEqual(ids(browseModels([{ id: 'ten', displayName: 'Model 10' }, { id: 'two', displayName: 'Model 2' }], { sort: 'name' })), ['two', 'ten']);
  const tied = [{ id: 'z', displayName: 'Zulu', contextWindowTokens: 4096 }, { id: 'a', displayName: 'Alpha', contextWindowTokens: 4096 }];
  assert.deepEqual(ids(browseModels(tied, { sort: 'context-desc' })), ['a', 'z']);
});

test('tools and vision filters require confirmed support and provider hiding is independent of catalog-hidden models', () => {
  const models = [
    { id: 'router::known', supportsTools: true, inputModalities: ['text', 'image'] },
    { id: 'router::unknown' },
    { id: 'local_api::unsupported', supportsTools: false, inputModalities: ['text'], outputModalities: ['image'] },
    { id: 'native-hidden', hidden: true, supportsTools: true, supportsVision: true },
  ];
  assert.deepEqual(ids(browseModels(models, { toolsOnly: true })), ['native-hidden', 'router::known']);
  assert.deepEqual(ids(browseModels(models, { visionOnly: true })), ['native-hidden', 'router::known']);
  assert.deepEqual(ids(browseModels(models, { toolsOnly: true, visionOnly: true, hiddenModelProviders: ['codex'] })), ['router::known']);
  assert.deepEqual(ids(browseModels(models, { hiddenModelProviders: ['router'] })), ['local_api::unsupported', 'native-hidden']);
  assert.equal(browseModels(models).length, 4);
  assert.equal(models[3].hidden, true);
});

test('free-only matches provider-reported complete zero pricing and excludes unknown, incomplete, manual and nonzero prices', () => {
  const normalized = pricing => ({ id: 'vendor/model:free', ...providerModelMetadata({ id: 'vendor/model:free', pricing }, { reported: true }) });
  const cases = [
    normalized({ prompt: '0', completion: '0' }),
    normalized({ prompt: '-0', completion: '0e9', request: '.0' }),
    normalized({ prompt: '0', completion: '0', request: '0.1' }),
    normalized({ prompt: '0', completion: '1e-1000' }),
    normalized({ prompt: '0' }),
    { ...normalized({ prompt: '0', completion: '0' }), pricingIncomplete: true },
    { ...normalized({ prompt: '0', completion: '0' }), pricingSource: 'user-configured' },
    { ...normalized({ prompt: '0', completion: '0' }), freeVariant: false },
    { id: 'vendor/model:free' },
  ];
  assert.deepEqual(cases.map(zeroPricedFreeVariant), [true, true, false, false, false, false, false, false, false], 'Automatic OpenRouter free-variant selection keeps its existing policy.');
  assert.deepEqual(cases.map(modelIsFree), [true, true, false, false, false, false, false, true, false], 'Browsing accepts reported zero prices without requiring a variant suffix.');
  const result = browseModels(cases, { freeOnly: true }); assert.equal(result.length, 3); assert.ok(result.every(model => cases.includes(model)));
  assert.equal(modelIsFree(null), false);
});

test('publisher grouping uses explicit publisher metadata or model namespaces and never guesses vendors for plain IDs', () => {
  const explicit = { id: 'router::namespace/a', publisher: { id: 'actual', name: 'Actual publisher' } };
  const namespaced = { id: 'router::vendor/b' };
  const plain = { id: 'plain-id' };
  const groups = groupModels([explicit, namespaced, plain], { mode: 'publisher', defaultProviderId: 'router', defaultLabel: 'Research endpoint' });
  assert.deepEqual(groups.map(({ id, label }) => ({ id, label })), [
    { id: 'actual', label: 'Actual publisher' },
    { id: 'router', label: 'Research endpoint' },
    { id: 'vendor', label: 'vendor' },
  ]);
  assert.strictEqual(groups.find(group => group.id === 'actual').models[0], explicit);
  assert.deepEqual(groupModels([plain], { mode: 'publisher' }), [{ id: 'models', label: 'Models', models: [plain] }]);
  assert.deepEqual(groupModels([{ id: 'x', publisherName: 'Published name' }], { mode: 'publisher' })[0].label, 'Published name');
  assert.deepEqual(groupModels([{ id: 'router::a' }, { id: 'router::b' }, { id: 'native' }], { providers }).map(group => [group.id, group.models.length]), [['codex', 1], ['router', 2]]);
});
