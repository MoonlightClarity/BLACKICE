# BLACKICE 2.39.70

## Directory execution

- Replaces the contradictory closed-world worker prompt with explicit phase instructions. Execution phases use the attached tools to fulfill the user's objective.
- Adds a required execution status and next action. Incomplete work continues in the same model session before synthesis instead of repeatedly turning into a final summary.
- Carries complete host tool receipts into dependent work and continuation. Prior summaries cannot replace actual observed results.
- Retains truthful completion review, effect preservation and no-progress detection.
- Gives outcome review exact, short references for the full admitted evidence. Invalid references trigger a review-only correction against the same receipts and candidate; completed actions are preserved and never replayed to fix citations.
- Shows an identical failure diagnostic once while retaining distinct actionable messages.

## Browser input

- Requires explicit `text` for a fill action. Missing text or a select-only `value` now fails before focus or keyboard input; `text: ""` remains an intentional clear.

## Conversation context

- Scopes automatic Directory knowledge and learning to the current conversation's lineage, including when other conversations share its workspace.
- Groups the Context inspector by conversation and adds editing, full JSON corrections, deletion and a Changes view.
- Imports exactly one explicitly selected record from another conversation, with source provenance and a stable current-conversation destination.
- Uses current user-managed context in subsequent execution, preserving corrections through runtime refreshes and preventing deleted content from returning through old synthesized handoffs.
- Keeps drafts open during updates to the same conversation and resets inspection when the user switches conversations.

## Long-context models

- Uses the selected model's supported maximum context by default, while preserving explicit conversation settings.
- Removes fixed Directory document, objective, summary, dependency, receipt and final-answer clipping. Fresh phases reload full relevant evidence.
- Partitions source material and synthesis only when the complete phase exceeds the model's actual usable capacity; unknown capacity receives no invented fallback ceiling.
- Accepts long Directory messages and full context edits. Large tool reads and audit history remain accessible through paging.

## Verification

- The complete Windows source suite passed 8,197 tests with zero failures, zero required skips and 11 optional skips. The receipt is bound to the final source inventory and runtime fingerprint.
- A fresh native gpt-6-luna run with Directory and all nine Planning modules On submitted both eligible synthetic intake records exactly once, left the ineligible record untouched, and completed with an accepted final outcome review. The independent server ledger verified all form values, both unique receipts and zero duplicate or invalid submissions. No manual steering or form actions were used.
- That native run used three fresh Directory contexts and the selected model's actual capacity, with 812,016 usable input tokens for this model configuration.
- The rendered Context inspector imported a 644,016-character record, saved an edited 644,030-character copy, preserved the source, rejected a stale edit while retaining its draft, deleted the imported copy, and paged through all 85 audit records. Desktop and narrow layouts were checked in the native app.

Source-suite and live acceptance evidence are recorded separately under `verification/`. The intake task was local and synthetic; these checks do not assert real job-application submissions.
