# Verify a Working Slice

Use when a change must work across several steps, such as save → reload → use.

1. State a starting condition, action, and observable result. Example: “Set a non-default export folder, reopen settings, export a file, and find it there.”
2. Identify the actual build, configuration, and input being checked.
3. Choose an input that would reveal an ignored setting, wrong route, or silent fallback.
4. Start at the real entry point and follow the result through the relevant handoffs.
5. Inspect the result where it is used. Reopen saved state, read the receiving record, or view the rendered output.
6. Check the nearest case that should behave differently when it could expose a false pass.
7. If the result fails, find the first handoff where expected and actual state differ. Repair it and rerun that path.

Use a focused component check when the change has no relevant downstream behavior. Do not build a full workflow test for every small edit.

Report the input, build, observed result, and any untested boundary. A build check proves the build, a mock proves its simulated case, and a working slice proves the stated route. None alone proves every route.

Examples:
- A setting's label persists but the feature still uses the old value: saving is verified; feature behavior is not.
- A portal teleports the player but leaves them stuck: verify reaching the goal through normal controls.
- A report is generated but cannot be opened by its intended reader: the delivery path remains incomplete.

If the real route is unavailable, verify the accessible steps and identify the missing observation. If an action's effect is uncertain, inspect its result before retrying.
