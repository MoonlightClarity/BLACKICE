# Bounded Planning field repair

A provider that does not advertise structured output can omit required fields or return prose where an enum is required. Planning uses its existing single repair turn for a small, schema-derived patch when every structural defect belongs to a supported scalar family.

## Scope and acceptance

- Eligibility comes from the captured response and current generation schema, not model-provided paths or a truncated diagnostic display.
- Protocol `accuracy-missing-fields-v1` remains unchanged for missing scalar fields in otherwise valid existing accuracy objects.
- Protocol `accuracy-and-inference-scalars-v2` additionally supports missing or invalid primitive accuracy leaves and the `basis` leaf of root Inference findings. The model supplies the semantic choice; the host never chooses an accuracy policy or evidence classification.
- Existing valid values stay immutable. Missing whole accuracy objects, object/array replacements in scalar slots, extra fields, unrelated schema errors, duplicate JSON keys, and oversized target sets retain full-response repair.
- Up to eight objects and 32 editable fields receive fixed repair IDs. The patch supplies exactly those IDs and fields. Paths and masks are rebuilt from the original base, including canonical array indices.
- The prompt retains all captured sources, criterion context, and each affected inference's claim, sources and limitation. It explains unknownPolicy choices and observed/inferred/unknown without inventing evidence or permission.
- A mode-dependent empty tolerance is editable only when the original accuracy mode is bounded_estimate. Changing a mode cannot unlock another originally valid leaf.
- Duplicate or unsafe JSON keys, unknown IDs, extra fields, invalid enums, non-text values, blank required text, and oversized output are rejected. The raw patch is bounded to 32,768 characters.
- The merged response passes the original complete parser, reference checks, and relationship checks. A patch that passes its small schema may still fail the full contract, including source requirements for observed findings.
- Repair consumes the existing single repair allowance. It never adds a third provider turn, changes the selected model, bypasses cancellation or provider budgets, or grants operational tools.

## Ambiguous and unrelated failures

Partial field repair never resolves ambiguous JSON by choosing a duplicate member. Such bases remain on the full-response repair route. Its schema-derived checklist names duplicate paths, exact missing-leaf contracts, and small enum choices, instructing the provider to return each member once. This is diagnostic guidance, not a new duplicate-key acceptance rule in the existing full-response parser. Full repair must address the schema and relationship diagnostics using the captured evidence. Neither route guarantees that an unsupported provider will follow the contract; failed output remains failed with its raw evidence retained.

## Durable evidence

The original failed attempt retains its unmodified output. Repair stores the raw patch, target paths, previous attempt ID, and base/patch/merged hashes separately from the accepted merged output. On save and reload, completed repairs must replay to the exact accepted output. Failed and cancelled repairs retain their raw output and bind to the same original failed attempt.

Each protocol freezes its scalar audit rules. Generation derives its fields from the current attempt schema and declines a narrow protocol when its semantic scalar contract changes. Descriptions and property or enum ordering do not change the v2 semantic contract. A future semantic change requires a new protocol rather than reinterpreting historical receipts.

## Verification

Synthetic tests cover both protocol versions, mixed accuracy and inference defects, strict patch masks, inherited values, canonical path aliases, schema drift, malformed-response fallback, invalid patches, cancellation, provider errors, budgets, full merged validation, and persisted evidence corruption. Captured private provider bodies are inspected offline and are never added to the repository or sent to a provider by these tests. Offline eligibility is not a successful provider run; live acceptance requires a separately authorized run.
