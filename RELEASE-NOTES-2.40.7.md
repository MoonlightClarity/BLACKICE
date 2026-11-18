# BLACKICE 2.40.7

Candidate source notes, not a publication or installation receipt.

## Changes

- Restore human editing in Skills. Explicit saves persist title, summary, usage, scope and instructions separately from bundled originals. Revision checks prevent stale overwrites; unsaved drafts survive workspace changes and save conflicts. Model skill tools remain read-only and read the effective human-edited content on demand.
- Put native browser tabs and nested folders in a scrollable sidebar. Keep address/navigation and Passwords visible; group Downloads and tab-cleanup controls under Tools. Preserve ownership, folder drafts, and native page bounds.
- Close top-layer dialogs and collapse or suspend folder-management UI on workspace navigation without discarding drafts. Cronjobs folders have a compact accessible remove control that retains jobs and moves children up.

## Verification boundaries

The integrated pre-version code passed a complete Windows suite: 8,822 passed, zero failed, ten skipped. Real Electron checks covered Skills save/reload/restart/conflicts, folder draft preservation/navigation and responsive browser geometry. Exact versioned source qualification and installer verification are recorded separately.

Browser geometry checks used a native IPC stub, not live websites. Adblock and password-manager backends were not changed. The original reported Cronjobs cross-section visual leak was not independently reproduced; the verified changes target transient UI lifecycle behavior. Model read-only restrictions are tool-level protections, not an OS sandbox against unrestricted commands or localhost access. Existing user-authored skill and identity content is not rewritten by this release.
