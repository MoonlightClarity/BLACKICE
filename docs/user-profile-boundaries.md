# User profile scope and write boundaries

USER.md is an owner-maintained profile of enduring facts and preferences about the user. Task actions, project instructions, procedures and permissions belong with their task or project. New installations receive an unfilled template; initialization preserves existing and intentionally empty profiles.

## Model and owner paths

The model identity tool is read-only for both USER.md and SOUL.md. A source quote, including a request to remember something, does not unlock arbitrary profile rewriting. The model can propose text for the owner to apply in the existing identity editor. Owner edits retain revision, history and conflict checks.

Post-task learning no longer calls profile write or undo callbacks. Creating, updating, removing or restoring a scoped learned fact does not change the separate global profile.

Model-facing snapshots, identity reads and task-readiness profile reads omit only complete unchanged automatic blocks whose exact text and learning provenance remain in profile history. Canonical files are not rewritten. Human-modified blocks, appended human notes and unknown legacy blocks remain visible; original scope is not promoted into global authority. History retention bounds this cleanup, and owner-adopted unchanged automatic text should have its learning marker removed. Projection hashes describe projected text and sourceHash describes the original.

## Enforcement limits

Main and delegated agent workspace file handlers protect the configured identity directory, including history, against write, patch and undo. Checks resolve aliases, Windows case and nearest existing parents and repeat after admission callbacks. Unrelated files named USER.md remain editable; direct owner/editor routes are not restricted.

This is not an OS sandbox. Arbitrary shell execution, native provider file tools, hard-link aliases and external processes are not hermetically prevented from changing identity files. Instructions forbid indirect model writes, but these paths need process-level isolation for a complete security guarantee. A filesystem race after the final path check remains possible.

## Verification

Targeted identity, learning, engine-delivery, default-SOUL and protected workspace suites exercise model rejection with exact user quotes, owner editing, default preservation, scope projection, unchanged source files, learned create/remove/restore, aliases, Windows case and alias retargeting during admission. No live profile migration or deletion is performed by this change.
