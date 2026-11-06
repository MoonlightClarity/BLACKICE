# BLACKICE 2.39.24

## Check an API connection before saving

API setup now checks the address and credentials in the current form and loads the provider's live model catalog before the connection is saved. Choose a provider, enter its credentials, use **Check connection** or **Load models**, select models, and save once. Custom compatible endpoints and exact manual model IDs remain supported.

Checks do not save the draft, change the default model, start a conversation, or run a model. The result separates catalog access from credential verification and explicitly states that model generation was not tested. A public catalog response does not establish that an API key works. Authentication, catalog, and transport failures remain visible; failed discovery preserves the selected models and draft.

Editing the API target or credentials cancels an in-flight lookup and invalidates its result. A late response cannot populate a different connection. Saved-revision conflicts retain the draft and require reloading the current saved settings before saving.

## Current provider setup

The shared provider registry supplies current addresses, authentication guidance, protocol names, official documentation and key links, and the date on which its documentation was reviewed. The model list is fetched from the provider rather than bundled as a static list.

Current choices cover OpenAI Responses, Anthropic Messages, and Chat Completions-compatible OpenRouter, Kilo, Pollinations, Mistral, Groq, Cerebras, Gemini, NVIDIA, Hugging Face, DeepInfra, Ollama, LM Studio, and custom endpoints. Kilo's anonymous free-model mode is distinct from its keyed gateway.

Pollinations uses the current `gen.pollinations.ai` service. Saved Pollinations Classic connections remain readable with their original identity; the legacy preset is excluded from new setup and offers an explicit current-settings draft. Existing model IDs and conversations are not silently rewritten.

Provider-reported capabilities, aliases, model limits and supported endpoints are handled according to the catalog format. Missing capability information remains unknown. Free-model filtering uses provider-reported pricing or explicit access metadata; setup notes do not promise permanent free access or fixed quotas.

## Search independent model API providers

Settings → Models now includes Find model API providers. Search by provider name, model ID or endpoint across BLACKICE's reviewed presets and a current models.dev index. Filter by documented API keys, documented keyless access, reported zero-priced models and source. Results include model counts, source provenance, documentation and observed compatibility.

Reviewed providers open supported connection setup. Externally indexed OpenAI-compatible providers can open a reviewable custom draft without automatically saving it. Unsupported native protocols remain reference-only. A listing, public catalog or zero-price flag never proves inference entitlement.

Opening a saved connection now refreshes its live catalog. Saved models no longer reported are flagged, but historical IDs, conversations and defaults are not automatically deleted.

## Make an entered key effective

An explicitly entered replacement key now takes precedence over an older profile or environment key for that connection, including after restarting BLACKICE. Explicit removal also remains effective after restart. Ordinary connections without an explicit credential choice retain their established automatic credential behavior.

Changing the target of a saved connection requires an explicit credential choice. The old target's key and custom headers are not silently reused for a different origin or protocol. Secret values remain absent from provider metadata and check results.

## Preserve provider conversation metadata

Compatible streaming responses retain the opaque provider metadata needed for subsequent tool calls, including Gemini thought signatures at message and tool-call level. Parallel calls without numeric stream indices remain distinct. Existing OpenAI-style indexed argument streaming continues to work.

## Validation and release evidence

Regression coverage exercises draft discovery through the real HTTP handler and a local simulated provider, one-save setup, selected model metadata, persistent credentials after a cold store reload, unchanged defaults, public-catalog truthfulness, errors, cancellation, revision conflicts, and streaming tool continuation. The fixtures do not call paid model endpoints.

All 659 source test files passed across ten bounded Windows test batches: 7,587 passes, zero failures, and 11 optional skips. The planning evaluator's Python dependency was supplied through a separate official portable runtime, and the Workbench test fixture's native resource was copied into the isolated build-tools directory; application source was not changed to make these tests pass. The standalone Windows distribution suite also passed 12 of 12. A single unbounded aggregate run had exceeded its command deadline, so the complete file inventory was exercised in reproducible batches instead. The public installer has not been published: the official signed/build-bound release workflow and fresh installed-app validation must still complete.

Provider documentation was reviewed on November 6, 2026. Authenticated generation on every provider is not claimed: account permissions, credits, quotas and individual model availability are determined by that provider at request time.
