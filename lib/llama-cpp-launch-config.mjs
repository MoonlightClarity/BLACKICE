import path from 'node:path';

/**
 * Bounded, editable llama.cpp v1.0.0 launcher configuration.
 * Only router-specific options live on the command line. Model options live
 * in an INI preset so per-model overrides are not silently ignored.
 */
export const DEFAULT_LLAMA_CPP_SETTINGS = Object.freeze({
  executablePath: '',
  modelsDirectory: '',
  modelPaths: {},
  modelOverrides: {},
  sleepIdleSeconds: 120,
  // Remains opt-in until Windows router-child teardown has been validated.
  shutdownIdleSeconds: 0,
  modelsMax: 1,
  memoryMarginMiB: 1024,
  fitTargetMiB: 1024,
  ctxSize: 0,
  gpuLayers: 'auto',
  flashAttention: 'auto',
  parallel: 1,
  cacheRamMiB: 0,
  poll: 0,
});

const fail = message => Object.assign(new Error(message), {
  status: 400, code: 'LOCAL_LLAMA_SETTINGS_INVALID',
});
const keys = Object.keys(DEFAULT_LLAMA_CPP_SETTINGS);
const modelOptionKeys = ['ctxSize', 'gpuLayers', 'flashAttention', 'fitTargetMiB', 'parallel', 'cacheRamMiB', 'poll'];
const integer = (value, min, max, name) => {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw fail(name + ' must be a whole number from ' + min + ' through ' + max + '.');
  return value;
};
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value);
const absolute = value => path.isAbsolute(value) || path.win32.isAbsolute(value);
const safePath = (value, name) => {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value) ||
      value && !absolute(value)) throw fail(name + ' must be an absolute local path, or empty for automatic discovery.');
  // Do not allow INI comment characters in a directly configured model path.
  if (name.startsWith('Model path') && /[;#]/.test(value)) throw fail(name + ' contains a reserved INI character.');
  return value.trim();
};
const modelId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 &&
  !/[=[\]\r\n;#\x00-\x1f\x7f]/.test(value) && !['__proto__','prototype','constructor'].includes(value);

function modelOptions(value, field = 'Model options') {
  if (!plainObject(value) || Object.keys(value).some(key => !modelOptionKeys.includes(key))) {
    throw fail(field + ' contains an unsupported option.');
  }
  const result = {};
  for (const key of Object.keys(value)) {
    const entry = value[key];
    if (key === 'ctxSize') result[key] = entry === 0 ? 0 : integer(entry, 128, 262144, field + ' context size');
    if (key === 'parallel') result[key] = integer(entry, 1, 16, field + ' parallel slots');
    if (key === 'cacheRamMiB') result[key] = integer(entry, 0, 65536, field + ' RAM cache');
    if (key === 'poll') result[key] = integer(entry, 0, 100, field + ' polling');
    if (key === 'fitTargetMiB') result[key] = integer(entry, 128, 65536, field + ' GPU reserve');
    if (key === 'gpuLayers') {
      if (entry !== 'auto' && entry !== 'all' && !(Number.isSafeInteger(entry) && entry >= 0 && entry <= 1024))
        throw fail(field + ' GPU layers must be auto, all, or 0–1024.');
      result[key] = entry;
    }
    if (key === 'flashAttention') {
      if (!['auto','on','off'].includes(entry)) throw fail(field + ' Flash Attention must be auto, on, or off.');
      result[key] = entry;
    }
  }
  return result;
}

export function validateLlamaCppSettings(value) {
  if (!plainObject(value) || Object.keys(value).some(key => !keys.includes(key))) {
    throw fail('Use only documented llama.cpp launch settings.');
  }
  const result = { ...DEFAULT_LLAMA_CPP_SETTINGS, modelPaths: {}, modelOverrides: {} };
  result.executablePath = safePath(value.executablePath ?? '', 'llama-server executable');
  result.modelsDirectory = safePath(value.modelsDirectory ?? '', 'GGUF models directory');
  result.sleepIdleSeconds = integer(value.sleepIdleSeconds ?? 120, 30, 86400, 'Idle sleep');
  result.shutdownIdleSeconds = integer(value.shutdownIdleSeconds ?? 0, 0, 86400, 'Full shutdown idle');
  if (result.shutdownIdleSeconds && result.shutdownIdleSeconds <= result.sleepIdleSeconds)
    throw fail('Full shutdown must occur later than native model sleep, or be disabled.');
  result.modelsMax = integer(value.modelsMax ?? 1, 1, 8, 'Maximum loaded models');
  result.memoryMarginMiB = integer(value.memoryMarginMiB ?? 1024, 0, 65536, 'Router GPU memory margin');
  const globalOptions = modelOptions(Object.fromEntries(modelOptionKeys
    .map(key => [key, value[key] ?? DEFAULT_LLAMA_CPP_SETTINGS[key]])), 'Global settings');
  Object.assign(result, globalOptions);
  const paths = value.modelPaths ?? {};
  if (!plainObject(paths) || Object.keys(paths).length > 100)
    throw fail('Model paths must be a map of at most 100 model IDs to absolute GGUF files.');
  for (const [id, modelPath] of Object.entries(paths)) {
    if (!modelId(id)) throw fail('A custom model ID contains reserved characters.');
    const selected = safePath(modelPath, 'Model path ' + id);
    if (!/\.gguf$/i.test(selected)) throw fail('Custom model paths must reference .gguf files.');
    result.modelPaths[id] = selected;
  }
  const overrides = value.modelOverrides ?? {};
  if (!plainObject(overrides) || Object.keys(overrides).length > 100)
    throw fail('Model overrides must be a map of at most 100 models.');
  for (const [id, settings] of Object.entries(overrides)) {
    if (!modelId(id)) throw fail('A model override ID contains reserved characters.');
    result.modelOverrides[id] = modelOptions(settings, 'Model ' + id);
  }
  return result;
}

const iniKey = {
  ctxSize: 'c', gpuLayers: 'n-gpu-layers', flashAttention: 'flash-attn',
  fitTargetMiB: 'fit-target', parallel: 'parallel', cacheRamMiB: 'cache-ram', poll: 'poll',
};
const iniValue = (key, value) => key === 'flashAttention' ? String(value) : String(value);
const appendOptions = (rows, options) => {
  for (const key of modelOptionKeys) if (Object.hasOwn(options, key)) {
    rows.push(iniKey[key] + ' = ' + iniValue(key, options[key]));
  }
};

/** Pure launch plan. No disk writes, downloads, model load or process spawn. */
export function buildLlamaCppLaunch(settings, { presetPath = '<generated-preset.ini>', port = 8080 } = {}) {
  const config = validateLlamaCppSettings(settings);
  if (!config.modelsDirectory && !Object.keys(config.modelPaths).length)
    throw fail('Configure a GGUF models directory or an explicit model path before on-demand startup.');
  const ini = ['version = 1', '[*]', 'fit = on'];
  appendOptions(ini, config);
  for (const id of [...new Set([...Object.keys(config.modelPaths), ...Object.keys(config.modelOverrides)])].sort()) {
    ini.push('[' + id + ']');
    if (config.modelPaths[id]) ini.push('model = ' + config.modelPaths[id]);
    appendOptions(ini, config.modelOverrides[id] || {});
  }
  const args = [
    '--host', '127.0.0.1', '--port', String(port),
    '--models-preset', presetPath,
    '--models-max', String(config.modelsMax),
    '--models-memory-margin', String(config.memoryMarginMiB),
    '--models-autoload',
    '--sleep-idle-seconds', String(config.sleepIdleSeconds),
    '--no-webui',
    ...(config.modelsDirectory ? ['--models-dir', config.modelsDirectory] : []),
  ];
  return { args, preset: ini.join('\n') + '\n', effective: config };
}
