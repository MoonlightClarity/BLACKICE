# Operational-effect receipts: durable SQLite ledger (2.40.75 source lane)

## Decision

Chat archiving is a conversation-lifecycle operation, not a receipt-retention or
repair strategy. A live goal cannot be archived to release journal capacity, and
archiving a completed chat must never discard evidence of an unresolved external
effect. An 8 MiB global JSON journal or 10,000-record ceiling is not a permissible
reason to stop normal work.

The effects store is an indexed SQLite database per existing workspace
(native-effects-<workspace hash>.json.effects.sqlite). It grows with available
disk space and does not reject receipts for crossing an arbitrary total-byte or
record-count threshold. Browser and workspace effects are reserved transactionally
before dispatch; a missing/corrupt ledger or failed transaction prevents input
dispatch. Ordinary read-only browser observations remain available.

SQLite synchronous=FULL transactions protect updates. An independent, durable
.sqlite.anchor binds the database identity and the preserved legacy journal
signature. If the database disappears, its anchor changes, or the pre-migration
journal changes, the application fails closed instead of inventing an empty
history or replaying an uncertain action. A damaged database or orphaned anchor
requires deliberate read-only recovery from retained originals and backups;
automatic destructive reset is forbidden.

## Migration and rollback

The first consequential operation after activating the new source migrates the
original version-1 JSON journal under its existing task-state lock. Migration
writes a temporary SQLite file, commits all rows, durably publishes the identity
anchor, then atomically publishes the database. The JSON journal is never
overwritten or deleted. An interrupted migration leaves either the original
journal readable or an anchor that prevents unsafe redispatch. Result sidecars
created by experimental predecessors remain readable and hash-checked.

Backup/restore must include the SQLite file and its matching anchor (plus any
referenced result sidecars). Do not restore only an older JSON journal or delete
the SQLite database to free space: that would lose effects written since
migration. Archiving, moving, or restoring a chat does not authorize receipt
deletion. In-place downgrade to the old journal writer is unsafe after new SQLite
effects exist without explicit reconciliation and data migration.

## Confirmed offline verification, 2026-11-23

The actual installed v1 journal was audited read-only; migration executed on
a disposable copy, not the live application:
- Before: 8,388,331 bytes, 348 unique operations, 340 unknown, 7 confirmed, 1 absent.
- After: 348 identities, 340 unknown, 7 confirmed, 1 absent.
- Source SHA-256 remained 38987335f226e29d6c7f421f0d7162b3411e9c124035177590c9c26628b67774.
- SQLite copy occupied 9,179,136 bytes after import.

The test suite exercises over 8 MiB and over 10,000 legacy receipts, exact-call
idempotency, missing/corrupt ledgers, orphaned migration anchors, cross-task
operations, and the host/driver receipt lifecycle. To audit another original,
run the verification/check-operational-ledger-import-20261123.mjs script with the
absolute source .effects path; it migrates a temporary COPY and cleans up.

## Activation boundary

This branch is source-only, based on verified installed 2.40.75 integration
checkpoint 3fc873c8. It has not modified, restarted, installed, or published the
active production BLACKICE application. Keep goal
7029174f-0217-41d6-8eda-a4d11b1949a2 running uninterrupted until its
2026-11-23T11:00:00Z absolute deadline. After the goal is settled and deadline
receipts independently checked, review/merge this isolated source, run release
integration tests against the final source, back up the unmodified profile and
journal, then activate with a verified rollback plan. Never force an old-version
downgrade that ignores newer SQLite receipts.

## Remaining limitations

- SQLite capacity depends on actual disk space and filesystem health; full
  disks fail closed.
- A foreign writer modifying the preserved v1 journal after migration halts
  consequential dispatch until reconciled.
- Migration reads the legacy JSON once; new records use indexed SQL rather
  than whole-journal rewrites.
- This fixes receipt durability and the 8 MiB/10,000-record ceilings. It does
  not independently solve ATS site acceptance, stale-document timing, provider
  outages, or job-search productivity.
