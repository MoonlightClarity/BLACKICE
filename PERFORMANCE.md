# Performance and reliability verification

These results were recorded on Windows on 21 October 2026 for the performance update to BLACKICE 2.33.5. They describe the tested runtime changes before source-publication documentation and license metadata changes. A changed application fingerprint needs its own verification record; this summary does not transfer the earlier exact-build evidence to subsequent packages.

## Changes

History persistence now retains one active snapshot batch and one shared pending request. Serialization happens when a batch begins writing, instead of retaining a complete serialized history for every queued request. Callers wait for their corresponding save to finish, failures reject the affected callers, and later requests can retry. Unchanged files avoid replacement. Known-valid backups use native file copies, and shutdown checkpoints the final valid history. Transient Windows rename failures receive bounded retries; the live destination is never deleted to force a replacement. See [the persistence writer](lib/coalescing-persistence.mjs) and [engine integration](lib/engine.mjs).

Streamed events update application state immediately while visible workflow and Observe displays coalesce rendering into scheduled frames. Navigation and user actions can still refresh immediately; leaving Observe cancels pending display work. Browser tab-state saves retain the latest pending state, and DOM snapshots retain references only to the controls returned by the current query. See [the main interface](public/app.js), [Observe](public/observe-ui.mjs), and [the contained browser driver](desktop/browser-driver.mjs).

The browser driver also releases failed renderer resources, rejects pending operations with an explicit error, and preserves tab identity for recovery. Reload or navigation must explicitly recover a failed page. Uncertain inputs and side effects are not automatically replayed.

## Persistence benchmark

[The benchmark](scripts/benchmark-persistence.mjs) uses synthetic history and reproduces the previous save mechanism alongside the updated mechanism. Each run started in a fresh Node.js process with a 26,398,592-byte history and submitted eight concurrent save requests. Both mechanisms retained final revision 8 in every repetition. Three before/after repetitions ran on the same Windows machine using Node.js 24.13.0.

The table reports medians. MB uses decimal units.

| Metric | Previous mechanism | Updated mechanism | Reduction |
| --- | ---: | ---: | ---: |
| Burst completion time | 2,987 ms | 619 ms | 79.3% |
| CPU time | 2,329 ms | 421 ms | 81.9% |
| Observed peak JavaScript heap | 444.2 MB | 137.3 MB | 69.1% |
| Observed peak process RSS | 539.4 MB | 202.8 MB | 62.4% |
| Initial event-loop response delay | 457 ms | 156 ms | 65.8% |
| History serializations | 8 | 1 | 87.5% |
| Bytes serialized | 211.2 MB | 26.4 MB | 87.5% |
| Complete history reads | 8 | 1 | 87.5% |

Burst completion times ranged from 2,894–3,172 ms before and 617–752 ms after. The previous mechanism performed 16 file writes; the updated mechanism performed one file write plus one native backup copy. The backup copy still performs filesystem I/O. Memory was sampled at defined checkpoints, so the figures are observed peaks rather than continuous maxima.

These measurements apply to this history-save workload. They do not establish equivalent reductions in total application memory, idle resource use, or other operations. A full snapshot still serializes synchronously, with approximately 156 ms of initial event-loop delay in this workload. The measured improvements came from removing repeated work and bounding retained state; they did not require a C rewrite.

## Rendering and browser resource checks

A controlled replay of 1,000 real application event-handler calls reduced visible execution and inspector rendering from 1,000 calls each to one call each for the burst. Hidden workflow panels received no event-driven render calls. All 1,000 events and output characters remained in state. This is a render-call count, not a measured 1,000-fold application speedup. The relevant regressions are [live rendering](tests/live-render-performance.test.mjs) and [Observe rendering](tests/observe-render-performance.test.mjs).

A blocked-disk browser regression submitted 1,000 state updates after the first write began. The updated driver performed two writes and retained the final state, instead of queueing 1,001 writes. A separate DOM-reference regression visited 1,500 connected controls through 15 disjoint queries: each query retained 100 controls, an empty result retained zero, and an unfiltered result retained at most 300. See [browser resource regressions](tests/browser-resource-resilience.test.mjs).

