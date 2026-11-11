# BLACKICE 2.39.59

- Use a single forced data-return function for response-only analytical turns when a fresh exact-model catalog advertises both tools and tool_choice, while preferring existing native and JSON Schema transports.
- Keep that response function outside operational tool dispatch, with no executable-tool callbacks or tool-result loop; retain the selected model and configured budgets.
- Require a complete, exactly identified single response envelope and authoritative host validation. Function support does not guarantee constrained decoding or semantic accuracy.
- Preserve the existing single format-repair budget, literal bounded response evidence, raw/base/patch provenance, and safe text-only history on resume. Reject incomplete, cancelled, mixed, wrong-function and multiple-call responses.
- Clarify generation-only accuracy field roles and target-local repair guidance without semantic defaults, weaker validators, or changes to frozen public schemas.
- Preserve image redaction in failed-stream evidence and remove superseded truncated evidence when a complete envelope replaces it.

Validation uses synthetic offline fixtures and the exact Windows source suite. This release does not claim fresh live-provider compliance, live Planning acceptance, or successful execution of a user task.
