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
