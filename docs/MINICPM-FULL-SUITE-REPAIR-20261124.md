# MiniCPM full-suite repair checkpoint — 2026-11-24

## Source and scope

Repair worktree: `C:\Users\user\Documents\Codex\BLACKICE-minicpm-full-repair-20261124`

Branch: `fix/minicpm-full-suite-20261124`

Validated source: `6aa3b7691ca24f00a495b0e6fa454f05387f5a4e`, descending from isolated integration `82137ed4` and Goal-command repair `5ae34e7a`. The original baseline was run from `5ae34e7a` without changing its tracked files. This is **not** a main-branch merge, release, installed-app update, or live MiniCPM qualification.

## Exact full-suite comparison

| | Baseline | After repair |
|---|---:|---:|
| Total reported tests | 10,561 | 10,561 |
| Passed | 10,483 | 10,532 |
| Failed | 69 | 20 |
| Skipped | 9 | 9 |
| Duration (ms) | 519,030.011 | 547,483.830 |

**49 former failures now pass**. The repaired run completed; this is not a green full suite because 20 tests still fail.

Baseline TAP: `C:\Users\user\Documents\Codex\BLACKICE-minicpm-owner-operations-82137ed4-20261123\verification\minicpm-full-suite-20261124-v1.tap`  
SHA-256: `f190b7775e36bff049fc2c95e4e314ac3cdb1d45808792c378e74637d294cad5`

Repaired TAP: `verification/minicpm-full-suite-repair-20261124-v2.tap`  
SHA-256: `cf87f819bef4ccd404f598e8028627f038b57daec7d83c166d95f9c26b18741d`

The full run used installed Node 22.23.5, the exact lockfile-compatible Electron 44.7.2 dependencies linked into the isolated worktree, and existing uv-managed Python 3.12.16 via `PLANNING_BEHAVIOR_PYTHON`/`PYTHON`. No dependency or provider settings were changed globally.

## Completed repairs

- `5ae34e7a`: Bind settled native workspace command outcomes to the exact request/result; distinguish a nonzero exit from unresolved effects; strip inherited `NODE_TEST_CONTEXT` so nested `node --test` cannot silently skip checks.
- `d0eb755c`: Serve the existing `provider-output-settings.mjs` module from the HTTP static allowlist.
- `e426fd23`: Preserve 256-token answer and 128-token headroom floors when adapting implicit local context reserves; do not confuse reserve with generation ceiling.
- `5b08e1b2`: Keep corrupt optional owner-skill metadata from blocking task execution, without loading unverified fallback methods.
- `540ef018`, `b4345b25`, `a504c052`, `aa499b03`, `7cc349af`, `50e0b713`, `6aa3b769`: Correct focused test fixtures to preserve actual execution/review boundaries, unknown context-window semantics, provider output policies, report-correction requirements, the current Windows hidden discovery route, and valid failed-check Directory continuation. The latter still rejects unsupported completion.
- Environment-only repairs: provide verified local Electron dependencies, and use the existing Python runtime rather than Windows' placeholder `python.exe`.

Representative focused receipts remain in this worktree's `verification/` directory. No baseline tests were deleted or permanently skipped to improve the full-suite totals.

## Unresolved: 20 frozen historical benchmark tests

Exactly two file-level tests (`minicpm-execution-delivery.test.mjs` and `minicpm-execution-evidence.test.mjs`) cannot load the historical `minicpm-agentic-v1/harness/support/grade-modules.cjs`. Eighteen `minicpm-native-control.test.mjs` cases cannot verify the pinned `minicpm-agentic-v2/harness-deltas/create-v2-workspace.cjs` and associated historical sources. The configured checkout `C:\Users\user\Documents\Codex\BLACKICE-minicpm-context-vision-20261120\verification` is absent. Git history/ref inspection and the saved application patch-backup folder did not recover these inputs.

The historical controller checks require original exact bytes and SHA-256 pins; do **not** fabricate fixtures, relax hashes, reclassify them as passed, or infer the benchmark passed. A true rerun needs recovery of the original pinned source files (or a separate, explicitly redesigned benchmark with a new evidence identity).

## Separate live-model smoke and limitations

The first isolated probe used the raw saved model-path list, including an unavailable WhiteRabbitNeo entry, and its non-streaming completion timed out after 45 seconds. Receipt: `C:\Users\user\Documents\Codex\BLACKICE-minicpm-owner-operations-82137ed4-20261123\verification\minicpm-local-runtime-probe-20261124.json`. This probe did **not** apply the managed supervisor's normal missing-model filtering.

A corrected isolated probe filtered that unavailable extra model **only in its temporary launch preset**, retained MiniCPM's saved GGUF, projector and context settings, and used a bounded streaming chat completion. It recorded 39 events, first event at 11,347 ms, first content at 16,487 ms, and a completed `stop` response `READY.` after 16,499 ms. Receipt: `verification/minicpm-local-stream-probe-20261124.json`, SHA-256 `ec239de47da9f9421be32cd1fb2f442528eea484320deee0e672498ed70077c3`. No llama-server processes remained afterward.

This is a **narrow live local inference smoke pass**, not a successful coding task, Directory benchmark, full agent workflow, or general MiniCPM qualification. Because both model-list filtering and streaming/response limits differed from the first probe, the timeout's precise cause remains unisolated. No saved production model or provider configuration changed.

## Next bounded steps

1. Recover and independently SHA-256-verify the original historical benchmark inputs, then rerun the three frozen-fixture suites and the whole suite.
2. Reconcile the unfiltered non-streaming timeout with the supervisor-parity streaming success under matched generation settings; then validate a real MiniCPM task and Directory workflow using independently observed tool and final-result receipts before model-quality claims.
3. Submit this isolated repair branch and its immutable TAP digests to the integration owner; do not merge, install, or publish on incomplete evidence.

## Later integration and publication outcome — November 24, 2026

The 2.40.80 integration retained the original historical benchmark checks, but moved each unchanged test body into a named `.historical.mjs` module. A separate wrapper reports an explicit unexecuted skip **only when the entire externally pinned historical snapshot is absent**; when the snapshot is present but incomplete, original SHA-256 checks still fail. The three resulting skipped suite entries did not become passes or qualify the historical MiniCPM benchmarks.

The combined source suite subsequently passed 10,549 tests, failed zero, and reported 12 optional skips. GitHub [public release v2.40.80](https://github.com/MoonlightClarity/BLACKICE/releases/tag/v2.40.80) and its [hosted Windows verification workflow](https://github.com/MoonlightClarity/BLACKICE/actions/runs/45374218647) succeeded. A separate isolated native browser-capacity smoke also passed. See the [release verification record](RELEASE-2.40.80-VERIFICATION.md) for exact source, artifact digests, executed checks, and continued limitations. This does not retroactively certify the original missing 20 assertions, full MiniCPM coding benchmarks, or actual job-search submissions.
