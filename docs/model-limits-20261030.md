# Model capacity reports

BLACKICE reports the context window and maximum output separately for API and native Codex models. The report appears in model discovery, selected and saved model lists, and the result of adding a model. An unavailable capacity is shown as **Unknown**, without substituting the application's working budget.

## Four distinct quantities

| Quantity | Meaning |
| --- | --- |
| Context window | The model's reported total token capacity, subject to the provider's own accounting. |
| Maximum output | The model or endpoint's reported completion limit. This can be much smaller than its context window. |
| Configured output budget | The maximum BLACKICE is configured to request for a response. It does not raise the provider's maximum. |
| Working context budget | BLACKICE's local allowance for input, output reserve and headroom when constructing a request. A fallback working budget is not a model capability claim. |

Public model records expose `contextWindowTokens`, `contextWindowSource`, `maxOutputTokens` and `maxOutputTokensSource`. A missing value is `null` with source `unknown`. Known values distinguish `provider-reported` from `user-configured`; supported observation timestamps remain attached to provider metadata. Model capacities accept positive safe integers independently of the application's selectable working-budget ranges.

## Adding and editing models

Catalog discovery carries the advertised limits into model selection and saving. When new model IDs lack capacity metadata, onboarding uses a fresh cached catalog or makes one best-effort catalog request. This reads metadata; it does not ask a model to infer its own specifications. If the catalog is unavailable or omits a capacity, saving remains possible and the report shows the unknown value.

Renaming a model or editing its selected-model list preserves existing capacity metadata. An explicit capacity edit is a configured value; an explicit `unknown` clears it. Changing the provider's catalog identity requires fresh metadata for previously reported limits. Saved revisions and idle checks still govern configuration updates. Native Codex additions use actual catalog metadata when available and report missing capacities as unknown.

## Why the output limit is separate

The Pollinations Classic endpoint used during the planning test has a fixed 1,500-token output ceiling. Its upstream adapter sets `MAX_TOKENS = 1500` and sends that value regardless of the caller's requested output budget. The corresponding upstream regression test explicitly checks this override. Its Classic model catalog does not report a context window, so the context field remains unknown.

Primary references, pinned to the inspected upstream revision:

- [Classic adapter implementation](https://github.com/pollinations/pollinations/blob/a2a962686bd7e26589a2b5e9c7259f75e67fc967/text.pollinations.ai/cloudflare-cache/src/origin.js)
- [Classic adapter regression tests](https://github.com/pollinations/pollinations/blob/a2a962686bd7e26589a2b5e9c7259f75e67fc967/text.pollinations.ai/cloudflare-cache/test/origin.test.js)

An output-limit failure retains its partial response and does not qualify as a complete Plan or authorize an automatic format repair. A reported context window alone does not establish that a complete planning response fits within the provider's output allowance.

## Related planning contract correction

Generated Plan schemas require at least one acceptance criterion, one proposed step, and one criterion reference per step. Requested child questions also need nonempty acceptance criteria. Diagnostics identify the exact missing array. These per-attempt constraints preserve published control contracts and editable historical records.

Explanatory values, check notes, Plan descriptions, rationales and other declared explanations cannot consist solely of captured source IDs. Literal findings, requested identifiers, final-answer excerpts and result summaries remain usable as data. This rejects a concrete malformed response pattern; it does not independently establish the correctness of the model's analysis.
