# Canonical plan continuity

Stage 3 development implementation in the isolated canonical-plan-continuity checkout. Not deployed. No model starts, production restart, real submissions, or live-provider tests are part of binding or this validation.

## One saved source

blackice_task_contract action bind_plan accepts sourceTaskId and expectedSourceRevision. The host reads that exact TaskStateStore version 14 contract under its existing task/file lock. It derives a stable outcome-task ID from the authenticated owner and source task, records the source revision/epoch/digest, and retains the saved contract as a synchronized execution projection. The caller cannot substitute a copied contract or manually update a linked projection. Different grants remain distinct principals.

Binding is once per source and owner, not once per revision. Before protected work and measurement, the host refreshes the current source. Unrelated work-item changes preserve a context generation. Relevant scope changes advance generations: a queued stale operation fails before dispatch, while a fresh call resolves the updated scope using the same handle. Native linked attachments do not require idle reattachment for each receipt refinement. Unlinked legacy attachments retain their earlier exact-revision/material-contract checks.

Stable business identity, pending claims, deliberate occurrence provenance, issuer evidence, and operation history are not reset by plan revisions. Parent-goal changes or destructive changes to evidenced criteria remain conservative boundaries. Receipt interpretation is agent-authored intent, not proof.

## Admission boundary

Lock order is TaskStore then shared outcome ledger. Direct dispatch resolves and synchronizes the source while holding the TaskStore lock, then validates its captured scope and makes the shared claim. Native dispatch composes a host-only admission callback inside the existing original planning guard transaction, after its native checks and before its dispatched journal mark. The callback receives trusted current state, not model-supplied tool arguments.

This is a local admission linearization boundary, not an atomic transaction with a remote website or a two-file database transaction. A canonical edit after admission is a later operation, not retroactive cancellation of an already admitted effect. A crash between local journal writes can leave conservative uncertainty requiring reconciliation, never automatic replay.

## Evidence and refinements

The linked source retains its full normalized contract, including bounded alternative receipt mappings. Host-retained operation receipts and raw evidence sidecars support later interpretation under refined mappings without treating a model assertion as a destination confirmation. Missing, damaged, ambiguous, or insufficient evidence remains unresolved. Unknown effects reserve their business outcome until trustworthy reconciliation; a refined selector alone does not prove completion.

The native original planning and exact-payload duplicate guards remain intact. Shared deliberate occurrences do not bypass the independent same-native-task restriction. Unsupported opaque effects and workspace mutations remain outside protected semantic execution. Protected native provider routes remain limited to the verified HTTP host-function transports documented in HOST-ONLY-TRANSPORT.md.

## Proven checks

- Exact source revision, authenticated principal, stable task identity, and rejection of caller-supplied contract copies.
- Unrelated refinement preserves a handle; relevant refinement fences old generation and permits fresh use without issuing another handle.
- Native source revision changes do not force reattachment.
- Actual native planning guard holds the source lock during shared admission; stale plans and shared denials prevent a dispatched journal mark.
- Synthetic native browser submission becomes UNKNOWN, then a receipt-rule refinement and fresh native read reconcile the same outcome with one POST and unchanged attachment generation.
- Existing native/direct contention, revoked handles, detached mapping history, unsupported provider rejection, and server startup ordering remain regression-tested.

Focused source/native suites pass 38/38 in verification/canonical-source-tests.txt. The source/API/native/engine/server regression passes 188/188 in verification/canonical-source-regression.txt. The combined project run reports 397/398 with its sole previously reproduced baseline discovery securitySchemes failure in verification/canonical-final-regression.txt; suites overlap. See separate ledger/receipt logs for rehydration and multi-binding tests.

## Remaining limits and release work

No local mechanism guarantees external exactly-once execution against independent clients, humans, or a server without participating idempotency. No cross-grant identity inference or automatic promotion of legacy textual successes is implemented. New adapters need trustworthy effect descriptors and outcome evidence. Source authorization does not expand connector scopes. Native Codex/Mistral routes remain unsupported for protected execution.

Review/checkpoint, installation after active work settles, and client catalog refresh are separate unperformed steps. Server registration alone cannot refresh a cached connector catalog.

## Follow-up verification

The final expanded direct/canonical/catalog/connector regression passes 494/494 (verification/continuity-complete-regression.txt). The earlier discovery failure was a stale test expectation: MCP advertises OAuth transport scope read while execution separately enforces browser action scopes. Updated tests prove missing action scopes admit no jobs and dispatch nothing; production permissions were not changed. Catalog expectations now include the two registered task tools. Dedicated direct-runtime tests verify native POST-correlated rejection clears UNKNOWN without resubmission; identical uncorrelated rejection text does not. These supersede the prior known-failure and correlated-rejection test-gap notes, not the documented coverage limits.
