import { registerLocalModel, LOCAL_ENGINES } from './local-model-manager.mjs';

const invalid = message => ({ status: 400, body: { error: message, code: 'LOCAL_MODEL_ARGUMENTS' } });

/** This route is local-session only. Imported weights are never uploaded to any provider. */
export async function localModelHTTP({ manager, runtime, pathname, method, remote = false, value } = {}) {
  const supported = new Set(['/api/local-models', '/api/local-models/load', '/api/local-models/unload', '/api/local-models/import', '/api/local-models/downloads', '/api/local-models/config', '/api/local-models/activate']);
  if (!supported.has(pathname)) return null;
  if (remote) return { status: 403, body: { error: 'Local model files and runtimes are accessible only from the local BLACKICE app.', code: 'LOCAL_MODEL_LOCAL_SESSION_REQUIRED' } };
  if (pathname === '/api/local-models/downloads') {
    if (method !== 'GET') return { status: 405, body: {error: 'Use GET to discover official runtime downloads.'} };
    try { return {status: 200, body: await manager.downloads()}; }
    catch (e) { return {status: e.status || 502, body: {error: e.message, code: e.code || 'LLAMA_DOWNLOAD_CATALOG_UNAVAILABLE'}}; }
  }
  if (pathname === '/api/local-models' && method === 'GET') return { status: 200, body: await manager.list() };
  if (pathname === '/api/local-models/config' && method === 'GET') return {status:200, body:{
    ...manager.llamaConfig(), process: manager.llamaProcessStatus(), launchArgs:manager.llamaPreview(),
  }};
  if (pathname === '/api/local-models' || method !== 'POST') return { status: 405, body: { error: 'Use GET to list models or POST to configure, activate, load, unload, or import.' } };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Provide local model details.');
  const allowed = pathname.endsWith('/import') ? ['sourcePath', 'model'] :
    pathname.endsWith('/unload') ? ['engine', 'model', 'instanceId'] :
    pathname.endsWith('/config') ? ['expectedRevision','settings'] :
    pathname.endsWith('/activate') ? ['providerId','model'] : ['engine', 'model', 'contextLength'];
  if (Object.keys(value).some(key => !allowed.includes(key))) return invalid('Only documented local model fields are accepted.');
  try {
    if (pathname.endsWith('/config')) {
      const saved = await manager.configureLlama(value);
      return {status:200, body:{...saved,process:manager.llamaProcessStatus(),launchArgs:manager.llamaPreview()}};
    }
    if (pathname.endsWith('/activate')) {
      const provider = runtime.listProviders?.().find(item => item.id === value.providerId);
      if (!provider || provider.preset !== 'llamacpp' || provider.type !== 'compatible' ||
          provider.baseUrl !== LOCAL_ENGINES.llamacpp.baseUrl ||
          !provider.models?.some(item => item.id === value.model))
        return {status:404,body:{error:'The exact llama.cpp model is not registered in this connection.',code:'LOCAL_LLAMA_SELECTION_NOT_REGISTERED'}};
      return {status:200,body:await manager.activateLlama(value.model)};
    }
    if (pathname.endsWith('/unload')) return { status: 200, body: await manager.unload(value) };
    if (pathname.endsWith('/load')) {
      const loaded = await manager.load(value);
      const registered = await registerLocalModel(runtime, loaded.engine, loaded.model);
      return { status: 200, body: { ...loaded, ...registered } };
    }
    const imported = await manager.importFromDisk(value);
    // Loading is explicit and gives the user a ready-to-use choice in Chat.
    const loaded = await manager.load({ engine: imported.engine, model: imported.model });
    const registered = await registerLocalModel(runtime, imported.engine, imported.model);
    return { status: 200, body: { ...imported, ...loaded, ...registered } };
  } catch (e) {
    return { status: Number.isInteger(e.status) && e.status >= 400 && e.status <= 599 ? e.status : 500,
      body: { error: String(e.message || 'Local model operation failed.').slice(0, 1800), code: e.code || 'LOCAL_MODEL_ERROR' } };
  }
}
