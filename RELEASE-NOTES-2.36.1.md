# BLACKICE 2.36.1 — Contained browser and workflow checkpoint

This checkpoint preserves the completed browser-routing, conversation-continuity, planning and frontend changes since 2.36.0.

## Contained browser routing

- New web work uses BLACKICE's contained browser by default. The relay_browser tool only dispatches to its contained driver; selecting a different external browser is a separate tool choice.
- BLACKICE sessions that expose relay_browser exclude the installed browseros-neo auto-routing skill through the native provider's supported per-session configuration. Existing skill settings and their order are preserved, with the scoped exclusion applied last.
- Configuration that cannot be read or preserved stops the new agent turn instead of silently losing settings.
- Browser choice and plan provenance are carried in developer guidance. An earlier assistant-selected method is not treated as a user requirement.

## Conversation continuity and planning

- Recurring work preserves its conversation and task identity when its instructions change.
- Planning guidance keeps the user's requested outcome central and distinguishes useful disclosures from unnecessary negative framing.
- Planning context retains the plan's origin and last-update source while preserving completed work and uncertain external effects.

## Frontend and development tools

- Chat history and sidebar updates avoid cloning the entire conversation history and retain existing rendered rows where possible.
- Desktop frontend development tools provide scoped UI inspection and profiling through BLACKICE.
- The desktop server serves stylesheets referenced by the frontend, and related browser recovery and rendering checks are included.

## Verification

The source suite and exact Windows installer are verified separately. The release includes their bound JSON evidence and installer checksums. Bounded model observations verify only the behavior actually observed; they do not establish universal model compliance or successful completion of every application workflow.

The installer follows the project's existing per-user Windows release policy. Its manifest records its actual signing status.
