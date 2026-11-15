# BLACKICE startup performance — isolated Chat Mode review checkpoint (2026-11-15)

## Ownership, source, and non-actions

This lane starts at published GitHub `main` **2371578ed97960a235abbdd3dbdec14da91a4703** (2.39.97). Local isolated branch: `fix/startup-evidence-20261115`, source at `C:/Users/user/Documents/Codex/BLACKICE-startup-performance-20261115`. Unmodified detached baseline: `C:/Users/user/Documents/Codex/BLACKICE-startup-baseline-20261115`. The older `C:/Users/user/Documents/Codex/BLACKICE` checkout is unrelated 2.39.6 with extensive dirty state; `BLACKICE-startup-diagnostics-20261115` has independent dirty .94 diagnostics work. Neither was edited.

Root dot alone owns integration, release, install, restart and external ownership coordination. Deadline and Swarm owners remain separate. This lane performed **no application/agent actions, install, restart, network/security-code changes, state cleanup, full test suite, production ledger scan, or live-profile benchmark**. Windows live BLACKICE and Node processes were observed before isolated tests; never terminated. Synthetic temporary fixtures were owned and removed by their respective test invocations. A read-only GitHub clone verified the exact current main SHA; no branch push or CI run was requested.

## Installed startup: actual read-only log evidence, not candidate proof

Read-only extraction from `C:/Users/user/AppData/Roaming/Relay/diagnostics/events.0.jsonl` confirmed these **installed 2.39.94** events (all timestamps UTC). An observed reboot started **2026-11-15 13:25:40.224**, and desktop-ready was observed **13:29:34.497**, about **234.3 seconds**. The same log reports:

| Phase | End timestamp (UTC) | Duration |
|---|---|---:|
| Browser | 13:25:41.222 | 953 ms |
| History | 13:25:44.045 | 1,843 ms |
| Conversations | 13:25:50.576 | 6,516 ms |
| Direct jobs | 13:29:31.640 | **220,934 ms** |
| Local harness | 13:29:33.207 | **232,946 ms** |
| Remote route | 13:29:33.431 | 961 ms |
| Window | 13:29:34.397 | 356 ms |

Earlier .94 launch log entry ended 2026-11-15 00:10:47.457 with **325,714 ms** direct-job initialization and 338,505 ms local-harness startup. Intervals partly overlap; do not add all rows to obtain wall time. External desktop-ready timing is not the same as local harness duration.

The earlier completed Work checkpoint retained a **64,351-receipt / 1,246,950,056-byte** synthetic copied-history read-only component comparison. Its 4-reader scans were **37.181 / 32.120 seconds** and 8-reader scans **29.739 / 28.182 seconds**, with identical state hash; the OS cache/load was uncontrolled and no lease/recovery writes or full launch occurred. The published .97 includes 8 readers and startup telemetry but **is not installed or locally whole-startup measured**.

## Actual implementation

Only `lib/direct-execution-jobs.mjs` production code changed:

- At receipt preload, `readFile(file)` returns original bytes; `raw.byteLength` replaces `Buffer.byteLength(decodedString)`; JSON is parsed from a single `raw.toString('utf8')`; SHA-256 is computed over the **original bytes**, not an additional UTF-8 re-encoding of a string.
- The canonical full receipt validation, ordinary-file / symlink / 8 MiB size check, per-owner request digest and idempotency, eight bounded readers, lease, drain-before-recovery, interruption behavior, immutable on-disk receipts and terminal hydration stay in place.
- No cache shortcuts, index cutoffs, lazy skipped validation, phase-ready labels, partial action admission or reduced history coverage were added.
- A Unicode receipt regression asserts byte-mode read, equal SHA-256, exact result and unchanged disk bytes after restart. Existing corrupted-receipt, drained-reader, lease contention, retry, idempotency and recovery tests were retained.

This is a bounded CPU/allocation optimization, not a proof of full-app startup or state scale.

## Focused tests and isolated measurements

**Focused test command** (Windows Node v22.23.5):

```powershell
node --test --test-concurrency=1 tests/direct-execution-jobs.test.mjs tests/ledger-startup-metrics.test.mjs tests/direct-resource-history.test.mjs
```

Terminal result **56 tests / 56 pass / 0 fail / 0 cancelled / 0 skipped**, ~3.94 s. Original TAP saved as `verification/startup-evidence-20261115-focused-tests.tap`. `node --check` also passed for changed source/test.

**Synthetic byte read/parse/hash component only:** `verification/startup-evidence-20261115-byte-benchmark.mjs`, output JSON adjacent. 280 generated receipts, **17,969,116 bytes**, 8 readers, exact byte hashes matched, order legacy/buffer/buffer/legacy/legacy/buffer. Median wall times legacy **177.348 ms**, buffer **144.777 ms**; process CPU **235 ms** versus **140 ms**. Excludes canonical schema validation, lease, index, recovery and server.

