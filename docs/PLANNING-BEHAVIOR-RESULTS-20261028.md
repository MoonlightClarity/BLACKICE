# Planning behavior results — 2026-10-28

## Result and scope

Private run identifiers, local paths and activation identifiers are retained in the development evidence. This public report preserves the observed results and public source hashes.

Four fresh native BLACKICE runs completed the prepared tasks and passed the unchanged independent output evaluator, with no environment or integrity errors. Their observable traces show different diagnoses for identical debugging prompts, a correctly bounded exact edit, and an atomic SQLite implementation. They also exposed completion-recording friction. This is **postpatch acceptance evidence**, not a measured improvement against a matched prepatch control or a guarantee of reasoning quality.

All four traces record `gpt-6-luna`, resolved effort `max` from the request, Planning `on`, fresh native threads (`reused: false`), and full instructions without an instruction-budget limit. The reviewed runtime planning patch was `6e8b43b`; the source/evaluator checkpoint was `b79be56`. These receipts establish the recorded configuration and execution, not private reasoning depth.

The evaluator and interpretation rules are documented in [PLANNING-BEHAVIOR-EVAL.md](PLANNING-BEHAVIOR-EVAL.md); implementation is [scripts/planning-behavior.mjs](../scripts/planning-behavior.mjs). Candidates saw their own task folders, not the evaluator or its hidden acceptance checks.

## Runs and receipts

| Case | Native run ID | Independent result |
| --- | --- | --- |
| 01: duplicate requests, listener defect | `receipt retained privately` | Pass; 10 checks |
| 02: duplicate requests, retry defect | `receipt retained privately` | Pass; 10 checks |
| 03: exact phrase correction | `receipt retained privately` | Pass; 2 checks |
| 04: atomic SQLite import | `receipt retained privately` | Pass; 6 checks |

The isolated verification directory is retained privately:

```text
private-isolated-verification-directory
```

Private development receipts (excluded from public source):

- `.build/planning-behavior-native-evidence-20261028-0644.json`: baseline, admissions, completed-run metadata, and score references.
- `.build/planning-behavior-native-score-20261028-0644.json`: independent output results.
- `.build/planning-behavior-native-trace-case-01-20261028-0644.json` through `.build/planning-behavior-native-trace-case-04-20261028-0644.json`: per-case plans, external tool results, patches, final files, and outputs.

The four task runs started between 2:44 and 2:45 a.m. and completed between 2:46 and 2:48 a.m. Eastern time on October 28. Machine receipts retain UTC timestamps. Trace review used exported copies in `planning-native-review/case-01.json` through `case-04.json`; it did not require private reasoning.

## Observable judgment

### Different causes under identical prompts

Case 01 read the lifecycle and transport code, then reproduced two requests after mount/unmount/remount and one request after unmount. It identified the callback-identity mismatch: `mount()` registered `onSubmit`, while `unmount()` attempted to remove a fresh arrow function. It compared exact listener removal with request deduplication, correctly noting that deduplication could hide the symptom while retaining an inactive listener or suppressing deliberate repeated searches. The repair changed one line; correct retry code remained intact.

Case 02 found a different cause. Before editing, its actual EventEmitter reproduction returned two requests with `listenerCount: 1`. Its recorded diagnosis explicitly located duplication in `status >= 200`, rather than listener removal. It distinguished the sufficient `>= 500` retry repair from additional mounted-state checks. This supports evidence-responsive diagnosis; no forced change of opinion was necessary.

Case 02 also added idempotent mounting and a callback guard. These were small, related robustness changes, directly tested, but unnecessary for the reported navigation sequence. They should be described separately from the demonstrated root-cause repair. The final statement about stale callbacks should be limited to callbacks invoked while unmounted: the boolean guard does not establish mount-generation isolation after a later remount.

Both runs executed real inline Node assertions and inspected successful exit codes. Checks covered navigation, independent same-term submissions, inactive views, and bounded retries. Case 02's eight native test scenarios used `503`; the independent evaluator additionally checked the exact `500` boundary and other cases. Verification was not inferred from planning prose.

### Exact edit and settled implementation direction

Case 03 replaced only the requested phrase. The 73-byte output matched the expected substitution, the second intentional typo remained, and no files were added, deleted, or renamed. Its byte checks and independent evaluator support successful scope control. Repeated completion attempts added friction without improving the already-correct edit.

Case 04 accepted SQLite as settled and implemented the supplied schema and atomic import. It preserved inputs and existing data. The independent checks included a different CSV imported into an existing schema and rollback after a later invalid row.

Its native verification illustrates useful recovery: the first attempt failed from command quoting; the second printed successful assertions but exited nonzero because a verification connection prevented temporary-file cleanup. The agent did not count either attempt as complete verification. It corrected the harness and cleanup, reran successfully, and disclosed the two earlier failures. Candidate implementation and verification-harness failures should remain distinct.

