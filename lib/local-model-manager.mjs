import { inspectLlamaBundle, defaultBundleRoot } from './llama-cpp-bundle.mjs';
import { llamaCppDownloads } from './llama-cpp-downloads.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { llamaCppCatalog, loadLlamaCpp, unloadLlamaCpp } from './llama-cpp-local.mjs';
import { DEFAULT_LLAMA_CPP_SETTINGS, buildLlamaCppLaunch } from './llama-cpp-launch-config.mjs';
import { LlamaCppSettingsStore } from './llama-cpp-settings.mjs';
import { LlamaCppServerSupervisor } from './llama-cpp-supervisor.mjs';

export const LOCAL_ENGINES = Object.freeze({
  ollama: { name: 'Ollama', api: 'http://127.0.0.1:11434', baseUrl: 'http://127.0.0.1:11434/v1' },
  lmstudio: { name: 'LM Studio', api: 'http://127.0.0.1:1234', baseUrl: 'http://127.0.0.1:1234/v1' },
  llamacpp: { name: 'llama.cpp', api: 'http://127.0.0.1:8080', baseUrl: 'http://127.0.0.1:8080/v1' },
});

const failure = (message, code = 'LOCAL_MODEL_ERROR', status = 400) => Object.assign(new Error(message), { code, status });
const validModel = value => typeof value === 'string' && value.length > 0 && value.length <= 256 &&
  !value.includes('::') && !/[\x00-\x1f\x7f]/.test(value);
const validContext = value => value === undefined || Number.isSafeInteger(value) && value >= 128 && value <= 262144;
const text = (value, limit = 320) => typeof value === 'string' ? value.slice(0, limit) : '';
const errorMessage = e => e?.code === 'ECONNREFUSED' || e?.cause?.code === 'ECONNREFUSED' ||
  e?.name === 'TimeoutError' ? 'Local model server is not running or did not respond.' : text(e?.message || 'Local model server is unavailable.');

function checkRequest(engine, model, contextLength) {
  if (!Object.hasOwn(LOCAL_ENGINES, engine)) throw failure('Choose Ollama, LM Studio, or llama.cpp.');
  if (!validModel(model)) throw failure('Choose a valid local model ID (maximum 256 characters, without control characters or ::).');
  if (!validContext(contextLength)) throw failure('Context length must be a whole number from 128 through 262144.');
}

export class LocalModelManager {
  constructor({ fetchImpl = globalThis.fetch, spawnImpl = spawn, ollamaExecutable,
    dataDir, llamaSettingsStore, llamaSupervisor, llamaExecutableCandidates, llamaBundleRoot = defaultBundleRoot() } = {}) {
    this.fetchImpl = fetchImpl;
    this.spawnImpl = spawnImpl;
    this.ollamaExecutable = ollamaExecutable;
    this.llamaSettingsStore = llamaSettingsStore || (dataDir ? new LlamaCppSettingsStore({dataDir}) : null);
    // A candidate is only considered after stat() proves that an executable exists.
    const candidates = llamaExecutableCandidates || [
      ...(typeof process.resourcesPath === 'string' ? [
        path.join(process.resourcesPath, 'llama.cpp', 'llama-server.exe'),
        path.join(process.resourcesPath, 'llama-server.exe'),
      ] : []),
    ];
    this.llamaSupervisor = llamaSupervisor || (dataDir ? new LlamaCppServerSupervisor({
      request: this.request.bind(this), dataDir, executableCandidates: candidates,
      spawnImpl,
      resolveBundledRuntime: () => this.bundledRuntime(),
    }) : null);
    this.llamaLoadPromises = new Map();
    this.llamaBundleRoot = llamaBundleRoot;
    this.bundleInspection = null;
  }

