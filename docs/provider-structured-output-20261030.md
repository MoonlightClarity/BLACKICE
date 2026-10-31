# Planning schemas on compatible provider requests

Planning response workers already passed their full `outputSchema` to `ProviderRuntime`. The Responses adapter sent it through `text.format`; the compatible Chat Completions adapter previously omitted it. That left an OpenRouter analytical turn with prompt instructions and host validation, even when the selected model advertised structured outputs.

Compatible analytical turns now choose their transport from the exact selected model's provider-reported catalog entry. A fresh cached catalog is reused. A cold or expired cache triggers one existing read-only catalog discovery before inference. Discovery cancellation propagates without starting inference. Other discovery failures produce an explicit `catalog_unavailable` prompt fallback; they do not imply that inference access is unavailable.

| Evidence | Request behavior |
| --- | --- |
| Fresh exact model advertises `structured_outputs`, with a compatible strict schema | Send the unchanged schema as `response_format:{type:"json_schema",json_schema:{name:"planning_response",strict:true,schema}}` |
| Catalog lists only `response_format` | Keep prompt and host validation; JSON mode alone does not establish JSON Schema support |
| Model absent, parameters missing, catalog unavailable, or schema has optional/open object fields | Keep prompt and host validation, with a specific capability reason |
| The schema-bearing inference request fails | Surface that failure; do not retry without the schema or switch models/providers |

All object properties must already be required, and each object must declare `additionalProperties:false`, to use this strict transport. The helper does not add requirements, remove constraints, or replace optional values. A required property with `anyOf:[<closed object>,{type:"null"}]` is compatible, preserving the nullable representation used for optional accuracy metadata. Empty enum lists are rejected by this transport check. The actual merged five-stage schemas are checked recursively in the wire test suite.

OpenRouter requests also set `provider.require_parameters:true` when this schema transport is selected. That field is not sent to generic compatible endpoints. Ordinary requests without the analytical profile retain their existing behavior. An internal analytical context checkpoint clears the stage output schema for its summary request while retaining it on the stage itself.

Capability events identify `provider-json-schema` or `prompt-and-host-validation`, the reason for the choice, and `hostValidationRequired:true`. These describe the request contract, not verified model compliance. OpenRouter's [structured-output documentation](https://openrouter.ai/docs/guides/features/structured-outputs) documents the request format and provider-routing preference, and explains that schema enforcement varies by endpoint. Local structural and reference validation remains authoritative; a schema-shaped response does not prove its factual claims.

The focused tests use fake HTTP responses only. They inspect the actual serialized request body, fresh/stale/recreated-runtime discovery behavior, generic catalog fallback, nullable schemas, cancellation before inference, and the absence of an implicit HTTP retry or parameter downgrade. They do not measure model accuracy or call a live provider.
