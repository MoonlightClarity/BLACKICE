# Swarm project lifecycle

Swarm's project header exposes Edit project, Archive project and Delete project.
The project rail separates Active, Archive and Trash, with counts. Delete is a
recoverable move to Trash, not a permanent purge. Restore returns a project to
Active. Projects created before lifecycle metadata existed are treated as active.

Archive/Trash/Restore use the same coordinator identity, optimistic project
revision, mutation deduplication and durable event ledger as existing project
edits. They do not cancel workers, dispatch work, delete worker data, or change
unrelated projects. Saved work items, source/evidence records and native receipts
remain attached. Trash is read-only in the human editor until restored, but
existing worker receipts can still arrive. Organization is not task cancellation.
There is intentionally no permanent purge in this change.

Unsaved editor drafts survive switching project views and a Trash/Restore cycle
within the open workspace. They still retain their original edit revision, so a
stale draft is explicitly reconciled rather than silently overwriting newer work.
This change also fixes the default work-verification selection being mistaken for
an unsaved edit on every untouched project.

## Verification
- `node --test tests/swarm*.test.mjs`
- Run `tests/swarm-project-lifecycle-render.cjs` with Electron, repository path
  and an evidence-output directory. It uses an isolated store and hidden
  offscreen window, never the installed application's data or live browser.
- The real UI journey edits a project, archives/restores it, moves it to Trash,
  confirms no edit form in Trash, restores the unsaved draft, and checks
  persistence and an unrelated project. Responsive checks cover 1536/1024/640px.

## Capacity
The 60-project limit counts Active projects only. Archive and Trash free active
slots; Restore uses the same limit and serialized check as Create. Saved records
are not discarded. Retained storage remains bounded by the existing 16 MiB
ledger limit and 5,000 event/mutation limits. Archive is not storage compaction.
