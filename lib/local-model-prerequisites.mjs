import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { inspectLlamaBundle } from './llama-cpp-bundle.mjs';
import { llamaCppCatalog } from './llama-cpp-local.mjs';
import { LocalModelManager } from './local-model-manager.mjs';

const execute = promisify(execFile);
const elapsed = start => Math.round(performance.now() - start);
const safeCode = error => /^[A-Z0-9_]{1,64}$/.test(String(error?.code || '')) ? error.code : null;
const modelsNotVerified = Object.freeze({ status: 'not_tested' });

export async function inspectLocalModelPrerequisites({
  bundleRoot, port = 8080, run = execute, fetchImpl = globalThis.fetch,
  platform = process.platform, arch = process.arch,
} = {}) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new RangeError('Provide a valid local llama-server port.');
  let gpu = { status: 'not_tested' };
  const runtimeStart = performance.now();
  const runtimeTask = inspectLlamaBundle({
    root: bundleRoot, platform, arch,
    run: async (file, args, options) => {
      if (args[0] !== '--list-devices') return run(file, args, options);
      const start = performance.now();
      try {
        const result = await run(file, args, options);
        const stdout = result.stdout || '';
        const deviceCount = (stdout.match(/^\s*Vulkan\d+:\s+\S/gm) || []).length;
        gpu = {
          status: deviceCount ? 'detected' : /^\s*Available devices:\s*$/m.test(stdout) ? 'none' : 'unrecognized_output',
          deviceCount, durationMs: elapsed(start),
        };
        return result;
      } catch (error) {
        gpu = {
          status: 'probe_failed', durationMs: elapsed(start), code: safeCode(error),
          exitCode: Number.isInteger(error?.code) ? error.code : null,
          timedOut: error?.killed === true,
        };
        throw error;
      }
    },
  }).then(result => ({
    status: result.available ? 'available' : 'unavailable',
    backend: result.backend, version: result.version, message: result.message,
    durationMs: elapsed(runtimeStart),
  }));
  const manager = new LocalModelManager({
    fetchImpl: (url, options) => {
      const endpoint = new URL(url);
      endpoint.port = String(port);
      return fetchImpl(endpoint.href, { ...options, redirect: 'error' });
    },
  });
  const modelStart = performance.now();
  const modelTask = llamaCppCatalog(manager.request.bind(manager)).then(
    ({ mode, models }) => ({
      status: models.length ? 'detected' : 'none', mode, modelCount: models.length,
      loadedCount: models.filter(model => model.status === 'loaded').length,
      sleepingCount: models.filter(model => model.status === 'sleeping').length,
      durationMs: elapsed(modelStart),
    }),
    error => ({ status: 'catalog_unavailable', code: safeCode(error), durationMs: elapsed(modelStart) }),
  );
  const [runtime, models] = await Promise.all([runtimeTask, modelTask]);
  return { runtime, models, gpu, inference: modelsNotVerified, gpuOffload: modelsNotVerified };
}
