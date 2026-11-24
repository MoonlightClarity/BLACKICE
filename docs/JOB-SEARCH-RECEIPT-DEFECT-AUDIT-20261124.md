# BLACKICE: November 23–24 job-search receipt audit and generalized harness repairs

**Evidence window:** November 23–24, 2026. **Scope:** prior real BLACKICE browser/job-search diagnostic workload, not a new job search. No employer form was reopened or resubmitted during this audit. The goal and saved application history were not edited.

## Evidence sources and interpretation

- Read-only BLACKICE runtime records: `%APPDATA%/Relay/data/run-state.sqlite`, especially runs `5637a260-8313-4fa3-a8e6-7e22b4b78ce2` (failed), `04f680d9-a0f8-4b58-bde5-047f60fd8b7e` (user-paused), and `c52244bb-6542-43db-a633-d5f3fde02f36` (completed).
- The saved goal state for conversation `4fe33c5c-f50e-43e4-a7d0-994abb2e905d`, plus user-held application records under `Documents/Job Search/Application History`.
- The event-ledger records are bounded retained windows, not all browser activity from the entire overnight campaign. The 81 recently modified history JSON files are not 81 unique successful new applications; they contain earlier receipts, confirmed and uncertain attempts, duplicates, checkpoints and rollups. Do not combine status labels into a new-application count without requisition reconciliation.
- Only the relevant error types and workflow decisions are recorded below. Names, applicant details, browser form text and private profile paths are not reproduced.

## Observed defects, changes, and verification

| Evidence from the recorded run | Root-cause category | Repair in this isolated branch |
| --- | --- | --- |
| An active run ended `CODEX_TOOL_FAILURE_LOOP` after repeatedly issuing native browser `fill` with `value`, which the tool rejected with `BROWSER_VALIDATION` and `GOAL_REPLAN_REQUIRED`. | Cross-domain tool-call argument recovery; not a candidate fit decision. | Normalize only unambiguous `fill` + string `value` into a `text` field at the agent/browser, driver and direct-execution boundaries. Preserve durable original arguments; do not accept contradictory or non-string input. |
| `BROWSER_TASK_TAB_LIMIT` repeated as the task reached eight live pages, including attempts to activate suspended views. | Resource-budget recovery and browsing efficiency. | Return an owner-scoped task capacity receipt and a concrete `tabs` next action. Advise reuse of an owned page or safe suspension after checking its effects. No automatic eviction of unfinished forms, downloads, protected or unrelated tabs. |
| An uncertain browser navigation was followed by `GOAL_EFFECT_UNRESOLVED`; a subsequent reconciliation attempt received `GOAL_EFFECT_IDENTITY_REQUIRED`. | General effect-continuity and deterministic recovery. | Include the exact observed signature, timestamp, receipt ID and resolution revision in the refusal when known. Require inspection and evidence before choosing occurred/not occurred/unknown; never infer success or automatically replay. |
| `BROWSER_REF_STALE`, `BROWSER_TARGET_COVERED`, `BROWSER_NAVIGATION_FAILED` and `CONTEXT_ARCHIVE_INVALID` also appeared. | Additional browser/document-state and tool-schema failures. | Retain as separate outstanding analysis lanes; the new fixes do not claim to resolve every occurrence. The older pre-input/ref-correction and live-data-reclamation changes already in v2.40.80 remain in place. |
| Saved work distinguished confirmed employer submissions, `not_submitted`, `submitted_pending_account_completion` and uncertain receipts. An external CAPTCHA on an account sign-up prevented one submission. | Outcome reconciliation and truthful reporting. | Retain the actual destination status. A CAPTCHA is a real interaction challenge, **not** proof of an applicant's ineligibility and not equivalent to a legal/factual attestation. No duplicate submission was made in this audit. |
| The agent sometimes treated compensation/source ambiguity or required form declarations as grounds to bypass a candidate rather than advocate for the person and pursue legitimate completion routes. | General judgment, agency and inefficiency, exposed by job searching. | Strengthen shared harness identity, bundled SOUL seed, general outcome-review guidance and the job-search execution method. A third-party preference, agreement or attestation does not itself veto the user's authorized objective. Distinguish delegated assent from truth-constrained factual claims; infer responsibly, verify material facts, preserve pending work and pursue alternate same-target routes rather than self-rejecting. |

## Generalization and authority

These are **software agent defects**, not merely job-search ranking-policy changes. Shared guidance applies to procurement, onboarding, vendor agreements, account setup, support cases and other web forms, while the native-browser correction and unknown-effect binding apply regardless of the task.

Never fabricate work history, legal eligibility, credentials or submission confirmation. Conversely, the absence of an attached certificate, a counterparty's preference, a standard form agreement or a question labeled “attestation” is not sufficient evidence that the user's requested action should stop or that the user is unqualified. Distinguish the actual user's prohibitions from third-party wording. If a factual assertion genuinely cannot be defended, isolate it, keep the pending target, and continue useful work or a legitimate alternative path. Do not manufacture an affirmative answer.

The owner-maintained `%APPDATA%/Relay/data/identity/SOUL.md` already explicitly says legal attestations and uncertainty are not blockers. It was **not overwritten**. The bundled default SOUL change seeds future profiles; the shared harness identity and review instructions generalize behavior for active runs according to their normal delivery rules.

## Qualification and limitations

Tests cover the corrected browser argument path, native driver, direct job idempotency, capacity hints, goal-effect reconciliation identity, shared identity guidance, outcome-review delivery, existing job-search skill integration and historical regression fixtures. Source tests are synthetic fixtures; they do not prove performance on every real employer portal.

The branch under `fix/jobsearch-receipt-harness-20261124` is isolated from the installed v2.40.80 release and the user's paused Goal. A passing test, a source commit and the existence of confirmed application history are three different observations. Do not describe this repair as installed or released until a future integration/installation is independently verified.

## Further work requiring separate evidence

Measure loop concentration over the complete event window (including provider turns and repeated page inspections), confirm why the model entered repeated malformed calls, validate stale-document and `ERR_ABORTED` navigation recovery across redirect and iframe cases, and analyze actual employer search-source ranking for low-return browsing. Re-run a controlled real-world representative task after merging to confirm useful throughput and retained user agency. Preserve historical receipts and the user's instructions while doing so.