  bundledRuntime() {
    return this.bundleInspection ||= inspectLlamaBundle({root:this.llamaBundleRoot});
  }
  async llamaRuntimeStatus() {
    const configured = this.llamaConfig().settings.executablePath;
    if (configured) {
      const available = await stat(configured).then(s=>s.isFile()).catch(()=>false);
      return {available,source:'custom',version:null,backend:null,message:available?'Custom llama-server selected.':'The configured custom executable is unavailable.'};
    }
    const {executablePath,fallbackPath,...status} = await this.bundledRuntime();
    return this.llamaSupervisor?.runtime ? {...status,backend:this.llamaSupervisor.runtime.backend,message:this.llamaSupervisor.runtime.message} : status;
  }
  async init() { await this.llamaSettingsStore?.init(); return this; }
  llamaConfig() {
    return this.llamaSettingsStore?.snapshot() || {
      revision:0, settings:structuredClone(DEFAULT_LLAMA_CPP_SETTINGS),
      recommended:structuredClone(DEFAULT_LLAMA_CPP_SETTINGS),
    };
  }
  llamaProcessStatus() { return this.llamaSupervisor?.status(this.llamaConfig().revision) || {
    owned:false, activeLeases:0, starting:false, pendingRestart:false,
  }; }
  llamaPreview() {
    try { return buildLlamaCppLaunch(this.llamaConfig().settings).args; }
    catch { return null; }
  }
  async configureLlama(value) {
    if (!this.llamaSettingsStore) throw failure('Local llama.cpp settings are unavailable.', 'LOCAL_LLAMA_SETTINGS_UNAVAILABLE', 503);
    return this.llamaSettingsStore.update(value);
  }
  async acquireLlama(model, {signal} = {}) {
    checkRequest('llamacpp', model);
    const config = this.llamaConfig();
    const lease = this.llamaSupervisor
      ? await this.llamaSupervisor.acquire(config.settings, config.revision, {signal})
      : {owned:false, release:() => {}};
    try {
      if (!this.llamaLoadPromises.has(model)) {
        const pending = loadLlamaCpp(this.request.bind(this), {model});
        this.llamaLoadPromises.set(model, pending);
        void pending.finally(() => { if (this.llamaLoadPromises.get(model) === pending) this.llamaLoadPromises.delete(model); }).catch(() => {});
      }
      const loaded = await this.llamaLoadPromises.get(model);
      signal?.throwIfAborted?.();
      return {...loaded, owned: lease.owned, release: lease.release};
    } catch (cause) { lease.release(); throw cause; }
  }
  async activateLlama(model) {
    const acquired = await this.acquireLlama(model);
    try { const {release, owned, ...receipt} = acquired; return receipt; }
    finally { acquired.release(); }
  }
  async close() { await this.llamaSupervisor?.close(); }


