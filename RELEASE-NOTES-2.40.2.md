# BLACKICE 2.40.2

## Changes

- Browser folders are part of the existing tabstrip through a lightweight bundled Manifest V3 extension. Nested folders have icons, descendant counts, collapse, and tab drag/drop. Existing tab identities, ownership, navigation and persistence are retained; the duplicate folder panel is removed.
- Chat uses compact titles and a collapsed folder-options control rather than redundant always-visible folder controls.
- Knowledge and Skills entry lists show small title-only rows. Full content and management remain available when opened.
- Cron results are ordered by result availability and job history by the latest run, newest first. Older results remain reachable through progressive display.
- Removed the app-wide concurrent-task setting and its saved throttle effect. Workflow-specific scheduling, overlap and dependency rules remain in place.

## Verification scope

The integrated UX source passed 337 focused checks with no failures or skips. Disposable hidden Electron fixtures exercised real extension actions and persistence, Chat at 1536/1024/640 widths, and Knowledge/Skills navigation and compact lists. These checks do not establish real-world provider performance, faster startup, or installed-package acceptance. Broader source and installer verification are recorded separately with the exact artifact; this note is not a publication or installation receipt.

## Limitations

The extension decorates BLACKICE Electron tabs, not Chrome tabGroups. A server-only browser without the bundled extension retains ordinary ungrouped tabs. Collapse is presentation state for the current tabstrip instance. Deep nesting under heavy tab loads and live user workflows remain unverified. No startup-performance fix is included. The installer is unsigned unless its artifact metadata explicitly states otherwise.
