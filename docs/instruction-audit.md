# User-owned instructions and execution audit

Open **Config → Behavior & profile → Instructions**, beside the **Behavior** and **About you** tabs for SOUL.md and USER.md.

## Edit the persistent instructions

The Instructions editor holds BLACKICE's common execution instructions. Edit the text and choose **Save changes**. The saved text replaces the common default block; it is not an extra overlay over a hidden copy. Exact whitespace and an explicitly empty value are retained.

The initial default is pinned to the profile as revision 0. Later application upgrades do not replace it. Saved changes create revisions with content hashes; saving the same user-owned content again leaves its revision unchanged. The editor shows the saved version, a character count and version history. Loading a historical revision puts it into the draft; Save makes that draft current. Revert discards only the unsaved draft. A concurrent save conflict preserves the draft instead of silently overwriting another revision.

Changes apply at the next execution admission. Active executions and their delegated workers retain the snapshot they already received.

SOUL.md supplies behavioral defaults, USER.md holds profile facts, and effective owner-edited skills supply task procedures. The current user request supplies the task and its constraints. Tool schemas and host state describe actual operations and preconditions.

## Model write boundary

There is no model save or restore tool for this setting. Config management uses the authenticated local owner UI route and revision/hash checks. Model and direct structured file write, patch and undo handlers protect the whole instruction-store directory, including aliases, history and temporary files. Reading the active instructions remains available.

This is an application-level boundary. BLACKICE's unrestricted shell and native executable capabilities still run with the Windows user's authority, and its owner/development frontend capability can operate the application. These are not an OS sandbox or proof of a physical human gesture. The application does not claim absolute isolation from those broader capabilities.

## Inspect an execution

Choose a saved turn or paste its ID. Expand a section to read the captured text, source, layer, inclusion reason, revision, character count and hash. Tool definitions have their own group for the descriptions and parameter guidance advertised to the model. Delivered skills, planning preparations, context summaries and delegated workers are distinct captures. A context summary records its technical instructions separately, without copying its historical transcript or replacing the main execution's saved revision. The readable export retains these source boundaries.

Current saved instructions and historical execution snapshots are separate. Editing the current setting does not rewrite a saved execution. Historical turns created before capture are labelled unavailable; current source is never presented as their historical payload. Provider-owned hidden instructions remain outside BLACKICE's capture boundary.

An active native execution retains the catalog captured for that execution. On a later requested continuation, BLACKICE compares the saved descriptor fingerprint with the current source catalog; a changed catalog can use the existing context-preserving handoff to a fresh native session. Saved messages, receipts and the previous native-thread identity remain inspectable. The audit still shows the catalog actually captured for each execution and marks uncaptured historical definitions unavailable. A source update does not rewrite past snapshots.

## Skill and data boundaries

Owner edits replace bundled skill text, and deletion does not restore old bundled content. Planning preparations use the effective owner skill too. The retired universal analytical essay and duplicate fixed task-method advice do not compete with those sources. Selected skills are no longer silently omitted at 20,000 characters; actual model context admission still applies.

The audit records instruction-bearing sections and final adapter additions. It does not duplicate ordinary task messages, conversation history, USER.md facts or general tool outputs. An active persistent goal is an explicit exception: the host's exact injected goal contract is captured, including its objective and execution limits. Successful skill reads record the delivered method and source; identical repeated deliveries are counted without repeating the full body.

## Verification scope

The audit makes active sources and revisions inspectable. It does not automatically prove that arbitrary natural-language instructions are mutually consistent. Tests cover saved and empty instructions, revision conflicts, upgrade persistence, admission snapshots, structured write denial, effective skill sources, provider payload capture, planning preparation, archive persistence and readable export.
