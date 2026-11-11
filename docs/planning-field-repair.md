# Missing accuracy field repair

A provider that does not advertise structured output can omit required accuracy fields even after a full-response format repair. Planning now uses its existing single repair turn for a small, schema-derived patch when the rejected JSON has only missing scalar fields in existing accuracy objects.

## Scope and acceptance

- Eligibility comes from the captured response and current generation schema, not model-provided paths or the truncated diagnostic display.
- Existing values must already satisfy the schema. Missing whole objects, invalid existing values, unrelated schema errors, ambiguous JSON, and oversized target sets retain the existing full-response repair path.
- Up to eight accuracy objects and 32 missing fields receive fixed repair IDs. The patch supplies exactly those IDs and fields. No host default selects unknownPolicy or invents evidence.
- The prompt retains every captured source and relevant criterion context, explains the permitted unknownPolicy choices, and asks for missing values only. It does not send the entire rejected response as a replacement template.
- Duplicate JSON keys, unsafe keys, unknown IDs, extra fields, invalid enums, non-text values, blank required text, and oversized output are rejected. The raw patch is bounded to 32,768 characters.
- The host applies declared missing leaves to the captured base and then runs the original complete response parser, reference checks, and relationship checks. A successful patch alone never establishes readiness or external effects.
- A failed patch consumes the existing single repair. It cannot start another full-response retry, change the selected model, or bypass cancellation and provider budgets.

## Durable evidence

The original failed attempt retains its unmodified public output. The repair stores the raw provider patch, target paths, previous attempt ID, and base/patch/merged hashes separately from the accepted merged output. On save and reload, completed repairs must replay to the exact accepted output. Failed and cancelled repairs retain their raw output and bind to the same original failed attempt.

The accuracy-missing-fields-v1 audit contract freezes its scalar rules. Generation derives its fields from the current attempt schema and declines this narrow protocol if that scalar contract changes. A future semantic schema change must add a new version rather than reinterpret historical repair receipts.

## Verification

Synthetic tests cover incomplete accuracy objects, strict patch boundaries, inherited values, malformed-response fallback, invalid patches, cancellation, provider errors, budgets, full merged validation, and saved-provenance corruption. Captured private provider bodies are inspected offline and are never added to the repository or sent to a provider by these tests. Live acceptance requires a separately authorized provider run.
