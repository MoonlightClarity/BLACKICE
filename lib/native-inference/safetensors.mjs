import { open, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { decodeFloatTensor } from './precision.mjs';

const fail = (message, code = 'INVALID_SAFETENSORS') => Object.assign(new Error(message), { code });
const stride = Object.freeze({ F16: 2, BF16: 2, F32: 4 });
const MAX_HEADER = 32 * 1024 * 1024;
const positiveShape = shape => Array.isArray(shape) && shape.every(n => Number.isSafeInteger(n) && n >= 0);
const sizeOf = shape => shape.reduce((size, n) => {
  if (size && n > Number.MAX_SAFE_INTEGER / size) throw fail('Tensor shape overflows the addressable file range.');
  return size * n;
}, 1);

async function readExact(handle, position, length) {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (!bytesRead) throw fail('Safetensors file ended before the declared tensor data.');
    offset += bytesRead;
  }
  return buffer;
}

/** Only reads and validates file headers until a tensor is explicitly requested. */
export class SafetensorsFile {
  constructor(file, { maxTensorBytes = 3 * 1024 ** 3 } = {}) {
    this.file = path.resolve(file);
    this.maxTensorBytes = maxTensorBytes;
    this.entries = new Map();
    this.dataStart = 0;
    this.length = 0;
    this.cache = new Map();
  }

  async init() {
    const file = await open(this.file, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size < 10) throw fail('Expected a nonempty Safetensors file.');
      const intro = await readExact(file, 0, 8);
      const size = intro.readBigUInt64LE(0);
      if (size < 2n || size > BigInt(MAX_HEADER) || size + 8n > BigInt(info.size))
        throw fail('Safetensors header length is invalid or exceeds the configured limit.');
      const json = await readExact(file, 8, Number(size));
      if (json[0] !== 0x7b) throw fail('Safetensors header must begin with an object.');
      let header;
      try { header = JSON.parse(json.toString('utf8')); }
      catch { throw fail('Safetensors header contains invalid JSON.'); }
      if (!header || Array.isArray(header) || typeof header !== 'object') throw fail('Safetensors header must be an object.');
      this.dataStart = 8 + Number(size);
      this.length = info.size;
      const spans = [];
      for (const [name, entry] of Object.entries(header)) {
        if (name === '__metadata__') continue;
        if (!entry || typeof entry !== 'object' || !Object.hasOwn(stride, entry.dtype) ||
          !positiveShape(entry.shape) || !Array.isArray(entry.data_offsets) || entry.data_offsets.length !== 2)
          throw fail('Unsupported or invalid tensor header for ' + name.slice(0, 120));
        const [begin, end] = entry.data_offsets;
        if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end < begin ||
          this.dataStart + end > info.size || end - begin !== sizeOf(entry.shape) * stride[entry.dtype])
          throw fail('Tensor byte offsets or shape are inconsistent for ' + name.slice(0, 120));
        if (end - begin > this.maxTensorBytes) throw fail('A tensor exceeds the reference engine memory budget.');
        this.entries.set(name, Object.freeze({ shape: [...entry.shape], dtype: entry.dtype, begin, end }));
        spans.push([begin, end, name]);
      }
      spans.sort((a, b) => a[0] - b[0]);
      // Reject overlapping views. No implicit aliasing or hidden reshaping of original weights.
      for (let i = 1; i < spans.length; i++) if (spans[i][0] < spans[i - 1][1])
        throw fail('Safetensors header contains overlapping tensor ranges.');
      return this;
    } finally { await file.close(); }
  }

  async tensor(name) {
    if (this.cache.has(name)) return this.cache.get(name);
    const entry = this.entries.get(name);
    if (!entry) throw fail('Model weight is missing: ' + name, 'MODEL_TENSOR_MISSING');
    const file = await open(this.file, 'r');
    let bytes;
    try { bytes = await readExact(file, this.dataStart + entry.begin, entry.end - entry.begin); }
    finally { await file.close(); }
    const tensor = Object.freeze({ shape: entry.shape, dtype: entry.dtype, data: decodeFloatTensor(bytes, entry.dtype) });
    this.cache.set(name, tensor);
    return tensor;
  }

  release() { this.cache.clear(); }
}

/** Supports one unsharded file or an explicit Hugging Face shard index. */
export async function openSafetensorsModel(directory) {
  const modelDir = path.resolve(directory);
  const config = JSON.parse(await readFile(path.join(modelDir, 'config.json'), 'utf8'));
  if (config.model_type !== 'qwen3') throw fail('The BLACKICE reference engine currently implements Qwen3 only.', 'UNSUPPORTED_MODEL_ARCH');
  let index;
  try { index = JSON.parse(await readFile(path.join(modelDir, 'model.safetensors.index.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let files;
  let weightMap;
  if (index) {
    weightMap = index.weight_map;
    if (!weightMap || typeof weightMap !== 'object' || Array.isArray(weightMap)) throw fail('Invalid Safetensors shard index.');
    files = [...new Set(Object.values(weightMap))];
  } else {
    const candidates = (await readdir(modelDir)).filter(name => name.endsWith('.safetensors'));
    if (candidates.length !== 1) throw fail('Expected one Safetensors file or an explicit shard index.');
    files = candidates;
  }
  const readers = new Map();
  for (const name of files) {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.safetensors$/.test(name))
      throw fail('Shard index includes an invalid model filename.');
    const reader = await new SafetensorsFile(path.join(modelDir, name)).init();
    readers.set(name, reader);
  }
  const locations = new Map();
  for (const [fileName, reader] of readers) for (const name of reader.entries.keys()) {
    if (locations.has(name)) throw fail('Tensor is defined by multiple model shards.');
    locations.set(name, fileName);
  }
  if (weightMap) for (const [name, fileName] of Object.entries(weightMap))
    if (locations.get(name) !== fileName) throw fail('The shard index does not match its model files.');
  return {
    config,
    tensors: locations.size,
    sourcePrecision: [...new Set([...readers.values()].flatMap(r => [...r.entries.values()].map(t => t.dtype)))],
    async tensor(name) {
      const reader = readers.get(locations.get(name));
      if (!reader) throw fail('Model weight is missing: ' + name, 'MODEL_TENSOR_MISSING');
      return reader.tensor(name);
    },
    release() { for (const reader of readers.values()) reader.release(); },
  };
}
