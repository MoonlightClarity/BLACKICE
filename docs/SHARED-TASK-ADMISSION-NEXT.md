# Shared admission: implemented boundary and next stage

> **Status: Historical documentation.** This preserved release-era design, evaluation, or migration record is **not current usage guidance or deployment evidence**. Do not infer present defaults, tool contracts, or installation state from it. See [current documentation](README.md) and [source release notes](../RELEASE-NOTES.md).

This checkpoint implements explicit task contexts, shared direct/native semantic admission, and supported HTTP host-only transport enforcement. It remains development-only and is not deployed.

## Implemented

- Host-issued owner-bound handles identify a direct contract, generation, work item, criterion and supported adapters. They are references, not expanded permissions. External callers supply them explicitly unless a concrete owned browser binding already supplies context. No global last-active-task inference is used.
- Explicit idle native-task attachment binds the authenticated owner/context to an exact saved native revision. Native and direct browser commits use the same atomic semantic claim ledger while preserving native planning, evidence and exact-payload guards.
- Final dispatch validates current owner scopes, handle generation, material contract, supported descriptor, prerequisites and target capacity. UNKNOWN claims survive crashes and cannot expire into automatic retry. Read-only reconciliation remains available.
- Supported HTTP OpenAI/compatible/Anthropic routes expose only host-attached functions. Protection is preserved through main/delegated workers and analytical helpers. Native Codex/Mistral routes are unsupported and fail closed for protected execution. Ordinary unprotected tasks are unchanged.
- A first attempt without recorded host effects needs no mandatory baseline read. UNKNOWN baseline remains explicit; adequately confirmed progress is qualified as within-recorded-history unless issuer absence is established. Known prior and uncertain effects remain recorded.
- Deliberate occurrences are agent-managed using durable caller-attested instruction provenance and explicit uncertainty acknowledgement when needed. They do not clear prior claims or establish absence. Distinct issuer evidence, not intent alone, proves additional progress. No user-facing control or direct-mode exit is introduced.

## Implemented stage 3: canonical saved-plan continuity

bind_plan now links the actual TaskStateStore version 14 source, not a caller-authored copy. Host synchronization preserves owner/source identity and retained outcome history across revisions. Scoped generations allow fresh calls after relevant refinements while rejecting stale queued effects; unrelated refinements do not require reissuing handles. Native shared admission runs inside the original guard's TaskStore transaction. No new model is started. See CANONICAL-PLAN-CONTINUITY.md for architecture, evidence boundaries, tests and limitations.

Next work remains new trustworthy adapters, a verifiable native Codex/Mistral transport boundary, explicit cross-principal migration if authorized, and reviewed import of legacy outcomes. Native exact-payload repeat restrictions remain independent. Deployment and client-catalog refresh are still unperformed.

## Acceptance and release checks

Exercise concurrent tasks under one grant, changed saved-plan revisions at admission and immediately before dispatch, edits during pending UNKNOWN effects, preserved completed evidence, deliberate repeat identity, distinct outcomes versus duplicate issuer receipts, native/direct claim contention and read-only recovery. Verify helper model changes cannot bypass transport protection and that ordinary unrelated tasks retain existing behavior. Measure local admission overhead separately from browser/provider latency.

The checkpoint's combined regression is 368/369 passing; the sole discovery securitySchemes assertion failure was reproduced on the clean baseline. Additional recorded passing groups include native engine/server 147/147, final measurement 72/72, transport 259/259, helpers 104/104 and focused protected paths 11/11; these overlap. Use final logs rather than earlier intermediate failures. Include the bounded transport-boundary-evidence.json summary and exclude raw protocol/catalog capture from distributable documentation and commit recommendations.

Stage 3 is implemented in the third isolated worktree and remains uncommitted pending final review. Deployment, safe installation/restart after active work settles, and client catalog refresh remain separate, unperformed release steps. Server registration alone does not refresh a cached client catalog.

The final context-focused rerun passed 68/68; see verification/context-final-focused.txt.

Stage 3 source/API/native/engine/server regression passes 188/188; see verification/canonical-source-regression.txt. Combined stage 3 regression reports 394/395 with the same known baseline discovery assertion; see verification/canonical-final-regression.txt. No deployment or catalog refresh has occurred.
