import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelLimitResolver } from '../lib/model-limit-resolver.mjs';

const config = {
  id: 'local_llamacpp', name: 'Local llama.cpp', type: 'compatible',
  preset: 'llamacpp', baseUrl: 'http://127.0.0.1:8080/v1',
  models: [],
};

test('llama.cpp router metadata reports allocated context without autoloading an unloaded model', async () => {
  const paths = [];
  const request = async path => {
    paths.push(path);
    if (path === '/models') return { data: [
      { id: 'active.gguf', status: { value: 'loaded' }, meta: {n_ctx: 8192}, memory: { effective: { n_ctx: 32768 } } },
      { id: 'inactive.gguf', status: { value: 'unloaded' }, memory: { effective: null, max: { n_ctx: 32768 } } },
    ] };
    throw new Error('No other endpoint is allowed for router metadata: ' + path);
  };
  const result = await new ModelLimitResolver().enrich(config, [{ id: 'active.gguf' }, { id: 'inactive.gguf' }], { request });
  assert.equal(result[0].contextWindowTokens, 8192);
  assert.equal(result[0].contextWindowSource, 'runtime-reported');
  assert.equal(result[0].contextWindowEvidence.path, 'data[].meta.n_ctx');
  assert.equal(result[1].contextWindowTokens, undefined);
  assert.deepEqual([...new Set(paths)], ['/models']);
});

test('llama.cpp single-model metadata verifies ID before reading active /props', async () => {
  const paths = [];
  const request = async path => {
    paths.push(path);
    if (path === '/models') return {data: [{id: 'single.gguf', meta: {n_ctx:16384, n_ctx_train:131072}}]};
    if (path === '/v1/models') return { data: [{ id: 'single.gguf' }] };
    if (path === '/props') return { default_generation_settings: {n_ctx: 16384}, n_ctx_train: 131072 };
    throw new Error('Unexpected path ' + path);
  };
  const result = await new ModelLimitResolver().enrich(config, [{ id: 'single.gguf' }], { request });
  assert.equal(result[0].contextWindowTokens, 16384);
  assert.equal(result[0].contextWindowSource, 'runtime-reported');
  assert.equal(result[0].maxOutputTokens, undefined);
  assert.deepEqual(paths, ['/models', '/v1/models', '/props']);
});
