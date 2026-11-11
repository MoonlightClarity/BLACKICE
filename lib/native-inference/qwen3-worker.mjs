import { workerData, parentPort } from 'node:worker_threads';
import { openSafetensorsModel } from './safetensors.mjs';
import { Qwen3Reference } from './reference-qwen3.mjs';
import { Qwen3Tokenizer } from './qwen3-tokenizer.mjs';
import { NativeSimdMatvec } from './simd-matvec.mjs';

// This worker is intentionally the only process running Qwen3 CPU tensor loops.
// Atomics-based cancellation does not rely on an event-loop message being processed
// during long synchronous matvec operations.
const cancellation = new Int32Array(workerData.cancelBuffer);
let reference, tokenizer, source, busy = false;
const errorShape = error => ({
  code: typeof error?.code === 'string' ? error.code : error?.name === 'AbortError' ? 'ABORT_ERR' : 'NATIVE_INFERENCE_ERROR',
  message: String(error?.message || error || 'Native model inference failed.').slice(0, 1000),
});
const signal = { throwIfAborted() {
  if (Atomics.load(cancellation, 0) !== 0) {
    const error = new Error('Native model generation was cancelled.');
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    throw error;
  }
} };

async function initialize() {
  const directory = workerData.modelDirectory;
  source = await openSafetensorsModel(directory);
  tokenizer = await Qwen3Tokenizer.load(directory);
  const cpuKernel = workerData.cpuKernel ?? 'simd';
  if (!['simd', 'reference'].includes(cpuKernel)) throw new Error('Unsupported BLACKICE CPU kernel selection.');
  const simd = cpuKernel === 'simd' ? await NativeSimdMatvec.create() : null;
  reference = new Qwen3Reference({ config: source.config, tensors: source,
    maxContext: workerData.maxContext ?? 2048,
    ...(simd ? { matvecImpl: simd.matvec.bind(simd) } : {}) });
  parentPort.postMessage({ type: 'ready', backend: 'blackice', modelType: source.config.model_type,
    sourcePrecision: source.sourcePrecision, maxContext: reference.maxContext, vocabSize: source.config.vocab_size,
    cpuKernel });
}

async function generate(message) {
  const { requestId, messages, prompt, tokenIds, maxNewTokens = 16, enableThinking = false } = message;
  if (busy) {
    parentPort.postMessage({ type: 'error', requestId,
      error: { code: 'NATIVE_INFERENCE_BUSY', message: 'A generation is already in progress.' } });
    return;
  }
  busy = true;
  try {
    const promptIds = Array.isArray(tokenIds) ? tokenIds
      : typeof prompt === 'string' ? tokenizer.encode(prompt, { allowSpecial: false })
        : tokenizer.encodeChat(messages, { enableThinking });
    if (promptIds.length === 0) throw new Error('The prompt contains no input tokens.');
    if (promptIds.length > reference.maxContext) throw new Error('The prompt exceeds the selected reference context length.');
    signal.throwIfAborted();
    const decoder = tokenizer.newDecoder({ skipSpecialTokens: true });
    const result = await reference.generateTokenIds(promptIds, {
      maxNewTokens, signal,
      onToken: tokenId => {
        const text = decoder.push(tokenId);
        parentPort.postMessage({ type: 'token', requestId, tokenId, text });
      },
    });
    const tail = decoder.finish();
    if (tail) parentPort.postMessage({ type: 'token', requestId, tokenId: null, text: tail });
    parentPort.postMessage({ type: 'done', requestId, promptTokens: promptIds.length,
      tokenIds: result, completed: true });
  } catch (error) {
    parentPort.postMessage({ type: 'error', requestId, error: errorShape(error) });
  } finally { busy = false; }
}

parentPort.on('message', message => {
  if (message?.type === 'generate' && Number.isSafeInteger(message.requestId))
    void generate(message);
});
void initialize().catch(error => parentPort.postMessage({ type: 'load-error', error: errorShape(error) }));
