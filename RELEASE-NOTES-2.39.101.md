# BLACKICE 2.39.101 - workspace clarity and bundled local-model setup

## Changes since 2.39.100

- **Swarm:** clearer cards and compact status badges, full-width titles, reachable board stages, focused detail navigation, and drafts preserved across navigation, concurrent saves, and conflicts.
- **Knowledge and Skills:** separate memory and skill workflows; manual memory folders, filing and filters; refresh reconciles removed folders without losing unsaved work.
- **Settings:** six primary destinations, clearer behavior/profile language, app connections grouped by host, and advanced/recovery controls shown in context.
- **Local GGUF models:** Windows x64 packaging includes pinned llama.cpp v1.0.0 (b12359), with Vulkan device probing and an independent CPU fallback. Choose a local GGUF, name it, then Save & load. Model weights are not bundled or downloaded automatically.
- **Model changes:** revised GGUF catalogs restart only an idle BLACKICE-owned router. Active requests defer restart; external servers and existing model files are preserved.
- **Installer verification:** recognizes the exact native password-manager HTML and CSS assets retained from .100.

SOUL defaults, existing identities, saved data, stopped-task tab behavior, and the native password manager are retained. This release does not regenerate AGENTS.md.

## Verification status

These are next-release source notes, not a published or installed artifact receipt. Focused tests and disposable Chromium workflows cover the integrated changes. Tiny-fixture CPU/Vulkan/fallback inference and safe catalog refresh were exercised; this does not establish performance or compatibility for every GGUF or GPU.

Full-suite, installer/signature, packaged-runtime, and installed-version qualification remain separate. See [runtime distribution inventory and installer coverage](docs/RELEASE-2.39.101-VERIFICATION.md). The installed .100 and its existing draft are not modified by this preparation.
