# Adaptive context paging — controlled coding and long-horizon evaluation

Date: 2026-11-23

Branch: feature/adaptive-context-paging-20261123 (isolated).
Base: 8486164486e21634600ea79190ae40a4a0c0b470 (prior verification-coverage and paging ablation).
Frozen implementation commit: f18c98e314b590c22e0cc3a8823cd244184791bf.
Reference control: unmodified BLACKICE 2.40.75 commit 3fc873c8394fb8381456c305cd91068ce9b98eac.

No install, release, merge, restart, paid API use, or modification to the control/main worktree occurred.

## Reason for the implementation

The previous same-harness Directory-off benchmark found that *eager* external paging of individual tool results did not improve task-solving on a short coding task. It could archive important context even when the model did not need paging, forcing the model to request the full original if it chose to do so. The two prior eager trials made no such retrieval calls.

BLACKICE now supports adaptive paging as its experimental default for **new** harness conversations:

- Successful read-only tool text is normally retained directly while a bounded visible-output allowance remains.
- A result exceeding 64 KiB is paged immediately; other results above 12,000 bytes are paged once accumulated visible output would exceed 96 KiB.
- Smaller observations remain intact but count toward the total. Archived results include exact task-scoped references, bounded head/tail previews, source-continuation metadata, literal search and byte-accurate page reads.
- Concurrent calls reserve space against the visible budget before asynchronous archival. If disk archival fails, the original result is returned and its visible bytes are counted, so nothing is silently lost.
- Task-scoped deduplication still prevents repeated results from multiplying archives.
- The Engine exposes explicit experimental eager and off settings so comparisons can keep the same source revision. New native sessions get the selected policy; resumed tool catalogs are not retroactively changed. Constrained benchmark profiles retain their established tool catalog.

**The 96-KiB allowance is a heuristic for returned tool text, not provider token accounting or a measurement of the model's remaining context.** This implementation does not reconstruct native provider context, remove previously delivered messages, or implement automatic out-of-core rollover of an entire conversation.

## Functional evidence

A real Engine integration test delivered 12 repeated large read-only observations. The default adaptive policy kept the **first four** responses inline (initial result: 20,537 UTF-8 bytes each), then archived the next **eight**; the tool recovered the exact source marker. Existing eager-mode integration tests continued to pass.

Additional tests exercise cumulative pressure, mandatory paging for a single large result, short-result budget charging, archival failure, concurrent tool callbacks reserving budget, task isolation, and reopening saved artifacts. Earlier Unicode/binary-offset search, deduplication and corruption tests also pass.

Regression selection: **338 passed, 0 failed, 0 skipped, across 45 test files.**
Raw test log: adaptive-regression-20261123.tap in the external results directory.

### Model-free 1,000-read stress

The deterministic Engine/Directory coding fixture requested 1,000 large reads, exact evidence recovery, a code repair and passing test, and Directory finalization.

| Observation | Unmodified control | Adaptive candidate |
|---|---|---|
| Requested large reads | 1,000 | 1,000 |
| Completed large reads | 256 | **1,000** |
| Tool calls | 257 | **1,015** |
| Host Directory receipts | 256 | **1,011** |
| Completed source repair + tests | No; blocked by DIRECTORY_CAPACITY | **Yes** |
| Archive files | None | **4, deduplicated** |
| Returned model-facing tool text | 5,029,548 bytes (partial run) | 1,884,459 bytes (full run) |

Do **not** compare those text totals as an equal-workload saving: the control stopped early. The full candidate run confirms paging and full host receipt retention after the original control's 256-receipt boundary.

An initial adaptive stress run completed the tool sequence but failed its finalization assertion because the scripted mock did not consume the newer one-time verification review. The driver was corrected to handle that specific provider-only continuation once; the real 1,000-read run then completed. The original driver-mismatch output was preserved separately rather than counted as a model-quality failure.

## Native closed-source coding benchmark

Model: gpt-6-luna through authenticated ChatGPT/Codex app-server (not a paid API key). Directory: off for all arms. The same candidate Engine revision, coding fixture, model configuration and test grader were used, changing only the paging policy. Runs were sequential, with the second set in a different arm order.

