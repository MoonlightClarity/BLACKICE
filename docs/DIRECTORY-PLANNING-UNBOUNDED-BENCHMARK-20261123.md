# BLACKICE Directory without arbitrary admission caps: Planning + Directory benchmark

Date: 2026-11-23. Isolated branch `feature/directory-no-arbitrary-limits-20261123`, based on `c3ab36c6` (the search-first context fix and exact MiniCPM/Directory integration source). No application release, installation, restart, user-job mutation or provider-setting change.

## Decision

Make **Planning + Directory** the primary real long-horizon agent benchmark. The current first-party Planning implementation is `chatPlanning: 'on'`, not the retired `planningMode: 'on'` alias. Its Decomposition / Anti-Overalignment / Structured Analysis / Intent Inference modules commit action proposals into the same canonical Directory state used during execution.

Evaluate a source-frozen **factorial** comparison rather than treating a change to a single component as proof that it improves the system:

| Arm | `chatPlanning` | `directoryActions` | Question |
|---|---|---|---|
| planning-directory (primary) | on | on | Does joint planning, execution coordination and evidence recovery improve completed work? |
| planning-only | on | off | How much benefit does explicit preparation provide without Directory execution restrictions? |
| directory-only | off | on | Can Directory alone preserve progress without the Planning pass? |
| neither | off | off | What can the same model, tools and task do without either extension? |

The Planning-only arm still writes a task-scoped **planning proposal** into its underlying Directory store; it does not enable `relay_directory_action` execution enforcement. This distinction is intentional.

## Implemented cap removal

The isolated source removes host-authored hard ceilings that previously refused legitimate work at 24 actions, 8,192 receipts, 24 checklist checks/revisions, 16 qualifying rows, 8 required checks, 32 cited receipts, and finite search scopes. The hard admission gate `DIRECTORY_CAPACITY` is removed. Old receipts and unresolved-effect identities are preserved, not discarded or automatically marked successful.

Archive retrieval no longer imposes an 8,192-byte page maximum or an 8-MiB search scan cutoff; model-specified page lengths and searches can traverse exact returned archive data. Search remains streaming in bounded I/O chunks and returns byte offsets. The initial 12-KB archiving threshold is a *trigger* for externalization, not a cap on retained evidence; a 4-KB read page remains the default, **not** a maximum.

Planning's former eight-action/eight-dependency/four-alternative and first/last 32-record provider projections no longer reject or invisibly omit larger plans. Planning decision text no longer truncates at 8,000/5,500 characters, the host no longer keeps only 12 planning receipts, and the per-module default 45-second planning timeout is removed. Actual provider deadlines, user deadlines, cancellation and model-context capacity still apply.

Dependency cycle checks, blocked-action derivation, and checklist outcome rollups were changed to iterative traversals rather than recursive depth-capped methods. A task with 70 dependent actions, deep checklist rollups, an 8,193-receipt reopened ledger, archive text beyond 8 MiB, and a 32-KB source read are covered by deterministic tests.

## Verification and benchmark fairness

- **340 Directory/Planning regression tests across 43 files passed**, 0 failures, before the final separate planning-timeout adjustment.
- **25 focused tests passed**, 0 failures, after that adjustment.
- The 21-test independent gold solution for the difficult two-module event-replay coding task passed **21/21**. This proves benchmark fixture solvability, not candidate model success.
- A new scorer separates complete workflow success (host run completed **and** every hidden acceptance test passed), code-only correctness, planning pass activity, Directory outcomes, tool calls, source hashes and infrastructure-invalid trials. Never treat an incomplete run, user-facing claim, or partial test pass as a full success.
- The benchmark runner accepts `--arm=planning-directory|planning-only|directory-only|neither`, `--variant=control|candidate`, `--case=event-replay|async-cache|stream-scheduler`, and an explicitly verified subscription or free model ID.
- The candidate's source revision and each task's hidden-test fixture SHA-256 are recorded. Score only comparable same-model/task/source trials; do not pool different source revisions. Randomize arm order and repeat independent trials before population-level conclusions.

Example commands, from this isolated worktree:

```powershell
node scripts/benchmark-directory-live.mjs --case=event-replay --verify-gold --arm=planning-directory --model=gpt-6-luna
node scripts/benchmark-directory-live.mjs --case=event-replay --variant=candidate --arm=planning-directory --model=gpt-6-luna
node scripts/benchmark-directory-live.mjs --case=event-replay --variant=candidate --arm=planning-only --model=gpt-6-luna
node scripts/benchmark-directory-live.mjs --case=event-replay --variant=candidate --arm=directory-only --model=gpt-6-luna
node scripts/benchmark-directory-live.mjs --case=event-replay --variant=candidate --arm=neither --model=gpt-6-luna
node scripts/score-directory-planning-benchmark.mjs --model=gpt-6-luna --case=event-replay
```

All coding tasks execute against clean temporary projects with real workspace tools; acceptance checks are independent and hidden until grading. A run that cannot obtain model access, is cut off by a benchmark wall budget, or fails due infrastructure must not be counted as model failure. Benchmark time budgets are diagnostic censoring boundaries, not user/task policy or production step limits.

## Current limits and non-claims

- **This is not an infinite-context model.** Provider context windows and output budgets are real. A requested archive read could exceed the recipient's available context; dynamic per-provider delivery sizing is a separate integration gate. A default 4-KB source page is not a hard limit.
- **The durable ledger is not yet append-only/out-of-core.** Complete Directory JSON snapshots are still copied and serialized. A very large number of receipts may become costly in CPU, RAM and disk traffic. That is a throughput issue to profile and redesign, not grounds for silently discarding evidence or refusing a task at a fixed number.
- **Planning is still a finite collection of four preparation modules,** rather than an autonomous ongoing planner. The modules themselves cannot have their own hidden task-count cap.
- The Native/compatible provider API and tools retain real protocol constraints, actual file/memory availability, task cancellation, authorization boundaries and explicit user deadlines. Removal of arbitrary numeric ceilings must never imply permission to replay uncertain external effects.
- The deterministic tests, even when substantial, do not prove that real models succeed more often. Until independent matched real-model trials finish, claims of an end-to-end Planning + Directory advantage remain **unproven**.
- No live consumer release has been installed or activated from this experimental source. The older production integration and MiniCPM branches remain preserved.
