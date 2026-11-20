# Verify a code change

Choose focused regression checks and distinguish verified behavior from untested paths.

**What you need:** A patch or changed files and, for execution, a suitable local test command and dependencies.

**Approach:** Map the edit to user-visible behavior and choose a regression case that would fail before the change if possible. Add the edge most likely to regress, then run the narrowest suite that exercises the requested behavior on the relevant surface. Expand where dependencies or regression risk warrant it; a quick check on a different surface is not a substitute.

**Check and recover:** Record actual commands and pass, fail, or skip outcomes. Treat missing dependencies and timeouts as not verified; give a reproducible rerun command and do not infer a release pass from static inspection.

## Browser regression on a local fixture

Use this when the user-visible defect depends on navigation, rendered controls, or a browser action. Start from the exact workflow that failed, not just the page where it happened. Use a project-provided local fixture or development server; start one with the documented project command only if needed. Use a disposable record when the test writes data.

1. Open the local fixture in a new task tab with `relay_browser`. Wait for the expected user-visible view, not a generic delay or an idle network. Use a fresh snapshot to identify the current control; pass its returned reference and any required document identity. Don't rely on a reference from the previous page or another version.
2. Perform the step that reproduces the defect and verify the resulting UI or receipt. If a browser ref goes stale before the input was dispatched, use the fresh controls in the result or take a fresh snapshot. If dispatch is uncertain, check for the effect before another click.
3. Compare the same input, objective, and starting state before and after the change. For a timing defect, prefer a fixture that changes routes at a controlled event. Hold the model out of a browser-driver test; keep the model and tools fixed when comparing guidance. Keep navigation-only probes separate from end-to-end tests: viewing a fixture form cannot prove that the submit path works.
4. Keep the evidence small: exact build, starting condition, action, final state, and any error or effect receipt. Capture a screenshot for visual defects, not as a substitute for verifying a saved change.

**Example:** A folder appears renamed but reverts on reload. Use the same disposable folder on both versions, change its current label, wait for the save result, then reopen and check the name. If the write succeeded and an independent read shows the new name but the reopened UI shows the old one, report a readback/display defect rather than a failed save.

Local fixture and rendered-state workflow inspired by [Anthropic's Web Application Testing skill](https://github.com/anthropics/skills/blob/main/skills/webapp-testing/SKILL.md), surfaced by [VoltAgent's skill catalog](https://github.com/VoltAgent/awesome-agent-skills). No upstream scripts or bundled dependencies are used.
