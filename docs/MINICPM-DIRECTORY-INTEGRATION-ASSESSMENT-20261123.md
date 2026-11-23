# MiniCPM × Directory — integration assessment (2026-11-23)

**Decision:** Wait to combine Directory context architecture into the MiniCPM product/release lane. Do **not** hold independently tested MiniCPM provider routing, outcome JSON validation, code-check capability disclosure, operational-journal protection, final-step review, or vision transport behind that experiment.

## Exact examined sources

- MiniCPM fixes: `fix/minicpm-post24075-routing-20261122`, commit `1864c54782af57bcb2ce1e04f80f1c784b19dfeb`. This includes 2.40.75 docs-only head `9b3ec8e4`, but does not change the installed app or other branches.
- Current Directory harness/context branch: `feature/context-harness-reliability-20261123`, commit `ac81974f25f9050a14bff29d2a578ce795afd495`, separate Git object store. The older context-paging head is `fad9f51b`.
- Prior shared base: `3fc873c8394fb8381456c305cd91068ce9b98eac`.
- Underlying evidence: `docs/DIRECTORY-PAGED-LEDGER-LONGHORIZON.md`, `docs/HARNESS-CONTEXT-HARD-BENCHMARK-20261123.md` in the Directory branch, and raw outcomes in `BLACKICE-context-benchmark-results-20261123`.

## Impact on MiniCPM

**High expected value on long tool-return histories, not small coding tasks.** The new `TaskExternalContextStore` externalizes successful large read-only tool returns above 12,000 bytes. It keeps bounded decoded head/tail previews, a retrievable task-scoped reference and a `sourceContinuation` for source-reader truncation. Ordinary Chat can use `relay_context_page` even with Action Directory Off; failed tool results stay inline. This could reduce context pollution from multi-page source files and logs while preserving access to complete *returned* bytes. It cannot restore bytes truncated by the lower-level reader or erase existing provider history.

**Directory receipt longevity.** The new paged ledger increases the recorded receipt bound from 256 to 8,192. On a deterministic Engine/Directory harness, the 2.40.75 control stopped after 256 reads; the candidate completed 1,000/1,000 reads, 1,015 tool calls, a verified source fix and Directory closure, while preserving 1,011 receipts. Repeated archived content deduplicated to four files. This proves longer *host infrastructure* survivability, not 1,000-step MiniCPM reasoning. Full host state is still rewritten as JSON; performance, data lifecycle and the finite limit remain risks.

**No demonstrated repair for MiniCPM's dominant short-task failures.** The 1B model issued real write/test tool calls but failed elementary CommonJS exports, misread compiler/test failure, spent steps on irrelevant controls, and sometimes claimed unsupported completion. Paging only triggers on large evidence and will not normally help these small cases. Giving the model another optional retrieval tool or enforcing Action Directory plan/focus could increase cognitive load and rejected calls. Keep action planning Off while benchmarking the independently usable paging capability.

**Outcome-review interaction requires an explicit test.** Ordinary Chat may now pass the model an archived pointer and excerpt instead of a large original tool result. MiniCPM's reviewer still must not treat the preview or candidate claims as full original evidence. Test source reads/retrievals with a decisive marker in the middle, successful and failed tool returns, large logs, final-step exhaustion, and readback after reload. The previously fixed low-budget `CHAT_OUTCOME_STEP_BUDGET` safeguard must not regress. Host recording must distinguish *original admitted evidence*, *model-facing preview*, and *pages actually inspected*. The new Directory tests verify result paging, but not a fully qualified MiniCPM reviewer decision with hidden middle evidence.

**Separate limits.** MiniCPM branch's 64 MiB operational-effects journal and Directory's 8,192-action-receipt ledger are distinct stores, with different semantics and limits. One fix does not automatically solve the other's lifecycle or throughput.

## Current model-quality evidence

The latest authenticated native `gpt-6-luna` benchmark increased difficulty to a 21-test event-replay problem spanning two modules. Candidate runs reached 19/21 on multiple attempts; the unmodified control also reached 19/21, with large stochastic variance down to 6/21. Zero evaluated trials achieved all 21 tests and a complete workflow. The two remaining hidden failures concerned invalid-cursor rejection and invalid events reaching an apply callback: material task requirements, not infrastructure errors. These observations do not establish better coding success. MiniCPM was not the model in those paired tests, so do not transfer the inferred outcome to its 1B capability.

