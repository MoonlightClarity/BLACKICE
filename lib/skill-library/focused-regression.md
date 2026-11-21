# Verify a code change

Use to check that a patch produces the requested behavior and preserves nearby behavior.

1. Name the changed behavior and an input that would reveal a wrong implementation.
2. Run the narrowest existing check that exercises that behavior. Add a regression case when the defect needs one; a wording-only edit can use direct inspection.
3. Check the adjacent behavior the patch could affect. Expand testing only to resolve a concrete remaining risk or a required project gate.
4. Record the command, relevant build/files, exit status, executed cases, and failures or skips.
5. Repair a failed result and rerun the affected check.

A zero exit code with no intended cases is not verification. A missing dependency or timeout is a check failure to investigate, not a passing result. Keep the expected behavior fixed while repairing the code.

## Browser defects

Use the project's local fixture or development server and a disposable record when the test writes data. Open it in a task tab, wait for the expected view, and use a fresh snapshot for controls. Check the resulting UI or saved record. After a stale ref rejected before dispatch, refresh the snapshot; after uncertain dispatch, inspect the effect before another click.

For a timing defect, use a controlled event that reproduces it. Keep the model out of a browser-driver test; keep model and tools fixed when comparing guidance. A navigation-only probe does not verify a submission.

Example: rename a disposable folder, wait for the save, reopen it, and check the displayed and saved names. Capture a screenshot when the defect is visual.

Workflow reference: [Web Application Testing](https://github.com/anthropics/skills/blob/main/skills/webapp-testing/SKILL.md); adapted for BLACKICE without upstream scripts.
