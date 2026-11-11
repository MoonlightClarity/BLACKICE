const paths = Object.freeze({
  status: '/api/native-inference/status',
  load: '/api/native-inference/load',
  generate: '/api/native-inference/generate',
  cancel: '/api/native-inference/cancel',
  unload: '/api/native-inference/unload',
});

const invalid = message => ({ status: 400, body: { error: message, code: 'NATIVE_INFERENCE_ARGUMENTS' } });
const validId = id => typeof id === 'string' && /^native_[a-f0-9]{32}$/.test(id);
const validShape = (data, fields) => data && typeof data === 'object' && !Array.isArray(data) &&
  Object.keys(data).every(name => fields.includes(name));

/** Local experimental API. Models load on worker threads, never on the Electron main loop.
 * Existing provider routes and saved chat identities remain untouched.
 */
export async function nativeInferenceHTTP({ manager, pathname, method, remote = false, value, signal } = {}) {
  if (!Object.values(paths).includes(pathname)) return null;
  if (remote) return { status: 403, body: { error: 'Native model management is available in the local BLACKICE desktop only.', code: 'NATIVE_INFERENCE_LOCAL_ONLY' } };
  if (pathname === paths.status)
    return method === 'GET' ? { status: 200, body: await manager.status() }
      : { status: 405, body: { error: 'Use GET for native inference status.' } };
  if (method !== 'POST') return { status: 405, body: { error: 'Use POST for native model lifecycle actions.' } };
  if (!validShape(value, pathname === paths.load ? ['backend', 'modelPath', 'maxContext']
    : pathname === paths.generate ? ['id', 'prompt', 'messages', 'tokenIds', 'maxTokens', 'contextSize', 'enableThinking']
      : ['id'])) return invalid('Only documented native inference fields are accepted.');

  try {
    if (pathname === paths.load) {
      if (!['blackice', 'llama.cpp'].includes(value.backend) ||
          typeof value.modelPath !== 'string' || value.modelPath.length < 1 || value.modelPath.length > 4096 ||
          value.maxContext !== undefined &&
          (!Number.isSafeInteger(value.maxContext) || value.maxContext < 1 || value.maxContext > 131072))
        return invalid('Choose a native engine, an absolute local model path, and an optional positive context.');
      return { status: 200, body: await manager.load(value) };
    }
    if (!validId(value.id)) return invalid('Choose a native inference session ID.');
    if (pathname === paths.cancel) return { status: 200, body: manager.cancel(value.id) };
    if (pathname === paths.unload) return { status: 200, body: await manager.unload(value.id) };

    const modes = Number(value.prompt !== undefined) +
      Number(value.messages !== undefined) + Number(value.tokenIds !== undefined);
    if (modes !== 1) return invalid('Specify exactly one of prompt, messages, or tokenIds.');
    if (value.maxTokens !== undefined && (!Number.isSafeInteger(value.maxTokens) || value.maxTokens < 1 || value.maxTokens > 64))
      return invalid('Experimental generation accepts 1 to 64 tokens.');
    if (value.enableThinking !== undefined && typeof value.enableThinking !== 'boolean')
      return invalid('enableThinking must be a boolean.');
    if (value.contextSize !== undefined &&
        (!Number.isSafeInteger(value.contextSize) || value.contextSize < 1 || value.contextSize > 131072))
      return invalid('Context size must be a positive integer.');
    if (value.prompt !== undefined && (typeof value.prompt !== 'string' || !value.prompt.length || value.prompt.length > 100000))
      return invalid('Prompt must contain 1 to 100,000 characters.');
    if (value.messages !== undefined &&
        (!Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > 100 ||
         !value.messages.every(item => item && ['system', 'user', 'assistant'].includes(item.role) &&
           typeof item.content === 'string' && item.content.length <= 100000)))
      return invalid('Provide up to 100 plain system/user/assistant messages.');
    if (value.tokenIds !== undefined &&
        (!Array.isArray(value.tokenIds) || value.tokenIds.length < 1 || value.tokenIds.length > 131072 ||
         !value.tokenIds.every(Number.isSafeInteger)))
      return invalid('Pretokenized input must be a nonempty integer array.');
    const { id, maxTokens = 1, ...options } = value;
    return { status: 200, body: await manager.generate({ ...options, id, maxTokens, signal }) };
  } catch (error) {
    const code = error?.code || 'NATIVE_INFERENCE_FAILED';
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
      ? error.status
      : code === 'ABORT_ERR' ? 499
        : /BUSY/.test(code) ? 409
          : /NOT_FOUND/.test(code) ? 404
            : /NOT_BUNDLED|NOT_INSTALLED/.test(code) ? 503
              : 400;
    return { status, body: { error: String(error?.message || 'Native inference failed.').slice(0, 1200), code } };
  }
}
