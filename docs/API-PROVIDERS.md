# API providers

BLACKICE supports three request protocols: **OpenAI Responses**, **Anthropic Messages**, and **OpenAI Chat Completions-compatible APIs**. A provider preset configures a documented protocol and service address. It does not imply support for every additional native API offered by that company.

## Add a connection

1. Open **Settings → Models → API connections → Connect another endpoint**.
2. Select the provider. Use the displayed official documentation and key links for account setup.
3. Enter an API key or supported custom authorization headers when required. For a custom or local server, enter its API base URL and select the matching protocol.
4. Use **Check connection** or **Load models**. These actions read the current form without saving it or running a model.
5. Select the models you want, then use **Save connection**. You can also enter an exact model ID if the service does not expose a model catalog.
6. Select the saved model in Chat or set it as the default explicitly.

Adding, checking or enabling an API connection does not replace the current default or the provider identity of existing conversations.

## Current setup choices

The maintained registry is [public/provider-catalog.mjs](../public/provider-catalog.mjs). It supplies the UI and backend with protocol, catalog and authentication metadata. Official source links and review dates are stored with the corresponding preset.

| Protocol | Setup choices |
| --- | --- |
| OpenAI Responses | OpenAI |
| Anthropic Messages | Anthropic |
| Chat Completions compatible | OpenRouter, Kilo Gateway, Kilo anonymous free-model mode, current Pollinations, Mistral API, Groq, Cerebras, Google Gemini, NVIDIA hosted models, Hugging Face Inference Providers, DeepInfra |
| Local Chat Completions compatible | Ollama, LM Studio |
| Custom | An endpoint implementing one of the three supported protocols |

The Gemini preset uses Google's OpenAI compatibility API. It does not expose the native Gemini Interactions, file-upload, or provider-managed tool APIs. NVIDIA support uses the documented hosted LLM route; model-specific routes may need a custom connection.

Pollinations Classic is a retained legacy preset, not a current setup choice. Opening an existing Classic connection offers the current provider settings as an editable draft. Check the new credentials and available model IDs before saving that change.

## Find independent model providers

In Settings → Models, expand Find model API providers · keyed or keyless. Search provider names, model IDs, and API addresses, or filter by authentication, source and provider-reported free-model pricing.

Reviewed BLACKICE adapters include their implemented request protocol and setup guidance. Keyless applies only to documented no-key operation (such as Kilo anonymous access or a local Ollama endpoint). It does not mean unlimited quota.

External provider listings come from https://models.dev/api.json with a ten-minute cache and an explicit fetch timestamp. A declared environment variable indicates keyed configuration. The absence of one does not prove keyless access. An externally reported OpenAI-compatible endpoint may open an unsaved custom connection draft; unsupported native protocols remain reference-only.

Catalog discovery is read-only, does not send saved provider keys or chat data to the external index and does not change the default. Provider catalog access is distinct from key verification and successful model generation. Results from an unavailable external directory are clearly marked stale if they came from a prior successful fetch.

Opening a saved model provider forces a fresh catalog read. Saved models no longer advertised are flagged Not listed without silently modifying their saved IDs or prior conversation references.

## What a connection check establishes

- **Catalog available:** the endpoint returned a valid model list for the request.
- **Credentials verified:** the supported authenticated catalog or separate account-check endpoint accepted the supplied credentials.
- **Public catalog:** the list is available without credentials; a successful list request does not verify an entered key.
- **Model generation:** not tested by setup. A later model request can still be limited by the account's credits, rate limits, permissions, selected model or supported features.

Model lists, capabilities and prices are retrieved as observations. Unknown tools, image input or model limits are not assumed to be supported. Catalog failure does not remove a saved model selection or turn a static example list into a successful live result.

## Credential behavior

A blank key field keeps an existing key for an unchanged API target. Entering a replacement establishes an explicit saved credential choice for that connection and overrides an older profile or environment value. **Remove saved API key** clears the effective key choice for that connection; the cleared state survives a restart.

The profile `.env` file is not edited by these actions. Connections that have never received an explicit key replacement or removal keep their existing automatic source precedence. A changed origin or protocol requires an explicit key/header choice instead of implicitly borrowing the previous target's credentials.

## Maintaining support

Update a preset only after checking the service's current official API documentation and, where possible, its read-only catalog response. Keep generation authentication separate from catalog authentication. Do not add a static model list, a perpetual free-tier promise, guessed context limits, or an adapter label for a protocol that has not been implemented.

Catalog/parser changes require fixtures using the documented response shape. New provider-specific continuation metadata must round-trip through streaming, persisted conversation history and subsequent tool requests. The draft HTTP integration test verifies that discovery stays separate from saving and that a saved credential survives a cold store reload.
