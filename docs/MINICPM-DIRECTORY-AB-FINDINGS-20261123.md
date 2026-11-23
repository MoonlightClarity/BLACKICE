# MiniCPM × Directory context paging: exact integration gate and paired local trials

Date: 2026-11-23 (Eastern). **Experimental / not for release.**

## Source identity and isolation

- MiniCPM correctness branch `fix/minicpm-post24075-routing-20261122`, tested baseline `f2b593b4`; after the live trial an independent tool-schema correction `0f541860` was committed there.
- Directory long-horizon branch `feature/context-harness-reliability-20261123`, source `ac81974f`.
- A new isolated Git worktree `BLACKICE-minicpm-directory-review-gate-20261123` combines these for tests. The single `lib/engine.mjs` conflict was the model tool catalog: retain both `codeBlockToolForChecks` and Directory's `EXTERNAL_CONTEXT_TOOL`. No installed BLACKICE or existing user task was modified.

## Deterministic integration gate

`tests/minicpm-directory-outcome-evidence.test.mjs` uses the real BLACKICE Engine/compatible-provider route and a synthetic 300-line file with decisive text in the omitted middle of a 40 KB workspace result.

- If a worker only obtains an archived head/tail preview and claims the middle diagnosis, the review snapshot contains **no matching source text**. The read-only reviewer returns `continue`; with no remaining provider steps BLACKICE fails `CHAT_OUTCOME_STEP_BUDGET`. No preview-only claim is falsely certified.
- If the worker explicitly searches the archived reference and reads the matching page, that exact source page is present in the review's admitted evidence. The reviewer can accept the complete report.

**2/2 tests passed.** This establishes the basic reviewer/provenance boundary, not real MiniCPM capability. The reviewer itself does not automatically retrieve archived middle content; the task model must choose the paging tool, or the reviewer must independently inspect the source through an explicitly designed evidence route.

## Real MiniCPM local-model A/B

`verification/minicpm-directory-paging-ab.mjs` runs `local_llamacpp::MiniCPM-V-4.7-1B-heretic-Q4_K_S` on the existing llama.cpp server. The variants use the same model, task, generated 300-line log, middle diagnosis `ROOT_CAUSE_CODE: CACHE_EPOCH_STALE_42`, context settings and step limit, with two separate prompt revisions. Control uses 2.40.75+MiniCPM fixes; candidate uses the combined Directory harness with Action Directory **Off** and its new `relay_context_page` tool. Temporary profiles/workspaces are deleted after each run, and the reports are saved individually.

| Trial | Model tool calls | Outcome | Exact code independently reported? | Observation |
|---|---:|---|---|---|
| v1 control, relative file path | 8, 4 completed / 4 failed | `PROVIDER_STEP_LIMIT` | No | Repeated wrong `C:\\incident.log` and invalid file-search arguments |
| v1 Directory, relative file path | 8, 4 completed / 4 failed | `PROVIDER_STEP_LIMIT` | No | Eventually located log, but did not retrieve diagnosis before step exhaustion |
| v2 control, exact absolute path | 2 | Bounded timeout/cancelled | **Yes, but unaccepted** | Read full returned source with diagnosis; attempted unavailable code check on log; 1B reviewer returned `continue`, not a verified final completion |
| v2 Directory, exact absolute path | 10 | `PROVIDER_STEP_LIMIT` | No | Read succeeded and was archived. Then called unavailable `relay_code check` eight times, used `relay_context_page search` only on final step; no page read or final diagnosis |

**Whole accepted task successes: 0/2 in v1 and 0/2 in v2.** In the narrowed v2 comparison, the control could read the decisive source fact directly while Directory's archive path required another tool choice the model deferred. This is a valid **negative 1B behavior** but not a statistically generalizable estimate; the base source has other harness differences and source paths were each run-specific. No run may be reported as a complete coding or research-task pass.

The model's repeated invalid code checking is independent of Directory's archive integrity. Prior MiniCPM code-tool repair constrained check kinds but left unsupported languages too broadly advertised. `0f541860` now restricts ordinary syntax-check schema to JavaScript/JSON and public benchmark checking to JavaScript, and points text/log analysis toward read/search. **That fix passed 42/42 focused checks and 29/29 engine/code-block checks separately.** The live A/B described above preceded this change; it does not establish behavior after the fix.

## Engineering recommendation

1. Keep **MiniCPM correctness improvements** separate and integrate by exact-source review. Do not block them on experimental Directory development.
2. Preserve Directory's paging and larger receipt ledger as optional experimental infrastructure. The 1,000-read scripted test demonstrates genuine host capacity, but native-model hard coding tests have no full wins.
3. **Do not enable Directory paging by default for MiniCPM 1B** yet. Validate a fresh small paired run only after making a meaningful tool-choice change, not repeated retries of the same error. Track *successful source retrieval and exact final answer*, not merely total prompt bytes or number of archived files.
4. Follow up on repeated failed-tool alternatives and over-conservative local reviewer interpretation if measurable. Preserve unknown external effects and never turn incomplete trials into success via prompt or grader weakening.
5. Maintain the model's strongest verified niche independently: exact local MiniCPM image transport and one elementary code/color image test. No claim of broad vision or autonomous coding quality.

Raw reports (original, not overwritten):
- `verification/minicpm-directory-ab-control-20261123.json`
- `verification/minicpm-directory-ab-paging-20261123.json`
- `verification/minicpm-directory-ab-control-v2-20261123.json`
- `verification/minicpm-directory-ab-paging-v2-20261123.json`

No publication, installation, restart, production task mutation, or integration into the release branch is authorized by these tests alone.
