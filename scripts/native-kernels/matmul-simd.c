/* BLACKICE-owned SIMD128 batched projection kernel.
 * W: [rows, cols], X: [cols, tokens], Y: [rows, tokens].
 * All elements are float32 for computation; no weight quantization.
 */
#include <stdint.h>
#include <wasm_simd128.h>

__attribute__((export_name("matmul_f32")))
void blackice_matmul_f32(uint32_t w_offset, uint32_t x_offset,
                         uint32_t y_offset, uint32_t rows,
                         uint32_t cols, uint32_t tokens) {
    const float *restrict W = (const float *)(uintptr_t) w_offset;
    const float *restrict X = (const float *)(uintptr_t) x_offset;
    float *restrict Y = (float *)(uintptr_t) y_offset;
    for (uint32_t row = 0; row < rows; row++) {
        const float *w = W + ((uint64_t)row * cols);
        float *y = Y + ((uint64_t)row * tokens);
        uint32_t token = 0;
        for (; token + 16 <= tokens; token += 16) {
            v128_t sum0 = wasm_f32x4_splat(0.0f);
            v128_t sum1 = wasm_f32x4_splat(0.0f);
            v128_t sum2 = wasm_f32x4_splat(0.0f);
            v128_t sum3 = wasm_f32x4_splat(0.0f);
            for (uint32_t col = 0; col < cols; col++) {
                const v128_t weight = wasm_f32x4_splat(w[col]);
                const float *x = X + ((uint64_t)col * tokens) + token;
                sum0 = wasm_f32x4_add(sum0, wasm_f32x4_mul(weight, wasm_v128_load(x)));
                sum1 = wasm_f32x4_add(sum1, wasm_f32x4_mul(weight, wasm_v128_load(x + 4)));
                sum2 = wasm_f32x4_add(sum2, wasm_f32x4_mul(weight, wasm_v128_load(x + 8)));
                sum3 = wasm_f32x4_add(sum3, wasm_f32x4_mul(weight, wasm_v128_load(x + 12)));
            }
            wasm_v128_store(y + token, sum0);
            wasm_v128_store(y + token + 4, sum1);
            wasm_v128_store(y + token + 8, sum2);
            wasm_v128_store(y + token + 12, sum3);
        }
        for (; token + 4 <= tokens; token += 4) {
            v128_t sum = wasm_f32x4_splat(0.0f);
            for (uint32_t col = 0; col < cols; col++) {
                const v128_t weight = wasm_f32x4_splat(w[col]);
                sum = wasm_f32x4_add(sum, wasm_f32x4_mul(weight,
                    wasm_v128_load(X + ((uint64_t)col * tokens) + token)));
            }
            wasm_v128_store(y + token, sum);
        }
        for (; token < tokens; token++) {
            float sum = 0.0f;
            for (uint32_t col = 0; col < cols; col++)
                sum += w[col] * X[(uint64_t)col * tokens + token];
            y[token] = sum;
        }
    }
}
