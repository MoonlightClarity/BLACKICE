# Human skill editor verification

The Skills page previously exposed only a read-only bundled catalog. Human editability was accidentally removed along with model mutation.

This change adds an explicit Edit skill / Save skill form. Human edits are stored separately from bundled originals, with revision checks against concurrent overwrites. The effective catalog is shared by the UI and model search/read tools. Editing does not automatically inject a skill into existing conversations.

## Verified

- 28 affected tests passed, covering workspace behavior, HTTP authorization, catalog retrieval, folder organization, persistence, stale saves and crash recovery.
- Real Electron UI/API test passed at 1200px and 640px: save, reload, server restart, unchanged bundled original, concurrent conflict preserving the draft, and discard loading the winning edit.
- Documentation validation passed.
- Independent review identified and corrected an in-flight external navigation race and a crash-stale-lock problem.
- Tests use isolated temporary data, never live user skills.

Run the focused unit/HTTP suite with Node's test runner; run tests/skill-editor-render.cjs through Electron with the source root and a fresh output folder as arguments.

## Boundaries

Model skill tools expose search/read only. Structured model file mutations are blocked for the override directory. This is not an operating-system sandbox: arbitrary shell commands and localhost access retain their existing capabilities. Do not describe it as an absolute guarantee against model modification through unrestricted shell access.

This commit is source work, not an installation or release receipt. No user-authored skill content was changed.

## Combined source qualification

Final tested code revision: c3c8fcd, on integrate/skills-browser-stability-20261118, based on 2.40.6 source257faf7.

Combined changes include the human Skills editor, native browser folder rail and Tools disclosure, folder-management lifecycle cleanup, and compact Cronjobs folder removal.

- Final full Node suite: 8,832 tests, 8,822 passed, zero failed, 10 skipped; 342.5 seconds. Required Python was supplied through PLANNING_BEHAVIOR_PYTHON using the existing Python3.12.16 interpreter.
- Earlier full attempts are not claimed clean: the first lacked default Python; the second found a navigation fixture missing the DOM dialog query API. Both were addressed before the final complete rerun.
- Combined real Electron tests passed for human skill save/reload/restart/conflict handling and folder navigation across four sections with unsaved drafts preserved.
- Native browser frontend rendered at1200,780 and640px with matching IPC geometry. At780x560 the page retained562x356 pixels, excluding the218px folder rail. This uses an IPC test stub, not live website or native BrowserView validation.
- Screenshots were inspected. A stale hidden-window screenshot fixture was corrected to use offscreen rendering and wait for rendered fonts/frames before verification.
- Documentation classification and link checks passed.

The original reported cross-section Cronjobs visual leak was not independently reproduced. The tested fix closes top-layer dialogs and suspends folder-management UI on navigation, preserving drafts. It should not be described as proof that every possible cause of that original report is resolved.

This is source qualification only. No installer was built or installed here; live user drafts, saved skills and browser profiles were not changed.

## Direct-document follow-up

The next iteration removes the separate Edit step and duplicated metadata fields. A selected skill is one directly editable document with Save and Discard changes. Saves send only content and its edit-start revision. Display labels derive from the document heading; search reads the document. No user document text is rewritten by folder operations. Folder names rename inline; arrows expand/collapse; drag moves folders or skills; Ctrl+Enter indents a folder under its preceding sibling and Ctrl+Shift+Enter outdents it. Stale edits retain their original revision and draft across refresh rather than silently rebasing.

## Skill deletion follow-up

The selected document now exposes Delete skill. Inline confirmation identifies the selected skill and warns before discarding its unsaved changes. Deletion persists across restart and excludes the skill from future model search/read. Existing conversation text is not erased. Deleted skills can be restored: a saved human document is retained exactly; an unedited bundled skill restores the then-current bundled default. Revision checks prevent stale deletion, restore or save from overwriting concurrent state. Folder placement is retained for restore, so a deleted skill must be restored and moved before its folder can be removed as empty. Bundled assets and unrelated documents are unchanged. This source work is not installed.
