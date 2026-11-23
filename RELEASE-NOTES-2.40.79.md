# BLACKICE 2.40.79 — Searchable Chat and Browser folder moves

Local Windows installation candidate, not published.

- Chat's Move to folder dialog now supports case-insensitive search across alphabetically ordered full folder paths, with the current destination preserved during filtering.
- Chat relocation retains the opening folder revision and will not replay a rejected move; vanished destinations cannot be silently selected.
- Browser tab Move now has searchable, sorted full folder paths while preserving selected IDs across refresh.
- Browser folder rows now expose a dedicated SVG Move button and the same searchable destination interface, excluding itself and all descendant folders to prevent cycles.
- Browser folder moves retain their original source parent while open, reject unavailable or externally changed destinations, and never change tab ownership without an explicit action.
- Kept the existing drag-and-drop and keyboard nesting interactions, creation/rename drafts, and native browser controls.
- Added focused tests for large folder trees, cancellation, stale revisions, source changes, focus and drafts, plus native Electron acceptance at 1200, 640 and 390 px.

These controls update organization only; they do not create agent tasks, navigate web pages, or run models.
