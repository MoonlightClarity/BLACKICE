import assert from 'node:assert/strict';
import test from 'node:test';
import { createLlamaBundleFixture } from './fixtures/llama-bundle.mjs';
import { inspectLocalModelPrerequisites } from '../lib/local-model-prerequisites.mjs';

async function bundle(t) {
  const { root, verify } = await createLlamaBundleFixture(t);
  return { bundleRoot: root, verifyBundle: verify, platform: 'win32', arch: 'x64' };
}

test('records both prerequisites without claiming GPU offload or inference', async t => {
  const config = await bundle(t);
  const seen = [];
  const result = await inspectLocalModelPrerequisites({
    ...config, port: 18080,
    run: async () => ({ stdout: 'Available devices:\r\n  Vulkan0: Fixture GPU (1024 MiB)' }),
    fetchImpl: async (url, init) => {
      seen.push(new URL(url).pathname);
      assert.match(url, /^http:\/\/127\.0\.0\.1:18080\//);
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'error');
      return Response.json(seen.at(-1) === '/props' ? { role: 'router' } : {
        data: [{ id: 'fixture', status: 'unloaded' }, { id: 'one', status: 'sleeping' }, { id: 'two', status: 'loaded' }],
      });
    },
  });
  assert.deepEqual(seen, ['/props', '/models']);
  assert.equal(result.runtime.backend, 'Vulkan');
  assert.equal(result.gpu.status, 'detected');
  assert.equal(result.gpu.deviceCount, 1);
  assert.equal(result.models.status, 'detected');
  assert.equal(result.models.modelCount, 3);
  assert.equal(result.models.loadedCount, 1);
  assert.equal(result.models.sleepingCount, 1);
  assert.equal(result.inference.status, 'not_tested');
  assert.equal(result.gpuOffload.status, 'not_tested');
  assert.doesNotMatch(JSON.stringify(result), /Fixture GPU|"fixture"|llama-server\.exe/);
});

test('empty running catalog differs from catalog unavailable; probe failure differs from absent device', async t => {
  const config = await bundle(t);
  const fetchImpl = async url => Response.json(url.endsWith('/props') ? { role: 'router' } : { data: [] });
  const absent = await inspectLocalModelPrerequisites({
    ...config, fetchImpl, run: async () => ({ stdout: 'Available devices:\r\n' }),
  });
  assert.equal(absent.runtime.backend, 'CPU');
  assert.equal(absent.gpu.status, 'none');
  assert.equal(absent.models.status, 'none');
  const failed = await inspectLocalModelPrerequisites({
    ...config,
    run: async (_, args) => {
      if (args[0] === '--list-devices') throw Object.assign(new Error('private path'), { code: 42, killed: false });
      return { stdout: 'version' };
    },
    fetchImpl: async () => { throw new Error('private details'); },
  });
  assert.equal(failed.runtime.backend, 'CPU');
  assert.equal(failed.gpu.status, 'probe_failed');
  assert.equal(failed.gpu.exitCode, 42);
  assert.equal(failed.gpu.timedOut, false);
  assert.equal(failed.models.status, 'catalog_unavailable');
  assert.equal(failed.models.code, 'LOCAL_ENGINE_OFFLINE');
  assert.doesNotMatch(JSON.stringify(failed), /private/);
});

test('distinguishes unknown probe output, malformed catalog and unavailable bundle', async t => {
  const config = await bundle(t);
  const fetchImpl = async () => Response.json({ unexpected: true });
  const bad = await inspectLocalModelPrerequisites({
    ...config, fetchImpl, run: async () => ({ stdout: 'unexpected' }),
  });
  assert.equal(bad.gpu.status, 'unrecognized_output');
  assert.equal(bad.models.code, 'LOCAL_LLAMA_CATALOG_INVALID');
  const unsupported = await inspectLocalModelPrerequisites({
    ...config, platform: 'linux', fetchImpl, run: async () => assert.fail('must not run'),
  });
  assert.equal(unsupported.runtime.status, 'unavailable');
  assert.equal(unsupported.gpu.status, 'not_tested');
  await assert.rejects(inspectLocalModelPrerequisites({ port: 65536 }), RangeError);
});
