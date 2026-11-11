# Independent operational effect protections

BLACKICE's modular Planning ontology does not own application deduplication, external-effect uncertainty, native tool reservations, or durable execution receipts. Those are operational runtime concerns and apply with Planning **Modules** or **Off**. They do not require a saved planning contract, model-backed readiness check, or an attached native task context.

## Dispatch sequence

For an ordinary unprotected `relay_browser` or `relay_workspace` mutation, the host first describes the actual target at dispatch time. Read-only actions and navigation remain available for gathering evidence and resolving an uncertain submission.

- Recognized final ATS submission: check dated local application records plus the cross-task application claim journal, then durably reserve UNKNOWN **before the native input**. An earlier confirmed or uncertain claim for the same requisition blocks only that requisition. Distinct employer requisition IDs stay distinct. An unclassified POST on a recognized ATS page cannot be treated as a known harmless action.
- Other recognized commits/opaque browser input: store an independent root-scoped operation identity, concrete resources, and UNKNOWN reservation before dispatch. Locks serialize reservations across tasks and worker instances; an identical/potentially conflicting effect is not replayed.
- File write/patch/undo: reserve only the affected file, dispatch with the existing workspace adapter, then verify the actual file bytes and expected SHA-256. A confirmed edit remains in the history but does not prevent a later distinct edit; an uncertain mutation blocks only that file until reconciled.
- Results: record a receipt digest and the state **absent**, **confirmed**, or **unknown**. A successful tool callback is not proof an employer, website, or service accepted an action. Absence requires a trusted explicit non-dispatch observation. A recognized external commit can be confirmed only by matching host evidence, never arbitrary page prose.

In all cases an unrelated independent task or requisition remains runnable. The model receives an explicit, local error/receipt; no extra provider round trip or full-task planning gate is created.

## Explicit attached native contexts

When the user explicitly attached a native task context, BLACKICE preserves the existing context-scoped native outcome and authorization mechanism. The independent guard is used only for ordinary tool calls **without** that attachment. Detaching a context never deletes its UNKNOWN records. No unrelated ChatGPT grant is inferred.

## Boundaries

This protection directly wraps BLACKICE's contained browser and workspace write/patch/undo adapters, including subagents. Native Windows application adapters, email integrations, and generic shell commands have their own action receipts and existing protections; they are **not** claimed to have the same semantic reservation coverage by this extraction. An unclassified shell command is not globally fenced as an invented external submission. The inability to verify an external outcome does not justify repeating a possibly consequential action, and it does not stop unrelated work.

Supported tests: `operational-effect-guard.test.mjs`, `application-history.test.mjs`, `operational-workspace-effects.test.mjs`, `operational-browser-engine.test.mjs`, `native-task-context-bridge.test.mjs`. They cover cross-process locks, durable UNKNOWN after restart, correct duplicate prevention, actual workspace hash verification, minimum-scope blocking, exact tool-call idempotency, actual HarnessEngine tool dispatch, and explicit native-context behavior.

## Retired planning compatibility

Historical Forced/Advisory and Plan-only records remain viewable for provenance only. New `plan_only` admissions are rejected with `PLANNING_EXECUTION_MODE_RETIRED` **before** side effects. Neither saved record viewing nor graph editing launches the old cycle. The old schedule-readiness endpoint returns `TASK_VIABILITY_RETIRED`; enabling, triggering, and retrying jobs no longer invokes its inference/feasibility model calls. An old Plan-only queued job is held independently while other jobs continue.
