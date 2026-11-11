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

## Independent PyTorch numerical parity: verified

BLACKICE's real Qwen3 reference and its optimized SIMD path have been independently compared against **PyTorch 2.15.0+cpu and Hugging Face Transformers 4.57.6** on the *same verified FP16 checkpoint*. PyTorch computes in FP32 on CPU. The entire weight file is hashed by the verifier to reject accidental comparisons against a different model. None of these Python dependencies are part of BLACKICE's inference runtime.

Input: raw text "Hello world", token IDs 9707 and 1879. We compared full 151,936-dimensional next-token logit vectors for two positions and key/value cache values for every position in all 28 layers (112 cache arrays).

| Metric | BLACKICE JavaScript reference, token 0 / 1 | BLACKICE SIMD, token 0 / 1 |
| --- | --- | --- |
| Argmax token versus PyTorch | 21806 / 0, both match | 21806 / 0, both match |
| Logit RMS difference | 0.00000573 / 0.00000209 | 0.00000980 / 0.00000418 |
| Maximum logit difference | 0.0000324 / 0.0000112 | 0.0000496 / 0.0000205 |
| Maximum KV difference | 0.0000687 / 0.0000534 | 0.000122 / 0.0000916 |

The default parity thresholds are stricter than before: logits RMS <= 0.0001, logits max <= 0.001, KV RMS <= 0.0001, and KV max <= 0.001. These thresholds are diagnostic bounds, not a guarantee for every Qwen3 checkpoint or hardware architecture.

The oracle and detailed parity logs are local files under .build/native-parity and **are not distributed in GitHub**. Generate or regenerate them using the following commands from the BLACKICE checkout, with the appropriate local model directory:

    python scripts/verify-native-qwen3-pytorch.py --model ABSOLUTE_FP16_MODEL_DIR --output .build/native-parity/fixtures/qwen3-abliterated-fp16 --prompt "Hello world"
    node scripts/verify-native-qwen3-parity.mjs --model ABSOLUTE_FP16_MODEL_DIR --oracle .build/native-parity/fixtures/qwen3-abliterated-fp16 --kernel reference
    node scripts/verify-native-qwen3-parity.mjs --model ABSOLUTE_FP16_MODEL_DIR --oracle .build/native-parity/fixtures/qwen3-abliterated-fp16 --kernel simd

The Python command requires PyTorch, Transformers, NumPy, and Safetensors in an external test-only virtual environment. It is not a BLACKICE runtime dependency.

## Independent CPU performance: verified first milestone

The original scalar FP16 decoder was replaced with exact **65,536-entry FP16 and BF16 conversion lookup tables**. All 65,536 possible bit patterns of each format have exhaustive unit tests. This preserves source precision and made the full two-token comparison approximately **5.6x faster** (21.59 s -> 3.86 s) on the test computer, without changing any numerical results.

BLACKICE also includes a **self-authored C SIMD128 matvec kernel** in scripts/native-kernels/matvec-simd.c, compiled into the 3,296-byte lib/native-inference/kernels/matvec-simd.wasm binary. It does not use llama.cpp. This is a float32 compute kernel; the stored model stays FP16, without quantization.

- Reproducible compiler: Zig 0.15.2 with wasm32-freestanding+simd128.
- Build script: scripts/build-native-simd.ps1.
- Source/binary SHA-256 and compiler provenance: lib/native-inference/kernels/matvec-simd.manifest.json.
- Bounded temporary memory: approximately 35 MB for the actual Qwen3 test.
- Real warm-token calculation: approximately **1.07 s (JavaScript) vs 0.50 s (SIMD)**; about 2.1x faster on the measured run.
- End-to-end HTTP load/generate/unload with the real FP16 checkpoint: **20.9 s before the optimizations vs 3.46 s after**. This includes a change to the FP16 decoder and to the matvec kernel and is not a controlled isolated microbenchmark.

The native engine exposes "BLACKICE SIMD CPU (optimized)" and "BLACKICE JavaScript reference" as *separate CPU kernel modes*, not as separate providers. A user can explicitly select the reference kernel to debug numerical differences; a missing SIMD asset fails explicitly rather than silently switching to a third-party engine.

## Outstanding acceptance gates

1. Improve model residency, warm-up, long-context KV cache and multi-session memory measurements; current tests cover real token-0/1 parity but not long sequences.
2. Develop optional **BLACKICE-owned CUDA FP16 kernels** on supported GPUs and compare numerical results against the same PyTorch oracle.
3. Integrate explicit native model selection into normal Chat and persistent per-conversation model identity, tool-call streaming and Shadowdancer's planning/context system. The experimental Settings panel is not yet the production model picker.
4. Build, verify and package the separate llama.cpp CPU/CUDA binaries and a new tested BLACKICE Windows installer. The compiler and Python oracle remain development-only; the bundled BLACKICE wasm is self-contained.
