# MiniCPM step and output budget reassessment

Date: 2026-11-23 (Eastern). Exact source: isolated integration preview `ed10a691fb52408714d718c92f07beba9c6311cc` with MiniCPM fixes and Directory harness. **Not a release, installation or main-branch merge.**

## Important correction: the original trial limits were artificial

The original read-and-retrieve experiments configured **8–10 provider steps**, **4,096 model output tokens**, and **85 seconds of wall time**. These are experimental test harness settings, not BLACKICE's actual default provider limits.

Read-only inspection of installed `local_llamacpp` provider configuration on 2026-11-23 showed:
- `maxSteps: null` (**no application step limit**)
- `maxTokens: 8192`
- the saved MiniCPM-V-4.7-1B-heretic-Q4_K_S model has **no model-specific maxOutputTokens limit**.

Source `lib/provider-store.mjs` independently confirms new provider connections default to `maxSteps:null`. Therefore scoring short `PROVIDER_STEP_LIMIT` tests as MiniCPM capability failures or Directory performance losses was not justified. The original ten-step paging trial searched the archived result at its last step, making step exhaustion a direct confound.

## Budget-controlled follow-up: same task and local model

The updated `verification/minicpm-directory-paging-ab.mjs` accepts independent `--steps`, `--wall-ms`, and `--output-tokens` arguments, retains source/task parity, and writes distinct raw reports and per-tool progress traces. The task remains identifying the exact `ROOT_CAUSE_CODE` hidden at source line 149 in a 300-line synthetic log. The model is **local_llamacpp::MiniCPM-V-4.7-1B-heretic-Q4_K_S** using the existing localhost llama.cpp server. Action Directory planning remained **Off**.

| Trial | Steps/output/wall permitted | Elapsed | Tool calls | Result | Independent source result |
|---|---|---:|---:|---|---|
| Paging with raised steps only | 32 / 4,096 / 360 s | 182.5 s | 2 | `PROVIDER_TRUNCATED`, **invalid for step comparison** | Did not finish; exhausted per-response output |
| Paging with raised steps and output | 32 / 8,192 / 540 s | 208.7 s | 6 | `CHAT_OUTCOME_STALLED` | No exact diagnosis; repeated continuation from line 225 and fabricated a line near 231 |
| Unpaged control, raised steps and output | 32 / 8,192 / 540 s | 204.7 s | 2 | `CHAT_OUTCOME_STALLED` | **Correct diagnosis** `CACHE_EPOCH_STALE_42` in both tool evidence and model's unpublished answers |

Neither run in the final matched pair exhausted its step, response-output or wall-time allowance. **Complete BLACKICE task successes: 0/1 per final-pair variant.** Only the unpaged control produced the correct diagnosis in its model draft. That answer was not published because the separately configured local outcome reviewer returned `continue` on the unchanged evidence twice, causing `CHAT_OUTCOME_STALLED`. Do not count it as a complete BLACKICE success, but do distinguish that reviewer false negative from model extraction quality.

In the paging variant, the model called `relay_context_page` **read** with a `needle` field but an irrelevant byte offset; the host silently ignored `needle`. It then repeatedly followed sourceContinuation at line 225 even though the target was in the already returned (but externally archived) earlier page. This is a real host-tool-contract and prompt priority defect interacting with model behavior, not exhaustion of a 32-step limit. The final reviewer correctly refused to certify its invented code.

## Separate isolated Directory correction

Branch `fix/context-page-search-first-20261123` at `c3ab36c6f4bd8566f49a5ca49c374611742525bf` adjusts the external-context tool so that:
- When locating a target phrase, the model is told to **search the archived returned result first, then read at the returned byte offset**.
- `sourceContinuation` remains exposed for original source bytes beyond the returned/truncated workspace page; it is not mistaken for searching the archive.
- Calls such as `read` with `needle` or `search` with `offset` explicitly fail with corrective guidance instead of silently ignoring the misapplied field.
- Existing full tool results and durable archive data are unchanged.

The exact combined-source **146-test** reviewer/Directory/code-tool/receipt regression suite passed with zero failures; a new fixture verifies the marker is in an omitted middle and the search-first route returns it. **No live MiniCPM qualification after this correction is claimed.**

## Decision and next tests

1. **Do not change production provider maxSteps**. It is already `null`. Do not present artificially capped experimental trials as production MiniCPM capability scores.
2. Fix benchmark validity by using production-like output policy and a wall bound that permits the intended tool horizon; report output exhaustion and time exhaustion separately. A 32-step cap is still an explicit experimental bound, but it did not bind in the final matched pair.
3. Assess the **local reviewer's false negatives** with exact admitted source: the control model accurately answered, but review rejected it. A correction must preserve receipt provenance, avoid fabricated success and avoid adding routine user approval gates.
4. Treat the source-continuation/search-first Directory correction as a separate candidate. Re-evaluate the same model with and without it before enabling paging by default.
5. Do not infer general coding competence or incompetence from this one synthetic log extraction trial. The elementary CommonJS repair remains unqualified; the earlier image-transport smoke was independently successful.

Raw saved reports:
- `verification/minicpm-directory-ab-paging-v2-steps32-wall360s-20261123.json`
- `verification/minicpm-directory-ab-paging-v2-steps32-wall540s-out8192-20261123.json`
- `verification/minicpm-directory-ab-control-v2-steps32-wall540s-out8192-20261123.json`
- Adjacent `.progress.jsonl` files record individual tool calls with their actual returns.

No installed app, user provider settings, release branch or user job-search task was changed. No publication, push or restart.
