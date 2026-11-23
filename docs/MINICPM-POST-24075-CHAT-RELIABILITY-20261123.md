# MiniCPM post-2.40.75: coding and final-review reliability checkpoint

Date: 2026-11-23 (Eastern)
Branch: `fix/minicpm-post24075-routing-20261122`
Current base: original `3fc873c8` plus newer docs-only integration commit `9b3ec8e4` merged as `ae975eac`.
This branch includes earlier independent commits `639acb20` (provider-qualified model routing), `8e69a917` (local strict outcome JSON), and `7b3feb8e` (larger lossless operational journal).

## New runtime issues observed

A live native engine coding probe used `local_llamacpp::MiniCPM-V-4.7-1B-heretic-Q4_K_S`, an isolated temporary profile/workspace, and real source/test tools. The baseline `src/math.cjs` exported `add(a,b)` but subtracted; the fixed source must add and pass three Node tests. These are smoke tests, not difficult benchmark scores.

- The first live run used a generic Mission workflow, which intentionally does not attach the ordinary Chat outcome reviewer. It ended `completed` despite unchanged source and failing tests after the model tried an unavailable public code checker. This is not evidence that the ordinary Chat reviewer was disabled in production.
- Ordinary workspaces exposed `relay_code check:public` although their attached checker supports `syntax` only. Benchmark workspaces support `public` only. The model repeatedly chose the advertised but unavailable route.
- The second live run used the correct `chatgpt_mission_` workflow and an executable syntax-only code catalog. It saved an incorrect JavaScript file with no CommonJS export and then claimed completion. The run status was `completed`, but independent test exit was 1 and `outcomeAssessment` was null. Investigation found the exact guard: `chat-execution-review.mjs` skips its final assessment when fewer than two provider steps remain. The claim could slip through that exhausted-budget path.
- The third bounded live Chat run, after the source fix below, ended `PROVIDER_STEP_LIMIT` rather than being reported as completed. It had multiple tool calls but still left invalid/unverified source (`export { add }` in a CommonJS file). It did not reach an accepted final answer and therefore does not prove successful local coding.

## New changes isolated in this branch

**Code check discovery:** `codeBlockToolForChecks` projects only code-check kinds actually attached to that workspace into the provider-facing `relay_code` schema. Main ordinary Chat and workers advertise `syntax`; agent-tools benchmark mode advertises `public`. General parser, checked writes, source readback, and saved historical calls remain backward compatible; benchmarks retain their public checker. Neither unavailable checker is silently treated as a success.

**Last provider step review:** ordinary Chat's final low-budget path uses an existing read-only outcome assessor instead of accepting a candidate without review. When it returns `respond` with supported evidence, the report can be accepted. When it identifies unfinished work but no provider/tool steps remain, BLACKICE emits `CHAT_OUTCOME_STEP_BUDGET` and retains earlier effects. Cancellation, steering and provider-truncated output still take precedence. No tool is replayed or synthesized by this assessment.

## Verification

- `node --test` over 14 targeted files (Chat reviewer, local provider output, engine/provider budget integration, code-block routing, operational receipts, continuity, Directory and compaction): **264 passed, 0 failed**, exit 0.
- Deterministic `tests/chat-execution-review-budget-integration.test.mjs`: the engine and compatible provider receive a false final completion with zero remaining model steps; the separate read-only reviewer returns `continue`, and the engine fails `CHAT_OUTCOME_STEP_BUDGET` with the source untouched. **1 passed**.
- `verification/minicpm-chat-review-admission-probe.mjs`: ordinary `chatgpt_mission_` attaches `onBeforeFinal` and syntax-only `relay_code`; a generic Mission does not attach the ordinary Chat reviewer.
- `verification/minicpm-engine-coding-smoke.mjs`: real MiniCPM model, actual engine and workspace tools. The model was able to issue tools and save source but **did not pass** the 3-test source acceptance. No coding success is claimed.
- Earlier same-branch tests and source audits are recorded in `docs/MINICPM-POST-24075-PRESERVATION.md` and `docs/MINICPM-POST-24075-REVIEW-AND-JOURNAL-20261123.md`.

## Position and integration policy

MiniCPM 1B can execute tool calls and structured outcome JSON, but current live evidence does **not** support treating it as a reliable autonomous coder. Do not improve its benchmark score by weakening acceptance, rewriting its attempted source on the host, or inferring success from a completed response. The corrected host guard is a reliability improvement independent of the model's coding ability.

Do not merge entire older MiniCPM branches over newer BLACKICE; features already present were reconciled by source and tests. Preserve the old branches, including uncommitted calibration work. Integrate these focused commits through the next source integration review; the installed BLACKICE, its live provider settings, existing operational journal and other tasks have not been modified. No push, release, installer or app restart was performed. Revisit MiniCPM's coding role only after a genuinely passing task, and keep image/vision qualification separate from unsupported coding claims.