  async request(engine, route, { body, timeoutMs = 3000 } = {}) {
    const base = LOCAL_ENGINES[engine]?.api;
    if (!base) throw failure('Unsupported local engine.');
    let response;
    try {
      response = await this.fetchImpl(base + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw failure(LOCAL_ENGINES[engine].name + ': ' + errorMessage(e), 'LOCAL_ENGINE_OFFLINE', 503);
    }
    let data;
    try { data = await response.json(); } catch { data = null; }
    if (!response.ok) throw failure(
      LOCAL_ENGINES[engine].name + ': ' + text((typeof data?.error === 'object' ? data.error?.message : data?.error) || data?.message || 'Request failed (HTTP ' + response.status + ').'),
      'LOCAL_ENGINE_REQUEST_FAILED', response.status >= 400 && response.status <= 599 ? response.status : 502);
    return data || {};
  }

  async ollamaCatalog() {
    const engine = 'ollama', config = LOCAL_ENGINES[engine];
    try {
      const tags = await this.request(engine, '/api/tags');
      let loaded = [];
      try { loaded = (await this.request(engine, '/api/ps')).models || []; } catch {}
      const running = new Set(loaded.map(entry => entry.name || entry.model));
      return { id: engine, name: config.name, available: true,
        models: (Array.isArray(tags.models) ? tags.models : []).slice(0, 500).filter(item => validModel(item.name || item.model)).map(item => ({
          id: item.name || item.model, loaded: running.has(item.name || item.model),
          sizeBytes: Number.isFinite(item.size) ? item.size : null,
          format: item.details?.quantization_level || null,
        })) };
    } catch (e) { return { id: engine, name: config.name, available: false, models: [], error: errorMessage(e) }; }
  }

  async lmStudioCatalog() {
    const engine = 'lmstudio', config = LOCAL_ENGINES[engine];
    try {
      const result = await this.request(engine, '/api/v1/models');
      return { id: engine, name: config.name, available: true,
        models: (Array.isArray(result.models) ? result.models : []).slice(0, 500)
          .filter(item => item.type === 'llm' && validModel(item.key))
          .map(item => ({
            id: item.key, displayName: text(item.display_name, 160) || item.key,
            loaded: Array.isArray(item.loaded_instances) && item.loaded_instances.length > 0,
            instanceIds: (item.loaded_instances || []).map(instance => instance.id).filter(validModel),
            sizeBytes: Number.isFinite(item.size_bytes) ? item.size_bytes : null,
            format: item.quantization?.name || null,
          })) };
    } catch (e) { return { id: engine, name: config.name, available: false, models: [], error: errorMessage(e) }; }
  }

  async llamaCatalog() {
    const engine = 'llamacpp', config = LOCAL_ENGINES[engine];
    try {
      const catalog = await llamaCppCatalog(this.request.bind(this));
      return { id: engine, name: config.name, available: true, ...catalog };
    } catch (e) {
      return { id: engine, name: config.name, available: false, models: [], error: errorMessage(e) };
    }
  }

  async downloads() { return llamaCppDownloads(this.fetchImpl); }

  async list() {
    const [ollama, lmstudio, llamacpp] = await Promise.all([this.ollamaCatalog(), this.lmStudioCatalog(), this.llamaCatalog()]);
    return { engines: [ollama, lmstudio, llamacpp] };
  }

  async load({ engine, model, contextLength } = {}) {
    checkRequest(engine, model, contextLength);
    if (engine === 'llamacpp') {
      if (contextLength !== undefined) return loadLlamaCpp(this.request.bind(this), {model, contextLength});
      return this.activateLlama(model);
    }
    if (engine === 'ollama') {
      const options = contextLength === undefined ? undefined : { num_ctx: contextLength };
      const response = await this.request(engine, '/api/generate', {
        body: { model, prompt: '', stream: false, keep_alive: '30m', ...(options ? { options } : {}) },
        timeoutMs: 300000,
      });
      if (response.done !== true) throw failure('Ollama did not confirm the model loaded.', 'LOCAL_MODEL_LOAD_UNCONFIRMED', 502);
      return { engine, model, loaded: true };
    }
    const result = await this.request(engine, '/api/v1/models/load', {
      body: { model, ...(contextLength ? { context_length: contextLength } : {}) }, timeoutMs: 300000,
    });
    if (result.status !== 'loaded' || !validModel(result.instance_id)) throw failure('LM Studio did not confirm the model loaded.', 'LOCAL_MODEL_LOAD_UNCONFIRMED', 502);
    return { engine, model, instanceId: result.instance_id, loaded: true };
  }

  async unload({ engine, model, instanceId } = {}) {
    checkRequest(engine, model);
    if (engine === 'llamacpp') return unloadLlamaCpp(this.request.bind(this), { model });
    if (engine === 'ollama') {
      const result = await this.request(engine, '/api/generate', { body: { model, prompt: '', stream: false, keep_alive: 0 }, timeoutMs: 30000 });
      if (result.done !== true) throw failure('Ollama did not confirm unloading.', 'LOCAL_MODEL_UNLOAD_UNCONFIRMED', 502);
      return { engine, model, loaded: false };
    }
    const id = instanceId || model;
    if (!validModel(id)) throw failure('Choose a valid LM Studio instance ID.');
    const result = await this.request(engine, '/api/v1/models/unload', { body: { instance_id: id }, timeoutMs: 30000 });
    if (result.instance_id !== id) throw failure('LM Studio did not confirm unloading.', 'LOCAL_MODEL_UNLOAD_UNCONFIRMED', 502);
    return { engine, model, loaded: false };
  }

  async executable() {
    if (this.ollamaExecutable) return this.ollamaExecutable;
    if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
      for (const name of ['Programs/Ollama/ollama.exe', 'Ollama/ollama.exe']) {
        const candidate = path.join(process.env.LOCALAPPDATA, name);
        try { await access(candidate); return candidate; } catch {}
      }
    }
    return 'ollama';
  }

