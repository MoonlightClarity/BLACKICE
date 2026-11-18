# SQLite direct-tool receipts

The runtime uses `data/direct-execution.sqlite`, not a loose JSON receipt or pack backend.
Request identity and argument digests prevent repeated effects. Metadata is indexed separately from JSON payloads. Startup recovers unfinished rows only; completed payloads are fetched on explicit job lookup. Browser lifecycle queries use an owner index. Historical URL matches are not appended to tool results.

## Existing local installation

Do not install this change over existing receipts without the one-time import. Stop BLACKICE, verify a fresh backup, then run from the new source:

```powershell
node scripts/import-sqlite-receipts.mjs --data-dir "<profile>/data" --staging-dir "<new staging folder>" --publish
```

The importer acquires the normal executor lease, rejects a live executor or existing database, validates imported records, checks counts and SQLite integrity, and publishes an independent copy of the finished database by a same-directory atomic rename while holding the executor lease. The retained staging database and published database do not share an inode or WAL state. Original receipt files remain unchanged. A failed import leaves source receipts intact and requires a new staging folder on retry. Obsolete pending approval records become interrupted, never executed. Packed historical data is rejected rather than silently omitted; this importer supports the observed installation's loose receipts only.

This is an explicit operational import, not a runtime compatibility backend. No profile has been imported by these development tests. Do not delete original receipts or the staging copy as part of installation.

## Recovery and backup

Unfinished actions become interrupted on restart. Dispatched mutations retain possible-effect uncertainty; reads and undispatched work do not acquire fabricated effects. Saved browser dialogs are not advertised as still live after restart. Inspect the actual browser again.

SQLite uses WAL and FULL synchronous commits. Whole-profile backup must be offline and include the database plus any `-wal` and `-shm` files left by a crash. The existing offline profile backup is exercised by an abrupt-child-exit, backup/restore, and deduplication test. A normal close checkpoints through SQLite connection closure. This is not a claim of exhaustive power-loss testing.

Completed payloads are still retained on disk. This change removes their startup cost and automatic contextual injection; it does not silently delete user history or introduce an unapproved retention policy.

## Validation and retired tests

API tests retain argument confidentiality, request deduplication, caller isolation, cancellation, and uncertain commit behavior with SQLite fixtures. New tests cover unfinished-only recovery, transaction rollback, explicit import, no contextual enrichment, and crash-WAL restore. Semantic admission/capacity/revision and browser lifecycle assertions remain.

Removed tests exercised the retired JSON-reader concurrency, Windows per-file rename retries, pack publication/retirement, downgrade readers, and automatic URL-history enrichment. They are replaced by SQLite transaction/recovery/import/isolation tests, not skipped. Startup phase tracing remains; obsolete per-receipt scan instrumentation does not.

The synthetic benchmark seeds 76,379 receipts of approximately the observed payload size. Reopen measurements are warm-cache, same-machine measurements, not installed-app or cold-boot timing. Node 22.23.5 and Electron 44.7.2's Node 24.21.0 were exercised. Independent review and full release qualification remain required.
