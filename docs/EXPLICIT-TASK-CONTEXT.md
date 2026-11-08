# Explicit task contexts

Development implementation in the isolated checkpoint. Not deployed; not a universal exactly-once guarantee.

## Contract and identity

A task context is a random host-issued reference, not a permission grant. It binds authenticated connector owner, direct contract signature, work item, criterion, generation and allowed host adapters. Browser commits reference an existing host-observed binding and identity-field policy. No identity is inferred from the last request, grant, conversation text, URL or arbitrary task ID. Different grants remain isolated.

Issuance checks the current task revision. Later observation/journal revisions do not invalidate the handle. Revocation invalidates a handle without clearing UNKNOWN evidence. There is no automatic expiry. Stage 3 bind_plan links the actual saved canonical task. Scoped generations preserve unaffected handles and fence queued stale calls; fresh calls use compatible refinements without reissuing handles. See CANONICAL-PLAN-CONTINUITY.md.

## Implemented direct interface

blackice_task_context supports explicit handle issuance, reading and revocation. blackice_native_task_context manages authenticated native attachments. blackice_task_contract bind_plan links a saved canonical source without starting a model. Protected calls supply taskContext, included in request identity and durable metadata and stripped before adapter arguments. Current planning:write and ordinary adapter scopes are required at admission and final dispatch. Claims and context-generation checks share one transaction. Browser association is compare-and-set.

Supported adapters are relay_browser for scoped observations/interactions and recognized evidence-backed native form commits, and relay_workspace for scoped observations only. Shell/file mutations, opaque operations and other protected tools fail before dispatch. Descriptive claims that an unsupported tool is read-only do not authorize it. Contextless maintenance keeps existing behavior and remains outside this guarantee. No new user-facing controls or exit from direct mode are required.

## Implemented native bridge and transport boundary

An authenticated owner explicitly attaches a context to a saved native canonical task at its exact revision while idle. The bridge preserves owner/context mapping and generation, rechecks scopes and material native contract state, and composes the original native guards with the shared semantic ledger. Native and direct calls contend for the same owner-scoped business-effect claim. Native task IDs do not become authenticated principals.

Protected native execution is supported only with an explicitly selected HTTP OpenAI, compatible or Anthropic route whose requests expose only the attached host function tools. The provider boundary rejects unsupported routes, old unprotected sessions, catalog changes and protection downgrades. Main and delegated workers, readiness, recursive analytical stages and final review preserve the boundary, checking each actual selected helper model. Default unprotected tasks remain unchanged.

Native Codex app-server and Mistral transports remain unsupported for protected execution. Accepted feature flags or one observed catalog do not prove a universal host-only dispatcher. No live config change, production restart or real provider/model invocation was used to validate this change. See HOST-ONLY-TRANSPORT.md.

The original same-native-task exact-payload duplicate restriction is retained. A deliberate occurrence in the shared semantic ledger does not bypass that independent native restriction. Linked contracts and native saved plans now share the host-synchronized canonical revision lifecycle; unlinked legacy contracts retain their existing behavior. Stage 3 remains undeployed.

## Initial actions, repeats and recovery

An initial attempt with no recorded host effect is allowed with an UNKNOWN baseline; there is no mandatory per-operation baseline read. Its confirmed outcome can count only with adequate admitted-effect evidence and the qualified novelty within-recorded-history when issuer history is not established. Known prior outcomes, pending UNKNOWN claims and duplicate issuer outcomes are retained and do not silently become new progress.

A deliberate repeat is agent-managed, with a durable instruction reference, quoted instruction, reason and caller-attested provenance. An uncertain earlier effect requires recorded acknowledgement and an uncertainty statement. This is an explicit new occurrence, not deletion of the prior claim or proof that the earlier action failed. Instruction references are idempotent; counting another occurrence requires distinct trustworthy issuer-outcome evidence. Caller attestation cannot independently authenticate the user's words.

UNKNOWN never expires into retry permission. Scoped reconciliation remains available. A replacement tab or fresh valid handle can recover the same owned binding without clearing uncertainty. Independent targets may progress within the same task/work item/criterion/identity policy while the earlier claim retains its target-count reservation. Changing targets cannot hide a pending claim to reassign a tab to an unrelated task. Local fencing cannot stop an independent client or human from repeating an external effect.

## Validation

The final combined log verification/combined-task-context-regression.txt reports 368/369 passing, with only the known baseline MCP browser-schema discovery securitySchemes failure. Other saved groups pass: explicit smoke 67/67; native engine/server 147/147; native final measurement 72/72; transport regressions 259/259; helper regressions 104/104; focused protected paths 11/11. Suites overlap. Tests cover owner isolation, stale/revoked contexts, final-dispatch scope changes, unknown recovery, direct/native contention, deliberate repeats, unsupported-route zero dispatch, recursive helper propagation and measured completion distinct from transport success.

The synthetic 100-outcome benchmark measured 51.3 ms median and 78.2 ms p95 per complete bind/baseline/claim/confirmation sequence, and about 0.53 ms per measurement read. This measures local fixture overhead, not production/browser latency. Include the bounded transport evidence summary with the checkpoint; exclude raw local protocol/catalog captures from the documentation package and commit recommendation.

The final context-focused rerun passed 68/68; see verification/context-final-focused.txt.

Stage 3 source/API/native/engine/server regression passes 188/188; see verification/canonical-source-regression.txt. Combined stage 3 regression reports 394/395 with the same known baseline discovery assertion; see verification/canonical-final-regression.txt. No deployment or catalog refresh has occurred.
