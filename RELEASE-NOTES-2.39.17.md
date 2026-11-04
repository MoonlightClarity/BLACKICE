# BLACKICE 2.39.17

**Source verification and behavioral evidence, 4 November 2026.** The full source gate passed. The host robustness fixes below are verified narrowly. The tested model did not complete the mandatory form task, and the separate decision component failed aggregate validation.

## Planning compatibility and recovery

Compatible Chat Completions requests now use a detached wire copy of the output schema that omits `uniqueItems`, which the tested NVIDIA grammar rejected. The original schema remains available for host validation. Projection visits schema nodes while preserving property names and literal enum/const/example data. If uniqueness occurs under an exclusive `oneOf` branch, the adapter uses its explicit prompt-and-host-validation fallback because removing that constraint could change which branch matches. Native and Responses schema paths retain their existing contracts. See the [structured-output note](docs/provider-structured-output-20261030.md).

The verified local uniqueness invariant is specifically the string-ID array `hardConstraints[].blockedOptionIds` in raw user-cost inputs: the unchanged shared host evaluator still rejects duplicates. This does not claim general JSON Schema uniqueness enforcement for arbitrary object arrays.

Malformed plan-edit operations now receive structured `INVALID_PLAN_EDIT` rejection before revisit or reconciliation inspection. JSON-encoded strings and invalid operation collections are not coerced or dispatched, and plan/ledger state remains unchanged. The missing-plan recovery message now includes the complete current leaf fields, schema-appropriate operation object, and guidance to use separate leaves for separate primary calls. Mandatory Planning acceptance and operation reconciliation are preserved.

## Reproducible evaluation

The evaluation harness now uses full application services and forced Planning, records effective admission flags, and snapshots mandatory Planning resources. It distinguishes adopted analytical Plans from executable shared task outlines and actual effects.

The isolated free evaluator used one fixed model, `nvidia/nemotron-3.5-super-vl:free`, at default effort. It verified zero catalog input/output pricing before inference, blocked inherited credentials/native fallback, and left live provider/default settings unchanged. The full-execution ceilings were 32,768 configured provider tokens, 600,000 ms per runtime run, 900,000 ms per case, and 64 model-response iterations. Captured wire limits are reported separately: final r4 Planning requests used 32,768 tokens and execution requests used 8,192. No execution output truncation was observed.

## Observed behavioral results

The final forced form trial adopted a Plan but exhausted 64 execution responses and 69 tool calls. The form never opened successfully; there were no fills or submissions. Invalid browser arguments repeated. Malformed edits and reviews received structured host rejection; no new unhandled host exception was observed. The outcome remains an objective failure, not a pass based on model intent or receipt integrity.

A separate seven-case decision component made one request at 65,536 output tokens, with zero tools and no mandatory execution cycle. It returned final JSON but failed aggregate validation because the backup case omitted its required typed decision assessment. The original `host-validation.json` was never written. Exact fictional input, prompts, schemas, final answers, hashes, and offline checks are retained in the [public evidence bundle](verification/agency-20261104/evidence-map.md).

A later per-case diagnostic structurally accepted four cases and rejected three; those accepts are not behavioral passes. Semantic review found gratuitous negative disclosure in the general SQL answer and an unsupported credential gate/HOLD plus missing claimed drafts in the role case. The explicit SQL answer was sound on its fixture. Backup and clarification calculations selected sensible actions but lacked valid typed comparisons, and the clarification draft added unsupported reassurance. The negotiation draft protected the private ceiling and respected draft-only instructions but had an invalid checkpoint. Recovery correctly distinguished pre- and post-dispatch failure, while its missing-receipt retry rule was too broad.

See the complete [results](docs/agency-behavior-report-20261104.md) and [methods](docs/agency-behavior-methods-20261104.md). Neither a completed mandatory agency task nor a controlled native behavioral improvement is established. Native Luna quota exhaustion prevented a usable native comparison.

## Verification and release limits

Focused schema, guarded malformed-edit, evaluator-budget, and engine-recovery checks passed. Their receipts support the narrow changes and must not be summed into a complete release gate. The initial source gate stopped on two confirmed installer-note approval entries; those entries were repaired. The fresh complete source gate passed on frozen source `1162e3136dfc7681e2e72c5c022af48767521b15`: 614 test files, 7,038 tests, 7,029 passed, 9 permitted optional skips, and zero failures, required skips, cancellations, or todos. Unique coverage and unchanged source/application identities were verified. See [verification/windows-2.39.17.json](verification/windows-2.39.17.json).

This document records source and behavioral verification. Installer verification is established by the release workflow’s separate receipts; desktop activation is recorded separately. The component is one explicitly guided, fixed-order context with descriptive case names and illustrative cost assumptions. Its semantic findings are limited to the preserved drafts; no external tasks were performed.
