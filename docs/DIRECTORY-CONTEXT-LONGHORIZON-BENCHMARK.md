# Directory external context: long-horizon benchmark (2026-11-23)

**Experiment source:** BLACKICE 2.40.75 feature branch feature/directory-external-context-20261122, implementation commit b49913517b409338cfe93ce0d450a710c34949d3.

**Control source:** exact 2.40.75 commit 3fc873c8394fb8381456c305cd91068ce9b98eac, in a separate detached Git worktree.

**Scope:** isolated evaluation, no install, release, merge, or change to main. All coding tasks and logs were synthetic. No paid API models were used.

## Validity and fairness rules

- Fix reproducible benchmark-driver defects; rerun from original clean task fixtures; exclude invalid attempts. Provider unavailability, exhausted free allowance, broken grading and incomplete provider output are not coding failures.
- Primary coding success requires an agent-completed run and every acceptance test passing. Test counts are diagnostic, not partial successes.
- Verify every fixture with an independently supplied passing reference solution.
- Compare identical task source, hidden checks, fixed model ID, output budget, workspace abilities and execution limits. The candidate intentionally adds a retrieval tool, whose calls count against it.
- Do not combine unpaired trials into a win rate. Score the first eligible trial per variant/task. Preserve original reports, including erroneous raw validity flags, and use the independent scorer's corrected classification.
- A single stochastic paired trial is not statistically sufficient to claim a general improvement.

The live model was **kilo_free::nvidia/nemotron-3.5-lightning:free**, an API-accessed free model listed in the live Kilo catalog. This does not establish results for all closed-source models.

## Coding task outcomes

The gold reference solutions passed the full acceptance suites: **async cache 9/9** and **dependency scheduler 7/7**.

| Task | Unmodified 2.40.75 control | Context-paging candidate | Comparison |
|---|---|---|---|
| Async cache: TTL, LRU, in-flight deduplication, rejected load retry, stale invalidation | 5/9 tests; 25 calls; 103.2 s; Directory unfinished | 6/9 tests; 28 calls; 51.5 s; agent run completed | Valid pair, neither solved the whole task |
| Dependency scheduler: roots, all-of prerequisites, concurrency, cycles and errors | Anonymous free-provider usage gate after one call | 4/7 tests; 22 calls; 44.4 s; agent run completed | Unpaired, no control score |

**Whole coding-task successes on valid pairs: control 0/1, candidate 0/1.** The candidate passed one additional assertion and took less wall time in the single paired task, but this is insufficient to conclude better model performance.

## Excluded attempts and fixed benchmark defects

1. An unsupported Directory diagnostics setting caused an error before a model call; corrected.
2. A stale saved free-model ID was rejected by the provider; switched to an ID verified against the live model catalog.
3. An early model trial exhausted the configured output budget; excluded, then both variants used the same increased 16,384-token reserve.
4. The initial hidden-test runner resolved source imports from the wrong relative directory; corrected, and both fixtures passed with reference solutions.
5. The free provider blocked the scheduler control after one tool call. Its initial raw JSON incorrectly reported trialValid true; the independent scorer now invalidates it. The original raw evidence remains unchanged.

These driver and provider failures are not scored as context-management failures.

## Offline 180-read, coding-and-recovery stress

A deterministic tool-using fixture exercised the real BLACKICE Engine and Directory through 180 large tool reads, expected failed-read recovery, code repair, a passing code test, evidence-based Directory completion and reopening saved context.

| Measure | Control | Candidate |
|---|---:|---:|
| Large evidence reads | 180 | 180 |
| Total tool calls | 186 | 192 |
| Model-facing tool text | 3,711,929 bytes | 325,137 bytes |
| Directory receipts | 183 | 189 |
| Code repair, test, Directory completion | Pass | Pass |
| External archive files | 0 | 360 |

The candidate used approximately **91.2% less model-facing tool text**, with six additional exact evidence-search/retrieval calls. Archive content remained retrievable after reopening the task-specific store.

**This is a harness and payload benchmark, not a model reasoning benchmark.** A scripted agent following known steps does not prove that a real language model can reason through 180 steps.

One invalid initial stress fixture assumed paging could recover text already truncated by BLACKICE's lower-level workspace reader. The fixture was corrected to place its verification marker inside the actual returned page. The new store preserves the complete returned tool text; it does not recover content omitted before that boundary.

## Known limits and decision

- Action Directory still has a **24-action, 256-receipt** capacity bound. The successful 180-read stress stays below it. Larger single-task runs need a separate ledger-scaling design.
- This feature does not rebuild native provider context, replace native compaction, or eject older messages already held in a provider session.
- The archive currently lacks a retention/cleanup lifecycle; long use could accumulate disk data.
- Retrieval calls cost model time and may be ignored or misused. No statistically credible coding task-success gain has been established.
- The second matched live coding trial could not be completed because the free provider denied access.

**Decision:** preserve this as an isolated experiment, not a release candidate. It passes meaningful long tool-loop tests and compresses model-facing outputs, but the evidence does not justify a claim that it improves real coding success. Do not merge or install solely on these results.

## Reproduce

From the feature worktree, with the immutable 2.40.75 control worktree available, run:

    node scripts/benchmark-directory-live.mjs --case=async-cache --verify-gold
    node scripts/benchmark-directory-live.mjs --case=stream-scheduler --verify-gold
    node scripts/benchmark-directory-stress.mjs
    node scripts/score-directory-context-benchmark.mjs

The scripts accept optional BLACKICE_BENCH_CONTROL_ROOT, BLACKICE_BENCH_PROVIDER_DIR and BLACKICE_BENCH_REPORT_DIR environment variables. Live model trials use the same script with a selected --variant=control or --variant=candidate, --case=..., and explicitly free --model=... provider model. Each coding trial starts with clean synthetic source. The scorer saves a reconciled score JSON alongside the unchanged raw reports.

See also the implementation experiment: DIRECTORY-EXTERNAL-CONTEXT-EXPERIMENT.md.