  async runOllama(args) {
    const command = await this.executable();
    return new Promise((resolve, reject) => {
      let child;
      try { child = this.spawnImpl(command, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (e) { reject(failure('Unable to start Ollama: ' + errorMessage(e), 'LOCAL_MODEL_CLI_UNAVAILABLE', 503)); return; }
      let output = '', complete = false;
      const finish = (error, value) => {
        if (complete) return; complete = true; clearTimeout(timer); error ? reject(error) : resolve(value);
      };
      const timer = setTimeout(() => { child.kill(); finish(failure('Ollama import timed out.', 'LOCAL_MODEL_IMPORT_TIMEOUT', 504)); }, 600000);
      for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => { output = (output + String(chunk)).slice(-12000); });
      child.once('error', e => finish(failure('Ollama CLI is not available. Install Ollama or configure OLLAMA_EXECUTABLE. ' + errorMessage(e), 'LOCAL_MODEL_CLI_UNAVAILABLE', 503)));
      child.once('close', code => finish(code === 0 ? null : failure('Ollama import failed: ' + text(output, 1200), 'LOCAL_MODEL_IMPORT_FAILED', 502), { exitCode: code }));
    });
  }

  async importFromDisk({ sourcePath, model } = {}) {
    if (!validModel(model) || !/^[a-z0-9][a-z0-9._:/-]*$/i.test(model)) throw failure('Use a valid Ollama model name (letters, digits, periods, underscores, hyphens, slashes or colons).');
    if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath) || sourcePath.length > 4096 || /[\x00-\x1f]/.test(sourcePath))
      throw failure('Select an absolute path to a GGUF file or Safetensors model folder.');
    const resolved = path.resolve(sourcePath);
    let kind;
    try {
      const info = await stat(resolved);
      if (info.isFile() && /\.gguf$/i.test(resolved)) kind = 'GGUF';
      if (info.isDirectory()) {
        const entries = await readdir(resolved);
        if (entries.includes('config.json') && entries.some(name => /\.safetensors$/i.test(name))) kind = 'Safetensors';
      }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!kind) throw failure('Choose a .gguf file, or a Safetensors folder containing config.json and .safetensors weights.');
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'blackice-local-model-'));
    try {
      const modelfile = path.join(temporary, 'Modelfile');
      const quotedPath = resolved.replaceAll('\\', '/').replaceAll('"', '\\"');
      await writeFile(modelfile, 'FROM "' + quotedPath + '"\n', { encoding: 'utf8', flag: 'wx' });
      // Intentionally omit --quantize. The original source precision is not deliberately reduced.
      await this.runOllama(['create', model, '-f', modelfile]);
    } finally { await rm(temporary, { recursive: true, force: true }); }
    return { engine: 'ollama', model, imported: true, sourceFormat: kind, quantizationRequested: false };
  }
}

export async function registerLocalModel(runtime, engine, model) {
  checkRequest(engine, model);
  if (!runtime || typeof runtime.listProviders !== 'function' || typeof runtime.saveProvider !== 'function')
    throw failure('BLACKICE model configuration is unavailable.', 'LOCAL_MODEL_CONFIG_UNAVAILABLE', 503);
  const { baseUrl, name } = LOCAL_ENGINES[engine];
  const providers = runtime.listProviders();
  const existing = providers.find(p => p.preset === engine && p.type === 'compatible' && p.baseUrl === baseUrl);
  const ids = new Set(providers.map(p => p.id));
  let id = existing?.id || 'local_' + engine;
  if (!existing && ids.has(id)) {
    let suffix = 2;
    while (ids.has(id + '_' + suffix)) suffix++;
    id += '_' + suffix;
  }
  const models = [...(existing?.models || []).map(item => item.id), model];
  await runtime.saveProvider(existing
    ? { id, enabled: true, models: [...new Set(models)] }
    : { id, name: 'Local ' + name, preset: engine, type: 'compatible', baseUrl,
        enabled: true, models: [model] }, { preserveDefault: true });
  return { providerId: id, selection: id + '::' + model };
}
