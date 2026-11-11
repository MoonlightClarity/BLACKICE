/** BLACKICE-owned numeric conversions. This module never quantizes weights. */
export function float16ToFloat32(bits) {
  if (!Number.isInteger(bits) || bits < 0 || bits > 0xffff) throw new RangeError('Expected unsigned 16-bit FP16 bits.');
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = bits >> 10 & 0x1f, fraction = bits & 0x3ff;
  if (exponent === 0) return sign * (fraction / 1024) * 2 ** -14;
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

const floatBits = new DataView(new ArrayBuffer(4));
export function bfloat16ToFloat32(bits) {
  if (!Number.isInteger(bits) || bits < 0 || bits > 0xffff) throw new RangeError('Expected unsigned 16-bit BF16 bits.');
  floatBits.setUint32(0, bits << 16, true);
  return floatBits.getFloat32(0, true);
}

// A fixed 16-bit float has only 65,536 possible values. Lookup avoids
// repeating exponent decoding hundreds of millions of times for FP16 weights.
// Each entry is a full float32 value; no source quantization is introduced.
let fp16Table;
let bf16Table;
const nativeLittleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
function conversionTable(dtype) {
  if (dtype === 'F16') return fp16Table ||= Float32Array.from(
    { length: 65536 }, (_, bits) => float16ToFloat32(bits));
  return bf16Table ||= Float32Array.from(
    { length: 65536 }, (_, bits) => bfloat16ToFloat32(bits));
}

export function decodeFloatTensor(bytes, dtype) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError('Tensor data must be a Buffer.');
  const stride = dtype === 'F32' ? 4 : dtype === 'F16' || dtype === 'BF16' ? 2 : null;
  if (!stride) throw new Error('BLACKICE reference engine accepts F16, BF16 and F32 source tensors only.');
  if (bytes.length % stride) throw new Error('Tensor bytes do not match their floating-point precision.');
  const result = new Float32Array(bytes.length / stride);
  if (nativeLittleEndian && bytes.byteOffset % stride === 0) {
    if (dtype === 'F32') {
      result.set(new Float32Array(bytes.buffer, bytes.byteOffset, result.length));
      return result;
    }
    const bits = new Uint16Array(bytes.buffer, bytes.byteOffset, result.length);
    const table = conversionTable(dtype);
    for (let i = 0; i < result.length; i++) result[i] = table[bits[i]];
    return result;
  }
  if (dtype === 'F32') {
    for (let i = 0; i < result.length; i++) result[i] = bytes.readFloatLE(i * 4);
  } else {
    const table = conversionTable(dtype);
    for (let i = 0; i < result.length; i++) result[i] = table[bytes.readUInt16LE(i * 2)];
  }
  return result;
}
