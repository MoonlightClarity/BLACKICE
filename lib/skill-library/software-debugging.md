# Diagnose a software bug

Use this when behavior is wrong and the cause isn't yet established. Aim to identify the first boundary where expected and observed behavior diverge. A useful diagnosis can be narrow; it need not map the whole system.

## Start where observation is cheapest

- With an exact error or failing test, start there. Use `relay_workspace` with `action:"search", path:<source folder>, query:<literal error text>` to locate relevant project files. The search matches file contents literally, not regex or filenames; `relay_find_files` fits exact or partial filenames. Read the smallest useful source or log range with `action:"read"` and `startLine`/`lineCount`, then follow the caller or data across one boundary at a time.
- When a focused test or local repro is available, use `relay_workspace` with `action:"run", cwd:<project folder>, command:<repo's focused command>, timeoutMs:<bounded duration>`. Judge the recorded exit code and output. A command that never reached the assertion, a skipped test, or a timeout is not a passing repro. Use the project's documented runner and an isolated fixture when a repro could mutate real data.
- If it only happens in the installed app or under load, preserve what differs: exact build, entry point, approximate time, and input size or concurrency. Compare the same observation under a good and bad case. Prefer a timestamped log, one measured boundary, or a small fixture over broad instrumentation. Don't disturb a working installation just to make a guess testable.

## Make a discriminating check

Pick two explanations that imply different observations, and probe where they disagree. Split “write failed” into questions such as: did the renderer send the expected payload, did the server accept it, and did the subsequent read return the saved value? This separates a UI symptom from a persistence defect. Keep observed facts, causal inference, and unresolved alternatives distinct.

If asked to diagnose only, stop at a supported finding and the next check that would change it. If asked to fix, make the smallest repair at the confirmed boundary and rerun the check that failed before, plus a nearby case that should remain unchanged. Prefer testing through the same route that failed; a source-level check may miss packaging, process, or integration differences.

## Worked example

“Renaming a folder looks successful, but it reverts when I reopen the view.” Two plausible causes: the write never persisted, or it persisted and the reopened view used stale state. A focused test using a disposable folder shows the write returns success and a fresh independent read returns the new name, while reopening renders the old name. Trace how the reopened view gets its initial data and test whether its cache refreshes after a write. Don't rewrite persistence merely because the symptom looks like a save failure. If only a screenshot is available, report that it establishes the displayed name, not the state of storage; a write receipt and a fresh read would distinguish the two.
