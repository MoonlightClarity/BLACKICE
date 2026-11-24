# Directory real-benchmark evidence recovery — 2026-11-23

Branch: `fix/directory-benchmark-evidence-recovery-20261123`. Base: `189ae626b2f9ac12a4b7f0c36e45c3b6f5c0766f` (isolated no-arbitrary-limits Planning + Directory candidate). No production release, installer, provider settings or user tasks changed.

## What the first genuine four-arm benchmark established

Under exact frozen source and an authenticated native `gpt-6-luna`, the independent 21-test event-replay fixture was solved fully by none of the four arms. The first trial's outcomes were:
- Planning + Directory: 18/21 hidden tests, 21 tool calls, run **failed**, repair focused but not closed; verification pending.
- Planning alone: 19/21, 11 calls, run completed but hidden grade failed.
- Directory alone: 6/21, 13 calls, 7 hidden tests cancelled, run completed but source not repaired.
- Neither: 19/21, 13 calls, run completed but hidden grade failed.

This is only **one stochastic sample per arm**. The gold solution independently passes 21/21. The raw score and trace files are preserved in `BLACKICE-context-benchmark-results-20261123`.

## Exact coordination defects

**Misattributed prior effects:** The combined run successfully wrote `src/ledger.mjs` and `src/processor.mjs` while the `inspect_project` action was still focused. The inspection was later marked observed citing receipts `4,5,6,12` — **not** the repair write receipts `10,11`. When it focused `repair` and cited those two returned write receipts, Directory rejected both as assigned to the earlier action. The agent then declared that the repair could not be evidenced, despite existing actual returned effect receipts. Replaying the writes would be inefficient and potentially harmful.

**Unsupported stop:** In Directory-only, the agent claimed the workspace was read-only and blocked inspection with `no-viable-route` **without any failed write or patch attempt**. The benchmark permitted writes. That assertion ended the agent's attempt while repair and verification remained undone.

## Isolated repair

1. A successful returned effect from the same run/node that was recorded under an earlier **closed** action can be explicitly linked **once** as evidence for the newly focused action, provided the original action has not already cited it in its completed observation or notes. The original `receipt.actionId`, `runId`, `nodeId`, `success`, and returned state remain unchanged. The second action records the link through `linkedByActionId`; no tool action is replayed. Wrong-run, wrong-node, failed, unresolved, already-used and observation-only prior receipts remain ineligible.
2. An agent cannot mark the whole action `no-viable-route` without a returned, unsuccessful tool receipt eligible for that action. Human steering semantics are unchanged. An unsupported assumption that the workspace is read-only does not silently become a terminal blocker. The error directs the model to attempt the authorized work or an actual alternative; it does not fabricate success.
3. All existing evidence validation and resume checks were retained, extending restore validation to cover the new cross-action link form. The prior standalone tests that expected unsupported blockers were changed to exercise an actual failed source attempt before accepting a blocker.

**Deterministic verification:** 343/343 Directory/Planning tests in 44 files pass. The new fixture validates unverified blocker rejection and accepted failed-receipt blockers, one-time cross-action links with original attribution preserved across reload, and wrong-run/wrong-node/failed/already-used receipt rejection. These are deterministic host-correctness tests, not evidence that the model will select better actions.

## Real-model validation plan

Run the same 21-test event-replay fixture from this exact source commit with all four arms. Preserve same task, source hash, hidden tests, model and native provider; use independent temporary workspaces. Score **full workflow completion AND 21/21 hidden tests** as the only complete success. Use action receipts, tool errors, ignored tool arguments, test failures and model-imposed false blockers as diagnostics. Do not infer a general performance improvement from one re-run.

If this fix removes the prior observed coordination failure, the next benchmark should involve multiple dependent code fixes and later retrieval of a long log, rather than assuming a short three-action coding exercise measures long-horizon planning.

## First isolated native recheck and concurrent-admission defect

The source-matched `gpt-6-luna` native recheck of the prior fix (commit `455081d0`) gave a valid Directory-only run that reached 19/21 hidden tests with real source writes and an observed repair action, versus the earlier single Directory-only run's 6/21. It is **not** a full pass and cannot establish a causal success rate from one stochastic sample. Raw file: `BLACKICE-directory-recovery-results-20261123/event-replay-candidate-directory-only-3c439ada.json`.

The same-source Planning + Directory recheck still failed, with only 9/21 tests passing (5 failed, 7 cancelled); inspection was observed, repair active, verification pending. Raw file: `event-replay-candidate-planning-directory-a8f19aba.json`.

**New precise root cause:** The Planning + Directory model issued two different `relay_workspace write` calls targeting `src/ledger.mjs` and `src/processor.mjs` in the *same millisecond* (`1795438280492`). The first write was reserved and dispatched; the second was rejected as `DIRECTORY_UNKNOWN` before its handler ran. The first result subsequently returned successfully. Directory incorrectly treated a pending actively dispatched effect as an unresolved historical attempt, even though the second target was independent.

A blanket queue of all same-action effects was tested and **discarded**: it deadlocked fixtures with parallel browser/form coordination. It was never committed, installed or shipped.

The revised approach tracks current active effect reservations **only in memory** and permits concurrent `relay_workspace write/patch` actions whose lexical normalized targets are different and of the same path kind, within the **same run and node**. It does not change or weaken persisted unknown-result receipts, and it does not permit same-target aliases (including Win32 case and slash variations), different model/runtime scopes, opaque browser effects or unknown tool kinds to bypass the uncertainty guard. The active reservation is removed on all normal, failure, and cancellation paths. This retains independently useful concurrency rather than imposing an artificial all-task serialization bottleneck.

The revised combined suite passed **350/350** Directory/Planning regression tests across **48 files**. Dedicated tests verify two simultaneous disjoint writes both dispatch, same-target overlapping calls are denied, genuine post-dispatch uncertainty remains protected, observation-only reads proceed independently, and Win32 path aliases are not misclassified as distinct.

An end-to-end compatible-provider Engine replay with **Planning + Directory enabled** sent two distinct workspace writes in one model tool-call message. Both writes settled once, both exact receipts were returned, the repair action was observed, and the run completed. This is deterministic execution-path evidence, not a genuine native-model capability trial.

**Not yet claimed:** the revised in-flight classification has not been qualified by a new native-model run at the moment of this checkpoint. It is not a proof that an entire long-horizon coding task succeeds. The next benchmark should use this exact frozen source and preserve independent acceptance evidence.
