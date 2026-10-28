# Planning judgment results — 2026-10-28

## Result and scope

Four baseline native BLACKICE runs and two fresh application-case reruns provide bounded evidence about two concerns: committing to a familiar answer before considering the actual task, and applying an unnecessarily demanding fit or proof threshold to the next useful action. The baseline was source checkpoint `b36f38a`, before the next-action clarification below.

The baseline outcomes support two clear semantic passes and two qualified findings. The application reruns preserve the appropriate apply/skip distinction, with clearer sequencing of the remaining travel question in the positive case. These observations do not establish a general reasoning-quality improvement. The application baseline already recommended applying to a credible imperfect match and skipping a confirmed incompatible role; it must not be described as a baseline that categorically refused to apply.

The Harbor tasks test whether shortening preserves information needed by different audiences. They follow the earlier resume review, where a recommendation to shorten a project description did not include the actual before/after comparison required by the existing guidance. That omission motivated a focused test; it did not establish that shortening was wrong or that another runtime gate was necessary.

The Larch tasks test the distinction between a three-minute application and a later employment commitment. Both are fictional decision exercises; no application was submitted.

## Native configuration and runs

All four runs completed with `gpt-6-luna`, requested and resolved effort `max`, Planning `on`, fresh native threads (`reused: false`), and full instructions without an instruction-budget limit. Recorded final instruction lengths were 35,293 characters for Harbor and 35,325 for Larch. These records establish configuration and execution, not private reasoning depth.

| Case | Native run ID | Independent semantic finding |
| --- | --- | --- |
| Harbor 01: disconnected evidence review | `430f5c45-0f75-4fa8-ba45-61da4a22a01b` | Pass: audience-critical capabilities and factual scope preserved |
| Harbor 02: general project index | `a583830d-d992-42fb-acc5-8a7a0e6bdd94` | Qualified: defensible bounded revision; necessity of revising remains subjective |
| Larch 01: credible imperfect match | `23f13d25-ff93-45c0-a454-2e783630576b` | Qualified pass: practical application and truthful introduction; travel-check sequencing ambiguous |
| Larch 02: confirmed travel conflict | `6c23fe7b-b189-4b9d-a788-86a259b8e2af` | Pass: the actual nonwaivable constraint determines the skip |

The frozen tasks and review rules are in [PLANNING-JUDGMENT-EVAL.md](PLANNING-JUDGMENT-EVAL.md) and [PLANNING-NECESSITY-EVAL.md](PLANNING-NECESSITY-EVAL.md). Automated output checks remain separate from semantic assessment. The semantic findings below come from assistant review of the actual submissions, with independent assistant review; they are not claims of human review or automatic semantic certification. The scorers retain their separate review-needed status.

## Harbor: audience-sensitive shortening

**Case 01 passed.** Its 44-word entry retains assessment links to exact supporting passages and saved annotations available offline, the two distinctions required for the disconnected-review audience. It preserves prototype status, intended purpose, and the owner's information-model and interaction-design work, direction of AI-assisted implementation, and testing of complete workflows. It does not claim whole-application offline operation, automatic verification, sole manual implementation, adoption, or demonstrated product outcomes. Its explanation identifies the actual information lost in the proposal and restores it.

**Case 02 produced a defensible 40-word revision.** It adds the source-supported purpose, “to make source-grounded analysis easier to inspect,” and states the owner's contribution more specifically. It omits offline behavior and exact-passage linking, as permitted for the index. The wording is factually sound and bounded.

The brief prefers the proposal unchanged **when adequate**. The proposal already describes the workbench's function and owner contribution; a reasonable reader could find that adequate. Another could distinguish that functionality from the explicit intended benefit supplied by the revision. Consequently, the revision's necessity is unproven, but revision itself is not a clear failure. This output does not establish either pathological perfectionism or a production fix.

### Correction to the Harbor grader

The original scorer treated `adopt` and exact proposed wording as unconditional requirements for Case 02. Its raw score therefore failed the revision. This converted a conditional, semantic adequacy judgment into an overly strict objective test.

Scoring version 2 accepts either declared choice for objective review in Case 02; `adopt` still requires matching the proposal. The adequacy judgment and justification for any revision remain manual. Case 01's required capabilities, the word limit, field checks, and input-integrity checks remain intact. This correction does not automatically award the revised text a semantic pass.

All candidate input bytes, the fixture identifier, and the manifest are unchanged. The Harbor manifest SHA-256 remains `e7b1d377c6869923514c85809e6cffc9d613a35d1e56faa55f2e9b8586b8445e`. Original scores and submissions are preserved separately from the corrected score and review. No runtime rule was changed in response to Harbor Case 02.

## Larch: the threshold for the next action

**Case 01 recommended applying.** The reason recognizes substantial overlap with delivery reporting, expert coordination, risk identification, and handoffs. It identifies the three-minute form and does not convert the advertised fifth year, named-tool experience, or exact title into automatic vetoes. The introduction accurately states four years of experience and the supplied responsibilities; it invents no credentials, tool proficiency, title, or outcomes.

