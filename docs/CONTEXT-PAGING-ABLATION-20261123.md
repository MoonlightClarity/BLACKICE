# Context paging: verified-test reuse and same-harness ablation

Date: 2026-11-23
Branch: feature/verification-coverage-20261123
Source base: ac81974f25f9050a14bff29d2a578ce795afd495
Frozen ablation source: 2a4882a3bb3db5c3c43cbd92c809bb765046c6cd
Immutable control, for the separate full-implementation comparison: 3fc873c8394fb8381456c305cd91068ce9b98eac

## Implemented harness improvements

1. A one-time, evidence-led coding verification continuation can be emitted after a host-confirmed source edit and successful public test when Directory reports the task finished. It is provider-only and **does not** mark an action complete, replay a tool effect or request a user approval. A later source edit invalidates older test evidence; the host then emits one bounded stale-test warning.
2. A returned successful, untruncated local test may be cited by a **dependent** Directory action in the same run/node. The original receipt retains its action identity; unsuccessful tests, source writes, unrelated actions, different runs/nodes, unknown effects and invalid metadata do not gain this privilege. This resolves a real native-model failure where the agent had to record a second verification action, but was prevented from citing the already-completed test and correctly avoided rerunning it.
3. An internal Engine constructor option can disable only context paging for controlled experiments. Default behavior is unchanged. Ordinary Chat with paging disabled returns the full original result and has no retrieval tool; with paging enabled, the task-scoped external store and retrieval tool are present. This is not a user-facing approval or settings control.

The extended verification and context tests passed with the existing Directory regression selection: 43 test files, **331 tests, zero failures**. A focused Engine test verifies that the same host test can close a dependent verification action without a second command.

## Native coding trial with Directory enabled

The harder synthetic event-replay challenge repairs two interacting JavaScript modules, includes 600 incident events and has 21 hidden/public acceptance tests. The separately provided reference implementation passes 21/21.

- Frozen candidate at 1e8a21d7: 19/21, 32 tool calls, 99.8 seconds, Directory completed including a dedicated edge-review action. Its two missed checks were invalid read cursors and preventing invalid events from reaching the apply callback.
- The matched unchanged 2.40.75 control: 6/21, 10 tool calls, 21.1 seconds, Directory incomplete.

These are single stochastic trials and neither fully solved the task. The larger candidate completion is encouraging but **does not prove a general advantage**; control performance has varied substantially across previous runs.

## Directory-off comparison across different implementations

One additional pair disabled Directory in both variants:

| Measure | Unmodified 2.40.75 | Updated context/harness candidate |
|---|---:|---:|
| Full workflow status | Completed | Completed |
| Acceptance tests | 18/21 | 19/21 |
| Tool calls | 11 | 11 |
| Duration | 28.5 s | 24.3 s |
| Archived outputs | 0 | 1 |

This compares entire implementations. Because the candidate contains other harness changes, the result **must not be credited to paging alone**.

## Exact same-harness paging ablation, Directory off

Both conditions used the same updated Engine, workspace tools, task fixture and native gpt-6-luna model, with paging toggled off/on. Both had full 21/21 reference-solution validation.

| Paired trial | Paging off | Paging on |
|---|---|---|
| 1 | 19/21; 11 calls; 25.9 s | 19/21; 13 calls; 28.4 s |
| 2 | 19/21; 10 calls; 23.4 s | 18/21; 9 calls; 25.1 s |
| **Mean** | **19/21; 10.5 calls; 24.7 s** | **18.5/21; 11 calls; 26.8 s** |
| Complete task success | 0/2 | 0/2 |

Paging-on archived original tool results, but made **zero** calls to the paging retrieval tool in these two trials. The feature did not demonstrate a coding success benefit, and imposed a small latency/call overhead in this very small sample. A 2-pair stochastic benchmark cannot establish a population-level effect.

The same-source ablation is more causal than the original full-implementation comparison; it is **not** a long-context exhaustion test. This challenge does not approach the model's full native context window. Eager externalization can be counterproductive when material is removed from the prompt before the model needs retrieval.

## Opportunity cost and next implementation

The next scoped change is to retain early read-only outputs in the active context until a bounded accumulated volume or a single very large result justifies archiving. This preserves the exact archival/recovery mechanism while avoiding unnecessary paging on modest tasks.

The threshold is an external-result-volume heuristic, **not** a claimed measurement of provider token usage or its exact remaining context. It must be tested against both the same-source paging-off and eager-paging baselines and retain the 1,000-read stress behavior. An architectural provider-aware context assembler remains separate future work.

Do not merge, install or release on the present evidence. The branch and control sources remain isolated; raw reports are retained.

## Reproduce

The benchmark driver accepts --variant, --case, --model, --directory and --paging. Same-harness ablation uses variant candidate, directory off and paging on versus off. This tests the intervention without changing the Engine source.

    node scripts/benchmark-directory-live.mjs --case=event-replay --verify-gold
    node scripts/benchmark-directory-live.mjs --variant=candidate --case=event-replay --model=gpt-6-luna --directory=off --paging=off
    node scripts/benchmark-directory-live.mjs --variant=candidate --case=event-replay --model=gpt-6-luna --directory=off --paging=on
    node scripts/score-context-paging-ablation.mjs --model=gpt-6-luna

The native model is accessed through authenticated ChatGPT/Codex, not a paid API key. Graders run after the task and benchmark-driver/provider failures are excluded from model failure counts.

Saved raw reports and score:
C:\Users\user\Documents\Codex\BLACKICE-context-benchmark-results-20261123\score-context-paging-ablation-20261123.json
