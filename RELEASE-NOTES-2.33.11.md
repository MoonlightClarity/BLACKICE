# BLACKICE 2.33.11: dogfood navigation and task fixes

This maintenance release addresses problems observed while dogfooding 2.33.10. It preserves the user profile, scheduled deployments, durable run history, existing browser capabilities and Windows accessibility execution tools.

## Changes

- Removed the old **OPTIONS** overflow and its entry into the deprecated Desktop workspace. Retired Desktop navigation, sidebar shortcuts, command-palette entry and Settings link now cannot open that legacy screen. Observe remains the place to inspect running work; the background Windows automation tools are not disabled.
- Kept the working folder accessible as a direct composer shortcut and moved Save for later and prompt templates into normal composer actions.
- Simplified one-off Swarms to Goal, Workers and Model, with optional role scopes, access and plan preview. **Start swarm** submits the chosen goal as one idempotent run directly into Chat rather than showing an additional task form. Advanced saved plans remain available in Swarms.
- Removed the unrequested 10-second minimum and 30-day maximum from interval schedule validation, schema and editor, while keeping positive-whole-second and real calendar range validation. Saved cron syntax remains unmodified and is shown alongside friendly schedule descriptions.
- Clarified live Planning tool instructions and edit validation errors to discourage guessed task/step vocabulary or unsupported edit operations, and clarified that missing workspace file paths should be located rather than retried blindly.
- Updated tests for retired UI routes, simple Swarms setup, exact cron text and positive second intervals.

## Verification and limits

The source suite was run in nine batches (316 files): **4,298 passing tests, 5 skipped, 0 failing** on Windows 2026-10-23. Source tests are not an installer or runtime receipt.

The original dogfood run's three tool errors were invalid plan metadata (TASK_TYPE_MISSING), an unsupported plan edit (INVALID_PLAN_EDIT), and reading an absent AGENTS.md (ENOENT). This release improves tool guidance and diagnostics; it does not claim those calls can never fail.

During development BLACKICE's direct-execution storage entered the conservative DIRECT_JOB_STORAGE fail-closed state after an unconfirmed write. A complete app restart restored execution and existing job receipts. The storage fault itself is not fixed by this release; further investigation is appropriate if it recurs.

For normal distribution, build and verify the per-user Windows Setup installer and use the normal update path. Avoid direct replacement of installed source files.