## Qualitative resume follow-up

Fresh native run `receipt retained privately` used the original prompt, `analyze the following resume`, and the same privately retained attachment. Saved execution metadata confirms `gpt-6-luna`, resolved effort `max`, Planning On, a fresh thread, and the full instruction set. It completed. The repository receipt is `.build/planning-behavior-native-resume-20261028-0644.json`.

The saved plan and output contain concrete evaluation-focused and product-research headline/summary alternatives, explain what each foregrounds or displaces, and condition the choice on the target role. The final output discusses page breaks and unused space without enforcing an arbitrary page count. It separates source-based analysis from external verification and explicitly says ATS parsing was not tested. Saved execution observations include successful source-read and page-image calls.

This is qualitative evidence of usable comparison and bounded claims. It is not an objective measurement that either positioning is best. Typography, emphasis, project length, and compensation-bullet recommendations remain editorial judgments. No rewritten or rerendered resume was required by the analysis request, and none is credited as produced.

## Completion-recording defect and follow-up

Case 02 encountered three rejected completion updates; Case 03 encountered two. The result/evidence completion contract produced repeated reads and resubmissions even after useful work had occurred. This is runtime interaction friction, separate from the accepted outputs and supported diagnoses.

A targeted correction preserves the meanings of the existing fields: `result` is the planned output, `note` is the prospective procedure, `doneWhen` is the completion criterion, and `evidence` records the actual finding and checks. The live tool descriptions and `describe` response now show an evidence-only completion update. A rejected update names the prospective fields that changed and explains how to correct the payload without repeating already completed work. A genuinely revised output, procedure, or criterion must still be saved while unfinished before that revised work is performed.

The admission predicate and rejection of copied planning text as completion evidence are unchanged. Legacy tool definitions and instructions for versions 1–7 are preserved, and the current version 8 argument structure is unchanged. The changes are feedback and guidance, with no additional planning field or deliberation requirement.

Trace export was corrected to retain the first and last observation of each revision, plus its saved timestamp. Raw events confirm Case 03's plan preceded its file edit; later rereads of the same revision had previously obscured that chronology. No same-revision work definition changed in any of the four runs.

- **Targeted correction validation:** 85/85 source tests and the same 85/85 tests against installed modules passed on Windows, with no skips or cancellations. Receipts: `.build/planning-completion-source-test-receipt-final-20261028.json` and `.build/planning-completion-installed-test-receipt-20261028.json`. New tests exercise the rejected native payload, unchanged saved bytes/revision, corrected completion, preserved prospective fields, and the executable live-help example. An older test's obsolete prose assertion was replaced by checks of the example's actual required fields.
- **Correction activation:** Complete. BLACKICE's native restart receipt `receipt retained privately`, for request `activation request retained privately`, reports a completed restart on the same connection and profile. The installed runtime hashes match the reviewed source. The installation and backup receipt is `private-activation-backup/receipt.json`.

### Fresh native follow-up after the correction

Only the two cases that exhibited completion-reporting loops were repeated, with fresh original inputs, the same task wording apart from the directory path, and the same resolved model, effort, Planning On, and full instruction setting.

| Case | Fresh native run | Independent checks | Rejected completion updates, initial → follow-up |
| --- | --- | --- | --- |
| 02 | `receipt retained privately` | Pass; 10 checks | 3 → 0 |
| 03 | `receipt retained privately` | Pass; 2 checks | 2 → 0 |

All recorded completion updates in these reruns supplied `evidence` while omitting the prospective fields; each was accepted on its first attempt. Case 03 separately recovered from one unsupported directory-listing depth. That was a workspace-argument error, not a rejected completion or a failed output check.

The follow-up root is `.build/planning-behavior-followup-20261028-0707`. The generic preparation command created all four folders, but Cases 01 and 04 were declared unworked before these reruns and are not counted as native follow-up results. The raw full-root scorer therefore records those untouched folders as failures; the executed Cases 02 and 03 both pass. The receipt retains that full raw score alongside the explicitly selected results.

Follow-up receipts:

- `.build/planning-completion-native-followup-20261028.json`: launch settings, actual run metadata, completion payloads, failures, and score.
- `.build/planning-completion-followup-score-20261028.json`: unchanged-evaluator results with executed and unworked case IDs.
- `.build/planning-completion-followup-trace-case-02-20261028.json` and `.build/planning-completion-followup-trace-case-03-20261028.json`: saved plan snapshots and external tool results.

These two reruns support the targeted recovery correction. They are one observed rerun per case, not a statistical estimate of the error rate.

The evidence supports these bounded outcomes. There is no matched prepatch control, repeated-trial estimate, or general guarantee that planning artifacts produce deeper reasoning.
