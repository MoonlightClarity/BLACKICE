# BLACKICE storage management

Storage & Data is available in Settings. It reports on-disk byte and file counts
using fixed, disjoint storage categories. The measured total is **not** the total
installation size; it excludes unmanaged directories and includes read-only VM
and desktop cache categories for visibility.

## Clearing data

Select one or more categories and enter `DELETE SELECTED DATA`. A confirmed
request is saved as `data/storage-cleanup-pending.json`, but nothing is deleted
immediately. The next BLACKICE startup attempts the queued cleanup **before**
conversation, planning, execution, and workspace stores are loaded.

The following are independently selectable:

| Category | Contents |
| --- | --- |
| Conversations | Saved chat turns, provider threads, recent run history, archived run events and task state |
| Context | Knowledge, learning and planning-browser state |
| Workspace metadata | Project, schedule, workflow, and inbox state, without working-directory files |
| Managed workspace files | Actual working-directory documents and source files (external custom directories are excluded) |
| Action history | Durable tool receipts, prior outcomes, file-patch undo records |
| Media | Saved attachments, application documents, recordings, downloads |
| Browser | Browser profiles and credentials, saved sessions and browser site data |
| Temporary | Diagnostics, development caches and runtime probes |

Read-only (measured but **not** deletable through this feature): the Workbench
virtual machine and the live Electron browser rendering caches. VM reset
requires its own guest-aware feature. Custom external working directories are
not traversed or deleted. Browser sign-ins may be lost when browser data is
cleared. Workspaces may contain user-authored files, so their removal is
permanent. Deleting action receipts removes some idempotency and prior-action
evidence. No production data is deleted by installation or opening Settings.

## Startup recovery

The pending marker moves through `queued → applying → completed`, or
`queued → applying → failed`. The marker is persisted *before* destructive
operations begin. A crash during deletion leaves an `applying` marker and
**will not cause automatic re-deletion on the next startup**. On failure,
BLACKICE starts normally and reports a warning. The user can cancel an
interrupted marker; this prevents a retry but cannot restore files already
removed. Active direct-execution ownership prevents cleanup until that owner
is gone. Symlinks and unsupported filesystem entries are not traversed.

The optional `autoClearTemporaryOnStartup` policy affects only rebuildable
temporary/diagnostic data. All other retention defaults are no-op. The policy
and last completed cleanup report live in `data/storage-retention.json` and
`data/storage-cleanup-report.json` respectively.

## API (local desktop session)

* `GET /api/storage/overview`: exact category size/counts, pending request,
  policy, prior report and any startup warning.
* `POST /api/storage/cleanup`: `{ "categories": ["conversations"],
  "confirmation": "DELETE SELECTED DATA" }` queues a request.
* `POST /api/storage/cleanup/cancel`: `{}` cancels a pending request.
* `POST /api/storage/policy`: `{ "autoClearTemporaryOnStartup": true }`
  enables automatic temporary-data clearing.

## Further work

This first implementation provides explicit manual deletion, accounting, and
opt-in temporary-data cleanup. Automatic retention of completed durable-action
receipts is **not** enabled: those records carry idempotency and external
action reconciliation information and need a verified compact or archival
representation before automatic eviction. A future VM management feature
should distinguish guest-disk snapshots, active disks, and reclaimable space
inside virtual disks. Cached Electron rendering data should be cleared before
the Electron browser starts, not during live operations.
