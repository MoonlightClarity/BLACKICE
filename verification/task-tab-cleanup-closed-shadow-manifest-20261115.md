# Task-scoped browser cleanup — closed-shadow manual review correction

- Exact parent commit: 5ba87ec2ed880b34ce715989417c3af4fbe095de
- Source lane: feat/task-tab-cleanup-20261115
- Isolated worktree: C:\Users\user\Documents\Codex\BLACKICE-task-tab-cleanup-20261115
- Recorded UTC: 2026-11-15T15:55:44Z
- Chat Mode-only. Root dot is the sole integration/release/install owner.

## Failure reproduced from 5ba87ec before source changes
- Added three targeted tests while native/preview/UI source remained frozen at 5ba87ec; ran node --test with name pattern closed shadow content on an ordinary div | limited DOM inspection is a manually reviewable candidate | limited inspection requires deliberate per-page selection.
- Result: 0 passed, 3 failed (exit 1). The page-JS inspector falsely returned clear for an ordinary div with an unobservable closed shadow containing a synthetic unfinished form. Preview lacked manual-review identity and UI auto-preselected candidate.
- Receipt: verification/task-tab-cleanup-closed-shadow-baseline-repro-20261115.tap (TAP with normalized UTF-8 and whitespace-only lines).

## Corrected semantics
- The existing read-only recursive frame/open-shadow inspection still protects detected forms, cross-origin frames, inaccessible roots, active runs, transfers, user-pinned pages, downloads, pending effects and late-close races.
- When no editable content is observed in reachable DOM, inspectCleanupDOM returns limited with reachability coverage; native cleanupInspection downgrades any legacy clear result to limited. An unobservable closed shadow root on an ordinary div/span cannot be declared empty.
- Limited pages are reviewable candidates, not automatically protected and not automatically selected. Preview rows expose manualReviewRequired/inspectionWarning and a reviewRequired count; the shared native/captured cleanup panel warns explicitly about hidden content.
- A local user must select each limited page, sending an exact reviewedTabIds acknowledgment matching selectedTabIds. BrowserWorkspace rejects unreviewed limited candidates before any close, and the native driver requires cleanupReviewed after the final DOM probe while retaining abort/ownership/safety revalidation.
- An ordinary div without an observed form remains selectable after deliberate review; no blanket div/span blocker. Agent cleanup guidance requires independent evidence of completion rather than equating absence of detected forms with completion.

## Focused correction receipts (no combined/full suite)
- Native synthetic inspection and delayed-probe races: 11 passed, 0 failed. verification/task-tab-cleanup-closed-shadow-native-20261115.tap
- Existing and new scope/ownership/HTTP/UI tests: 54 passed, 0 failed. verification/task-tab-cleanup-closed-shadow-scoped-20261115.tap
- Static HTTP JS route/MIME: 1 passed, 0 failed. verification/task-tab-cleanup-closed-shadow-http-asset-20261115.tap
- Static import/allowlist graph: 4 passed, 0 failed. verification/task-tab-cleanup-closed-shadow-static-20261115.tap
- Focused total: 70 passed, 0 failed. node --check of touched .mjs files and git diff --check passed.

## Remaining limits and release gate
- A deliberate human review and checkbox choice are an explicit close decision, NOT proof that hidden drafts, closed roots or external effects are absent.
- No Chromium CDP closed-shadow host inspection was added: feasibility and reliability in the installed Electron build are unverified. This narrow fix prioritizes accurate semantics over an untested inspection claim.
- No live user/browser tabs closed, no applications, no Work Mode, no restart, no installer, no release and no combined suite. Previous 69d153 and 5ba87ec source manifests and original TAP files remain unchanged.
- Independent exact-source review is required before root integration; root must reconcile concurrent server/browser/UI edits and owns any full suite or release.

## SHA-256 of canonical staged Git-index bytes
- 1ba658bade1fa61cf0d96237004ae91b2d4dd39041b3906639efc576cc69d6eb  desktop/browser-cleanup-dom.mjs
- 2dda63af4098191c4850c592f91f37b708c465cd1eb7c2f5a4d10689fa35b084  desktop/browser-driver.mjs
- 8d3a0a07f1ed33c8b74e0ff1b4edca1a23aa1750f5919df488108def355b6bbe  lib/browser-cleanup-policy.mjs
- ef8898f62a673d0882a4aaa95881b26707672735ab89f10fce0f08e000d65111  lib/browser-scoped-cleanup.mjs
- f54566b8901232fa6baffffae23e8ffd3a78acac17ccf32d9ee21f212d8e9c2c  lib/browser.mjs
- 4b2d2626bc4720f8ccefe920aeb97ee5dd2fbf3dd3f693c44ebb9346cf064886  public/next/workspaces/browser-scoped-cleanup-ui.mjs
- d23ae4675ae8433f281c611865eec50e37cf6b1940e78c71afaea64e9944f194  tests/browser-contained-driver.test.mjs
- 40384b23a0a9a0dc546bdf19d3002180de822489bd460aeea49920de9e69e1c2  tests/browser-conversations-http.test.mjs
- 1cbe769145e7c0ccf4b9daefcfd82334a246fc9ed85428fb7d10e4f2f4e391ab  tests/browser-scoped-cleanup-ui.test.mjs
- 0fe41b42a7a0fca05f265f12ef97b6ac3e3e4ad629ec12eb1dfe817d94533d00  tests/browser-scoped-cleanup.test.mjs
- eb08f01d796b5b0a382734880942d615f368991976944939c29282639a5ddccd  verification/task-tab-cleanup-closed-shadow-baseline-repro-20261115.tap
- 3926f97a697d3520ca7dedf565e5bd7ca518eacd3ed941427a25605800cb4cdc  verification/task-tab-cleanup-closed-shadow-native-20261115.tap
- b3613aa7a019ba86ba789bc64ab9ec29f7299d57dec99be8a5b26d6c49243585  verification/task-tab-cleanup-closed-shadow-scoped-20261115.tap
- e0bfa0e90012eeb04d5db1744d0131e77fa2c1ca84b23bf6a7b3ae272d1b9ff5  verification/task-tab-cleanup-closed-shadow-http-asset-20261115.tap
- 23be637254cd0f3641b2b01792e3759056f409f278b82ab0cb3c035cc73a9c63  verification/task-tab-cleanup-closed-shadow-static-20261115.tap
