# BLACKICE 2.39.22

## Align Forced planning with admissible operations

Native execution refinement could advertise task bookkeeping as an operational choice even though the host correctly rejected it as a prospective execution leaf. The mismatch could consume the bounded repair attempt and stop a Forced task before its first operation.

The refinement now receives only attached operational tools. Provider-schema choices are bound to their actual tool and action pairs, so the advertised catalog and the prospective-operation checks describe the same choices. The operational worker still has `relay_task` for normal bookkeeping.

## Supply current registered references

A refinement could also name a task type or another registered reference that did not exist in the current workspace. Each refinement attempt now reads the normal task description, a supported bounded method-catalog page with its pagination and revision metadata, and a fresh task snapshot. Reference choices are bound to observed task and step types, exact method ID/revision pairs, and registered artifact IDs.

Saved methods outside the current page receive an exact saved-revision lookup. Missing or stale references are marked unavailable and are not advertised as current choices; existing historical references can remain in saved history.

Five explicit reference-related host rejections that occur before committing a plan can use the same existing single repair attempt. That repair refreshes the reference context before asking for a corrected plan. Provider, source, storage and uncertain-outcome failures, along with generic method errors, remain terminal. This does not add retries.

## Make output failures actionable

Schema diagnostics now identify unsupported root fields, invalid types or actions, and missing or malformed steps. They include the allowed root fields and declared `plan.<field>` locations so the existing bounded repair can correct the actual shape error.

A single unambiguous JSON or bare code fence around the whole response can be removed as transport formatting. The enclosed JSON is unchanged, and the normalization records the original-output and body hashes. Prose, multiple or inner fences, truncated or other-language wrappers, invalid JSON and invalid plan content remain rejected. The handoff does not relocate or drop fields and does not add repair attempts.

## Preserve history and existing checks

Saved terminal actions can retain a historical tool that is no longer attached. The host requires their saved status and operation to remain identical, and it rejects new detached-tool or bookkeeping leaves.

The complete original task schema, accepted source Plan, current revision, source ownership and operation validation remain authoritative. The accepted semantic Plan stays unchanged, and the worker still receives the exact saved outline before execution. Source changes, uncertain outcomes and other terminal failures retain their existing guards.

## Verification

The focused affected suite passed 111 of 111 tests across six files, including 55 handoff regressions. Coverage exercises the actual provider-schema boundary, catalog agreement, registered references, bounded repair behavior, precise shape diagnostics, strict fence normalization, retained terminal history and rejection of newly introduced detached-tool or bookkeeping leaves.

A fresh complete Windows source suite and hosted verification of the exact public installer remain required release gates. The release receipts record their actual tested source, counts, installer checksum and installation results. Earlier incomplete source attempts are preserved as history and are not counted toward the fresh gate. Live provider verification is recorded separately from the automated receipts.

The existing release workflow binds the final source-test receipt, application fingerprint, exact source tag, installer checksum and corresponding native dependency sources before publication.
