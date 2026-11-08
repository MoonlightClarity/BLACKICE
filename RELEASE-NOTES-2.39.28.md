# BLACKICE 2.39.28 — Workbench native theme and graceful viewer close

## Unified Workbench styling

The detached Windows Workbench viewer now shares BLACKICE's dark monochrome visual language: matching title-bar chrome, native toolbar surfaces, readable status text, rounded buttons, a bright primary Open BLACKICE action, and styled clipboard / fit-to-window toggles.

This changes the **BLACKICE host viewer**, not Windows inside the existing guest. Guest files, apps, VM state, and agent/user ownership controls are preserved.

## Viewer lifecycle

The native viewer now waits for a real process exit after acknowledging Close, up to its bounded shutdown deadline, before falling back to forced cleanup. The prior behavior could report a forced SIGTERM even on an otherwise successful viewer close.

- Added a regression test for graceful close and kept the forced-cleanup fallback tests.
- Hidden real-VM verification recorded exit code 0, no termination signal, and no forced termination.
- The accepted native helper executable, source, integrity inventory, and local-preview acceptance evidence match.
- Updated the Workbench launcher test to expect the current automatic pairing endpoint.

## Verification

The Workbench patch passed 81 focused tests on the current 2.39.27 base; the native helper was rebuilt and self-tested, its 217 package files were verified, and the real guest test confirmed 30/30 marker inputs with approximately 30 decoded frames per second and no counter regressions. The native viewer remains in its explicitly documented **local-preview** acceptance scope, not unrestricted native display acceptance.

## Installation

Use **Blackice-2.39.28-Setup.exe** after its complete Windows installer and release verification has passed. Closing the viewer hides its window without intentionally stopping the guest. The existing BLACKICE profile and VM are retained.

BLACKICE is distributed as an unsigned Windows installer unless a publisher signing configuration is provided.
