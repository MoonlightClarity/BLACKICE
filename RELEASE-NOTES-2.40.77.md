# BLACKICE 2.40.77 — Skills folder movement

- Added a dedicated SVG Move action beside each skill and folder, plus an action for the selected skill in its editor.
- Added a keyboard-accessible searchable destination dialog. User folders are alphabetized by full path, independent of folder expansion and pagination. Moving skills also supports automatic grouping and explicit category placement.
- Prevented invalid folder moves into themselves or descendants, disabled unchanged destinations, preserved unsaved skill documents, and retained the existing drag-and-drop shortcut.
- Added focused UI and integration tests for nested moves, revisions, cancellation, failed writes, drafts, sorting, and existing folder behaviors.

This source change does not modify skill documents or stored folder organization until the user chooses a destination.
