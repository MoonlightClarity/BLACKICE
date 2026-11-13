/**
 * llama.cpp 1.0 llama-server adapter.
 *
 * Router mode exposes /models, /models/load and /models/unload. Single-model
 * mode only exposes an already-loaded model through /v1/models. Do not claim
 * to unload or change context on a single-model process we do not own.
 */
const failure = (message, code = 'LOCAL_MODEL_ERROR', status = 400) =>
  Object.assign(new Error(message), { code, status });
const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 256 &&
  !id.includes('::') && !/[\x00-\x1f\x7f]/.test(id);
const loadedStatus = status => status === 'loaded' || status === 'sleeping';
const modelStatus = item => typeof item.status === 'string' ? item.status : item.status?.value;

const usableRows = response => {
  if (!Array.isArray(response?.data)) throw failure(
    'The llama.cpp server returned an unexpected model catalog. Use a compatible llama-server build.',
    'LOCAL_LLAMA_CATALOG_INVALID', 502);
  return response.data.filter(item => item && validId(item.id)).slice(0, 500);
};

/**
 * llama-server's router lists all models; a single-model server lists only
 * its active model. /models returning 404/405 is the documented distinction.
 */
export async function llamaCppCatalog(request) {
  try {
    const response = await request('llamacpp', '/models');
    return {
      mode: 'router',
      models: usableRows(response).map(item => ({
        id: item.id,
        displayName: item.name && typeof item.name === 'string' ? item.name.slice(0, 160) : item.id,
        loaded: loadedStatus(modelStatus(item)),
        manageable: true,
        status: modelStatus(item) || 'unknown',
        sizeBytes: Number.isFinite(item.size) && item.size >= 0 ? item.size : null,
        format: typeof item.meta?.quantization === 'string' ? item.meta.quantization : null,
      })),
    };
  } catch (error) {
    if (error?.status !== 404 && error?.status !== 405) throw error;
  }
  const response = await request('llamacpp', '/v1/models');
  return {
    mode: 'single',
    models: usableRows(response).map(item => ({
      id: item.id,
      displayName: item.id,
      loaded: true,
      manageable: false,
      status: 'loaded',
      sizeBytes: null,
      format: null,
    })),
  };
}

async function modelInCatalog(request, model) {
  const catalog = await llamaCppCatalog(request);
  const found = catalog.models.find(item => item.id === model);
  if (!found) throw failure('This model was not found on the running llama.cpp server. Refresh the model list.',
    'LOCAL_MODEL_NOT_FOUND', 404);
  return { catalog, found };
}

export async function loadLlamaCpp(request, { model, contextLength }) {
  // The router's /models/load accepts only {model}. A context override here
  // would silently do nothing; require startup flags or a router preset.
  if (contextLength !== undefined) throw failure(
    'Set llama.cpp context with --ctx-size or a --models-preset entry when starting llama-server; /models/load cannot change it.',
    'LOCAL_LLAMA_CONTEXT_REQUIRES_RESTART');
  const { catalog, found } = await modelInCatalog(request, model);
  if (catalog.mode === 'single' || found.loaded) return { engine: 'llamacpp', model, loaded: true, mode: catalog.mode };
  const response = await request('llamacpp', '/models/load', { body: { model }, timeoutMs: 300000 });
  if (response?.success !== true) throw failure(
    'llama.cpp did not confirm the load request.', 'LOCAL_MODEL_LOAD_UNCONFIRMED', 502);
  const after = await modelInCatalog(request, model);
  if (!after.found.loaded) throw failure(
    'llama.cpp accepted the load request, but the model is not confirmed loaded. Refresh and check the server status.',
    'LOCAL_MODEL_LOAD_UNCONFIRMED', 502);
  return { engine: 'llamacpp', model, loaded: true, mode: 'router' };
}

export async function unloadLlamaCpp(request, { model }) {
  const { catalog, found } = await modelInCatalog(request, model);
  if (catalog.mode === 'single') throw failure(
    'This llama.cpp server was started with a single model. Stop or restart llama-server to free its memory.',
    'LOCAL_LLAMA_UNLOAD_UNSUPPORTED', 409);
  if (!found.loaded) return { engine: 'llamacpp', model, loaded: false, mode: 'router' };
  const response = await request('llamacpp', '/models/unload', { body: { model }, timeoutMs: 30000 });
  if (response?.success !== true) throw failure(
    'llama.cpp did not confirm the unload request.', 'LOCAL_MODEL_UNLOAD_UNCONFIRMED', 502);
  const after = await modelInCatalog(request, model);
  if (after.found.loaded) throw failure(
    'llama.cpp accepted the unload request, but the model still reports loaded.',
    'LOCAL_MODEL_UNLOAD_UNCONFIRMED', 502);
  return { engine: 'llamacpp', model, loaded: false, mode: 'router' };
}