The event-replay challenge requires repairing two interacting JavaScript modules for concurrent stream processing, idempotency, optimistic version checks, copy isolation, invalid inputs, failure retries and exclusive cursor reads. It includes a long incident trace. The independent reference implementation passes **21/21** public and hidden checks.

| Trial | Paging off | Eager paging | Adaptive paging |
|---|---|---|---|
| 1 tests | 0/21 (generated invalid regular expression; source failed to load) | 19/21 | 19/21 |
| 1 calls / time | 15 / 31.7 s | 12 / 27.4 s | 11 / 25.3 s |
| 2 tests | 18/21 | 18/21 | 19/21 |
| 2 calls / time | 9 / 34.6 s | 10 / 27.2 s | 10 / 26.1 s |
| Mean checks passed | 9/21 | 18.5/21 | **19/21** |
| Mean calls | 12 | 11 | **10.5** |
| Mean elapsed | 33.2 s | 27.3 s | **25.7 s** |
| Complete task successes | **0/2** | **0/2** | **0/2** |

A model-authored source syntax error is a valid coding failure, not a failed benchmark harness. The independent gold grader passed 21/21. In that run, Node reported only two file-level failures because the source module could not be imported; the scorer retains **0/21 expected checks passed** and identifies the source-load failure rather than incorrectly excluding the trial as an infrastructure error.

Both adaptive runs kept all useful responses in context and created **zero archives**. Both eager runs archived one result and the model made **zero retrieval calls**. Adaptive therefore avoided an unnecessary intervention in this particular workload.

The two-triplet sample is very small and the native model is stochastic. It establishes no population-level success-rate improvement. The off-arm source syntax error disproportionately affects the averages. **No arm achieved a complete solution.** Partial test counts and reduced latency are diagnostics, not evidence of complete benchmark superiority.

## Correct scoring and opportunity-cost conclusion

- Context paging works mechanically and the adaptive policy prevents premature archival during small tasks.
- The larger scripted task can preserve evidence and proceed beyond the original Directory capacity boundary, with the same model-facing retrieval capability.
- This specific coding benchmark does **not** demonstrate that paging improves complete task success. It also does not exercise model reasoning near a native context-window limit.
- The implementation remains attractive because it can retain the simpler direct-observation path when paging is unnecessary, while activating recovery when tool output grows.
- The remaining high-value work is provider-aware native context reconstruction; better targeted verification against explicit requirements; long-lived archive retention and cleanup; and efficient append-only host receipts instead of full-JSON snapshot rewrites.
- The previous requirement to increase benchmark difficulty **if both fully passed** was not met. Difficulty remains 21 independently verified checks; falsely escalating after 0/2 complete-task successes would conceal the current gap.

This branch should remain an isolated experiment. Do not merge, install or release based solely on these results.

## Reproducibility

The experimental source supports these policy settings for a new Engine run: adaptive (default), eager, and disabled. The benchmark driver accepts --paging=adaptive, --paging=eager (or --paging=on), and --paging=off, as well as --directory=off.

Run from this exact worktree:

    node --test --test-reporter=spec tests/task-external-context-adaptive.test.mjs tests/adaptive-context-engine.test.mjs
    node scripts/benchmark-directory-stress.mjs --reads=1000 --expect-control-capacity
    node scripts/benchmark-directory-live.mjs --case=event-replay --verify-gold
    node scripts/benchmark-directory-live.mjs --variant=candidate --case=event-replay --model=gpt-6-luna --directory=off --paging=off
    node scripts/benchmark-directory-live.mjs --variant=candidate --case=event-replay --model=gpt-6-luna --directory=off --paging=eager
    node scripts/benchmark-directory-live.mjs --variant=candidate --case=event-replay --model=gpt-6-luna --directory=off --paging=adaptive
    node scripts/score-adaptive-context-benchmark.mjs --model=gpt-6-luna

Raw receipts, complete trial reports, source snapshots and independent score:
C:\Users\user\Documents\Codex\BLACKICE-context-benchmark-results-20261123

Primary score file: score-adaptive-context-20261123.json
