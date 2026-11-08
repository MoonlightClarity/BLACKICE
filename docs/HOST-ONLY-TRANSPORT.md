# Protected host-only transport boundary

This is opt-in development code. Ordinary tasks keep their existing transport behavior.

## Supported operational boundary

ProviderRuntime supports hostOnlyTools:true for explicitly selected configured HTTP providers using the OpenAI Responses, compatible Chat Completions, or Anthropic Messages adapters.

supportsHostOnlyToolDispatch({model}) is scoped to the exact concrete provider::model selection. It returns false for native Codex, Mistral Vibe, retired Chat mode, unspecified/default selections, unavailable models and unknown protocols. Each actual run checks again; an earlier capability check cannot authorize another worker's transport.

The HTTP adapters serialize only attached host functions. Returned calls are resolved against the host's exact attached catalog before onToolCall; unknown names never dispatch. Empty protected catalogs are explicit. No native shell, computer, apps, MCP server or provider-side built-in tool type is attached by these adapters.

Protected session records persist the catalog hash. They cannot be resumed without hostOnlyTools, silently upgraded from an old unprotected session, or resumed with a changed tool catalog. Those transitions require a fresh supported session. No automatic model/provider fallback is added.

Analytical API helpers can use responseOnly:true with hostOnlyTools:true and an empty catalog. Native response-only profiles do not qualify. Engine readiness, response-cycle and delegated worker selection must preserve this boundary or fail closed.

## Unsupported Codex boundary

The installed official Codex 0.167.0-alpha.3.2 protocol has no global tool allowlist field. Existing analytical feature controls and a read-only sandbox are not equivalent to host-only dispatch.

A model-free test started a separate app-server with a temporary isolated CODEX_HOME and a localhost-only synthetic Responses endpoint. It captured the actual model-facing tool request with available dangerous feature controls disabled. The request contained relay_browser and the native request_user_input tool. No real provider/model was called, no tools were executed, and live config was untouched.

The capture does not establish a universal native dispatch boundary. Consequently CodexRuntime rejects hostOnlyTools before process/model startup, rather than claiming protection from the feature flags. See verification/transport-boundary-evidence.json.

A future native implementation needs a supported, verifiable allowlist or equivalent native dispatch gate covering every mutation-capable built-in and inherited connector, with effective-state attestation before the first turn and throughout continuation. Acceptance of config keys or prompt instructions is insufficient.

## Tests

tests/host-only-transport.test.mjs exercises all three supported HTTP protocols, exact function catalogs, host callback dispatch, unknown-tool rejection, native-route denial, session upgrade/downgrade/catalog restrictions and response-only helpers. Existing analytical profile and provider execution contract tests remain included. All requests use mocks or localhost synthetic endpoints; no real model runs.

Protected engine readiness, recursive analytical stages, and final review explicitly forward the boundary. Planning workers check the actual saved or selected helper model before claiming an attempt, then the provider rechecks at dispatch. Per-entry state preserves the flag through queued execution and format repairs. Helper capability methods advertise propagation support, not approval of an arbitrary model; admission still checks each actual model. Normal helper requests remain unchanged.
