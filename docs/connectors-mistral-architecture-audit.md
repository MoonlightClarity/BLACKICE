# Connector and Mistral architecture audit (.106, 2026-11-17)

## Three different connections
- **Apps → BLACKICE:** one incoming MCP endpoint, not one server per provider. ChatGPT/Claude have special CIMD identities; other apps can use RFC 7591 dynamic client registration. OAuth authorization code + PKCE S256, resource indicators, HTTPS callbacks are required. Arbitrary CIMD documents and HTTP loopback/native callbacks are not implemented. Registration is not authorization.
- **BLACKICE → tools:** Settings → Tools already accepts arbitrary named stdio or Streamable HTTP MCP servers, with configuration import and catalog search. It is shared across tool-capable model providers, not restricted to the branded App connections list.
- **BLACKICE → models:** API provider presets are convenience adapters, separate from incoming apps. Custom compatible endpoints and external provider discovery already exist. Index-reported compatibility is explicitly unverified.

## Confirmed UI defect and fix
Incoming generic clients can register, but .106's three branded panels filter pending requests and grants by ChatGPT/Claude/Google. An unlisted app's request can become invisible in Settings. The added Other MCP apps panel exposes the shared endpoint, all pending requests and all active grants. It explains protocol limits without claiming every app will work. Navigation is read-only; explicit actions reread the current record. No live grants, configuration, endpoints, accounts or installed files were changed.

## Mistral: supported foundation, brittle enrichment
The subscription connection launches official vibe-acp. Mistral explicitly documents ACP as its supported integration route:
https://docs.mistral.ai/vibe/code/use-vibe-in-other-ides
https://docs.mistral.ai/vibe/code/cli/install-setup

BLACKICE's extra coupling is in lib/mistral-vibe.mjs:
- _auth/status and browser-auth-delegated are vendor-specific extensions.
- An owned strict TOML profile assumes many native option names.
- experimental_enable_model_catalog is explicitly experimental upstream:
  https://github.com/mistralai/mistral-vibe/releases
- Catalog enrichment reads model_catalog_cache.json, timestamp/payload/aliases/capability fields, then polls session/set_config_option to obtain a matching ACP view. This is a CLI storage-format dependency, not a documented network API.
- On enrichment failure, existing code preserves confirmed saved choices, or uses the current session's ACP model catalog on first setup. This keeps the connection available but can leave stale choices and warnings.
- ACP model options and usage updates are used for runtime-backed choices; no hardcoded global model entitlement is assumed.
- Separate Mistral API adapter already uses /v1/models and /v1/chat/completions. It must remain a separate explicit access path, not silently replace a subscription or reuse its credentials.

## Recommended follow-through, not claimed implemented
1. Treat standard ACP config options as the authoritative minimum model list; make private-cache enrichment genuinely optional and explicitly sourced.
2. Negotiate vendor auth extensions with a compatibility diagnostic; retain tested native sign-in fallback without credential copying or a second billing path.
3. Version-pin/test the adapter against official CLI releases, including extension removal, changed cache schema, absent thinking controls, startup configuration rejection, cancellation and resume.
4. For richer catalog metadata, prefer an upstream documented ACP capability over more cache fields. The separately configured official API is an option, not automatic migration.

## Verification
69 focused tests passed: generic UI, Settings navigation, Mistral Vibe lifecycle/catalog behavior and official Mistral API catalog fixtures. No real external signup, consent, inference, payment, CLI upgrade, release or installation occurred. Rendered browser acceptance and aggregate release suite remain integration-owner steps.
