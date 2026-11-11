import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Qwen3WorkerHost } from '../lib/native-inference/worker-host.mjs';

/** Inspect a real local FP16 Qwen3 model without changing BLACKICE's chat defaults. */
export async function probeNativeQwen3({ modelDirectory, prompt = 'Hello', maxNewTokens = 1,
  maxContext = 128, timeoutMs = 90000, chat = false, cpuKernel = 'simd' } = {}) {
  if (typeof modelDirectory !== 'string' || !path.isAbsolute(modelDirectory))
    throw new Error('Choose an absolute model directory.');
  const host = new Qwen3WorkerHost({ modelDirectory, maxContext, cpuKernel });
  const started = performance.now();
  let timeout;
  try {
    const model = await host.load();
    const loadedMs = performance.now() - started;
    const textParts = [];
    timeout = setTimeout(() => host.cancel(), timeoutMs);
    const result = await host.generate({
      ...(chat ? { messages: [{ role: 'user', content: prompt }] } : { prompt }),
      maxNewTokens, enableThinking: false,
      onText: part => textParts.push(part),
    });
    return {
      backend: 'blackice', worker: true,
      loadedMs: Math.round(loadedMs), totalMs: Math.round(performance.now() - started),
      model: { type: model.modelType, sourcePrecision: model.sourcePrecision,
        maxContext: model.maxContext, cpuKernel: model.cpuKernel },
      promptTokens: result.promptTokens, generatedTokens: result.tokenIds.length,
      tokenIds: result.tokenIds, text: result.text, streamMatches: textParts.join('') === result.text,
      completed: result.completed,
    };
  } finally {
    clearTimeout(timeout);
    await host.unload();
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const args = process.argv.slice(2);
  let options = {};
  try {
    for (let i = 0; i < args.length; i += 2) {
      if (!['--model', '--prompt', '--tokens', '--context', '--timeout', '--chat', '--kernel'].includes(args[i]) || i + 1 >= args.length)
        throw new Error('Usage: --model ABSOLUTE_DIR --prompt "Hello" --tokens 1 --context 128 --timeout 90000 --chat false');
      const key = { '--model': 'modelDirectory', '--prompt': 'prompt', '--tokens': 'maxNewTokens',
        '--context': 'maxContext', '--timeout': 'timeoutMs', '--chat': 'chat', '--kernel': 'cpuKernel' }[args[i]];
      options[key] = ['maxNewTokens', 'maxContext', 'timeoutMs'].includes(key)
        ? Number(args[i + 1]) : key === 'chat' ? args[i + 1] === 'true' : args[i + 1];
    }
    console.log(JSON.stringify(await probeNativeQwen3(options), null, 2));
  } catch (error) {
    console.error('Native Qwen3 probe failed: ' + String(error?.message || error));
    process.exitCode = 1;
  }
}