## Source compatibility probe

To avoid changing either active worktree, the MiniCPM commit was locally cloned into disposable scratch `BLACKICE-minicpm-directory-compat-20261123`; Directory head was fetched only there. A Git three-way merge against the common base found exactly **one textual conflict** in `lib/engine.mjs` where both sides edit the provider tool list.

The scratch conflict resolution retained MiniCPM's provider-facing `codeBlockToolForChecks` (ordinary `syntax`, benchmark `public`) *and* Directory's optional `EXTERNAL_CONTEXT_TOOL` alongside the normal workspace tool. The merged file passed `node --check` and `git diff --cached --check`. The combined source passed **131 tests, 0 failures** across ordinary Chat paging, context store, paged receipt ledger, code-block engine, provider output schema, Chat final-step review, and operational effect receipts. These are deterministic regressions, not a live MiniCPM/Directory benchmark.

This is a promising low-conflict **integration preview**, not authorization to merge, install or release. The Directory branch is evolving; repeat the preview against its final frozen commit, not this moving head.

## Next gates and recommended order

1. **Land independent correctness repairs first**, through the usual exact-source integration test and release owner. They should not wait for Directory architecture.
2. Freeze Directory source/receipt schemas, add the specific ordinary-Chat-reviewer/archived-result boundary test above, and profile at least a 1,000-receipt host ledger for JSON rewrite overhead and cleanup/lifecycle.
3. Run bounded **same-model MiniCPM A/B** with identical source, tests and finite step budgets: baseline 2.40.75+MiniCPM fixes, paging with Action Directory Off, and full Action Directory On. Use tasks whose diagnosis requires a long log and later retrieved evidence; keep ordinary tiny coding tasks as a negative control. Count fully passing tasks and independent effect evidence, extra retrieval calls, bad tool arguments, false completions, context size, and latency. Do not infer improvement from shorter tool text alone.
4. Enable paging for MiniCPM only if its actual task success or long-run reliability improves without unsafe completion claims. Keep Action Directory planning separately gated until the model can perform valid plan/focus/observe tool sequences. Use vision qualification as an independent lane.

**No original branch, installed BLACKICE runtime, job-search task, or local-provider configuration was altered by this compatibility analysis.**

## Later same-day continuation: actual MiniCPM paired trials

A separate isolated compatibility branch, `test/minicpm-directory-review-gate-20261123` at `ed10a691`, combines the exact MiniCPM and current experimental Directory source lines, resolves only their provider-tool-catalog conflict, and retains detailed original evidence in `docs/MINICPM-DIRECTORY-AB-FINDINGS-20261123.md`.

The combined source passed **145 deterministic tests with zero failures**, including two end-to-end archived-middle-evidence review cases. A preview without the middle source did not satisfy the reviewer; a model-retrieved exact page did. This proves the evidence boundary, not the local model's ability to choose the retrieval.

The real local `MiniCPM-V-4.7-1B-heretic-Q4_K_S` was then run in paired long-log trials with Action Directory Off. **No full task succeeded.** In the initial relative-path pair both variants exhausted tool steps while looking for the log. In the narrower absolute-path pair, control read the exact hidden diagnosis and accurately stated `CACHE_EPOCH_STALE_42` but did not obtain an accepted final answer. The Directory variant archived the log, called the unsupported source checker on the `.log` file eight times, searched its context reference at the last tool step, but never read that page or completed the task.

This is strong evidence that the current 1B model's *tool choice* remains the limiting factor even when Directory's storage and retrieval work correctly. It is not a population-level estimate of paging's effect. The independent MiniCPM branch now has commit `0f541860`, restricting the advertised code-check languages to the attached backend; targeted tests passed 42/42 and 29/29. Those live trials **preceded** that change, so they are not evidence of post-fix success.

**Decision unchanged:** continue independent reliability integration, but do not enable experimental Directory paging or action planning by default for MiniCPM 1B. A further local-model benchmark is justified only after a materially different tool-use/recovery mechanism is implemented and tested.
