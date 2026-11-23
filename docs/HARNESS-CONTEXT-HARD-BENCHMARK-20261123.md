# BLACKICE harness/context continuation and harder coding benchmark

**Date:** 2026-11-23
**Branch:** feature/context-harness-reliability-20261123
**Base:** experimental paged-ledger commit 9a89ea1654107c4feac1c3abc3e29d18977e7fa5
**Control:** unchanged BLACKICE 2.40.75 commit 3fc873c8394fb8381456c305cd91068ce9b98eac
**Scope:** isolated Git worktree. No install, main-branch mutation, release or merge.

## Implementation improvements

1. External paging now applies to new ordinary **Chat** executions, not only Action Directory On. The host stores large read-only tool results under task-specific references and provides search/read access; small results and failed tool effects remain unchanged. Existing native sessions whose immutable tool catalogs lack the new tool are not silently modified.
2. New host-owned workspace mutability guidance distinguishes attached BLACKICE file tools from assumptions about a native-model sandbox. This addressed a candidate run that claimed file writes were prohibited without attempting a write, even though the host had admitted the write tool.
3. Directory tool schema descriptions and pre-dispatch argument failures provide an exact minimal plan example. Failed plans remain failed, do not mutate state, and never authorize tool effects.
4. Archived workspace reads include an explicit **sourceContinuation** when the original source reader reported truncation. This points to the next source line, not just the previously returned bytes retained in the archive. The archive is not falsely described as having unseen source content.
5. Workspace tool instructions now distinguish successful public tests from full correctness on every stated requirement; targeted edge-case checking is advised proportionately rather than required ritual.
6. A successful workspace test command can produce one targeted **provider-only** Directory finalization prompt per action, with the exact returned receipt and command. It does not mark the action complete, authorize repeat effects, or claim that hidden tests passed. If evidence is only partial, the model must continue verification or report partial progress.

## New harder benchmark

Previous synthetic coding cases had 9 and 7 acceptance tests. The new **event-replay** benchmark has 21 tests across two interacting modules:

- EventLedger: stream-local identity, event deduplication, optimistic versions, immutable returned/stored payloads, exclusive paginated reads and invalid-argument rejection.
- StreamProcessor: ordered per-stream asynchronous execution, concurrency across streams, concurrent duplicate suppression, retry after callback failures, invalid-call protection and copy isolation.
- A 600-event incident log contains noisy hypotheses, with a decisive diagnosis near the end.
- Agents receive public tests and specifications; hidden tests are only run after the coding trial. Source and test fixtures are identical across control and candidate trials.

The independently supplied gold/reference implementation passed **21/21**. The benchmark is solvable. No broken fixture was included as a scored failure.

## Native gpt-6-luna results

The model used was **gpt-6-luna** through the authenticated native Codex app-server integration, not a paid API key. All listed attempts returned actual tool results and completed the grader; there were no provider outages in these event-replay trials.

| Trial | Code checks passed | Workflow | Tool calls | Time | Observation |
|---|---:|---|---:|---:|---|
| Unmodified control trial 1 | 19/21 | Failed: Directory action remained active | 19 | 61 s | Corrected most bugs but omitted two validation paths |
| Candidate before host-write guidance | 6/21 | Completed as blocked | 13 | 26.8 s | Claimed environment was read-only without attempting a write |
| Candidate after host-write guidance | 19/21 | Completed | 23 | 52.3 s | Made and tested code edits |
| Unmodified control trial 2 | 6/21 | Failed: Directory action remained active | 22 | 41.7 s | Invalid focus/plan calls blocked substantive work |
| Candidate with source continuation and edge-check guidance | 19/21 | Completed | 22 | 54.1 s | Still relied mainly on passing public checks |
| Candidate with receipt-based test finalization | 19/21 | Completed | 27 | 54 s | Finished workflow after targeted verified-test handoff |

