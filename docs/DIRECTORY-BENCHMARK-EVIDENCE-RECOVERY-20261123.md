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
