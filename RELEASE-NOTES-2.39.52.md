# BLACKICE 2.39.52

- Close failed and cancelled planning-owned browser tabs during startup recovery rather than moving them into Personal.
- Use the persisted terminal outcome when cleaning up a failed planning node.
- Preserve explicitly pinned browser tabs across persistence and restore.

This release addresses browser-tab lifecycle cleanup. It does not establish or add application-submission deduplication.
