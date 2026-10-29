# BLACKICE 2.37.0 — Recursive planning and post-work reassessment

This release makes Planning On a continuing part of the work. The agent saves concrete substeps before attempting them, records actual findings, returns to the plan to decide what follows, and completes a fresh reassessment before publishing its final response.

## Concrete, chronological substeps

- Plans can contain nested sequence, parallel and choice groups. Each executable leaf identifies one tool operation or one bounded reasoning question, its expected result, its procedure and its completion check.
- Planning On executes one eligible leaf at a time. Tool dispatch checks the saved operation and prerequisites, and the previous operation's result must be recorded before another operation proceeds.
- Material analytical comparisons belong in their own substeps. A phase such as “compare every option and choose the winner” needs decomposition when it contains several distinct comparisons.
- The outline preserves parent-child relationships and displays dotted numbering such as `1`, `1.1` and `1.1.1`. Collapsing a group retains the saved numbering; reordering siblings changes the outline consistently.

## Executable decisions and returning to earlier work

- Choice groups support ordered `IF / ELIF / ELSE` with nested `AND`, `OR`, `NOT` and Boolean `XOR`, plus equality, ordering, membership and supported identity comparisons.
- Branches operate on recorded constituent observations. An unknown earlier condition prevents fallthrough; missing evidence is not silently treated as false.
- `revisit` reopens an earlier action or group, preserves its prior attempts and findings, and marks affected dependent work for reassessment.
- Reopening a step does not undo or repeat its previous effects. Uncertain operations retain their identity until their actual outcome is reconciled.

## A real return to planning before the response

- Task-tool schema 10 adds an explicit review after actual reasoning or tool work. The agent records whether to continue an eligible leaf, respond with the completed result, or report a genuine blocker.
- A plan read or a `done` status alone does not satisfy this reassessment. The final review is tied to the relevant plan, recorded operations and accepted user direction; changes require a fresh review.
- A premature final answer remains an unpublished candidate while the same accepted task returns to planning. Completed operations are preserved. A compliant model can finish the entire cycle within one provider turn; no fixed number of turns or tokens substitutes for the work.
- Scoped workers review their own assignments, so unrelated pending work does not prevent a completed handoff. Planning Off retains its ordinary behavior.
- Existing schema 9 tool definitions remain unchanged. Planning On upgrades older native conversations through the existing continuity path while preserving the BLACKICE conversation and task history.

## Chronological presentation and saved conversations

Chat presents planning, work updates, reassessment and the final response in chronological order. Nested substeps retain their hierarchy across the Planning views. Saved conversation and archive records preserve the public phase metadata needed to reconstruct that sequence when reopened.

The visible timeline uses saved plan events, recorded findings, concise review summaries and public message phases. When an actual final-message start follows a dated review, it can show a clearly labeled “Compose response” activity. It does not expose private reasoning or invent a missing activity.

Reopened workshop records preserved the repeated planning returns and one final answer. The first run reconstructed `Plan → Think → Plan → Think → Respond`; the second retained all five outcome/review cycles, response preparation and the final response. These archive checks are separate from the synthetic browser fixture, which passed its ten presentation checks and visual inspection.

## Verification status

The [public dogfood summary](docs/PLANNING-DOGFOOD-2026-10-29.md) distinguishes completed model observations, targeted tests and remaining validation. It includes early planning failures and the corrections they prompted. The [planning guide](docs/RECURSIVE-PLANNING.md) documents the condition language, review contract and recovery behavior.

The second ordinary workshop trial saved five reasoning leaves, kept at most one active, and recorded four continue reviews followed by a fresh respond review. Its selected bundle ($155) and nearest valid alternative ($165) were correct. One saved finding incorrectly described the $155 result as $25 below a $170 cap; the correct margin is $15, and the final answer did not repeat the error. This establishes candidate-level decomposition and repeated reassessment for that trial, not the finest possible decomposition or a guarantee of semantic correctness. The workshop trial did not exercise an executable choice or revisit.

The complete Windows source suite passed 5,265 tests across 430 test files, with eight predefined optional integrations skipped and no failures, cancellations or required skips. The tested 2.37.0 checkpoint is identified in the [source verification record](https://github.com/MoonlightClarity/BLACKICE/blob/v2.37.0/verification/windows-2.37.0.json). That receipt binds the result to its tested commit, source files and logs. Publication of the Windows installer requires a separate fresh passing receipt for the exact Setup executable. The [release page](https://github.com/MoonlightClarity/BLACKICE/releases/tag/v2.37.0) and its attached installer verification records report the actual publication status and checked artifact. A patched development installation, synthetic UI fixture or successful model run does not establish that the Setup installer passed.

The installer retains the existing per-user Windows installation and profile-continuity policy. Its release manifest records its actual signing status.
