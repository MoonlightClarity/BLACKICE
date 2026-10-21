# BLACKICE 2.24.1 — Control and recovery

## Stop remains available during a direction request

Sending a direction no longer disables Stop. A stop request has its own per-task pending, accepted, or failed state. Duplicate pending requests are suppressed; a failed or uncertain request offers Retry stop. A late response stays attached to its original conversation.

Conversation, the working-chat list, the sidebar and Activity distinguish a requested stop from settled work. Cancelled turns remain visibly stopping while their active work still occupies capacity. Completed or failed turns that are releasing resources remain visibly finishing. Drafts stay available, and new work respects the original execution slot until settlement.

Conversation summaries retain the settlement signal. Trash refuses a live unsettled conversation. An older archived turn that was left unfinished and has no live engine owner recovers as an explicit interrupted failure after restart; its original saved bytes, partial output and thread identity remain available.

## Optional email failures do not block startup

An unreadable email state file now produces an unavailable email workspace while the rest of BLACKICE can open. The original file and draft artifacts are preserved. Email status remains readable, identifies the storage problem, and disables operations that would rely on or overwrite unreadable state. Configuration and previous access evidence do not override this failure state.

The email view also provides Previous and Next controls for mailbox and search results. Pages retain the current query and mailbox, and changing the account, mailbox, or search resets navigation. Late responses cannot replace a newer selection. Message previews continue to show raw message text; sending and provider draft upload remain unavailable.

## Removed schedules retain a final record

Removing a deployment no longer leaves a later failed attempt waiting forever for an automatic retry that cannot start. The job keeps its observed failure and attempt history, records why retries ended, and releases admission capacity once the actual attempt settles. Existing stranded retry waits are reconciled after restart, including jobs whose deployment is missing.

A still-running or stopping original attempt retains its execution lease. The interface says it is waiting for that attempt and does not promise another retry. Removed schedules keep their readable job history and observed errors without an unusable Retry action. Existing external-action holds continue to prevent unsafe duplicate attempts.

## Failed swarm work keeps its evidence

Failed and cancelled child workers now retain observed thread and turn identifiers, measured usage, and successful/failed tool counts in their result and terminal event. A provider error or parent cancellation no longer discards those records. A late result after cancellation may contribute observed usage, but cannot be exposed as a successful answer.

## Verification and installation

This is a local update from the verified 2.24.0 installation. The frozen 496-file baseline and inspected additional source files are checked before application changes. The updater retains its full regression, real web UI, contained-browser, installed email CLI, and real native-plan acceptance requirements, and verifies rollback copies and final source/installed hashes.

Current results are recorded in the version-bound receipts described in UI-VALIDATION.md and in the implementation handoff. The UI acceptance includes a deliberately held direction request and a separately delayed cancellation acknowledgement. Test fixtures use owned data; real email accounts and external deliveries are not part of these checks. A public Windows Setup installer is not rebuilt by this patch.
