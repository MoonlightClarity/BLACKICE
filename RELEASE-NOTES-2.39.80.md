# BLACKICE 2.39.80

## Recovery and visible efficiency feedback
- Outcome review steers a changed strategy before repeated no-progress final candidates end a task. A yellow efficiency warning makes that recovery attempt visible; continued failure remains bounded.
- Review evidence, per-node state, and duplicate accounting are preserved. This is a tested recovery mechanism, not proof that every model will recover successfully.

## Historical-job startup indexing
- Startup builds resource indexes in bulk after validating and loading all receipts rather than repeatedly sorting each insertion. Normal incremental admission remains ordered.
- All history, validation, fail-closed handling, and recovery behavior remain intact. A controlled 60,000-receipt disk comparison improved modestly (about 6% mean); the larger in-memory gain does not establish that the full installed startup delay is resolved.

## Scope and verification
- Planning and Directory defaults remain unchanged in this incremental release. A separate proposed defaults update is held for deeper integration testing; no module was pruned.
- Synthetic UI tests exercise recovery warning delivery, per-node visibility, and clearing. Focused tests cover recovery/control paths and preserved receipt validation.
- Native model recovery efficacy, broad quality improvements, and complete startup-latency elimination are not claimed. Exact combined source-suite, installer, and installed-runtime verification are separate release gates.
