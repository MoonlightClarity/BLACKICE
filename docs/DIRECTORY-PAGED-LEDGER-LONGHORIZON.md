# Directory long-horizon receipt and artifact scaling

**Date:** 2026-11-23
**Branch:** feature/directory-paged-receipts-20261123 (isolated, child of the head/tail preview experiment at fad9f51b985423766be5c19cb58d15b0a99f7fd6).
**Control:** unmodified BLACKICE 2.40.75 at 3fc873c8394fb8381456c305cd91068ce9b98eac.
**Scope:** offline scripted Engine/Directory integration and regression tests, with no release, installer change, or main-branch mutation.

## Observed problem

The existing TaskActionDirectory rejects tool receipts once a task has 256 receipts. This
shortens the effective supported task even when the model's context window is not full.
The experimental context-paging tool makes this worse by issuing read/search calls that
occupy some of the same receipts.

On a scripted request for 270 large observations, the old control succeeded on 256
observations before DIRECTORY_CAPACITY and the original context-paging experiment
succeeded on 252 observations. The latter had used four other receipt slots for retrieval
checks. Neither completed its source-code repair or its test.

An additional storage inefficiency occurred: 500 repeated large observations produced
1,002 archive files, although the vast majority of their contents were identical.

## Implementation in this child branch

- The durable task-local Directory ledger now permits up to **8,192** recorded host receipts
  rather than 256, with an explicit bound and validation. It does **not** discard, overwrite,
  or silently compact older receipts. Unresolved effect receipts retain their original
  identities and still block unauthorized re-execution.
- The model-facing Directory state remains bounded. On ledgers above 256 receipts,
  Directory modifications return a compact active view. A Directory read returns a
  task-scoped external reference to the complete ledger alongside the bounded view,
  so the model can search or page older details.
- Tool-result archives use task- and tool-scoped content addresses, verifying full
  source bytes before reusing an existing artifact. Parallel callers, reopened stores,
  and two store instances sharing a task converge on the same saved content.
- A failed archive operation returns the original full tool result. It must never
  destroy an earlier shared archived artifact. Same-size content corruption is detected.
- Existing random-reference artifacts remain readable as before.

The host still persists complete Directory JSON snapshots. This is a **bounded-ledger
scaling step, not a fully out-of-core, append-only event store**. The remaining linear
read/rewrite costs may be substantial at thousands of receipts.

## Reproducible comparison

The scripted benchmark uses the actual HarnessEngine tool path with 180, 270, or
500 or 1,000 large reads; literal evidence retrieval, a known failed read, a real
code write, a passing test, and Directory completion. It also checks retrieval of the oldest
receipt through archived Directory state and the complete ledger on disk.

| Workload | Control | Paged-ledger candidate |
|---|---|---|
| 270 requested reads | 256 reads; DIRECTORY_CAPACITY | 270/270 reads, pass |
| 270 total calls | 257; incomplete | 285; verified result and Directory closure |
| 500 requested reads | 256 reads; DIRECTORY_CAPACITY | 500/500 reads, pass |
| 500 total calls | 257; incomplete | 515; verified result and Directory closure |
| 500 candidate Directory receipts | Not completed | 511 receipts retained on disk |
| 500 candidate archive file count, before dedup | Not applicable | 1,002 files |
| 500 candidate archive file count, after dedup | Not applicable | **4 files** |
| 500 candidate archived bytes after dedup | Not applicable | **181,224 bytes** |
| 1,000 requested reads | 256 reads; DIRECTORY_CAPACITY | **1,000/1,000 reads, pass** |
| 1,000 total calls | 257; incomplete | **1,015; verified result and Directory closure** |
| 1,000 candidate Directory receipts | Not completed | **1,011 receipts retained on disk** |
| 1,000 candidate archive files | Not applicable | **4 files; 340,232 bytes** |

The deduplication decreases file count by **99.6%** for the deliberately repetitive
500-read fixture. At 1,000 reads it still saved only four files, with the second
archive accounting for the larger Directory history. This is not an expected saving
for unique source data.

**These are scripted harness tests, not real-model completion-rate estimates.** The
candidate now completes a scripted 1,000-read task the unchanged control cannot, but
a language model's ability to reason through the same sequence is unmeasured here.

## Test coverage

Focused tests cover receipt 301 after reloading a 300-receipt task, the oldest unknown
effect prohibiting a later write, rejection of corrupt overbound snapshots, paging and
search of a historic Directory receipt, recovery after process/storage failure, concurrent
deduplication across two independent stores, and same-length byte tampering.

Broader Directory and context-paging regressions were run on the isolated branch with
the same source. See the saved command receipts and raw result JSON in the results
folder below. A future release requires production-scale profiling and a same-model
multi-run coding benchmark with no infrastructure-invalid samples in the score.

## Remaining limits and release decision

- **8,192 receipts remains a finite host limit.** The implementation has not solved
  unbounded retention or efficient append-only persistence.
- Full host Directory state is still serialized on each transaction, which may
  impose rising latency and disk writes. Filesystem lifecycle/retention has not
  been implemented; deduplication alone is not a cleanup policy.
- It does not reconstruct native provider context, replace provider compaction,
  or guarantee that a model will retrieve the right evidence.
- In the original feature branch's authenticated native gpt-6-luna benchmark, a
  matched post-preview-fix scheduler pair passed 7/7 code tests in both variants,
  but the candidate failed Directory workflow closure while the control completed.
  Another candidate trial produced malformed Directory plan arguments. Scaling
  receipts does not establish that those separate model-planning behaviors are fixed.
- No merge, release or install is authorized by these measurements alone.

## Reproduce

From this child worktree, with the untouched control worktree in the adjacent directory:

    node --test --test-concurrency=4 tests/task-action-directory-ledger-scale.test.mjs tests/task-external-context*.test.mjs
    node scripts/benchmark-directory-stress.mjs --reads=270 --expect-control-capacity
    node scripts/benchmark-directory-stress.mjs --reads=500 --expect-control-capacity
    node scripts/benchmark-directory-stress.mjs --reads=1000 --expect-control-capacity

Raw results are stored outside the Git worktree:

    C:\Users\user\Documents\Codex\BLACKICE-context-benchmark-results-20261123

Relevant reports:
- offline-stress-270-capacity.json — previous experiment hitting capacity in both variants
- offline-stress-270-paged.json — first fixed ledger run
- offline-stress-500-paged-before-dedup.json — full run before deduplication
- offline-stress-500-paged.json — full run after deduplication
- offline-stress-1000-paged.json — longer successful run, exact ledger recovery

Never score an implementation or provider infrastructure failure as a model-quality
failure. Resolve the defect and rerun an identical task if the trial was not valid.