The two hidden failures in all 19/21 runs were **rejection of invalid read cursors** and **preventing invalid events from reaching the apply callback**. Both conditions were explicitly stated in the task. They are coding-coverage gaps, not infrastructure failures or unreasonable graders.

**Full benchmark passes: zero in these trials.** Neither variant can be reported as having solved the complete 21-test benchmark. Shorter duration alone is not a win. Variability on the identical unmodified control (19/21 vs 6/21) is substantial; the number of trials is too small for a confident population-level performance comparison. Treat the recovered write behavior and workflow-closure improvements as observed harness behavior, not proven general model success gains.

The independent scorer preserves all raw results, distinguishes revisions by the Engine/workspace/context/fixture SHA-256s, separates code correctness from workflow closure and excludes infrastructure-invalid attempts. The native model score is stored as a JSON report in the external benchmark-results directory.

## Tests and prior long-context infrastructure

The preceding paged-ledger branch already demonstrated a 1,000-read scripted Engine/Directory test that the immutable control cannot complete: the control stops at 256 receipts, while the feature preserves more than 1,000 receipts and original evidence. The branch also deduplicates repeated archived outputs.

This iteration passed focused integration tests for ordinary Chat paging, exact source continuation, malformed plan recovery, legitimate host-write capability messaging and verified local-test receipts. Broader Directory/workspace regressions: **318 tests across 38 files, zero failures**.

The scripted 1,000-read test was repeated on this final harness revision and passed: the control again stopped at **256 reads** with DIRECTORY_CAPACITY, while the candidate completed **1,000 reads, 1,015 calls and 1,011 retained receipts** with successful code repair, verification and archived evidence recovery. The candidate kept four archive files; model-facing tool text was approximately **1.79 MB** versus **5.03 MB** on the truncated control attempt. This test checks host execution capacity and exact evidence retention. It is not a 1,000-step closed-model reasoning benchmark. The extended receipt ledger still has a finite 8,192-receipt bound and saves full JSON snapshots rather than an append-only store.

## Fairness and stop conditions

Benchmark setup, grader or provider errors are infrastructure-invalid and must be fixed and rerun, not counted as model failures. A model failing to perform an authorized action or missing explicit required behaviors is a valid task outcome and must remain in the score. A full pass requires every acceptance test and a completed workflow; public tests alone do not qualify.

The requested difficulty increase was applied: 21 tests and two modules instead of 9/7. Because neither version fully passed the new fixture, further escalation is not yet justified by the user's conditional instruction. A future harder fixture should preserve the same source/task/limit parity and independent gold validation.

## Next implementation priorities

- Improve long-horizon evidence selection so agents use next-source-page cues rather than concluding that a truncated first observation establishes completeness.
- Improve agent testing against explicit non-public requirements without overfitting to hidden tests, adding user review gates, or spending most turns on bookkeeping.
- Bound Directory/workflow correction loops while preserving unknown external effects. The one-per-action successful-test hint remains strictly advisory.
- Profile ledger snapshot rewrite cost, artifact lifecycle/cleanup and native provider context reconstruction under larger real workloads.

## Reproduce

From the isolated branch, with the unmodified 2.40.75 control worktree available:

    node scripts/benchmark-directory-live.mjs --case=event-replay --verify-gold
    node --test --test-concurrency=4 tests/*directory*.test.mjs
    node scripts/benchmark-directory-stress.mjs --reads=1000 --expect-control-capacity
    node scripts/score-event-replay-benchmark.mjs --model=gpt-6-luna

On Windows PowerShell, expand the test file wildcard to exact filenames if necessary. For a new live model trial, use --case=event-replay, --variant=control or --variant=candidate, and --model=gpt-6-luna. Each trial creates a clean temporary source copy and saves the model run/grade/solution separately. Do not reuse another variant's solution.

**Raw evidence and scores:**
C:\Users\user\Documents\Codex\BLACKICE-context-benchmark-results-20261123

This branch is **experimental and not release-ready**. It has not been installed or merged.
