# User profile scope and write boundaries

USER.md is an owner-maintained profile of enduring facts and preferences about the user. Task actions, project instructions, procedures and permissions belong with their task or project. New installations receive an unfilled template; initialization preserves existing and intentionally empty profiles.

## Model and owner paths

The model identity tool is read-only for both USER.md and SOUL.md. A source quote, including a request to remember something, does not unlock arbitrary profile rewriting. The model can propose text for the owner to apply in the existing identity editor. Owner edits retain revision, history and conflict checks.

Post-task learning no longer calls profile write or undo callbacks. Creating, updating, removing or restoring a scoped learned fact does not change the separate global profile.

Model-facing snapshots, identity reads and task-readiness profile reads omit only complete unchanged automatic blocks whose exact text and learning provenance remain in profile history. Canonical files are not rewritten. Human-modified blocks, appended human notes and unknown legacy blocks remain visible; original scope is not promoted into global authority. History retention bounds this cleanup, and owner-adopted unchanged automatic text should have its learning marker removed. Projection hashes describe projected text and sourceHash describes the original.

## Enforcement limits

Main, delegated and direct-connector workspace file handlers protect the configured identity directory, including history, plus active knowledge, approval-queue, organization and learning snapshots and their known backup/lock paths against write, patch and undo. Checks resolve aliases, Windows case and nearest existing parents and repeat after admission callbacks. Unrelated files named USER.md remain editable; owner editor and approval API routes are not restricted.

This is not an OS sandbox. Arbitrary shell execution, native provider file tools, hard-link aliases and external processes are not hermetically prevented from changing identity files. Instructions forbid indirect model writes, but these paths need process-level isolation for a complete security guarantee. A filesystem race after the final path check remains possible.

## Verification

Targeted identity, learning, engine-delivery, default-SOUL and protected workspace suites exercise model rejection with exact user quotes, owner editing, default preservation, scope projection, unchanged source files, learned create/remove/restore, aliases, Windows case and alias retargeting during admission. No live profile migration or deletion is performed by this change.

## SOUL separation and upgrade behavior

The concise SOUL default keeps purpose, user agency, practical judgment, calibrated inference, proportionate effort and communication character. Detailed task decomposition stays in the planning tool contracts and planning-policy; delegation in subagents; evidence and comparison method in analytical-method; effect reconciliation in operational-receipts and its tool contracts; scheduling in control-tools; immutable snapshots and revision checks in identity/engine. These modules were already present: the reduction does not copy the removed text into another catch-all prompt.

Core judgment remains in SOUL and analytical-method is delivered independently of formal Planning mode. Engine invocation tests cover planning-off ordinary and Directory turns, frozen active identities and next-turn owner edits. Historical planning-mode/worker suites are additional regression coverage, not proof of a live task outcome. Broader harness-identity procedural sprawl remains a separate issue.

Defaults now seed only missing new profiles. Opening or upgrading an existing installation does not replace its SOUL, even when its text matches an older shipped default with seed/development provenance. Adoption of the concise version is an explicit owner/editor change, retaining history and conflict checks. This avoids a silent installed-profile migration.

## Managed-store threat boundary

The structured tools cannot write these managed files directly, even with ordinary files:write authority. Memory/skill changes go through the existing exact-proposal approval flow; USER/SOUL remain owner-editor controlled. Ordinary project files, including files with the same names elsewhere, remain accessible. Denied direct-file jobs retain actionDispatched:false and no possible file effect.

This is a mediated-tool safeguard, not a guarantee against arbitrary code running as the same Windows account. Remaining write paths include unrestricted shell commands, provider-native filesystem tools, direct filesystem/library invocation, calls to local owner HTTP endpoints, and host/UI automation able to operate the owner's editor or approval surface. A local request label is not proof that a human made it. Identity external-file reload and knowledge store startup/recovery intentionally accept owner files; a same-account process can forge those bytes. The guard also rejects UUID-named atomic staging siblings (.tmp and .bak.tmp), closing observed staging-file substitution through structured tools. Hard-link aliases and OS races remain outside the boundary. No live files or security settings are changed by this patch.

Moving storage to another process under the same account, hiding filenames, signing with a key readable by that account, or removing model write schemas would not close these paths. A strong design needs an authority the model cannot impersonate: a separately privileged service/account protecting data AND executable/configuration/key material, an authenticated owner approval channel the model cannot drive, and rejection of unapproved imports/recovery across restarts. The model can keep ordinary workspace access, but protected-service writes must be mediated; running the model elevated would defeat it. Such OS/security and approval-surface changes require an explicit deployment decision, not an automatic app update. Until then, “approval required” describes mediated tools, not hostile same-user shell resistance.
