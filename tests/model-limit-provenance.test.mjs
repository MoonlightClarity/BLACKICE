import test from 'node:test';
import assert from 'node:assert/strict';
import { modelLimitMetadata, modelLimitReport, mergeModelLimits } from '../lib/provider-model-metadata.mjs';
import { contextSnapshot } from '../lib/context.mjs';

const at = '2026-10-30T19:00:00.000Z';
const reference = {
  id: 'exact-model', contextWindowTokens: 131072, contextWindowSource: 'model-reference', contextWindowObservedAt: at,
  contextWindowEvidence: { label: 'Publisher model configuration', modelId: 'publisher/exact-model', url: 'https://publisher.example/model/config.json', endpointSpecific: false },
  modelLimitLookup: { status: 'partial', checkedAt: at, sources: [{ id: 'publisher-config', label: 'Publisher model configuration', status: 'found', url: 'https://publisher.example/model/config.json' }] }
};

test('reference limits retain their source, evidence, check date and explicit unknown output', () => {
  const reported = modelLimitReport(reference);
  assert.equal(reported.contextWindowTokens, 131072);
  assert.equal(reported.contextWindowSource, 'model-reference');
  assert.deepEqual(reported.contextWindowEvidence, reference.contextWindowEvidence);
  assert.equal(reported.contextWindowObservedAt, at);
  assert.equal(reported.maxOutputTokens, null);
  assert.equal(reported.maxOutputTokensSource, 'unknown');
  assert.equal(reported.modelLimitLookup.status, 'partial');
});

test('untrusted caller claims cannot create runtime or reference provenance', () => {
  for (const source of ['runtime-reported', 'model-reference']) {
    const result = modelLimitMetadata({ ...reference, contextWindowSource: source });
    assert.equal(result.contextWindowSource, 'user-configured');
    assert.equal(result.contextWindowObservedAt, undefined);
    assert.equal(result.contextWindowEvidence, undefined);
    assert.equal(result.modelLimitLookup, undefined);
  }
});

test('trusted exact-value evidence survives save and a changed numeric value becomes a manual override', () => {
  const saved = modelLimitMetadata({ contextWindowTokens: 131072 }, { verifiedModel: reference });
  assert.equal(saved.contextWindowSource, 'model-reference');
  assert.deepEqual(saved.contextWindowEvidence, reference.contextWindowEvidence);
  const edited = modelLimitMetadata({ contextWindowTokens: 65536 }, { previous: saved, verifiedModel: reference });
  assert.equal(edited.contextWindowTokens, 65536);
  assert.equal(edited.contextWindowSource, 'user-configured');
  assert.equal(edited.contextWindowEvidence, undefined);
  assert.equal(edited.contextWindowObservedAt, undefined);
});

test('refresh never converts an unchanged manual override into a provider claim', () => {
  const manual = { contextWindowTokens: 131072, contextWindowSource: 'user-configured' };
  const result = modelLimitMetadata(manual, { previous: manual, verifiedModel: reference });
  assert.equal(result.contextWindowSource, 'user-configured');
  assert.equal(result.contextWindowEvidence, undefined);
});

test('moving an endpoint invalidates runtime and reference reports while retaining manual overrides', () => {
  for (const source of ['provider-reported', 'runtime-reported', 'model-reference']) {
    const previous = { ...reference, contextWindowSource: source };
    assert.equal(modelLimitMetadata(previous, { previous, discardPreviousReports: true }).contextWindowTokens, undefined);
  }
  const previous = { ...reference, contextWindowSource: 'user-configured' };
  assert.equal(modelLimitMetadata(previous, { previous, discardPreviousReports: true }).contextWindowTokens, 131072);
});

test('cleared or invalid capacities cannot retain stale evidence or an all-resolved lookup result', () => {
  const result = modelLimitReport({ ...reference, contextWindowTokens: null, modelLimitLookup: { ...reference.modelLimitLookup, status: 'resolved' } });
  assert.equal(result.contextWindowSource, 'unknown');
  assert.equal(result.contextWindowEvidence, undefined);
  assert.equal(result.contextWindowObservedAt, undefined);
  assert.equal(result.modelLimitLookup.status, 'unresolved');
});

test('a discovered overlay fills missing values, refreshes reports and preserves manual capacities', () => {
  assert.equal(mergeModelLimits({ id: 'exact-model' }, reference).contextWindowSource, 'model-reference');
  const manual = { id: 'exact-model', contextWindowTokens: 64000, contextWindowSource: 'user-configured' };
  assert.equal(mergeModelLimits(manual, reference).contextWindowTokens, 64000);
  assert.equal(mergeModelLimits(manual, reference).contextWindowSource, 'user-configured');
  const fresh = { ...reference, contextWindowTokens: 262144, contextWindowSource: 'provider-reported' };
  assert.equal(mergeModelLimits(reference, fresh).contextWindowTokens, 262144);
  assert.equal(mergeModelLimits(reference, fresh).contextWindowSource, 'provider-reported');
  assert.equal(mergeModelLimits({ id: 'exact-model' }, manual).contextWindowTokens, null, 'a cached manual selection is not new provider evidence');
});

test('native default capacity and supported maximum remain distinct throughout reporting', () => {
  const model = modelLimitReport({ id: 'native', contextWindowTokens: 272000, contextWindowSource: 'runtime-reported',
    contextWindowObservedAt: at, contextWindowEvidence: { label: 'Codex runtime metadata', modelId: 'native', endpointSpecific: true },
    maxContextWindowTokens: 872000, runtimeDefaultContextWindowTokens: 272000 });
  assert.equal(model.contextWindowTokens, 272000);
  assert.equal(model.maxContextWindowTokens, 872000);
  assert.equal(model.runtimeDefaultContextWindowTokens, 272000);
  assert.equal(model.contextWindowSource, 'runtime-reported');
  assert.equal(modelLimitMetadata(model, { reported: true, preserveSources: true }).contextWindowSource, 'runtime-reported');
});

test('runtime metadata constrains the working context without being mislabeled as user configuration', () => {
  const status = contextSnapshot({ modelWindowTokens: 272000, modelWindowSource: 'runtime-reported', options: { preset: 'custom', windowTokens: 800000 } });
  assert.equal(status.effectiveWindowTokens, 272000);
  assert.equal(status.modelWindowTokens, 272000);
  assert.equal(status.windowSource, 'runtime-reported');
  assert.match(status.warnings.join(' '), /runtime reports/);
  assert.doesNotMatch(status.warnings.join(' '), /user setting/);
});

test('published model capacities constrain working context while remaining unconfirmed endpoint references', () => {
  const status = contextSnapshot({ modelWindowTokens: 131072, modelWindowSource: 'model-reference', options: { preset: 'custom', windowTokens: 800000 } });
  assert.equal(status.effectiveWindowTokens, 131072);
  assert.equal(status.modelWindowTokens, null);
  assert.equal(status.configuredModelWindowTokens, 131072);
  assert.equal(status.windowSource, 'model-reference');
  assert.match(status.warnings.join(' '), /endpoint.*smaller limit/);
  assert.doesNotMatch(status.warnings.join(' '), /user setting/);
});