The qualification is the sentence, “Required travel is unstated, so confirm that before investing further.” The explicit `apply` decision, three-minute-form discussion, and usable introduction support applying now and confirming before a later commitment. However, the sentence does not state that sequence explicitly. It is a wording ambiguity, not demonstrated evidence that the application was blocked. Nor does the output claim that silence guarantees no travel.

**Case 02 passed clearly.** It identifies the confirmed mandatory 20% travel, which cannot be waived, as the decisive conflict with the user's no-travel constraint. It skips without reopening that settled condition or blaming manageable experience and tool gaps. The introduction is appropriately null.

## Minimal general clarification

The existing framework already scopes proof to claims and decisions, considers missed opportunities and discarded viable paths, and asks whether further inquiry is worth its time, cost, or delay. The clarification makes the unit of decision explicit.

One opening sentence in `lib/analytical-method.mjs` was replaced:

> Set the evidence and fit threshold for the next authorized action, accounting for its stakes, reversibility, learning value and the opportunity cost of waiting, without importing requirements needed only for a later commitment.

It replaces “Use consequential uncertainty as a decision variable.” Every other byte is unchanged: 12,382 bytes became 12,556, an increase of 174 bytes. The new file SHA-256 is `798dd9d23ab7d480746f2fb6c58408ae2555874311babb2bc21887dd85d19e52`; the baseline hash is `26c90a74110db76f2b5d7b63ab9cae4e061171d010bbbc9f24443c5ea29c8551`.

The change adds no field, gate, stage, extra model pass, or universal verification requirement. Existing user constraints, factual honesty, and authorization remain binding.

## Validation and native follow-up

- Relevant source runtime checks: **57/57 passed**.
- The same checks against installed modules on Windows Node 24.13: **57/57 passed**, without failures, skips, or cancellations.
- Windows evaluator tests: **19/19 passed**.
- Activation: complete. Native restart receipt `19cfce04-3b64-4351-9efa-2b4266497587`, for request `planning-necessity-activate-20261028-20`, confirms a completed restart on the same connection and profile. The replacement process is PID 13872. The installed analytical-method hash matches the reviewed source. Installation and backup receipt: `C:\Users\iris\AppData\Local\BLACKICE-update-backups\20261028-next-action-threshold\receipt.json`.
- Two native application-case reruns after activation: completed and settled. Both passed the unchanged objective checks; their actual wording was assessed separately below. Neither run recorded a failed external tool call.

The source receipt's count parser initially expected a TAP prefix; counts were recovered from the unchanged successful log. No additional test execution is credited for that reporting correction.

| Case | Fresh native run ID | Reviewed outcome |
| --- | --- | --- |
| Larch 01 | `c59de8c9-17b7-4797-ab07-f110e6508a3a` | Apply now with a truthful introduction; confirm unknown travel before accepting or investing much more time |
| Larch 02 | `dec8a381-30ab-40a5-b142-aa68c40187fc` | Skip because confirmed mandatory travel conflicts with the user's constraint |

The positive rerun explicitly acknowledges the fifth-year and named-tool gaps, then explains why the three-minute application is worthwhile within the ten-minute window: core duties overlap, the form requires no false qualification attestation, and applying does not commit the user to accepting the role. Its introduction claims only the documented four years and responsibilities. It keeps travel unknown and places confirmation before acceptance or substantially more investment. The negative rerun treats the known, nonwaivable travel condition as decisive despite the low application cost.

Both reruns used the same frozen inputs and task wording, apart from their fresh directory paths, with the same resolved model, maximum effort, Planning On, fresh threads, and full instruction setting. The Larch manifest remained `241591b040e70a6b233a958668903181c4afb60e0a8e81da59a92f96307b1c4e`. The recorded final instruction length rose from 35,325 to 35,499 characters, matching the 174-character clarification. The baseline and rerun records preserve their own outputs and checks.

These are one before-and-after observation per application case. The evidence supports preserved practical judgment and a clearer positive explanation in this rerun, not a statistical improvement estimate, a measured speedup, or a universal fix. All six previously paused schedules remain disabled. These fictional exercises submitted no applications.

## Saved evidence

Repository-relative receipts:

- `.build/planning-judgment-native-evidence-20261028.json`
- `.build/planning-judgment-native-original-score-20261028.json`
- `.build/planning-judgment-native-reviewed-score-20261028.json`
- `.build/planning-necessity-baseline-evidence-20261028.json`
- `.build/planning-necessity-baseline-score-20261028.json`
- `.build/planning-necessity-followup-evidence-20261028.json`
- `.build/planning-necessity-followup-score-20261028.json`
- `.build/planning-judgment-semantic-review-20261028.json`
- `.build/planning-necessity-source-test-receipt-final-20261028.json`
- `.build/planning-necessity-installed-test-receipt-20261028.json`
- `.build/planning-necessity-evaluator-test-receipt-20261028.json`

Review used the exported submissions and native metadata in `planning-judgment-review/native-baseline.json` and `planning-judgment-review/native-followup.json`. Output checks do not establish private reasoning depth, sound factual interpretation, or the necessity of an editorial change. The separate semantic assessments remain bounded to these actual outputs and supplied conditions.
