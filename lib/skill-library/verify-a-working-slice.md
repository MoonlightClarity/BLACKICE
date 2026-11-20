# Verify a Working Slice

Use when building, integrating, debugging, or checking the status of something that must work across several steps. A slice is one real route from a starting condition to a result someone can use. Choose a slice when one realistic attempt will tell you more than several isolated checks. For a local change with no downstream claim, a focused check may be enough.

## Choose what to prove

- Write a sentence with a starting condition, an action, and an observable result: “From a fresh workspace, choose the new destination, send one test item, and find that item at the destination.”
- Pick the smallest route that crosses the boundary most likely to fail. If selecting an option works but reopening loses it, stop testing selection and check the write and readback. If the output is correct but the recipient cannot access it, test access from the recipient’s side when authorized.
- Identify what you are actually checking: the running build or deployed version, the relevant account or configuration, and the input. A current checkout does not establish what a running app is serving; a prior report does not establish the current state. If another process is changing the inputs, use a stable copy or record what changed before trusting the result.

## Follow the result through the handoffs

1. Use a representative input that would reveal the common failure. Avoid a default that would pass even if a setting were ignored. For a changed transformation, select an input that produces visibly different old and new outputs.
2. Start at the actual entry point. Follow the input through the steps that can change, persist, route, or display it. Inspect intermediate state only where it can distinguish explanations: did the input reach the handler, get saved, get read back, or reach the wrong destination?
3. Check the result where it is consumed. If persistence matters, reopen it. If the change is visual, look at the rendered output at its intended size. If an effect matters, look for the effect or a receipt tied to the exact action. An accepted request, a button click, and a lasting effect are different observations. If a write might already have happened, check before retrying it.
4. Try the nearest case that should behave differently when it would expose a false pass. After proving “allowed items arrive,” check that an excluded item does not. After proving “custom value persists,” check that the default still works. Keep the input and build fixed when comparing one condition.
5. If the path fails, find the first handoff where expected and actual state differ. Change one plausible cause and rerun the same path. Don’t change an assertion merely to make a failing outcome pass. If a real path is unavailable or exercising it would cause an unapproved effect, verify the steps you can and identify the missing observation.

## Report the boundary of the evidence

A clean build proves the build; a focused check proves the tested component; a structural check shows parts connect; a working slice shows an actual route works for the stated input and conditions. None automatically proves all routes. Report the strongest observation, the version or environment when it matters, and any remaining gap. Don’t call a mock, fallback, forced state, or earlier deployment the real path.

## Examples

- **Desktop setting:** Change a non-default setting, close the view, reopen it, then exercise the feature it controls. If the new label persists but the feature still behaves as before, the save is verified and the feature behavior is not.
- **Recurring report:** Run the existing report process on a small known batch. Confirm the intended reader can open the output and that a record with a distinctive value reached the correct row and total. A generated file alone does not establish that the report made it to the intended destination.
- **Game interaction:** Walk into a portal and reach a goal beyond the exit using normal controls. The teleport event alone misses a player who arrives but gets stuck. State that this route works; do not infer that all portals, maps, or entry directions work.

Adapted from the Eclipse Engine-Preliminary Verification skill in the Hermes archive. Its project-specific paths, fixed gates, and freeze rules are not part of this method.
