# Planning and Directory: benchmark trade-offs

## Product decision

Planning modules and Directory are opt-in. A module may be useful on a particular task without earning default-on status. Keep it on by default only after repeated benefit at low incremental cost across relevant tasks. Missing evidence means opt-in, not useless. Remove a recommended module or preset that has no identified use case; do not delete a capability merely because it was not exercised in one benchmark.

Consider verified quality, wall time, tokens, model turns, retries and useful work forgone together. Additional reasoning is not automatically better reasoning. All-on results cannot establish which individual method helped or hurt.

## Existing evidence and limits

Prior development ledger trials were small and heterogeneous across source revisions. All-on configurations sometimes lost quality and added cost. Directory sometimes helped repair real defects, but also introduced substantial overhead and reviewer mistakes. An earlier frozen baseline score missed a receipt defect; a later lookup-exception expectation had ambiguous scope relative to the original API. Preserve those limitations rather than silently changing scores or treating one grader as definitive.

The latest isolated reconciliation candidate preserved receipt/replay contracts and demonstrated report-only revision followed by fresh review without replaying task effects. Its frozen ledger result remained 9/10 because an unknown-account lookup retained the old return behavior rather than throwing. These observations support narrowly tested mechanisms, not universal quality superiority or a default-on recommendation.

## Harder-task comparison protocol

The 2.39.77 matched evidence task produced 12/12 functional coverage and 76/100 quality with intent inference + outcome verification + Directory, versus 1/12 and 0/100 direct. Recorded costs were 295.907 seconds and about 2.625 million tokens versus 30.847 seconds and 223,746 tokens. This supports a selective use case, not general default-on consistency. These results do not validate later 2.39.79 behavior. Root-cause fixes and matched retesting remain necessary before pruning decisions.

For further comparisons, use this protocol rather than treating the initial design as an unbounded benchmark queue. The benchmark owner selects and freezes two harder, distinct tasks, their input workspaces and independent graders before admission. For each task compare:

1. Direct baseline: all selectable Planning modules Off; Directory Off.
2. Sparse Planning: one or two task-justified modules; Directory Off.
3. The identical sparse selection with Directory On.

This is six initial trials, not a combinatorial all-on batch. Up to four paired repetitions or targeted ablations may follow only when they can resolve a concrete product decision; they are not automatic. Record the task-specific rationale for sparse selection before seeing results.

Hold runtime/source revision, model and effort fixed within each comparison. Record the exact tested version rather than mixing results from 2.39.76, 2.39.77 and later revisions as if they were equivalent. Use pristine workspaces and fresh contexts, reconcile existing admissions before starting a trial, and retain source/runtime fingerprints. Freeze graders before admission and keep prior findings, hidden tests and candidate rationale out of worker input. Never mutate the worker implementation to satisfy one ambiguous benchmark expectation. A clarified contract starts a separately labeled benchmark stratum.

## Record each trial

- Verified functional coverage and overall artifact correctness, including unexpected regressions.
- Native completion separately from artifact completion and independent grading.
- Wall time, model calls/turns, token counts, and cached/uncached tokens when exposed. Mark unavailable measurements, do not estimate them as facts.
- Unnecessary task replay, false blockers, invented constraints, and repair loops.
- Setup/maintenance failures separately from model behavior; do not erase valid unfavorable runs.

Run timing comparisons without concurrent suites or unrelated benchmark load. No arbitrary total elapsed cutoff: observe meaningful source/tool progress, not metadata churn, and stop demonstrated nonprogress loops. Save the reason and evidence for a stop.

## Decide, do not just rank

Choose the simplest configuration that reliably serves the task. A small quality gain at large latency/token cost may be appropriate for high-value complex work but poor as a general default. Consistency needs paired repeats and task diversity, not repeated tuning of one ledger. Prune a preset or module recommendation when no distinct use case survives this comparison, while documenting uncertainty and retaining reversible choices.

Publish verified aggregate findings and measurement definitions when available. Do not publish local workspace paths, private task material or unsupported claims of causal improvement.
