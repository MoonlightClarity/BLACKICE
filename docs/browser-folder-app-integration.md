# App-owned browser folder tree

The browser workspace renders one nested folder tree using the normal app DOM and stylesheet in both native desktop and server-served views. The same existing tab rows retain selection, close and ownership controls. Folder paths and descendant exclusion use the shared `public/next/core/folder-tree.mjs` presentation helper.

The old tab-folder content extension, startup loader, DOM event protocol and extension packaging entries are removed. Browser compatibility, Ghostery/adblocking, the password manager and browser backend persistence are not replaced or removed. Collection membership remains organizational: it never transfers browser task ownership. Folder removal retains tabs through the existing host action.

Create/edit/move are explicit controls. Editors remain in normal flow (not over the native browser surface), retain draft input across refresh, and stay open on an error. Pending mutations are not retried automatically. Collapse state lasts for the workspace instance. A newly selected or moved selected tab reveals its ancestors. Native More tabs pagination, pending-open placeholders and empty-state nodes retain their original listeners.

## Verification

- 78/78 targeted tests passed across browser folders, native navigation/surface/auth, collection persistence, password manager and browser protection.
- Independent review found dropped auxiliary tabstrip nodes; these were fixed and regression-tested before completion. Folder identity, rather than names, drives selected-tab reveal.
- A disposable hidden Electron 44.7.2 run exercised nested create/move, drag/drop, collapse after refresh, rename/remove preserving tabs, original select/close handlers, unchanged task ownership and driver restart persistence.
- The actual app stylesheet was loaded. At 780px viewport width, tree clientWidth and scrollWidth were both 742px and every folder control stayed inside the viewport. Screenshots were visually inspected.
- An initial responsive fixture retained an old fixture-only flex-wrap override; it produced horizontal columns. The override was removed, then the actual stylesheet check passed. A box-sizing safeguard remains in the app stylesheet.
- No installed application, real browser profile, website account or user document was changed. This is isolated component/driver evidence, not an installed full-app acceptance test.
- Source documentation check has four pre-existing 2.40.5 release-index/banner mismatches at base deaa5c5; release indexes were not edited in this lane.

Integration requires the server static route for `public/next/core/folder-tree.mjs`, owned by the Skills folder lane. The user's term SSS has not been mapped to a source symbol; this change addresses the observed browser folder DOM/CSS integration without asserting an expansion of that acronym.
