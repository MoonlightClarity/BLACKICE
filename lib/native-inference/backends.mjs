import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { LlamaCppBackend } from './llama-cpp.mjs';
import { Qwen3WorkerHost } from './worker-host.mjs';

const fail = (message, code = 'NATIVE_ENGINE_ERROR') => Object.assign(new Error(message), { code });

/** Explicit backend choice. No automatic switching or Ollama/LM Studio dependency.
 * BLACKICE's own CPU reference always runs inside a dedicated worker.
 */
export class BuiltinInferenceManager {
  constructor({ llamaCpp = new LlamaCppBackend(), workerFactory = options => new Qwen3WorkerHost(options) } = {}) {
    this.llamaCpp = llamaCpp;
    this.workerFactory = workerFactory;
    this.sessions = new Map();
  }

  async status() {
    return {
      engines: [
        { id: 'blackice', implementation: 'BLACKICE-owned Qwen3 CPU with SIMD/reference kernels', available: true,
          productionReady: false, input: 'chat messages, text or token IDs',
          formats: ['Safetensors F16', 'Safetensors BF16', 'Safetensors F32'],
          workerIsolated: true,
          note: 'Own tokenizer, forward pass and worker execution. Full-model parity and optimized execution remain validation gates.' },
        { id: 'llama.cpp', implementation: 'Bundled llama.cpp executable', available: await this.llamaCpp.available(),
          productionReady: false, input: 'text', formats: ['GGUF'],
          note: 'Requires the llama.cpp binary in BLACKICE resources. External inference servers are unnecessary.' },
      ],
      sessions: [...this.sessions.values()].map(session => ({
        id: session.id, backend: session.backend, modelPath: session.modelPath,
        ...(session.cpuKernel ? { cpuKernel: session.cpuKernel } : {}),
        status: session.busy ? 'running' : 'loaded',
      })),
    };
  }

  async load({ backend, modelPath, maxContext, cpuKernel } = {}) {
    if (!['blackice', 'llama.cpp'].includes(backend)) throw fail('Choose the BLACKICE or llama.cpp native engine.');
    if (typeof modelPath !== 'string' || !path.isAbsolute(modelPath)) throw fail('Choose an absolute model path.');
    const resolved = path.resolve(modelPath);
    let runner, metadata;
    if (backend === 'blackice') {
      runner = this.workerFactory({ modelDirectory: resolved, ...(maxContext ? { maxContext } : {}),
        ...(cpuKernel ? { cpuKernel } : {}) });
      try { metadata = await runner.load(); }
      catch (error) { await runner.unload().catch(() => {}); throw error; }
    } else {
      if (cpuKernel !== undefined) throw fail('The llama.cpp backend uses its own kernels, not BLACKICE SIMD/reference settings.');
      if (!await this.llamaCpp.available()) throw fail('llama.cpp has not been bundled with this BLACKICE build.', 'NATIVE_ENGINE_NOT_BUNDLED');
      if (!/\.gguf$/i.test(resolved) || !(await stat(resolved)).isFile())
        throw fail('Choose an existing GGUF file.');
    }
    const id = 'native_' + randomUUID().replaceAll('-', '');
    this.sessions.set(id, { id, backend, modelPath: resolved, runner, busy: false,
      cpuKernel: metadata?.cpuKernel || (backend === 'blackice' ? cpuKernel || 'simd' : null) });
    return {
      id, backend, modelPath: resolved,
      input: backend === 'blackice' ? 'chat-messages|text|tokenIds' : 'text',
      ...(backend === 'blackice' ? { cpuKernel: metadata?.cpuKernel || cpuKernel || 'simd' } : {}),
      ...(metadata?.sourcePrecision ? { sourcePrecision: metadata.sourcePrecision } : {}),
      ...(metadata?.maxContext ? { maxContext: metadata.maxContext } : {}),
    };
  }

  async generate({ id, tokenIds, messages, prompt, maxTokens = 32, contextSize, enableThinking = false,
    signal, onToken, onText } = {}) {
    const session = this.sessions.get(id);
    if (!session) throw fail('Native inference session not found.', 'NATIVE_SESSION_NOT_FOUND');
    if (session.busy) throw fail('Session is already generating.', 'NATIVE_SESSION_BUSY');
    signal?.throwIfAborted();
    const controller = new AbortController();
    const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    session.busy = true;
    session.controller = controller;
    const running = (async () => {
      if (session.backend === 'blackice')
        return session.runner.generate({ tokenIds, messages, prompt, maxNewTokens: maxTokens,
          enableThinking, signal: combinedSignal, onToken, onText });
      if (tokenIds !== undefined || messages !== undefined)
        throw fail('The llama.cpp CLI backend currently requires a text prompt.');
      return this.llamaCpp.generate({ modelPath: session.modelPath, prompt,
        maxTokens, contextSize, signal: combinedSignal, onText });
    })();
    session.inFlight = running;
    try { return await running; }
    finally {
      session.busy = false;
      session.controller = null;
      session.inFlight = null;
    }
  }

  cancel(id) {
    const session = this.sessions.get(id);
    if (!session || !session.busy) return { id, cancellationRequested: false };
    session.controller?.abort();
    session.runner?.cancel?.();
    return { id, cancellationRequested: true };
  }

  async unload(id) {
    const session = this.sessions.get(id);
    if (!session) return { unloaded: false };
    if (session.busy) throw fail('Cannot unload an active native inference session.', 'NATIVE_SESSION_BUSY');
    await session.runner?.unload();
    this.sessions.delete(id);
    return { unloaded: true, id };
  }

  async close() {
    const sessions = [...this.sessions.values()];
    for (const session of sessions) if (session.busy) this.cancel(session.id);
    await Promise.allSettled(sessions.map(session => session.inFlight).filter(Boolean));
    for (const id of [...this.sessions.keys()]) await this.unload(id);
  }
}
