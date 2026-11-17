# One-click local model setup: implementation brief

This is a design, not a shipped downloader. No model weights or live settings were changed.

## User flow
1. Models > Local models opens with Recommended for this computer, not a file picker.
2. Offer a short curated list with plain-language purpose, download size, estimated memory range and tested capabilities. Keep Choose an existing model file as a secondary path.
3. A Download & use button discloses the exact model, publisher, license link, download size and destination. It starts only on explicit selection. If terms require separate acceptance, present those terms before proceeding.
4. Show durable progress, pause/cancel, retry/resume and a clear failure reason. Download in the background without blocking app navigation.
5. Verify the completed file, register it through the existing revision-aware modelPaths configuration, then use the existing load path. If the runtime is busy, keep the download and show Ready to load rather than interrupting another task.
6. Leave the user's current default/chat selection unchanged until successful load and the requested selection update.

## Minimal architecture
- A checked-in curated manifest, updated with releases, not a mutable search-result recommendation.
- Each entry: stable ID, display name, publisher URL, license URL/ID, immutable repository revision, exact file name/URL, byte count, SHA-256, quantization, tested llama.cpp version/backend, context default and measured RAM/VRAM envelope. Label chat quality and tool-calling capability separately. Small does not mean suitable for unattended browser tasks.
- Start with two tested, permissively licensed text models, small and balanced. Model choices must pass actual .104 bundled-runtime tests before being listed as recommended; this investigation has not qualified any weight file.
- New local-model-download manager persists job state and per-model locks under the app data directory. Use .partial files, validated range requests/ETags, stream hashing, atomic rename and explicit disk-space checks. A cancelled/failed download never appears as a usable model.
- Separate /api/local-models/model-catalog and /api/local-models/model-downloads routes from the existing /downloads route, which means llama.cpp engine binaries today.
- Never execute downloaded model files as programs, install packages or modify a user's existing model. Bound redirects to the manifest's approved distribution origins; never forward credentials to redirected hosts. Keep model license review visible rather than assuming all Hugging Face files are unrestricted.
- Reuse localModelHTTP load/config concurrency and existing status events. Do not restart a busy runtime or silently change default providers.

## Acceptance
Use tiny fixture files and a local HTTP fixture for tests: interrupted download resumed, server ignores Range, checksum mismatch, disk full, concurrent duplicate request, cancel/retry, process restart recovery, stale config revision, existing model preservation, runtime busy, load failure, no auto-download on settings entry. Real qualification then downloads each chosen model deliberately, checks its pinned digest and license, loads it on supported CPU/GPU backends, performs chat/tool smoke tests and records memory/latency.

## Known source
ggml-org maintains public model collections at https://huggingface.co/ggml-org/collections (verified 2026-11-17). The current UX patch links there as an external browsing step, not a claim of per-model compatibility or a substitute for the downloader.

