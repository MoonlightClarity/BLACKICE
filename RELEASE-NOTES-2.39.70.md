# BLACKICE 2.39.70

## Directory execution

- Replaces the contradictory closed-world worker prompt with explicit phase instructions. Execution phases use the attached tools to fulfill the user's objective.
- Adds a required execution status and next action. Incomplete work continues in the same model session before synthesis instead of repeatedly turning into a final summary.
- Carries complete host tool receipts into dependent work and continuation. Prior summaries cannot replace actual observed results.
- Retains truthful completion review, effect preservation and no-progress detection.
- Shows an identical failure diagnostic once while retaining distinct actionable messages.

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

Verification includes deterministic execution, context lifecycle and mounted UI regressions. Live model and installed application checks are recorded separately from source-suite results; this release does not assert real job-application submissions from synthetic acceptance tests.