The native crash smoke test used Electron 44.7.2 and a disposable browser profile. It deliberately crashed one renderer and passed four scenario checks. The pending operation failed with `BROWSER_RENDERER_GONE` in approximately 31.4 ms; a sibling page remained usable. One explicit reload restored a valid snapshot and a 1282 × 825 capture. A previously completed local POST was not repeated, and its final effect count remained one. Browser persistence, shutdown, and fixture cleanup completed.

This verifies the exercised crash-recovery path. It does not establish a future crash rate or identify the cause of every historical failure. The reproducible harness is [browser-resource-smoke.mjs](scripts/browser-resource-smoke.mjs).

## Completed Windows verification

The full suite covered 296 test files and completed in approximately 109 seconds:

| Result | Count |
| --- | ---: |
| Total tests | 3,979 |
| Passed | 3,975 |
| Failed | 0 |
| Cancelled | 0 |
| Optional integrations skipped | 4 |

Forty new regression tests cover rendering, persistence, and browser resource/failure handling. The test candidate's fingerprint was unchanged before and after the suite.

The two optional Electron persistence integrations were subsequently enabled and both passed with zero skips. They exercised sign-in/local-storage persistence across a process restart and lazy tab restoration without loading closed or replaced pages. The other two optional integrations, native accessibility and Firefox, were not run during this update.

After the updated application was installed and manually restarted, verification confirmed the replacement process was running the installed performance code. Live status reported healthy history storage, conversation storage, browser persistence, and diagnostics; conversation recovery was not required. Diagnostics reported zero I/O failures and zero pending writes. The history and its backup were valid JSON with matching hashes. Retained startup diagnostics contained no recorded failures during approximately six minutes of observation.

This was a short activation and health check. No prolonged production soak was completed, and no new public installer was produced or validated during this update. Source publication and installer validation remain distinct: [Signing and release](SIGNING-AND-RELEASE.md) describes the evidence required for each exact Windows installer.

## Reproduce the checks

From a complete source checkout with dependencies installed:

```powershell
node --test --test-reporter=tap --test-concurrency=4 tests/*.test.mjs
node --expose-gc scripts/benchmark-persistence.mjs before 26397007 8
node --expose-gc scripts/benchmark-persistence.mjs after 26397007 8
```

Run each benchmark mode in a fresh process and repeat both modes under comparable conditions. The benchmark creates synthetic temporary history and does not open the installed application profile.

To enable the two real Electron persistence integrations on Windows:

```powershell
$env:RELAY_LIVE_BROWSER_QA = '1'
node --test --test-reporter=tap --test-concurrency=1 tests/browser-auth.integration.test.mjs tests/browser-lazy.integration.test.mjs
Remove-Item Env:RELAY_LIVE_BROWSER_QA
```

To exercise deliberate renderer failure in a separate temporary profile:

```powershell
& .\node_modules\electron\dist\electron.exe .\scripts\browser-resource-smoke.mjs
```

The crash harness prints its result and temporary profile location. Inspect or clean up that fixture only after its process exits. Keep machine-specific test logs and receipts outside the public repository.

## Source publication verification

After adding the Apache license, repository metadata, preserved notice index, packaging notice entries, and publication documentation, the complete Windows suite ran again on 21 October 2026: **3,979 tests, 3,975 passed, zero failures or cancellations, and four optional integration skips**, across 296 test files. The process exited successfully, and the application fingerprint was unchanged before and after that run. The machine-readable [source verification summary](verification/windows-2026-10-21.json) identifies this publication build and the retained test-log digest. The optional Electron integrations described above were exercised during the preceding performance validation; they were not enabled in this publication-suite rerun.

The connector command that launched this run exceeded its response time budget; the owned test process continued to completion. Its final process result, complete TAP totals, and test-log hash were read back and verified before publication. No result is inferred from the launcher status. This source check does not validate a new binary installer or a prolonged production soak.
