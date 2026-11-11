/* BLACKICE-authored float32 GEMV kernel for WebAssembly SIMD128.
 * Source tensors retain their original FP16/BF16/F32 storage precision.
 * This kernel computes in float32 and does NOT quantize model weights.
 * No llama.cpp or third-party inference code is involved.
 */
#include <stdint.h>
#include <wasm_simd128.h>

/* Caller owns linear memory and passes validated, non-overlapping regions.
 * Matrix rows are contiguous: W[rows, cols], x[cols], y[rows].
 */
__attribute__((export_name("matvec_f32")))
void matvec_f32(uint32_t w_offset, uint32_t x_offset,
                         uint32_t y_offset, uint32_t rows, uint32_t cols) {
    const float *weights = (const float *)(uintptr_t)w_offset;
    const float *input = (const float *)(uintptr_t)x_offset;
    float *output = (float *)(uintptr_t)y_offset;
    for (uint32_t row = 0; row < rows; ++row) {
        const float *w = weights + (uint64_t)row * cols;
        v128_t acc = wasm_f32x4_splat(0.0f);
        uint32_t col = 0;
        for (; col + 16 <= cols; col += 16) {
            v128_t w0 = wasm_v128_load(w + col);
            v128_t x0 = wasm_v128_load(input + col);
            v128_t w1 = wasm_v128_load(w + col + 4);
            v128_t x1 = wasm_v128_load(input + col + 4);
            v128_t w2 = wasm_v128_load(w + col + 8);
            v128_t x2 = wasm_v128_load(input + col + 8);
            v128_t w3 = wasm_v128_load(w + col + 12);
            v128_t x3 = wasm_v128_load(input + col + 12);
            acc = wasm_f32x4_add(acc, wasm_f32x4_mul(w0, x0));
            acc = wasm_f32x4_add(acc, wasm_f32x4_mul(w1, x1));
            acc = wasm_f32x4_add(acc, wasm_f32x4_mul(w2, x2));
            acc = wasm_f32x4_add(acc, wasm_f32x4_mul(w3, x3));
        }
        for (; col + 4 <= cols; col += 4) {
            acc = wasm_f32x4_add(acc, wasm_f32x4_mul(
                wasm_v128_load(w + col), wasm_v128_load(input + col)));
        }
        float lanes[4];
        wasm_v128_store(lanes, acc);
        float sum = (lanes[0] + lanes[1]) + (lanes[2] + lanes[3]);
        for (; col < cols; ++col) sum += w[col] * input[col];
        output[row] = sum;
    }
}
