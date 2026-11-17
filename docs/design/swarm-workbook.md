# Swarm workbook: organization and evidence

## Intent and mapping
Swarm now presents simultaneous project coordination workflows as a filterable task sheet. Folders group related project records; tasks inherit project filing unless explicitly filed elsewhere (including Unfiled). Folders are real persisted nested organization, not labels. Existing project and item identities, stages, workers, evidence and history stay unchanged.

A project remains a coordination record, not a newly created executable workflow template. Reusable workflows retain their separate execution surface. The sheet's Stage is recorded coordination state, while Runtime reports the existing native launch/result record. Queued is not running; dispatch authorized is not evidence of provider execution. Multiple projects can be viewed together, but this change does not start workers.

## Information architecture
The previous board displayed only one selected project and spread items across five card columns. Its detail stacked coordination, evidence, runtime and history down one long page. Fresh baseline captures in verification/swarm-workbook-20261117/before show both issues.

The new surface has icon-bearing nested folders, independent project filters, searchable rows, stage filters, and separate Summary / Evidence / Progress / Runtime / History detail tabs. Existing editing, archive, Trash/restore, workers, evidence and runtime controls remain. Narrow layouts use a solid folder drawer and a horizontally scrollable sheet rather than compressing every column. Drafts survive detail tabs and folder navigation. Organization edits never imply execution.

## REA adaptation, not a new verifier
References:
- https://github.com/morluto/rea/blob/main/docs/reference/reconstruction-obligation-ledgers.md
- https://github.com/morluto/rea/blob/main/docs/reconstruction-coverage.md

The display keeps authenticity, authority and applicability distinct using the existing revision-bound proof model. Observed (reported), Derived, Inferred, Unknown, Stale evidence and Failed evidence/contradicted styling are not interchangeable. Reported observations do not establish independently verified origin. Stale and failed evidence remains available. A current observation does not erase stale history. Worker readiness and coordinator approval remain distinct. This UI does not implement the complete REA reconstruction verifier or infer approval from presentation.

## Storage and migration
Legacy snapshots receive empty organization defaults on read, without rewriting their files. First organization mutation persists additive metadata with its own revision. Project/item/requirement revisions and evidence applicability are not changed by filing. Folder removal reparents child folders and assignments; it does not delete tasks or projects. Create-project/create-task optional folderId filing is atomic and rolls back on invalid destinations. CAS, mutation receipt retries and persistence rollback are covered.

Native actions retain project/worker ownership boundaries. Native coordinator-created folders carry creator scope; workers can file owned items. Human/direct organization remains available through existing authenticated actions. No live workspace was migrated or mutated during qualification.

## Verification and limits
Focused tests cover backend persistence, legacy snapshots, native actions, real HTTP routes, frontend filtering and interrupted retry/draft flows. Render harness uses the actual production static handler and actual isolated Swarm action endpoints, with synthetic unrelated shell APIs. It launches no provider or live task. Screenshots are offscreen Electron, not live user data.

Existing human-project to native-launch binding limitations are not solved here. Actual parallel provider performance, long-lived production concurrency and end-to-end live worker outcomes are not claimed. This is one audited product surface, not completion of the whole BLACKICE UX audit. No installer, version bump, release, or full-suite qualification is included.
