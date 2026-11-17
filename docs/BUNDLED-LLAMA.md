# Bundled local runtime (candidate, not installed)

The next Windows x64 installer includes llama.cpp. The user chooses an existing GGUF model; no runtime install, release selection, server URL, or API key is required. Model weights are not bundled or downloaded automatically. Custom executable paths and external servers remain supported and existing settings/model files are preserved.

## Runtime provenance

- Stable upstream: https://github.com/ggml-org/llama.cpp/releases/tag/v1.0.0
- Stable release points to binary build b12359, source b1b770d90. Its executable reports `1.0.0-dev (build 12359, commit b1b770d90)`; this is the upstream stable release's linked binary, not a claim that the binary prints a non-dev version.
- Pinned CPU archive: 25,097,509 bytes, SHA-256 `837c1655e87df3b66989f4be33a792a1399c785bf259038dc75c900096683e69`.
- Pinned Vulkan archive: 38,090,643 bytes, SHA-256 `e8d18c6e4210cca87e7307c2ea78363ac8d158e4e1397358ec96ab70b53a0d5e`.
- llama.cpp MIT license and upstream LLVM OpenMP license are shipped with the binaries. No CUDA toolkit dependency is introduced.
- The included dependency DLL set plus two servers occupies 146,372,154 bytes before installer compression. Archives and models are excluded from the installer.

`node scripts/prepare-llama-runtime.mjs` prepares the pinned runtime in `.build/llama.cpp`. The public packaging command does this automatically and validates the built runtime before promoting the installer. First build requires access to official GitHub; subsequent builds reuse checksum-verified archives. Never replace these pins with an unversioned latest download.

## Behavior

Blank executable path selects the bundled runtime. Files are checked against its manifest before probing. A successful `--list-devices` Vulkan probe selects the GPU runtime; absent/broken drivers select the independent CPU build. GPU router startup failure is retried on CPU only after the failed owned process exits. Model errors, missing models, invalid settings and external endpoints do not trigger indiscriminate retries.

The router starts only on demand and binds to loopback. Native model sleeping remains enabled at 120 seconds. Full idle-process shutdown remains an explicit advanced setting (default off), preserving existing preferences. BLACKICE closing terminates only the exact process tree it spawned. External llama.cpp servers are not stopped. Existing conversations/defaults are not rewritten.

macOS, Linux and Windows ARM64 bundles are not included or validated in this Windows x64 candidate; custom runtimes and existing servers remain available. No cross-platform efficacy is claimed.

## Verification

`node --test tests/llama-cpp*.test.mjs tests/local-model*.test.mjs` covers selection, corruption, unsupported platform, custom settings, local API, activation and preserved chat defaults.

`node scripts/verify-bundled-llama.mjs <bundle-directory> <tiny-GGUF-test-file>` exercises real router startup, local inference, GPU-start-failure CPU recovery, live child process capture, port closure and router/model-child termination. It uses ephemeral loopback ports, does not start BLACKICE and does not access its profile. Test weights are not product assets. Run this on Windows with a Vulkan device for the GPU branch.

On 2026-11-16, both actual pinned CPU and Vulkan binaries generated text with ggml-org's test-only stories260K.gguf (SHA-256 `270cba1bd5109f42d03350f60406024560464db173c0e387d91f0426d3bd256d`). Quadro RTX 3000 was detected. CPU, Vulkan, and forced-GPU-start-failure fallback all confirmed router and two model child process exits and closed ports. This is isolated runtime evidence, not installed UI or release acceptance.

Selecting another GGUF after the router starts is supported: a subsequent Load applies the saved catalog revision by restarting only an idle owned router. Active local responses are preserved; the UI receives a saved-but-deferred result and can retry Load when the response ends. Saving alone never restarts the router. Real verification now covers A-to-B selection using two separate GGUF files, with a concurrent A response preserved before the idle restart, on CPU, Vulkan, forced fallback and automatic selection.