**Synthetic *real ledger initialize* (baseline .97 vs patched .97):** `verification/startup-evidence-20261115-ledger-compare.mjs`, output JSON adjacent. 281 fully valid generated receipts (seed + 280 result-bearing), same profile, real exclusive lease + full receipt validation + index + sort with 8 readers. Order baseline/candidate/candidate/baseline/baseline/candidate. All six runs indexed **281** with **0 unfinished**, no recovery writes, and identical exact-state hash **34861c427bd8e6c41252a2e4ff5e64e20cbe2c8ec6c7bbebd2a9de244fc3ef48**. Median initializer wall times baseline **206.698 ms**, candidate **168.038 ms**; process CPU **250 ms** vs **172 ms**; scan **200 ms** vs **161 ms**. This is a **~18.7% reduction for this synthetic sample only**, with sequence, cache and unrelated host load uncontrolled. Real profile is 1.25 GB and has a different size/distribution; do not extrapolate these timings or assume .94 versus .97 parity.

The measured code difference is reversible and narrowly confined; negative results from whole-startup tests must supersede this component signal. Test and benchmark receipts are local, reproducible, and do not contain applicant data.

## Readiness / route audit boundary (no behavior change)

In current .97 `server.mjs`, `createServer` awaits `startupPhase(..., 'direct-jobs', () => new DirectExecutionAPI(...).init())` **before** `server.listen()`. `DirectExecutionAPI.init` awaits `jobs.init`, captures storage failures, and `requireStorage` denies new actions when storage is unverified; `DirectExecutionJobs.initialize` only sets `ready` after scanning, sorting and recovery. This existing overall startup boundary is preserved.

**No UI-first / execution-later split is proposed for integration** without independent route-by-route evidence. A future split must establish a *default-deny* readiness policy for every HTTP GET/POST, direct execution tool, browser/frontend operation, connector/remote bridge, Goal/task/project operation, history lookup, OAuth/provider action, and retry path. It must require the same durable history/lease/validation/recovery barrier before any action could run or be labeled execution-ready; static shell display is not action readiness. It must explicitly prove that status, help text and error states accurately say history/connector are unavailable, not ready. Treat route audit and fail-closed tests as prerequisites, not an assumed side effect of showing a window sooner.

## Independent-review and full-startup measurement gates for root

1. **Source gate:** Review the exact diff, pristine parent commit and SHA manifest. Verify Node Buffer read contract, UTF-8 handling, SHA-256 canonical bytes, error categorization and stage diagnostics. Review overlapping `lib/direct-execution-jobs.mjs` changes from the old .94 diagnostics lane—this .97 branch already contains its integrated 8-reader telemetry, so never cherry-pick older dirty source wholesale.
2. **Safety gate:** Independently rerun only relevant tests first, then root-scheduled full suite; add adversarial corrupted and permission-denied receipts, symlink and changed-byte cases, multi-reader drain/close/lease contention, same owner/idempotency, and interrupted effects. Confirm full history count/hash and unchanged on-disk bytes before/after. No discards, deletion, replay, or partial admission.
3. **Resource gate:** Only root may coordinate a supported stop/restart. Reconcile active deadlines, Swarm tasks, application effects, direct jobs, owned browser tabs and concurrent work; obtain a consistent supported backup and restore identical **complete** history to isolated profiles. Do not stop the installed app for this lane. No production account actions or uncertain-action retries.
4. **Whole-startup gate:** Use the already prepared `2026-11-14/new-chat-17/work/controlled-comparison/startup-protocol.json`: six full launches **ABBAAB** with the same restored history; baseline must be identified by *exact installed version and installer SHA*, candidate by exact new build. Keep validation/lease/recovery enabled and identical, production dispatch disabled through supported configuration. Record every ready, failed, aborted and unfinished launch (no survivor-only averages); machine/AV/cache/load, external monotonic spawn-to-UI + safe tool roundtrip + validated history, internal phases, process CPU/IO and version identity. Do not call cache-cold without proof.
5. **Acceptance gate:** Compare whole desktop and action-ready distributions, not just `direct_jobs_startup` or synthetic scans; verify all historical records and uncertainty are retained and no effects replayed. If no clear benefit or a regression, reject/adjust. Root owns independent review, integration, published release, install and actual restart measurements.

**Current limit:** the installed application remains **2.39.94**, while the code is an **unpublished and uninstalled** isolated branch based on **2.39.97**. Neither published .97 nor this change has demonstrated whole-startup performance on the user's rebooted installation.
