# Shared app connections and local-model onboarding

> **Status: Historical documentation.** This records the 2.39.104 onboarding change and its follow-ups. Its original labels, fixed source line numbers, model-download limits and future-work proposals are not current setup instructions. Use the [API provider guide](API-PROVIDERS.md), [local models guide](local-models.md), and [instruction audit](instruction-audit.md) for current controls, the optional MiniCPM setup, and catalog-refresh behavior. The measured results below retain their original scope.

## Findings against 2.39.104

- App connections uses one BLACKICE MCP endpoint. ChatGPT, Claude and Gemini setup panels are client-specific onboarding, not mutually exclusive servers. Each external app still needs its own configuration and OAuth authorization; one server cannot install itself in another app.
- OAuth dynamic registration is generic (lib/mcp-oauth-clients.mjs), although current guided app setup covers the named clients only. The historical /mcp/chatgpt URL is shared; this patch does not rename it or invalidate existing connections.
- Tools connections are a separate direction: external servers used inside BLACKICE. Their saved configuration has no provider owner. The engine supplies the common relay_connections handler to supported providers.
- Codex's native configuration is NOT automatically the shared catalog. blackiceSessionConfig in lib/codex.mjs disables ambient native plugins, MCP servers and skills using thread overrides. Existing native tools must be configured/imported in BLACKICE Tools for shared use. This behavior is unchanged by this UI patch.
- llama.cpp is already bundled where supported. Model weights are not bundled. There is no in-app model-weight catalog/download manager in this release; the release-download UI retrieves engine binaries, not models.

## Small coherent change

App connections explains the shared server and independent setup above its client guides. Local model onboarding explains engine versus model, offers a real external catalog from ggml-org on Hugging Face, provides download / select / load steps, and calls the picker Choose model file. Technical format is explained rather than used as the primary action label. Existing load behavior, advanced controls, runtime selection and authorization are unchanged.

## Remaining feature

A true one-click local model setup needs a curated, versioned model manifest with supported engine compatibility, download size / estimated memory / license information, resumable downloads and integrity validation, progress/cancel/retry, and registration into the existing modelPaths/load flow. Do not treat this explanatory UI patch as that feature. Do not auto-download weights or replace a user's runtime/model without an explicit choice.

## Verification

- 34 focused tests passed across llama-quick-setup, next-settings-local-models and next-settings-coherence.
- Disposable offscreen Electron fixture captures app setup and model onboarding at 1100px and 390px; no horizontal overflow, no model writes on viewing.
- 390px local-model capture visually inspected: all setup steps, catalog link, picker, load, refresh and advanced section readable.
- No live app, browser session, model runtime, job application, release or installer changed.


## Provider parity and actionable remaining gap

Fresh Codex and API-provider runs receive the same CONNECTION_TOOL via engine.mjs:1682,2122,2291. ProviderRuntime passes dynamicTools through to native Codex (providers.mjs:994/1000/1014) and flattens the same input for API providers (1047). Workers use the same manager at engine.mjs:1923/1935. Tool availability still requires the selected model to support calls.

A specific historical exception exists: resumed native Codex sessions retain resumeToolNames (engine.mjs:1509). A session started before relay_connections existed, or missing saved names, can therefore lack the shared catalog. This is a saved-session compatibility boundary, not a server belonging exclusively to Codex or Claude. New conversations get the current catalog. A future capability refresh should preserve prior receipts and offer a new compatible session with the updated tools, rather than mutate a native session schema or rerun old effects silently.

Recommended unification beyond this patch: a single shared Tools catalog with per-provider availability indicators and explicit import adapters for existing native client config. Import should preview/deduplicate destinations and credential handling; do not copy credentials or broaden access silently. App connections is the inverse direction and should remain clearly labeled.

## Implemented continuation fix (follow-up)

The old resumed-Codex limitation above is a real functionality gap, not only copy. The installed Codex app-server schema was generated without starting a model: ThreadResumeParams and ThreadForkParams cannot accept dynamicTools; ThreadStartParams can.

The follow-up engine change detects a stopped Codex session lacking relay_connections when an enabled shared server exists. Its next requested continuation uses BLACKICE's existing continuity handoff, preserving conversation/task identity, previous run and source native-thread ID. It opens a new native session with the shared catalog. Original native history and BLACKICE receipts are not rewritten. Saved conversation text is carried forward; original tool transcripts remain in their original thread, not falsely presented as transferred. A refresh notice directs inspection of saved state and forbids replay of completed/uncertain actions. Request IDs retain ordinary continuation deduplication.

An empty catalog does not force refresh; existing catalog-bearing threads keep native continuity. This is not live-thread mutation and cannot modify an active chat. Native ambient plugins, grants and browser policy are unchanged.

Verification: 111 targeted engine/history/model-switch/handoff/routing tests passed, including both current and historical planning engines. The new test goes through Codex JSON-RPC and invokes connections, tools and call against the shared manager; checks one downstream call, same BLACKICE task, original history unchanged, old source-thread ID, duplicate request reuse and next-turn native resume.

Final continuity hardening: capability refresh also reads the existing bounded TaskStateStore context before opening the new native session, including uncertainty warnings even with Planning off. If that required read fails, no replacement model turn starts. New tests seed both a confirmed receipt and an uncertain receipt plus an unfinished checkpoint; verify all remain unchanged and the actual new prompt receives the unresolved state and next action. No old operation is dispatched.
