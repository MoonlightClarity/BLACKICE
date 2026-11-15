# BLACKICE startup tracing — independent-review corrections (2026-11-15)

## Exact source / ownership

This is a **narrow source correction awaiting independent review**, not live-capture or release approval. Original published/installed BLACKICE 2.39.98 source: 0101d3f88cc7f3f139394a1c943b899511668a90. Original frozen startup trace code/evidence: d41ed60427b1459ee79608584a4ca2c8d4534624 and fd2bbea80fb2727463edf14a2c731828da75963e. Their 19-file SHA-256 manifest remains unchanged.

Correction code commit: 2b02bb002ec36f6df7135489a8f538fae63a86e9. Isolated branch: fix/startup-critical-path-observability-20261115. Worktree: C:/Users/user/Documents/Codex/BLACKICE-startup-trace-20261115. The narrow production delta modifies only desktop/main.mjs and lib/startup-critical-trace.mjs, adding tests/startup-critical-trace-deadlines.test.mjs. Root dot owns all integration/release/build/live restart. Swarm/Skills/Deadline owners remain separate. No installed/shared/profile edits, live applications, restart, network/security changes, full suite or real submissions were made.

## Correction 1 — diagnostic I/O is non-gating

Previous desktop code awaited criticalStartupTrace.start before displaying its startup indicator and awaited criticalStartupTrace.finish before proceeding with ready/error handling. Desktop now launches those diagnostics **without awaiting them**, and catch-guards the returned promises. Showing the startup indicator and handling startup errors are not gated by diagnostics.

Within the tracer, build fingerprinting and checkpoint persistence have independent configurable deadlines (both 250ms by default, clamped to 10–2000ms). A never-resolving asynchronous build read yields a degraded source status timed_out and explicit TRACE_BUILD_TIMEOUT, without delaying the app. The worker may settle later, but its result is consumed and cannot replace timed_out with falsely verified source bytes or start the next code-file read. A never-resolving diagnostics file mkdir/open/write/sync/close/rename similarly times out with TRACE_CHECKPOINT_TIMEOUT and counters. The previous checkpoint remains authoritative; if none persisted, the trace explicitly cannot promise durable startup evidence.

There is **one underlying checkpoint writer per trace**. Deadline expiry returns to the caller but does not release the writer or start another. New attempts are counted as dropped while the old writer is pending. If finish runs during that stall, its failed/ready result is retained in memory, finalCheckpointDeferred becomes true, and it returns immediately. Only after the original writer fully settles may one terminal checkpoint follow. Late fulfilled and rejected I/O results are observed; no unhandled promise rejection or action replay is introduced. Sticky traceIo.degraded, buildTimeouts, checkpointTimeouts, finalCheckpointDeferred, explicit pendingCheckpoint in support status, and rate-limited code-only warnings expose the limitation without logging secrets or arbitrary error text.

The deadlines bound **asynchronous** unresolved promises; they cannot preempt synchronous event-loop CPU blocking. A hard crash during an uncommitted first checkpoint may leave no trace file. No execution readiness, validation, history, lease, interruption, tool authorization or production admission logic changed.

## Correction 2 — full-precision monotonic operation attribution

endOp accumulates the original nonnegative fractional monotonic delta in cumulativeMs, maxMs, histogram selection and slow-operation rankings. Only snapshot serialization rounds cumulative/max/slow metrics to 0.001ms. A deterministic fake-clock regression applies 66,848 operations of 0.2ms each to parse, hash and index. Each category totals approximately **13,369.6ms**, not zero, with the correct sub-1ms histogram bucket. Concurrent IO await totals still cannot be summed into wall time.

## Tests and saved receipts

The previous independently reviewed frozen code retains its original 135 pass / zero fail / zero skip TAP; this lane **did not repeat it**. The first corrections-only 6-test receipt passed. The final focused run covering the corrected tracer, original tracer, startup timing, ledger metrics and diagnostics finished **46/46 pass, zero fail, zero skip, zero cancelled** with the exact new source then committed unchanged. No full suite, installed executable or real full-profile capture was run.

Deterministic tests cover: permanently never-resolving build read; a late rejected build read; a permanently never-resolving checkpoint sync with no second writer; late successful/rejected sync and eventual single deferred final checkpoint; race of finish before build timeout; static desktop non-await startup/error contract; and 66,848 fractional fake-clock operations. The original trace tests on stalls, recovery, privacy, size and instrumentation remain in the focused run.

Receipts: verification/startup-tracing-20261115-review-corrections-first.tap and verification/startup-tracing-20261115-review-corrections-focused.tap.

## Next gate (root)

Review the exact correction source/manifest/TAP, async deadlines, terminal-close races, Windows atomic rename and packaged source fingerprinting. No source in this lane is yet approved for live capture. If independently accepted, root coordinates one safe backed-up Windows launch on preserved full history, recording external spawn→UI/tool/history readiness and the trace's nested phase/operation/queue timings. Current installed .98 observations (desktop-ready 220,294ms; scan 206,030ms; 66,848 receipts; 1,287,176,259 bytes) remain phase attribution only, not a proven physical I/O or Defender cause. Do not restart/install/run a competing suite or touch the Swarm preview process from this lane.
