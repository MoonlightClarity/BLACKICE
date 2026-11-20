# BLACKICE 2.40.57

Windows test candidate.

- The desktop browser now passes an observed upload input's page binding through its browser router. This lets the desktop app use the same guarded upload path as the contained driver. A stale or mismatched reference still fails before file use; chooser and submit behavior is unchanged.

- Local Models supports opt-in YaRN settings for a named GGUF model in BLACKICE’s bundled llama.cpp. It does not rescale other models or change a running model until the normal restart/reload.
- Near the local context limit, BLACKICE asks the bundled server to count the actual templated request. It can shrink only the automatic answer reserve when the measured input fits the runtime window with headroom. Explicit reserves and hard limits still apply.
- Chats show the context budget and whether the count was measured or estimated near the composer. API compaction failures are shown explicitly; an actual Codex context overflow gets a distinct error code. Portable checkpoint parity across providers is not part of this change.

- Local Models puts loading up front and moves runtime setup, unload, and tuning under **More options**. The native file picker loads a chosen GGUF without a separate save step. Missing weights for another saved model no longer block the router.
