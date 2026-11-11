import { createHash, randomUUID } from 'node:crypto';
import { open, mkdir, rename, rm, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { SafetensorsFile } from './safetensors.mjs';
import { bfloat16ToFloat32 } from './precision.mjs';

const bits = new DataView(new ArrayBuffer(4));
const issue = (message, code = 'NATIVE_FP16_CONVERSION_FAILED') => Object.assign(new Error(message), { code });

/** IEEE754 float32 -> float16, round-to-nearest ties-to-even; no 4/8-bit quantization. */
export function float32ToFloat16Bits(value) {
  bits.setFloat32(0, value, true);
  const source = bits.getUint32(0, true);
  const sign = source >>> 16 & 0x8000;
  const exponent = source >>> 23 & 0xff;
  let mantissa = source & 0x7fffff;
  if (exponent === 0xff) return sign | (mantissa ? 0x7e00 : 0x7c00);
  const targetExponent = exponent - 127 + 15;
  if (targetExponent >= 31) return sign | 0x7c00;
  if (targetExponent <= 0) {
    if (targetExponent < -10) return sign;
    mantissa |= 0x800000;
    const shift = 14 - targetExponent;
    let result = mantissa >>> shift;
    const remainder = mantissa & ((1 << shift) - 1);
    const middle = 1 << (shift - 1);
    if (remainder > middle || (remainder === middle && (result & 1))) result++;
    return sign | result;
  }
  let half = targetExponent << 10 | mantissa >>> 13;
  const remainder = mantissa & 0x1fff;
  if (remainder > 0x1000 || (remainder === 0x1000 && (half & 1))) half++;
  return sign | half;
}

async function readExactly(file, buffer, position) {
  let current = 0;
  while (current < buffer.length) {
    const { bytesRead } = await file.read(buffer, current, buffer.length - current, position + current);
    if (!bytesRead) throw issue('Original tensor ended unexpectedly.');
    current += bytesRead;
  }
}
async function writeExactly(file, buffer, position) {
  let current = 0;
  while (current < buffer.length) {
    const { bytesWritten } = await file.write(buffer, current, buffer.length - current, position + current);
    if (!bytesWritten) throw issue('Output tensor write stopped unexpectedly.');
    current += bytesWritten;
  }
}

/** Converts one full Safetensors file without ever loading the whole checkpoint into RAM. */
export async function convertSafetensorsToFP16({ sourceFile, outputFile, chunkElements = 1 << 19, signal } = {}) {
  if (typeof sourceFile !== 'string' || !path.isAbsolute(sourceFile) ||
      typeof outputFile !== 'string' || !path.isAbsolute(outputFile))
    throw issue('Source and destination must be absolute Safetensors paths.');
  if (!/\.safetensors$/i.test(sourceFile) || !/\.safetensors$/i.test(outputFile))
    throw issue('Source and destination must use .safetensors files.');
  if (path.resolve(sourceFile).toLowerCase() === path.resolve(outputFile).toLowerCase())
    throw issue('Source and output must be different files.');
  if (!Number.isSafeInteger(chunkElements) || chunkElements < 1 || chunkElements > 1 << 22)
    throw issue('Conversion chunk size must be between 1 and 4,194,304 elements.');
  signal?.throwIfAborted();
  const reader = await new SafetensorsFile(sourceFile).init();
  const entries = [...reader.entries];
  if (!entries.length) throw issue('No tensors were found in the original file.');
  const metadata = { __metadata__: { format: 'pt' } };
  let offset = 0, totalElements = 0;
  for (const [name, entry] of entries) {
    const count = (entry.end - entry.begin) / (entry.dtype === 'F32' ? 4 : 2);
    const byteCount = count * 2;
    if (!Number.isSafeInteger(byteCount) || !Number.isSafeInteger(offset + byteCount))
      throw issue('The converted checkpoint exceeds safe file limits.');
    metadata[name] = { dtype: 'F16', shape: entry.shape, data_offsets: [offset, offset + byteCount] };
    offset += byteCount;
    totalElements += count;
  }
  const data = Buffer.from(JSON.stringify(metadata));
  const pad = (8 - data.length % 8) % 8;
  const header = Buffer.concat([data, Buffer.alloc(pad, 0x20)]);
  const prefix = Buffer.allocUnsafe(8);
  prefix.writeBigUInt64LE(BigInt(header.length));
  const firstPosition = prefix.length + header.length;
  const directory = path.dirname(outputFile);
  await mkdir(directory, { recursive: true });
  const temp = path.join(directory, '.' + path.basename(outputFile) + '.' + randomUUID() + '.partial');
  const source = await open(sourceFile, 'r');
  let output = null;
  const originalDigest = createHash('sha256'), convertedDigest = createHash('sha256');
  // Exact checkpoint hash is computed by an independent whole-file read at the end
  // to include the source header and metadata; the converted digest covers all bytes.
  let overflowCount = 0;
  try {
    const exists = await stat(outputFile).then(() => true).catch(error => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    if (exists) throw issue('The FP16 output file already exists. Choose another destination.');
    output = await open(temp, 'wx', 0o600);
    const head = Buffer.concat([prefix, header]);
    await writeExactly(output, head, 0);
    convertedDigest.update(head);
    let outputPosition = firstPosition;
    for (const [, entry] of entries) {
      signal?.throwIfAborted();
      const inputStride = entry.dtype === 'F32' ? 4 : 2;
      let sourcePosition = reader.dataStart + entry.begin;
      let remaining = (entry.end - entry.begin) / inputStride;
      while (remaining > 0) {
        signal?.throwIfAborted();
        const count = Math.min(remaining, chunkElements);
        const inputBytes = Buffer.allocUnsafe(count * inputStride);
        await readExactly(source, inputBytes, sourcePosition);
        const targetBytes = Buffer.allocUnsafe(count * 2);
        for (let i = 0; i < count; i++) {
          const fp16 = entry.dtype === 'F16' ? inputBytes.readUInt16LE(i * 2)
            : float32ToFloat16Bits(entry.dtype === 'BF16'
              ? bfloat16ToFloat32(inputBytes.readUInt16LE(i * 2))
              : inputBytes.readFloatLE(i * 4));
          if (entry.dtype !== 'F16' && (fp16 & 0x7c00) === 0x7c00 && (fp16 & 0x03ff) === 0) {
            const original = entry.dtype === 'BF16' ? bfloat16ToFloat32(inputBytes.readUInt16LE(i * 2)) : inputBytes.readFloatLE(i * 4);
            if (Number.isFinite(original)) overflowCount++;
          }
          targetBytes.writeUInt16LE(fp16, i * 2);
        }
        await writeExactly(output, targetBytes, outputPosition);
        convertedDigest.update(targetBytes);
        sourcePosition += inputBytes.length;
        outputPosition += targetBytes.length;
        remaining -= count;
      }
    }
    if (outputPosition !== firstPosition + offset) throw issue('Converted checkpoint size did not match the tensor metadata.');
    await output.sync();
    await output.close();
    output = null;
    // A separate source hash verifies the full original file, including the header.
    const sourceHash = createHash('sha256');
    const hashFile = await open(sourceFile, 'r');
    try {
      let position = 0;
      const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
      const size = (await hashFile.stat()).size;
      while (position < size) {
        signal?.throwIfAborted();
        const length = Math.min(buffer.length, size - position);
        const { bytesRead } = await hashFile.read(buffer, 0, length, position);
        if (!bytesRead) throw issue('Source hash read stopped unexpectedly.');
        sourceHash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
    } finally { await hashFile.close(); }
    signal?.throwIfAborted();
    // 'rename' would overwrite on some platforms; explicitly ensure target is absent at commit.
    if (await stat(outputFile).then(() => true).catch(error => error.code === 'ENOENT' ? false : Promise.reject(error)))
      throw issue('The FP16 destination was created by another process.');
    await rename(temp, outputFile);
    return {
      sourceFile, outputFile, originalSha256: sourceHash.digest('hex'),
      outputSha256: convertedDigest.digest('hex'), sourceDtypes: [...new Set(entries.map(([, entry]) => entry.dtype))],
      dtype: 'F16', tensorCount: entries.length, elements: totalElements,
      outputBytes: firstPosition + offset, overflowCount,
      quantizationRequested: false,
    };
  } finally {
    await output?.close().catch(() => {});
    await source.close();
    await rm(temp, { force: true }).catch(() => {});
  }
}
