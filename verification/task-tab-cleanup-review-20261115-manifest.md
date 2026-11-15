# Task-scoped browser cleanup: independent blocker correction candidate

- Frozen baseline: 69d153d55e0792ab0c9fc513a970f85750eb086a (parent; reviewed with three blockers)
- Worktree: C:\Users\user\Documents\Codex\BLACKICE-task-tab-cleanup-20261115
- Branch: feat/task-tab-cleanup-20261115
- Receipt timestamp UTC: 2026-11-15T15:20:11Z
- Sole implementation owner: task-scoped browser cleanup Chat Mode lane. Root dot alone owns integration, release and installed version.
- All patch paths stay inside this isolated worktree, not the shared dirty checkout or other candidate trees.

## Reproductions on the exact 69d153 source
- HTTP asset: actual GET /next/workspaces/browser-scoped-cleanup-ui.mjs returned 404 instead of JavaScript 200; see baseline HTTP receipt.
- Native focused regression run on detached baseline with legacy Boolean inspector returned 0 passes / 8 failures: nested iframe falsely clean and all delayed pin/human/download/dialog/effect/input/abort cases closed or failed to reject. See baseline native receipt. Detached worktree was removed after the reproducer.

## Narrow corrections
- server.mjs: explicit workspaces/browser-scoped-cleanup-ui.mjs static allowlist; live HTTP harness checks 200, text/javascript MIME and rejects a real temporary unlisted sibling with 404.
- desktop/browser-cleanup-dom.mjs: read-only, bounded recursive same-origin document / iframe / frame and open shadow-tree probe. Unknown for inaccessible or cross-origin child frames, closed custom roots, embeds, overlarge trees and incomplete results. Clean direct pages and fully inspected same-origin nested clean frames/shadows remain eligible.
- desktop/browser-driver.mjs: check live person ownership/pinning, dialogs, authentication, downloads, pending website and OS effects, renderer/load state and abort before AND after async DOM inspection, then again synchronously before close (with original exact owner/document guard preserved). No await between the final guard and close.
- Original scoped cleanup, conversation/worker identities, transfer semantics, partial-failure counts and archive/trash implementation are unchanged by this blocker correction.

## Source-bound focused receipts (not a full suite)
- HTTP harness: 1 passed, 0 failed; verification/task-tab-cleanup-review-http-20261115.tap
- Native synthetic frame/shadow + delayed race probes: 10 passed, 0 failed; verification/task-tab-cleanup-review-native-20261115.tap
- Existing ownership, scope, conversation HTTP and native/captured UI: 51 passed, 0 failed; verification/task-tab-cleanup-review-ownership-20261115.tap
- Static route/import graph checks: 4 passed, 0 failed; verification/task-tab-cleanup-review-static-20261115.tap
- Node syntax checks of all touched .mjs and git diff --check passed. Earlier base receipts remain at their old immutable 69d153 manifest.

## Important limits / handoff
- Evidence is harness HTTP and synthetic native fixture behavior, not a real signed site, live child worker, downloaded file, native popup shutdown or installed browser test.
- Hidden closed roots on arbitrary built-in elements are not directly observable via page JavaScript; the eligibility proof is limited to reachable roots and explicitly detectable opaque/closed components. No claim that all possible webpage drafts can be discovered.
- No live tab closures, real applications, full suite, Work Mode, release, install or restart performed.
- Independent exact-source review is still REQUIRED before root considers merging and any combined suite.

## Canonical Git-index SHA-256 of changed files and receipts

- 5cd50fdb4888560795cbec75628e03d5e046bb410162e58beeafa29ab97b2a62  desktop/browser-driver.mjs
- 169486a256df0755d0414a169407608d456f78e739a7196d125b447f682b0ee0  desktop/browser-cleanup-dom.mjs
- 7b7b6aeb4963c619956cea439bb5e183e014b42f0f1c33b5a94ab58b432bc6e2  server.mjs
- 7ca0f0e2cfe807ce21aa767a17406fc8b33ebd3e4f4a01323a4029682dfd7ffb  tests/browser-contained-driver.test.mjs
- bbd7a1039ed9767ecac4aa0ca215d1c5bbe4d25728399fc628c3fd7e3049f44f  tests/next-route-http.test.mjs
- 2f95d41d9f9d7840df68300d24521be6715ec22b38d4a6fa4092b79b1bf5402c  verification/task-tab-cleanup-baseline-native-repro-20261115.txt
- 432edbda4b7743900c04602156d967903c8d7d9e359f826953c3dc679f7eaa66  verification/task-tab-cleanup-baseline-http-repro-20261115.txt
- e028c62bf5cdc9abad20a7e5b6ac30201066f9cd2303f6df4b8c19582c262a87  verification/task-tab-cleanup-review-http-20261115.tap
- b3337361e9c777964fc922db84de9105e82c60f6722cedc2c73d285a5347f19d  verification/task-tab-cleanup-review-native-20261115.tap
- 863cd49665e610c39bd53e99459d6d4607e84b69bccf74302a357efbe21e6e92  verification/task-tab-cleanup-review-ownership-20261115.tap
- f6885d6e3797a8e9112848e09a8d394850d3789e44535758c408b53bc30d2881  verification/task-tab-cleanup-review-static-20261115.tap
