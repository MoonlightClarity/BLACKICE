# BLACKICE startup tracing — terminal monitor lifecycle correction (2026-11-15)

## Source and exact handoff

This narrow correction follows independent review of the original BLACKICE 2.39.98 trace source and the earlier bounded-I/O/fractional-duration fixes. **It is not integration, installation, release, or live-capture approval.**

- Installed/published source baseline: `0101d3f88cc7f3f139394a1c943b899511668a90`.
- Earlier frozen startup trace: `d41ed60427b1459ee79608584a4ca2c8d4534624` code; `fd2bbea80fb2727463edf14a2c731828da75963e` evidence.
- Earlier corrections: `2b02bb002ec36f6df7135489a8f538fae63a86e9` code; `e2e3ec296b4cb24405e6d7487c01f97827259d4f` evidence. Independent review confirmed the saved 46/0/0 focused receipt without rerunning it.
- **New code correction:** `0eada884e366e607886a58f0e67d592393fb697b`.
- Isolated branch: `fix/startup-critical-path-observability-20261115`; worktree: `C:/Users/user/Documents/Codex/BLACKICE-startup-trace-20261115`.
- Only `lib/startup-critical-trace.mjs` and `tests/startup-critical-trace-deadlines.test.mjs` change relative to the previous evidence HEAD. Root dot retains sole integration/release/installation/live-restart ownership.

## Review finding addressed

Previously, `finish()` could run before source-build binding resolved, mark `done`, and disable no monitor (none existed yet). The delayed `start()` continuation then created/enabled `monitorEventLoopDelay`, after terminal completion. Repeating `finish()` returned immediately, leaving the monitor active and potentially drifting telemetry.

The new continuation checks `!this.done` **before constructing or enabling** the monitor. Normal startup still creates/enables the Node monitor and terminal `finish()` disables it. A configurable `createDelayMonitor` factory is used solely to inject deterministic lifecycle spies; the production default remains `monitorEventLoopDelay`. If construction/enabling throws after returning a monitor, the catch path attempts `disable()` and clears the reference. No asynchronous await exists between the terminal guard and enabling the monitor.

The terminal `finish()` now captures exactly one final progress sample **before** `done=true`. All subsequent checkpoint writes—including a late `start()` continuation or deferred terminal checkpoint after a timed-out writer—serialize existing samples without collecting more. Timer creation was already conditional on `!done`, and the normal `finish()` clears it. No test data or real ledger receipt is written to the installed profile.

## Narrow deterministic verification

One new **targeted two-test run**, not a repeat of the 46-test prior review receipt, passed: **2 pass / 0 fail / 0 cancelled / 0 skipped**. Its original TAP is `verification/startup-tracing-20261115-monitor-lifecycle-first.tap`.

The first test holds source build binding indefinitely, invokes `finish('failed')` before the binding deadline, then verifies that the later `start()` continuation creates **zero** monitors, enables **zero**, leaves `delay` and `timer` null, preserves final failure on disk, never increases sampled progress after finish, and does not create timer checkpoints after a 300ms hold beyond the 250ms hypothetical interval. A late resolved binding cannot overwrite the terminal timed-out source status or enable a monitor.

The second test wraps a **real Node event-loop delay monitor** in an injected enable/disable counter. Normal startup creates/enables once, `finish('ready')` disables exactly once, timer is null, a post-finish manual durable checkpoint creates no new progress sample, repeated `start()`/`finish()` cannot re-enable it, and after 300ms both the monitor's sample count and trace progress/checkpoint counts remain unchanged.

Syntax checks and staged whitespace checks passed. The previously reviewed **46-pass** correction receipt and the original **135-pass** base trace receipt are preserved unmodified; those tests were **not rerun** for this narrow correction.

## Review limitations and next gate

This correction addresses a late-monitor resource leak and terminal sampling race only. The prior deadline, single-writer, full-precision aggregate, bounded trace size, fail-closed ledger validation and no-replay behavior remain. As before, asynchronous diagnostic deadlines cannot preempt a synchronous event-loop block, and a failed first durable checkpoint may leave no trace file. There is **no** actual Windows full-history capture, packaged Electron acceptance, proven physical storage cause, or whole-startup performance improvement.

Root should independently inspect the exact correction diff, prior frozen source/evidence, new TAP and SHA manifest. Only then may root coordinate integration and one safe actual Windows startup trace on the full preserved profile. This lane performed **no** restart, installation, release, full suite, real applications, process termination, or edits to shared production/Swarm/Skills/Deadline work.
