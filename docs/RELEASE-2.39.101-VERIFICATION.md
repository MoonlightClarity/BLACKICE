# 2.39.101 runtime inventory and installer coverage

Status: Reference. Next-release preparation, not package or installation proof.

## Frozen source
Feature base: 5f0efaa22dbcb496a693c38427cea98e27ec18ae. Earlier integrated evidence remains separate and is not relabeled as .101 aggregate-suite evidence. No live user profile is changed by metadata preparation.

## Exact runtime payload
[The 65-file inventory](runtime-inventory-2.39.101.json) records relative path, byte length and SHA-256 for the pinned runtime payload: 63 manifest-listed CPU/Vulkan backend files, plus root LICENSE and manifest.json. The payload is llama.cpp v1.0.0 (b12359); model weights are excluded.

## Installer coverage and remaining checks
- scripts/package-public.mjs prepares and checks the pinned runtime before electron-builder.
- desktop/electron-builder.yml copies .build/llama.cpp recursively to resources/llama.cpp via extraResources.
- This sibling resource tree is **outside appFingerprint**. The existing application fingerprint alone cannot prove runtime inclusion or identity; the public release manifest currently lacks its digest.
- At packaging and after installation, compare the complete resources/llama.cpp file set, sizes and SHA-256 values against all 65 inventory records, including LICENSE and manifest.json. Reject missing, changed or unexpected files. Record package and installed inventory digests alongside the app fingerprint and installer hash.
- Run the installed runtime integrity/probe and synthetic smoke separately. Source-only tests do not prove installer content, signing, or installed behavior.
- The exact native password-manager HTML/CSS allowlist correction is included. No broad vendor-path exception was added.

The source inventory is an explicit release handoff; this change does not alter appFingerprint, create a new release gate, or claim packaging has occurred.
