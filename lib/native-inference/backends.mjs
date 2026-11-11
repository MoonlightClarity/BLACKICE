import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { openSafetensorsModel } from './safetensors.mjs';
import { Qwen3Reference } from './reference-qwen3.mjs';
import { LlamaCppBackend } from './llama-cpp.mjs';

const fail = (message, code = 'NATIVE_ENGINE_ERROR') => Object.assign(new Error(message), { code });

/** Explicit backend choice. No automatic switching and no Ollama/LM Studio dependency. */
export class BuiltinInferenceManager {
  constructor({ llamaCpp = new LlamaCppBackend(), modelLoader = openSafetensorsModel } = {}) {
    this.llamaCpp = llamaCpp;
    this.modelLoader = modelLoader;
    this.sessions = new Map();
  }
  async status() {
    return {
      engines: [
        { id: 'blackice', implementation: 'BLACKICE-owned Qwen3 CPU reference', available: true,
          productionReady: false, input: 'tokenIds', formats: ['Safetensors F16', 'Safetensors BF16', 'Safetensors F32'],
          note: 'Numerical reference and tokenizer-independent testing; optimized execution and text tokenization not yet complete.' },
        { id: 'llama.cpp', implementation: 'Bundled llama.cpp executable', available: await this.llamaCpp.available(),
          productionReady: false, input: 'text', formats: ['GGUF'],
          note: 'Requires the llama.cpp binary in BLACKICE resources. The external inference servers are not needed.' },
      ],
      sessions: [...this.sessions.values()].map(session => ({
        id: session.id, backend: session.backend, modelPath: session.modelPath,
        status: session.busy ? 'running' : 'loaded',
      })),
    };
  }
  async load({ backend, modelPath, maxContext } = {}) {
    if (!['blackice', 'llama.cpp'].includes(backend)) throw fail('Choose the BLACKICE or llama.cpp native engine.');
    if (typeof modelPath !== 'string' || !path.isAbsolute(modelPath)) throw fail('Choose an absolute model path.');
    const resolved = path.resolve(modelPath);
    let runner, model;
    if (backend === 'blackice') {
      model = await this.modelLoader(resolved);
      runner = new Qwen3Reference({ config: model.config, tensors: model,
        maxContext: maxContext === undefined ? 2048 : maxContext });
    } else {
      if (!await this.llamaCpp.available()) throw fail('llama.cpp has not been bundled with this BLACKICE build.', 'NATIVE_ENGINE_NOT_BUNDLED');
      if (!/\.gguf$/i.test(resolved) || !(await stat(resolved)).isFile())
        throw fail('Choose an existing GGUF file.');
    }
    const id = 'native_' + randomUUID().replaceAll('-', '');
    this.sessions.set(id, { id, backend, modelPath: resolved, runner, model, busy: false });
    return { id, backend, modelPath: resolved, input: backend === 'blackice' ? 'tokenIds' : 'text' };
  }
  async generate({ id, tokenIds, prompt, maxTokens = 32, contextSize, signal, onToken, onText } = {}) {
    const session = this.sessions.get(id);
    if (!session) throw fail('Native inference session not found.', 'NATIVE_SESSION_NOT_FOUND');
    if (session.busy) throw fail('Session is already generating.', 'NATIVE_SESSION_BUSY');
    session.busy = true;
    try {
      if (session.backend === 'blackice') {
        if (typeof prompt === 'string') throw fail('The BLACKICE reference engine currently requires pretokenized integer IDs.', 'NATIVE_TOKENIZER_PENDING');
        return { backend: 'blackice', tokens: await session.runner.generateTokenIds(tokenIds,
          { maxNewTokens: maxTokens, signal, onToken }) };
      }
      if (tokenIds) throw fail('The llama.cpp backend requires a text prompt.');
      return await this.llamaCpp.generate({ modelPath: session.modelPath, prompt,
        maxTokens, contextSize, signal, onText });
    } finally { session.busy = false; }
  }
  unload(id) {
    const session = this.sessions.get(id);
    if (!session) return { unloaded: false };
    if (session.busy) throw fail('Cannot unload an active native inference session.', 'NATIVE_SESSION_BUSY');
    session.model?.release();
    session.runner?.reset();
    this.sessions.delete(id);
    return { unloaded: true, id };
  }
  close() {
    for (const session of this.sessions.values()) if (session.busy)
      throw fail('Cannot close native inference while generation is active.', 'NATIVE_SESSION_BUSY');
    for (const id of [...this.sessions.keys()]) this.unload(id);
  }
}
