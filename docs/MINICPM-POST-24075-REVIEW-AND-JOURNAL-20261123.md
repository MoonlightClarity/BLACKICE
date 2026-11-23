# MiniCPM continuation: outcome grammar, local coding, and operational journal

**Date:** 2026-11-23 (EST)
**Isolation:** `fix/minicpm-post24075-routing-20261122`, based on BLACKICE `3fc873c8` (2.40.75). The integration worktree later moved to docs-only `9b3ec8e4`; the changes below do not overwrite it.

## What was actually tested

The configured model `local_llamacpp::MiniCPM-V-4.7-1B-heretic-Q4_K_S` is served at `http://127.0.0.1:8080/v1`. An initial unqualified model name was wrongly treated as a Codex model; the earlier isolated fix `639acb20` rejects that mismatch.

A live read-only test of the llama.cpp `/v1/chat/completions` endpoint with a fully required six-field `response_format:json_schema` returned parseable JSON. The pre-fix BLACKICE reviewer, which lacked a reliably constrained output format for this local model, emitted a tool-call fragment/prose across three failed attempts and the installed Chat run ended `MODULAR_REVIEW_INVALID`/`CHAT_OUTCOME_UNREVIEWED`.

This source change recognizes strict JSON-schema output for **managed local llama.cpp on its known endpoint only**. A locally scoped ordinary reviewer uses a required-field-only wire schema without promoting optional analysis fields to required assertions. It keeps host-side `assessmentFieldErrors`, evidence citation validation, uncertainty, response repair, and the refusal to claim completion without supporting evidence. It now rejects an empty `summary` for `decision=respond`. Unknown/nonlocal compatible providers retain existing capability discovery and fallback.

A live isolated ProviderRuntime reviewer run produced one valid assessment without a format-repair loop. A second compact prompt was also valid. In both an exact source-read and a syntax-check-only evidence case, MiniCPM nevertheless returned `continue`; **structured format improved, semantic completion judgment is not qualified**. Do not reinterpret these runs as completed tasks.

The live source-writing experiment `verification/minicpm-provider-coding-smoke.mjs` confirmed the local model could invoke `save_source` and `run_tests` against disposable code. It failed task acceptance: first output used `export default` in a CommonJS file; after clearer test diagnostics, it repeatedly used `export clamp` and `Math.clip` and reached a finite tool-step limit. No end-to-end coding success is claimed. Model quality, not tool dispatch, is the remaining bottleneck in these attempts.

## Independent BLACKICE reliability issue

The full installed BLACKICE Chat coding run `8ed7519e-a2aa-41ae-9371-d6657a550e86` ended with `CHAT_OUTCOME_UNREVIEWED` and recorded two successful tool calls and three failures, including `OPERATIONAL_RECEIPTS_UNAVAILABLE` when edits were attempted. Investigation showed the shared default-workspace effects journal (not corrupt) at **8,388,331 bytes**, only **277 bytes** below its hard 8 MiB cap, containing **348 historical records, 340 unknown, 7 confirmed and 1 absent**. The journal is scoped by working directory, so long coding/job-search use accumulates multiple tasks into one file. These effects must not be silently deleted.

The isolated capacity repair changes the journal bound to **64 MiB**, retaining its existing record count bound of 10,000. It does not migrate, trim, truncate, archive, or overwrite old receipts. A regression creates a valid journal above the previous 8 MiB limit with an unresolved foreign-task effect; a new operation is recorded and reloading returns both complete identities and the preserved old contents. This addresses the immediate threshold failure; the per-operation JSON read/serialize cost may justify segmented persistence if sustained future growth warrants it. Do not replace this with lossy compaction of unknown effects.

## Tests and status

- `node --test tests/chat-outcome-review.test.mjs tests/provider-structured-output.test.mjs tests/chat-execution-review.test.mjs tests/provider-response-function.test.mjs tests/conversation-goals-direct-tool.test.mjs`: **155 passed, 0 failed** after schema and empty-summary validation.
- `node --test tests/operational-effect-guard.test.mjs`: **24 passed, 0 failed** with the over-8-MiB preservation regression.
- Consolidated nine-suite post-fix check (review, provider wire format, receipt guard, continuity, Directory, compaction): **206 passed, 0 failed**. This supersedes the separate totals above for the most recent exact-source verification.
- Prior baseline: 41/41 continuity, Directory, and compaction tests passed on integrated 2.40.75. The earlier preservation ledger documents the old branches that are already represented in integrated source.

No installed BLACKICE process, user provider configuration, existing operational journal, old MiniCPM worktree, or integration branch was modified; no release, publish, push, or restart was performed. The work in this branch requires independent integration validation before it can affect the installed app.

## Next focus

1. Do not invest in repeated identical MiniCPM coding retries without a concrete change to error consumption or tool contract. The two attempts already establish that the model calls tools but struggles with CommonJS basics and feedback.
2. After integration, validate one real local full-Chat run with operational receipt capacity available and reviewer JSON constraints enabled. Observe source/test receipts independently, not just the model's report.
3. If an ordinary shared workspace approaches the new cap or journal serialization becomes expensive, test a segmented history design that preserves unresolved effects and cross-task identities rather than silently dropping any.
