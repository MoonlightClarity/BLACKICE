# Mistral ACP-first catalog compatibility

The adapter behavior below is source-backed. The dated verification section records controlled fixtures, not qualification of every current Mistral account or CLI version. Use **Config → Models → Accounts → Optional Mistral account** for the native connection and [Add API](API-PROVIDERS.md) for the separately billed API route.

## Adapter contract
Mistral subscription access continues through the official `vibe-acp` executable and the existing authentication path. No API key migration, paid API fallback, account modification, CLI installation, or provider inference is part of this change.

ACP session `configOptions` is authoritative for available model identities. Standard `model` and `thought_level` categories use the agent's opaque selector IDs, with legacy Vibe `model`/`thinking` IDs supported. Grouped choices are supported. Unknown or absent model selectors do not invent choices.

Refresh reads optional private cache metadata once. The existing bounded parser accepts only its known timestamp/payload/models shape and matching current ACP identities; unknown, malformed, stale, or missing cache falls back to ACP. Cache-only models are never admitted. Cache enrichment retains existing alias deduplication and capacity provenance. This is still a private format compatibility adapter, not a public API.

Per-model reasoning control probes are optional. Failed probes do not replace fresh ACP choices with a stale saved account list. The discovery session closes without inference. Ordinary turns do not read or wait for private catalog storage and do not poll by selecting the current model.

Owned profiles no longer enable `experimental_enable_model_catalog`. This avoids depending on an experimental configuration key, but older Vibe versions can consequently advertise fewer choices. Full account-catalog parity is **not guaranteed**. Status includes `catalogNotice`; a lost prior default produces a visible warning rather than silently pretending it remains available. Existing conversations stay pinned to their original model; a run still requires that model in its current session, and never switches provider or billing path.

## Saved fallback
New receipts use catalog schema version 2, with `catalogSource: acp-session`, `compatibilityVersion: 1`, native CLI version and observation time. Versions 1 and 2 load; unknown versions do not. These are BLACKICE schema versions, **not** a claim of tested native CLI release compatibility.

If an authenticated session no longer exposes an ACP model catalog, previously saved choices remain explicitly marked `saved-fallback` with a warning, without overwriting the durable catalog. They are not proof of current entitlement. Without any previous choices, discovery is unavailable. Runtime execution still checks current ACP selection before sending a prompt.

## Limits intentionally retained
- `_auth/status` and delegated browser authentication remain vendor extensions. Removal produces a diagnostic/unavailable connection, not credential copying or a silent separately billed API switch.
- Strict owned-profile isolation still depends on other native Vibe configuration names. No unverified version gates or automatic weakening of isolation were added.
- Model list notifications arriving after the initial session snapshot are not aggregated here. Refresh reflects the advertised snapshot, not guaranteed eventual account completeness.
- Reasoning vocabulary remains BLACKICE's recognized effort vocabulary. Unknown controls are not guessed.
- No real account sign-in, native CLI upgrade, live inference, installation, or release was tested in this lane.

## Primary references checked 2026-11-17
- Official Mistral ACP integration: https://docs.mistral.ai/vibe/code/use-vibe-in-other-ides
- ACP v1 session configuration: https://agentclientprotocol.com/protocol/v1/session-config-options
- Mistral configuration reference: https://docs.mistral.ai/vibe/code/cli/configuration-reference

## Verification
Focused synthetic suites cover the existing lifecycle, protocol, routing, HTTP adapter, tool bridge, settings and API catalog, plus standard/legacy selector IDs, grouped choices, missing thinking control, cache mismatch/staleness/unknown schema, absent ACP choices, saved fallback versions, private auth extension removal, cancellation, cleanup, resume and uncertain-turn non-replay. See the lane receipt for the final exact count. These fixtures demonstrate adapter recovery, not qualification against every native CLI version.
