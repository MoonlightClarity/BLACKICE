# Time management: depth versus throughput

Status: Implementation candidate. Infrastructure-tested; behavioral efficacy not yet established.

Time management is an independent Planning module, not anti-overalignment, autonomy, model reasoning effort, or a job-search preset.

- New unconfigured tasks enable it. Missing time-management fields in older defaults adopt On for new admissions, including fresh chats inheriting those defaults; explicit On/Off and other module choices are preserved. Normalization does not mutate historical input objects or rewrite saved settings files. An explicit overall Planning Off still disables Planning modules.
- Calibration begins in the original provider instructions before optional work, with no separate model pass. Ordinary user directions (quick, comprehensive, high-volume, carefully checked) steer the approach; no mandatory configuration dialog.
- The model allocates effort to the useful outcome, explicit constraints, uncertainty, reversibility and delay cost. It adapts as evidence changes, not according to a permanent fast/slow label.
- Host elapsed and tool-duration observations measure the current coordinator node execution from wrapper construction, not the task lifetime or previous turns. A resumed execution starts a fresh observation window. Delegated child workers inherit initial module guidance but do not receive separate timing telemetry in this implementation. Observations are appended to an existing tool result at most once per 30 seconds. This is a reporting interval, not a time budget, timeout or action limit. No telemetry is added when disabled. Failures and effects remain unchanged.
- Host cost observations are not outcome evidence. They are kept outside original receipt journaling and do not alter review freshness/progress keys. Parallel tool durations can overlap; their sum is not exclusive wall time.
- When outcome review is already enabled, it receives the same effort guidance and current observed costs. This module alone does not enable a reviewer, repeat actions, skip required verification or accept a premature final.
- No SOUL changes, browser gates, permission expansion, model/effort switching, live profile mutation or automatic deadline.

## Existing controls and what this adds

Model reasoning effort controls provider deliberation, not which opportunities to screen or whether another comparison is worth doing. Goal and autonomy settings govern objectives and continuation, not depth. Directory changes evidence delivery, not the desired tradeoff. Anti-overalignment addresses invented obstacles and excess deference, but a non-refusing agent can still waste time. Outcome review can recover a premature final, but repeated early finals may themselves dominate elapsed time. Time management addresses the allocation problem at task start and throughout the work. It does not claim to fix provider premature-final behavior.

## Evaluation before claiming improvement

Infrastructure tests establish routing, preservation and lack of extra calls, not model efficacy. No live job applications are needed to test the implementation.

Use matched, isolated replay environments with identical task, model, reasoning effort, tools, filters, evidence and seed conditions. Randomize arm order and repeat cases; report all attempts, including zero-output failures. Keep user constraints identical in every arm.

Compare:
1. Module Off with current behavior.
2. Module On with task-adaptive judgment.
3. For repeatable opportunity tasks, a simple filter-only baseline: process eligible items in fixed or seeded-random order with minimum effect verification and no optional fit scoring.

Include job-search fixtures, a bounded fact lookup, editing a document, a multi-item data cleanup, and a high-cost irreversible-action simulation. Include fast and slow tools, uncertain duplicate effects, new evidence requiring deeper checks, user steering changes, and a narrow blocked branch with independent work available.

Primary measures: verified useful outcomes per elapsed minute and time to first useful outcome. Also record explicit-filter violations, fabricated claims, duplicate effects, necessary correctness failures, rework, token/cost, optional screening/review time, premature finals, interruptions, and residual uncertainty. Tool counts, promises and reviewer-approved prose do not count as outcomes. In high-cost cases, prioritize correctness and avoided material rework rather than raw action volume.

Accept improvement only when useful outcomes improve without losing explicit constraints or material correctness. Do not attribute gains from a newer browser fix, evidence paging, changed SOUL, altered model, or relaxed filters to this module. Compare anti-overalignment On/Off separately. If results do not beat the simple baseline, simplify rather than add more analysis.
