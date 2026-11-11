# BLACKICE-owned inference + llama.cpp backend

## Decision

BLACKICE is not a front end for Ollama, LM Studio, or llama.cpp. It owns the engine-selection contract, model lifecycle, inference state, KV-cache policy, tokenizer integration, streaming, and planning integration. Two separate model execution implementations share that contract:

1. **BLACKICE Reference** — code we wrote, initially Qwen3-only, independently implementing model math and reading Safetensors.
2. **llama.cpp** — separate upstream source pinned as a Git submodule and invoked through a BLACKICE-bundled binary once built. This supplies model compatibility and a performance/accuracy baseline, not the implementation of the BLACKICE engine.

Ollama and LM Studio remain optional compatibility connections. Neither is necessary for the two native backends.

## Current implementation state

| Capability | BLACKICE Reference | Bundled llama.cpp |
| --- | --- | --- |
| Engine code | lib/native-inference/reference-qwen3.mjs | third_party/llama.cpp (upstream MIT source) |
| Weight format | Safetensors F16, BF16 or F32 | GGUF |
| Loader | Independent validated header / shard reader, lazy weight decoding | Upstream llama.cpp loader |
| Transformer math | Independent Qwen3 RMSNorm, Q/K normalization, RoPE, GQA, KV cache, SiLU-gated MLP, output logits | Upstream implementation |
| Inference input | Pretokenized integer IDs only | Text through bundled llama-cli |
| CPU | Reference implementation (slow) | Buildable CPU implementation |
| GPU | **Not implemented yet** | Upstream CUDA backend can be built |
| Production chat integration | **Not implemented yet** | **Not implemented yet** |
| Binary included in current installer | Not exposed as an installed feature | **No** — source is pinned, binary build remains necessary |

GET /api/native-inference/status reports both native engines and their readiness without starting a model. No load/generate HTTP route is exposed until execution moves off the Electron main thread.

The source code is a tested engineering foundation, not an assertion that BLACKICE can now run Qwen3 end-to-end in Chat. In particular, the reference engine requires a tokenizer and isolated inference worker before exposing it to normal user conversations. No external model invocation is hidden inside the reference engine.

## Precision

No 4-bit, 8-bit, or GGUF quantization step is performed by the reference loader. The original F16/BF16/F32 tensor bytes are decoded into Float32Array for numerical computation. Widening in memory is not weight quantization. We should add a separate explicit BF16 to FP16 conversion path for the Shadowdancer target if the downloaded source weights are BF16. That transformation should record per-tensor source and destination types and verify that no quantization was requested.

For llama.cpp, source Safetensors can be converted to GGUF F16 with the upstream conversion script and its --outtype f16 option; this is a container conversion, not a 4-bit/8-bit quantization. Exact numerical equality is not guaranteed when converting BF16 to FP16 because the floating-point formats represent different values.

## How to test the code today

From a BLACKICE checkout with Node.js 22+: node --test tests/native-inference.test.mjs

The tests cover explicit backend selection, independent Qwen3 matvec/RMSNorm/GQA/RoPE/MLP, deterministic CPU token generation, cancellation without partial KV-cache commits, lazy Safetensors loading, precision handling, malformed files, and standalone llama.cpp CLI dispatch.

## Preparing the llama.cpp binary

The dependency is pinned in .gitmodules and its Git tree is retained outside the app bundle.

1. git submodule update --init third_party/llama.cpp
2. In PowerShell, run .\scripts\build-native-llama.ps1 -Backend cpu
3. After installing an NVIDIA CUDA toolkit and supported C++ compiler, run .\scripts\build-native-llama.ps1 -Backend cuda

The script needs CMake and a C/C++ toolchain; it stages resources/native-inference/llama.cpp/llama-cli.exe, required adjacent DLLs, the MIT LICENSE and a SHA-256/source-revision manifest. The Windows public-packaging script includes that binary directory only if a valid executable is staged. --require-native-inference explicitly fails a build if the binary is absent, preventing a source-only release from being represented as bundled native inference.

LlamaCppBackend launches only that bundled executable (or an explicitly configured development executable), passes prompts through an ephemeral file instead of command-line arguments, streams text chunks, supports cancellation, and never selects Ollama or LM Studio.

## Next acceptance gates

1. **Tokenizer:** independently load/verify Qwen3 tokenizer and ChatML formatting. Compare token IDs against a known-good tokenizer before any chat integration.
2. **Reference parity:** compare one-token logits and KV-cache state for real F16 Qwen3 weights against a reference on the same inputs. Validate end-to-end text before calling it production ready.
3. **Isolation:** run reference inference on a worker thread or separate process. CPU matrix operations must never block BLACKICE's Electron main loop. Preserve cancellation, timeouts and progress on both sides.
4. **Performance:** add owned C++/SIMD kernels, then optional CUDA FP16 kernels; retain the JS reference as a numerical oracle. Model memory, token speed, and GPU offload should be measurable, not guessed.
5. **Bundling:** build, sign/test where configured, and include llama.cpp binaries plus licenses in a new installer. Probe the packaged executable in the installed app rather than assuming source availability.
6. **Routing:** wire both engines into the existing provider-model selector, streaming tool-call handling and persistent per-chat model identity. Selection is explicit: if BLACKICE native fails, report the failure; do not silently switch to llama.cpp, a cloud API, or another precision.
7. **Shadowdancer integration:** keep recursive planning and context-folder state above the inference backend, so clearing/reloading planning context behaves identically with either local engine.

## Why the boundary matters

A common lifecycle interface lets us run the same token-ID tests and compare logits, latency, peak memory, sampling and cancellation behavior without confusing two different implementations. llama.cpp can be the compatibility baseline while BLACKICE's engine becomes more capable. Its existence must not prevent independent development of model loading, attention kernels, or caching policies.
