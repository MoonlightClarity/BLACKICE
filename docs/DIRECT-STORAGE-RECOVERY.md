# Bounded direct-ledger startup recovery

This change is isolated to failure during the initial receipt-validation scan. It does not repair receipts, replay actions, change antivirus settings, or bypass a denial.

## Eligibility and bounds

Only receipt `lstat` or `readFile` failures with an exact OS code in `EACCES`, `EPERM`, `EBUSY`, `EIO`, `EMFILE`, `ENFILE`, or `ENOENT` are eligible. The same instance retries on a later existing init/status call, after at least 30 seconds, at most three times after the original attempt. Concurrent callers share one promise and at most four receipt readers. No periodic scan is scheduled. The healthy initialization path retains its original promise.

JSON/schema failures, unsafe or oversized files, changed validated bytes, directory enumeration failures, lease failures, recovery-write uncertainty, and post-startup read/write failures do not enter this automatic retry path. Any integrity failure among concurrent readers takes precedence over an eligible access error. An exhausted retry budget remains unavailable in that instance.

## Preservation

Every receipt filename enumerated in an attempted startup remains required for all later attempts in that instance, even if it disappears from a later directory listing. Successfully validated hashes also remain fixed across attempts. Partial indexes are staged and never exposed as a successful ledger. Readers drain before a failed lease is released. A retry must reacquire the exclusive lease, validate all required receipts, and complete normal interrupted-state recovery before both the jobs and API storage latches are cleared.

Queued/running/cancelling work is recorded as interrupted, never resubmitted. Existing request IDs and digests continue to resolve to their exact saved receipt. Uncertain recovery writes remain failed, including a committed rename with a lost acknowledgement.

Diagnostics include only the hashed receipt filename, stat/read/validate stage, and an allowlisted OS code (otherwise UNVERIFIED). Original OS exception text, paths outside that filename, command arguments, and result bodies are not included.

## Limits

The remembered filename/hash set is in-memory. This change cannot detect a historical receipt already missing before the first enumeration of a new process. Durable critical-identity/body separation is a separate design problem; unreadable/quarantined bodies are not skipped here.

After the initial failure, status calls trigger or join a background recovery and promptly report unavailable with jobs.recovering while the shared scan is in progress. Real actions wait for complete validation and cannot dispatch during recovery. Background failures are consumed and remain visible as unavailable. Concurrent probes never cause one full scan per request. Initial startup still awaits its first scan; cooldown and attempt limits bound repeated failures, not individual filesystem-call duration.

The prior version discarded the OS cause. Synthetic EACCES tests demonstrate restored-access behavior but do not establish which code the actual antivirus incident produced or that antivirus recovery has been reproduced.

Validation uses disposable synthetic receipt fixtures only; no flagged sample, live profile, security setting, installer, or running app is modified.
