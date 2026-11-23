# Directory context paging: diagnostic preview repair and capacity boundary

Date: 2026-11-23. Worktree branch: feature/directory-external-context-20261122. Target: BLACKICE 2.40.75.
The unchanged control is commit `3fc873c8394fb8381456c305cd91068ce9b98eac`.
This work is isolated: no installed app, main branch, user jobs, or release was changed.

## Confirmed context-preview design flaw and repair

Version 1 archived every read-only tool result larger than 12 KB but exposed only its first 300 characters.
For structured workspace results whose `content` contains a log, the decisive diagnosis may be at
the end. The prompt can therefore lose the most useful evidence while retaining an inaccessible
full original unless the model chooses additional search/paging actions.

Version 2 preserves bounded **head and tail** excerpts of the decoded content, not merely the
first 300 characters of an escaped JSON wrapper. It also preserves path/line-range/truncation
metadata, supplies a search-and-read recovery hint, and **never archives failed results**.
Original host tool results and Directory receipts remain unchanged. The saved text can still
be restored exactly by task-scoped paging and literal search.

Focused and Directory regression tests passed. A new regression directly verifies a diagnostic
marker at the end of a large structured result. The Engine fixture shrank 25,825 model-facing
UTF-8 bytes to 1,387 (94.6%) and reconstructed the original byte-for-byte.

## Repeated model-free long-horizon harness check

On the same 180-read scripted repair task:

| Observation | 2.40.75 control | Candidate v2 |
|---|---:|---:|
| Large tool reads | 180 | 180 |
| Total calls | 186 | 192 |
| Model-facing tool text | 3,711,930 bytes | 467,877 bytes |
| Directory receipts | 183 | 189 |
| Code repair, test, Directory closure | Pass | Pass |

The candidate therefore reduced returned tool text by approximately **87.4%**, at the cost of
six extra evidence retrieval calls. This is a payload-and-harness correctness test, not a claim
of improved model reasoning or coding success. Pre-v2 stress output was preserved separately as
`offline-longhorizon-stress-v1.json` in the external results folder.

## Authenticated native model trials

The native Codex app-server CLI was verified to be logged in through ChatGPT (not a paid API key).
Trial model: **gpt-6-luna**. Tasks were synthetic but required actual source edits and hidden tests,
using the same clean fixtures on the unchanged 2.40.75 control and the experiment branch.
Reference solutions pass cache **9/9** and dependency scheduler **7/7**.

- Pre-repair cache: both control and candidate fixed the code to **9/9**. Control closed Directory;
  the candidate ended with an active action. This is retained as a real pre-fix end-to-end failure.
- Pre-repair scheduler: the control produced **7/7** (Directory still active), candidate **0/7**.
  Do not treat the gap as a deterministic causal estimate from one stochastic pair.
- Post-repair scheduler: both variants produced **7/7**. The control fully completed;
  the candidate left its Directory action active. The candidate used 18 tool calls and about
  44.4 seconds; control used 18 calls and about 59.5 seconds.
- Additional post-repair candidate scheduler run: failed after **15 calls**, with repeated
  invalid `relay_directory_action plan` arguments (missing objective/dependsOn, misplaced
  claim, incomplete doneChecks). It did not fix code. This remains a **valid negative agent
  outcome**, not an archive corruption or provider quota error, and is not paired without a
  second control replicate.

The independent native scorer selects only exact post-repair candidate source hashes and
labeled unchanged control trials, excludes invalid infrastructure and earlier candidate
versions, and separately records **code correctness**, **Directory workflow completion**, and
**full end-to-end success**.

For the one currently matched post-repair scheduler pair, both passed **7/7 code tests**;
full end-to-end success was **control 1/1, candidate 0/1**. There is still **no established
performance advantage**. The small, stochastic sample and task-bookkeeping failures do not
justify a release.

## Reproducible 270-read capacity failure

The extended scripted stress requested 270 reads and recorded the existing hard
`DIRECTORY_CAPACITY` limit. The unchanged control completed **256 large reads**; the candidate
completed **252** because four additional context retrieval calls used the same 256-receipt
budget. Neither task reached its requested 270 reads.

That is a **shared Directory infrastructure boundary plus candidate-specific extra receipt
consumption**. Longer tasks cannot be scored fairly as model failures until the host retains
full evidence without the current tiny ledger cap. The test records this expected infrastructure
failure in `offline-stress-270-capacity.json` and does not score it as failed coding.

## Decision and next dependency

Retain the isolated experimental branch. The preview bug has a validated fix, but the
long-horizon capacity defect and stochastic native Directory planning/finalization failures
remain important. Do not merge or install.

Next: implement persistent/paged receipt handling on an **additional isolated branch**
without losing old receipt identities, cross-run linkage, or unresolved external effects.
Re-run the exact 270-read and then a larger stress fixture. Distinguish those improvements
from the original pure context-paging benchmark.

The saved reports and raw trials remain under
`C:\\Users\\user\\Documents\\Codex\\BLACKICE-context-benchmark-results-20261123`.

Commands:

    node --test --test-reporter=spec tests/task-external-context*.test.mjs
    node scripts/benchmark-directory-stress.mjs
    node scripts/benchmark-directory-stress.mjs --reads=270 --expect-capacity
    node scripts/score-directory-context-native.mjs --model=gpt-6-luna
