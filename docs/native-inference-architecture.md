# BLACKICE native inference: independent Qwen3 plus llama.cpp

## Design

BLACKICE owns its model lifecycle, tokenizer, weight loader, transformer math, KV caching and worker orchestration. The independently authored BLACKICE reference engine **does not call** llama.cpp, Ollama or LM Studio.

Two backends can be explicitly selected:

- **BLACKICE Qwen3 reference:** our own Safetensors reader (F16/BF16/F32), Qwen3 byte-level BPE tokenizer, transformer forward pass and CPU worker.
- **llama.cpp:** MIT-licensed upstream Git submodule, separate GGUF loader/kernels and an optional BLACKICE-bundled llama-cli process. It is not the implementation of our reference engine.

Ollama and LM Studio remain optional compatibility providers, never prerequisites for these backends. Failure does not silently switch to another backend.

## Current capabilities and limits

| Capability | BLACKICE reference | llama.cpp |
| --- | --- | --- |
| Model format | Safetensors F16/BF16/F32 | GGUF |
| Transformer math | RMSNorm, Q/K norms, RoPE, GQA, KV cache, SiLU-gated MLP, output logits | Upstream |
| Tokenizer | Own NFC, byte-level BPE, special tokens, limited text chat framing | Upstream |
| Execution | Dedicated CPU worker, shared-memory cancellation | Separate CLI process |
| Input | Text, system/user/assistant messages, or token IDs | Plain text |
| CUDA | Not yet implemented | Upstream support, not built locally |
| Production chat model picker | Not yet integrated | Not yet integrated |
| Ready for production | No | No (binary not built) |

An **experimental native inference** section is present in Settings > Models in the development branch. It does not modify existing default model settings or stored chat identities. It defaults to a one-token preview, because the reference engine is extremely slow with real weights.

Local API routes:

- GET /api/native-inference/status
- POST /api/native-inference/load
- POST /api/native-inference/generate
- POST /api/native-inference/cancel
- POST /api/native-inference/unload

The reference backend loads and generates on a Node worker, not Electron's main event loop. Model cancellation uses a shared-memory flag, and BLACKICE shutdown cancels generation before worker disposal. Token/text callbacks stream internally; the experimental HTTP response currently delivers the final JSON result, not incremental SSE.

## Actual Shadowdancer Qwen3 0.6B Abliterated weights

The development environment downloaded the mlabonne/Qwen3-0.6B-abliterated source checkpoint. It has 310 **F32** tensors. BLACKICE converted the whole checkpoint to FP16 using its own chunked conversion code.

- Original weight file: 2,384,234,968 bytes.
- Converted FP16 file: 1,192,134,784 bytes.
- Finite overflow count: 0.
- Quantization requested: false.
- The original file and tokenizer were preserved. The output config says float16.
- Source and output SHA-256 hashes, tensor count and conversion details are recorded beside the output in fp16-conversion.json.

Model weights are stored in the local BLACKICE workspace, not in GitHub.

The real first-party CPU worker produced greedy token 21806 (decoded text: " Answer") for the raw prompt "Hello" using the FP16 model. A subsequent **actual BLACKICE HTTP server** test loaded, generated the same token and unloaded that checkpoint end-to-end, completing in about 20.9 seconds including setup and teardown.

This proves that the loader, tokenizer, independent transformer code, worker and local HTTP path can execute together on real model weights. **It does not prove numerical parity** with PyTorch or llama.cpp, nor usable production performance.

## Testing and conversion

Run in a checkout with Node 22+:

    node --test tests/native-inference.test.mjs tests/native-qwen3-tokenizer.test.mjs tests/native-fp16-conversion.test.mjs tests/native-qwen3-worker.test.mjs tests/native-inference-http.test.mjs tests/native-inference-server.test.mjs tests/next-settings-native-models.test.mjs

The official tokenizer test fixture can be enabled with BLACKICE_QWEN3_FIXTURE_DIR pointing at the downloaded tokenizer.json directory.

The expensive real-model HTTP test requires BLACKICE_QWEN3_ABLITERATED_FP16_DIR pointing at a model directory containing config.json, tokenizer.json and the 310-tensor FP16 model.safetensors file. Without that, the test skips.

To convert a model directory explicitly, without overwriting its source:

    node scripts/convert-native-model-fp16.mjs --source ABSOLUTE_SOURCE_DIRECTORY --output NEW_ABSOLUTE_OUTPUT_DIRECTORY

To probe the worker directly:

    node scripts/probe-native-qwen3.mjs --model ABSOLUTE_FP16_MODEL_DIRECTORY --prompt Hello --tokens 1 --context 64 --timeout 90000

The F16 source tensor bytes are widened to Float32Array for numerical operations. Widening is not weight quantization. Conversion from BF16/F32 to FP16 uses IEEE754 rounding, preserves originals, and never requests 4-bit or 8-bit quantization.

## Separate pinned llama.cpp dependency

llama.cpp is pinned at aa75ff3239f9cc675b081697deda9e1b112345c6. Its MIT license is preserved in the source and copied beside the built executable.

    git submodule update --init third_party/llama.cpp
    .\scripts\build-native-llama.ps1 -Backend cpu

The build requires CMake and a C/C++ compiler, which were unavailable on this Windows development machine. Thus **no llama.cpp executable is built or verified** and the current installed Windows release does not include it. The source packaging script can include a staged executable and can require one explicitly with --require-native-inference.

## Outstanding acceptance gates

1. Compare token IDs, one-token logits and multi-position KV-cache state against a trusted implementation using the exact same FP16 checkpoint. Correct-looking output is insufficient.
2. Implement optimized first-party CPU kernels and optional CUDA FP16 kernels; keep JavaScript as a numerical reference.
3. Measure throughput and memory use on the actual host and establish multi-session lifetime behavior.
4. Integrate with the normal model picker, persistent per-conversation model identities, tool-call streaming and Shadowdancer's recursive planning/context system without silently replacing models.
5. Build, verify and package llama.cpp CPU/CUDA binaries and publish a tested installer.
