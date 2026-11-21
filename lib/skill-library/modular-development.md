# Modular Development

Use when building, fixing, refactoring, or extending software. Work in small changes that each produce a checkable result.

## Inspect the actual project

Read the current files, project instructions, relevant caller, and existing check command. Confirm the project directory and available tools. Use user-supplied absolute paths for inputs outside that directory. If an input's location is unknown, search likely user or project folders with the attached discovery tool; one miss in the working directory does not establish that it is absent. Preserve unrelated edits. Use the requested execution mode; if it is unavailable, say which capability is missing and continue useful inspection.

The tool definition attached to this run is the call contract. Source files, old transcripts, and skill examples may describe another version. Use current action names and argument fields, omit unsupported fields, and supply one path when a field accepts one path. After argument validation fails, read the error and correct the call before retrying.

## Define one small change

Choose one behavior with a clear input and result. Keep related state together; split independent behavior when it can be changed and checked separately. A module can be a function in an existing file. Avoid new wrappers or folders that add no behavior.

For work spanning several steps, keep a short card in the current task record or WORKPLAN.md:

- **Behavior:** What input should produce what result?
- **Files and owner:** Which files change, and who writes each?
- **Check:** Exact command or inspection and expected result.
- **Status:** Next action, saved result, check outcome, and any unresolved failure.

Example: “Empty export names return a validation error before any file is written. Change options.mjs. Run the existing options test, including empty and valid names.”

Use the current Directory action when Directory is active. Record observations there; do not enable another mode merely because this skill is loaded.

## Save, check, repair

1. Read the target before editing. For a revision or hash conflict, reread and combine the current changes.
2. Save the implementation through the available file tool. Wait for its completed result, then read back the saved file.
3. Run the recorded check through the attached command tool from the same project directory. Use the project's actual check command, not a filename invented from an example.
4. Inspect exit status and output. Confirm the intended cases executed. A skipped test, zero cases, timeout, missing result, or syntax check alone does not establish the changed behavior.
5. Repair the observed defect and rerun the affected check. Keep the required behavior fixed.
6. Check the affected caller or combined workflow after the small changes are composed. For a prose-only edit, inspect the final wording instead of inventing a test.

When a tool response is lost, inspect its existing job and file state before another write. A pending job is still pending. Continue independent work while resolving it.

## Finish with the actual result

Report changed behavior, saved files, checks that ran, and any remaining gap. State “verified” only for the current saved version whose check passed. If blocked, name the failed command or missing input and the next useful action; do not replace the implementation with a final chat description.

For parallel work, give each file one writer. Share the required interface and check with that writer, then inspect the returned change and integration result.
