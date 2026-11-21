# Method

Complete the task using the workspace tools and Action Directory. Use only relay_workspace and relay_directory_action. Do not delegate or use another model. Save code on disk; a program in the final reply is not an artifact. Only files under `src` are editable. Do not create WORKPLAN.md or change tests. There are no packages to install.

## 1. Read

Read each file in a separate `relay_workspace` call. A `path` is one filename, never a space-separated list. Paths below are relative to your assigned working directory. Wait for each result; if it fails, correct the call before continuing.

```json
{"action":"read","path":"TASK.md"}
```

```json
{"action":"read","path":"src/index.cjs"}
```

```json
{"action":"read","path":"public-cases.json"}
```

Implement the entire contract in TASK.md. Public cases are smoke checks, not the complete specification. Use the given filenames directly; filename searches are unnecessary.

## 2. Plan and focus

Use `relay_directory_action` to persist this action:

```json
{"action":"plan","actions":[{"id":"implement","objective":"Implement TASK.md in src and pass node test-public.cjs on the final saved code.","dependsOn":[]}]}
```

After the plan succeeds, focus it:

```json
{"action":"focus","id":"implement"}
```

Wait for a successful focus before writing. For these single-function tasks, private helpers that share the exported function's invariant and acceptance procedure may remain in this action and source module. A separate helper file is optional, not a requirement.

## 3. Write and check

Use `relay_workspace` with `action:"write"`, `path:"src/index.cjs"`, and `text` containing the complete JavaScript source. Preserve the named CommonJS export required by TASK.md. The `text` value is the source itself, not a filename. Check the returned write result before proceeding. If you add a helper under src, use a separate write call for that file.

Run this exact public check with `relay_workspace`:

```json
{"action":"run","command":"node test-public.cjs","timeoutMs":10000}
```

Read the actual exit code and JSON report. Success requires exit code 0, `semanticPass:true`, and `caseCount`, `executedCases`, and `passedCases` all equal to 2. A missing report, zero tests, timeout, tool error, or failed case is not success. Repair the saved source and rerun this command after every source change. Do not change the fixed runner or cases.

## 4. Record and finish

Only after the final saved source passes, use `relay_directory_action` to observe the focused action. Replace the placeholder with the actual host receipt ID returned for that successful command:

```json
{"action":"observe","id":"implement","outcome":"objective-met","claim":"Saved the implementation and the final public check passed both cases.","receipts":["<actual successful command receipt ID>"]}
```

Wait for the observation to succeed. Finish with the saved filenames and the observed test result. If blocked or out of budget, report the failed step and leave it incomplete; never claim an unverified success.
