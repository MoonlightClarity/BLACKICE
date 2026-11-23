# BLACKICE 2.40.78 — Cronjobs searchable relocation

Local installation candidate, not published.

- Added a visible SVG Move button to each cronjob and folder row in the compact Cronjobs outline.
- Added a searchable destination dialog with alphabetically sorted full folder paths, accessible across collapsed and distant branches. Supports Unfiled and top-level destinations.
- Prevented moving folders into themselves or their descendants, disabled no-op destinations, preserved unsaved creation and rename drafts, and maintained optimistic revision checks without replaying failed moves.
- Kept drag-and-drop and Ctrl+Enter nesting controls as optional shortcuts; moving an item changes organization only and never executes or edits scheduled jobs.
- Added focused tests for sorting, large folder catalogs, cycles, modal cancellation, revision conflicts, and draft safety, and expanded native Electron renderer acceptance at desktop and narrow sizes.
