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

export function decodeFloatTensor(bytes, dtype) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError('Tensor data must be a Buffer.');
  const stride = dtype === 'F32' ? 4 : dtype === 'F16' || dtype === 'BF16' ? 2 : null;
  if (!stride) throw new Error('BLACKICE reference engine accepts F16, BF16 and F32 source tensors only.');
  if (bytes.length % stride) throw new Error('Tensor bytes do not match their floating-point precision.');
  const result = new Float32Array(bytes.length / stride);
  for (let i = 0; i < result.length; i++) {
    result[i] = dtype === 'F32' ? bytes.readFloatLE(i * 4)
      : dtype === 'F16' ? float16ToFloat32(bytes.readUInt16LE(i * 2))
        : bfloat16ToFloat32(bytes.readUInt16LE(i * 2));
  }
  return result;
}
