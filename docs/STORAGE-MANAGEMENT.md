# BLACKICE storage management

Storage & Data is available in Settings. It reports on-disk byte and file counts
using fixed, disjoint storage categories. The measured total is not the total
installation size: unmanaged directories are excluded. Opening Settings or
installing the feature does not delete any data.

## Clearing data

Select categories and type `DELETE SELECTED DATA`. This queues
`data/storage-cleanup-pending.json`; it does not delete immediately. The next
BLACKICE server startup applies the request before its conversation, context,
execution, credential-vault, and workspace stores load.

| Selectable category | Contents |
| --- | --- |
| Conversations | Saved chats, provider threads, run history, archived events and task state |
| Context | Knowledge, learning, and saved planning state, including archived legacy files |
| Workspace metadata | Projects, schedules, workflows and inbox state, without working-directory files |
| Managed workspace files | Documents and source files in BLACKICE-managed working directories |
| Action history | Durable tool receipts, prior outcomes and file-patch undo records |
| Media | Attachments, application documents, downloads and saved media, including legacy Workbench media |
| Saved browser passwords | BLACKICE password-vault and mirror records |
| Temporary | Frontend development artifacts, runtime probes and diagnostics |

Custom external working directories are neither traversed nor deleted.
Workspace files may be user-authored and their removal is permanent.
Deleting action receipts removes idempotency and prior-action evidence.
Deleting saved passwords does not sign out websites or clear site data.

The following categories are measured but protected from deletion:
- Retired Workbench virtual-machine files. Removing the feature preserves any
  operating system and user files inside the old guest disks.
- Browser profiles, imported snapshot payloads, tab/session state and site data.
  Electron and imported browser processes can own these files before the server
  starts. Bulk browser reset needs a browser-aware lifecycle, not raw file removal.
- Electron rendering caches, which may already be open.
- Runtime preferences and modular planning definitions in runtime-settings.json.

There are no imports of Workbench or legacy Planning runtime modules in the
storage manager. Their old file paths are inventory entries, not active feature
dependencies. Context cleanup preserves modular planning configuration.

## Confirmation and recovery

The typed phrase is required for each queued deletion. Local session and origin
checks protect the API; the remote gateway and server independently refuse
remote storage management. Queue, cancellation and policy mutations are
serialized and drained during server shutdown.

The pending marker progresses from queued to applying before any removal, then
is removed on success or retained as failed on error. Its schema version is
preserved in every phase. A failed or interrupted request is never automatically
replayed. Cancellation cannot restore files already removed. If saved state is
unreadable, cancellation explicitly treats earlier deletion as uncertain.

Active direct-execution ownership defers cleanup. Symlinks and unsupported
filesystem entries are not traversed. The optional
`autoClearTemporaryOnStartup` policy affects only rebuildable temporary data;
all other retention defaults are no-op. The last completed report is retained in
`data/storage-cleanup-report.json`.

## Local API

- GET /api/storage/overview: category counts, pending request, policy, last report
  and startup warning.
- POST /api/storage/cleanup:
  `{"categories":["conversations"],"confirmation":"DELETE SELECTED DATA"}`.
- POST /api/storage/cleanup/cancel: `{}`.
- POST /api/storage/policy: `{"autoClearTemporaryOnStartup":true}`.

## Deferred work

Automatic eviction of durable receipts is not enabled. These records need
verified compact or archival representations before automatic removal.
VM disks and browser-owned files remain read-only until dedicated, safe cleanup
workflows exist. A final release must test these narrow changes against the
completed Workbench/legacy Planning retirement checkpoint.
