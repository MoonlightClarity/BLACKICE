# MiniCPM cross-version preservation checkpoint — 2026-11-22

## Scope and baseline

Release baseline: `release/final-2.40.75-20261122` at `3fc873c8`.
This audit and the only new fix live in the separate worktree `BLACKICE-minicpm-post24075-fixes-20261122`, branch `fix/minicpm-post24075-routing-20261122`.
No previous MiniCPM worktree, release source, installed binary, running service, user settings, or old experiment has been replaced.

**Do not merge the older MiniCPM branches wholesale.** They diverged from older BLACKICE snapshots. Compare actual source behaviors and tests, then transplant any genuinely absent, useful change as a focused patch with tests. A commit's missing ancestry does **not** mean its feature was lost.

## Preserved changes evidenced in the integrated source

| Older work/commit | Meaningful behavior | Current source evidence | Status |
| --- | --- | --- | --- |
| `1195aa20` — MiniCPM continuity | Deduplicate live-run tool acknowledgments after the bounded payload window evicts old records | `lib/conversation-tool-continuity.mjs` contains `liveAcknowledgments` WeakMap and `acknowledgmentsFor`; `tests/conversation-tool-continuity-idempotence.test.mjs` covers 24-payload overflow | Present |
| `779b95a2` — Directory recovery | After eight proven pre-dispatch `DIRECTORY_FOCUS` rejections, deliver task-local recovery context without silently changing run budgets | `lib/directory-tool-recovery.mjs`, `lib/engine.mjs` `onDirectoryToolRecovery`, `lib/providers.mjs`, focused tests | Present |
| `7125a50e` — Directory fixture contract | Keep Directory provider fixtures compatible with artifact responses | `tests/directory-host-bound-provider.test.mjs` exists; independent fixture-level equivalence not specifically established in this checkpoint | Check separately if this fixture fails |
| `435a1251` — Directory choice hints | Show ready/current action IDs on missing focus or invalid selection, without changing the task | `lib/task-action-directory.mjs` `currentActionChoices` and focus rejection; `tests/task-action-directory.test.mjs` | Present |
| `8426862e` — MiniCPM sampler | Optional model-specific repeat penalty, not a mandatory new default | `lib/llama-cpp-launch-config.mjs` `repeatPenalty`; `tests/minicpm-llama-sampling-config.test.mjs` | Present; optional |
| `1f8c8895` — QX4 llama runtime | The unique-parameters native runtime repair and its checked-in patch | `lib/llama-cpp-bundle.mjs` names `blackice-b12359-qwen3-unique-parameters-io-v3`; bundle/repair tests cover the fourth patch | Present |
| `b25d69c8` — task-first framing | Keep current task first in coordinator and planning prompts | Integrated as equivalent post-integration commit `dab0def2` | Present |
| `a8d76b97` — skill discovery | Clarify injected skill IDs and read routes | Integrated as equivalent post-integration commit `7b4169af` | Present |

The integrated history also includes MiniCPM runtime/shared harness `a31c2f4e`, compaction continuity test `dad90d9e`, native tracing, context admission, and vision settings. Historical branches `BLACKICE-minicpm-continuity-20261122`, `BLACKICE-minicpm-directory-recovery-20261122`, `BLACKICE-minicpm-sampler-20261122`, and `BLACKICE-minicpm-calibration-20261121` remain untouched. The calibration worktree had twelve modified tracked files when inspected; these must not be overwritten.

## Validation completed

- Baseline `node --test tests/conversation-tool-continuity.test.mjs tests/conversation-tool-continuity-idempotence.test.mjs tests/directory-tool-recovery.test.mjs tests/provider-compaction-integration.test.mjs`: **41 passed, 0 failed**, exit 0.
- Isolated source `node --test tests/conversation-goals-direct-tool.test.mjs tests/direct-schema-alignment.test.mjs tests/directory-input-capacity.test.mjs`: **13 passed, 0 failed**, exit 0, including the new provider-selection regression.
- Isolated source, eight targeted old-branch preservation suites: `engine-directory-recovery`, `provider-directory-recovery`, `task-action-directory`, `minicpm-llama-sampling-config`, `minicpm-agent-tools-profile`, `llama-cpp-bundle`, `materialize-llama-repair`, `prepare-llama-runtime`: test command exit 0. The command's stdout was truncated by the connector at 35,000 characters, so its total test count is not claimed here.
- No installer, release publishing, app restart, Git push, or broad benchmark was performed.

## Newly discovered provider routing problem and isolated fix

`blackice_start_chat` previously accepted the bare `MiniCPM-V-4.7-1B-heretic-Q4_K_S` ID and attempted to run it as **native Codex**, causing “model is not supported when using Codex with a ChatGPT account.” Local and API models need `providerId::modelId`, e.g. `local_llamacpp::MiniCPM-V-4.7-1B-heretic-Q4_K_S`.

In this branch, `lib/chatgpt-start-chat.mjs` now detects an unqualified ID matching a saved API/local provider, reports the exact qualified choice and rejects admission before accidentally launching a different provider. It preserves valid qualified IDs, native Codex IDs, and defaults. A focused regression test verifies all three paths. This code is **not installed**.

## Remaining MiniCPM validation gap

Using `local_llamacpp::MiniCPM-V-4.7-1B-heretic-Q4_K_S`, BLACKICE did actually select the local provider (`resolvedModel`) and saved a provider thread. Its run `50a13d04-1bc2-4364-9aed-b24e4820b169` completed one tool call with zero reported tool failures, but ultimately failed with `CHAT_OUTCOME_UNREVIEWED`; `outcomeAssessment.reason` was `MODULAR_REVIEW_INVALID`. This is **not** proof of a successful MiniCPM agentic run. Follow-up should inspect why the outcome reviewer rejected the run, or run a smaller local-model probe with observable tool receipts, and fix only a demonstrable defect.

The MiniCPM profile's `QUALIFIED_MINICPM_LOCAL_PROFILE` was `null` during the initial baseline inspection; do not silently mark the profile qualified or alter the user's provider settings merely to make the test pass. Optional repeat-penalty tuning is lower priority than provider/tool/review reliability.

## Merge policy for the next integration

Apply this isolated fix by review/cherry-pick onto a later integration baseline, only after validating against that exact source. Do not replace newer source with old snapshots or revert unrelated changes. Preserve the old worktrees and their commit references until remaining features have been reconciled. Do not claim the running app has changed until an actual installer/restart and version verification occur.
