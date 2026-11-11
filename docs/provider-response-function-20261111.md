# Response-only function serialization

Compatible Chat Completions providers without native JSON Schema support can still advertise both tools and tool_choice. BLACKICE now uses that exact fresh model-catalog evidence to request a single forced blackice_response function carrying the response schema. This is a data-return envelope, never an action tool.

Selection remains conservative:

- A compatible strict schema and safe wire projection are required.
- Fresh structured_outputs advertisement keeps the existing response_format transport.
- Otherwise both tools and tool_choice must be advertised by the exact selected model.
- Missing, stale/unavailable, or insufficient capability evidence retains the existing declared prompt-and-host-validation behavior.
- OpenRouter requests set provider.require_parameters:true. Existing provider/model/endpoint selection and headers do not change. No rejected schema request is downgraded to text or redirected to another model.
- Native, Responses API, and ordinary action-tool turns keep their previous transport.

A function schema is not proof of strict constrained decoding. Capability evidence therefore reports provider-response-function, chat-completions-forced-function, wireSchemaEnforced:false, responseFunctions:1, attachedTools:0, and hostValidationRequired:true. The complete host schema stays in the request instructions. The detached wire projection uses the same compatibility rules as response_format; authoritative local schema, reference, and semantic validation still determines acceptance.

The receiver requires exactly one expected function identity, one choice, complete JSON-object arguments, no message text or refusal, and tool_calls termination. Stream identities, indices, fragments, and duplicate termination are checked. A length stop, missing completion, cancellation, forged function, multiple calls, or mixed text is never accepted. Arguments are not defaulted, reserialized, or lexically repaired.

There is no operational dispatch or onToolCall/onToolResultDelivered callback for the data envelope. Accepted argument bytes become an assistant text message. The original envelope is kept separately as private responseOutput evidence and never replayed as an executable tool call when the conversation resumes.

Private failure evidence is bounded to 256,000 captured characters. Complete envelopes preserve literal argument strings and allowlisted termination metadata. Interrupted streams retain bounded received frames; oversize prefixes are explicitly marked truncated. Superseded prefixes are removed. For image-bearing turns, incomplete stream content is omitted because individually redacting small fragments would leak reconstructed image data; complete envelopes are image-redacted before persistence.

Only a fully framed, exactly identified expected function can report PROVIDER_RESPONSE_FORMAT with bounded raw format-failure data. Planning routes that data through its existing local validation and one-format-repair policy. An initial malformed JSON object can receive the existing single full-response repair. A parseable response missing required scalars can receive the existing field repair. A malformed repair remains failed with rawPatch evidence and cannot start a third turn. Envelope failures, cancellation, incomplete output, and provider exceptions never enter this repair route.

The tests are entirely offline: fake HTTP/SSE responses exercise capability negotiation, exact wire bodies, hostile envelopes, streaming/cancellation/termination, failure evidence, image redaction, ordinary tools, resumed history, and real PlanningBrowserRuntime to ProviderRuntime to mocked HTTP repair flows. They do not establish live provider compliance, factual model accuracy, or successful execution of a user task.

