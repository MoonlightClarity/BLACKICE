# BLACKICE 2.39.21

## Restore the handoff from Forced planning to execution

Forced planning could finish the native accepted Plan without giving the operational worker a saved executable outline that satisfied the existing task and operation checks. This release adds a dedicated handoff from that accepted Plan to a prospective execution outline.

The accepted semantic Plan remains unchanged. A native response-only refinement receives the current task snapshot and the actual tool catalog, then returns the existing plan-call schema. Operational tools are unavailable during this refinement. A self-contained transport schema passes the native response-only schema boundary; the complete recursive task-plan schema remains in the refinement prompt. The ordinary task handler validates the proposed leaves and saves them only against the expected current revision.

The operational worker receives the exact, untruncated saved outline with its plan reference, content hash and task revision before execution begins. Awareness is acknowledged on the first tool or final-response callback. If the saved plan changes before use, the existing stale-plan checks continue to block operations until current evidence is supplied.

## Keep source and operation checks intact

- The handoff stays bound to the accepted source Plan and current saved task state.
- Completed malformed refinement output receives one bounded repair attempt. Transport failures, cancellation and source changes remain terminal for that attempt.
- Normal plan admission, revision and operation checks remain in force.
- Measured refinement usage is included in planning usage.
- The handoff does not derive tool operations from plan titles.

## Keep native MCP sessions independent

Mistral Vibe opens a fresh MCP HTTP session for each tool call. BLACKICE now scopes request IDs and cancellation to the negotiated session, so repeated numeric IDs across calls do not collide. Retries and conflict checks remain scoped to one session, while authenticated access, bounded cleanup and delivery of real results from pending work stay intact.

## Preserve reproducible native build inputs

The compiler lock now pins the SHA-256 of the repository's canonical LF-encoded FreeRDP dependency lock. This corrects a stale CRLF-byte pin while preserving every dependency package version and artifact checksum. A cross-file regression assertion verifies the binding.

## Verification status

The latest focused suite, including native MCP transport regressions, passed 84 of 84 tests. The regressions exercise the actual native schema normalizer and response-only validator, preserve complete recursive plan data, and verify rejection of invalid expressions by normal host validation. Coverage also includes source replacement, concurrent task edits, primary-source mismatch, unresolved-result reconciliation, empty or stale refinement, single-attempt transport and source-read failures, planning usage and the ordinary first operational tool path.

The full Windows source suite and hosted verification of the exact public installer are required release gates. Their receipts must record the exact tested source, final counts, installer checksum and installation results. Live provider verification is recorded separately from these automated checks.

The existing GitHub release workflow binds the final source-test receipt, application fingerprint, installer checksum and corresponding native dependency sources before publication.
