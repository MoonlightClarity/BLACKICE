# BLACKICE 2.39.71

## Directory context management

- Keeps oversized saved results and dependencies on disk, with a compact working set and exact references that the model can read as needed.
- Preserves the current worker session while a single work package responds to outcome-review feedback and finishes its report. Completed private sessions are not reopened or reused with a different tool contract.
- Retains complete original records and source hashes. Indexed records, inspected ranges, and inspected images are distinguished; an index is not a claim that every source was read.
- Uses the full selected model configuration before deciding whether evidence must be offloaded. Small packets follow the existing direct path. Exact reads page only when required by the current remaining capacity.
- Keeps saved screenshots as inspectable image artifacts instead of sending their base64 encoding as ordinary prompt text.
- Preserves completed and uncertain operations while changing context; saved-source reads and outcome review do not repeat operational work.
- Saves checkpoint receipt references and hashes instead of repeatedly copying the entire growing tool journal.

## Outcome review

- Carries the conversation's actual context configuration into the final reviewer, including Directory's extended model capacity.
- Gives an oversized completion review the original evidence index and scoped read access, retaining canonical evidence identities and citation validation. No automatic all-source summarization pass is required.

## Context measurements

- Separates configured capacity, provider-reported input usage, observed model windows, and compaction events.
- Keeps per-phase measurements and an observed peak across fresh sessions, including a final diagnostic summary when a later handoff fails.
- Does not interpret cumulative token usage as the size of a single context.

## Reported failure

The reported run had an 812,016-token configured input budget. Its retained telemetry showed a largest measured call of 424,813 input tokens, followed by a fresh synthesis call of 24,525 tokens. Earlier events were no longer retained, so these measurements do not establish the maximum over the entire run.

The failing saved work record contained 548 tool receipts and was 11,771,055 bytes. Replaying that exact record against 2.39.70 reproduced the capacity error before any provider call. The failure was caused by assembling an indivisible saved-result packet, not an observed exhaustion of the model's available window.
