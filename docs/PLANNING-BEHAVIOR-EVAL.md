# Planning behavior acceptance fixtures

This opt-in developer tool prepares four local tasks and checks their actual outputs. It does not start BLACKICE, call a provider, create a model turn, or use the network. Node built-ins and Python 3.8+ with standard-library `sqlite3` are the only dependencies.

## Run

```sh
node scripts/planning-behavior.mjs prepare --root /absolute/path/to/new-evaluation
```

The root must not exist. Preparation refuses to merge with or overwrite any existing root. Give each `case-XX` directory and its `prompt.txt` to a separate fresh agent run. Keep this evaluator, its tests, the other cases, and scoring output outside those agent workspaces. Record the actual model, effective reasoning setting, planning setting, relevant patch/commit, and run identifiers separately. This tool does not infer those settings.

When the agent runs have finished:

```sh
node scripts/planning-behavior.mjs score --root /absolute/path/to/new-evaluation
node scripts/planning-behavior.mjs score --root /absolute/path/to/new-evaluation --python /path/to/python --timeout-ms 10000
```

On Windows, `--python` accepts an executable path such as `C:\Python312\python.exe`; it is an executable argument, not a shell command with embedded flags. Defaults are `python` on Windows and `python3` elsewhere. The default timeout is 10 seconds per child process; the accepted range is 100–120000 milliseconds. Candidate code runs as ordinary local child processes, not inside an OS sandbox. Use this evaluator only with candidate code you authorize to execute.

Both commands emit JSON. Score exit codes are **0** for all cases passing, **1** for behavioral failures, and **2** for invalid input, integrity failures, or an unavailable execution environment. Each case reports `pass`, `fail`, `environment_error`, or `integrity_error`. Node and Python child execution are checked separately from candidate code. Missing interpreters and explicit spawn denials (`ENOENT`, `EACCES`, `EPERM`) are never counted as a pass or a skipped success.

## Cases and independent checks

| Cases | Task | Checks |
| --- | --- | --- |
| `case-01`, `case-02` | Identical request to fix duplicate search calls after navigation; different underlying defects | Real EventEmitter dispatch, repeated and same-term submissions, inactive views, decoded URL semantics, no retry on success/client error, one bounded retry on server error |
| `case-03` | One exact phrase correction | Exact output bytes, untouched companion file, no added/deleted/renamed files |
| `case-04` | Implement an atomic SQLite import with storage choice already fixed | Actual SQLite file and exact rows, supplied columns/constraints, successful import of a different CSV into an existing schema, preserved inputs, rollback of a failed later row without damaging any established data |

Folder names and prompts do not disclose the debugging cause. Either single-cause repair applied indiscriminately to both debugging cases leaves one case failing. Removing retries entirely also fails, even if it removes the visible duplicate-request symptom. Applying both correct changes can legitimately pass; the scorer does not require a particular patch shape.

The executable oracles are embedded in the trusted evaluator, not written into candidate folders. JavaScript and Python candidates execute in fresh child processes with bounded output and timeouts. The event fixture uses real `bus.emit`, then drains its asynchronous requests through bounded event-loop turns; listeners need not return promises. Return values are checked directly through the documented `sendSearch` API. Equivalent URL encodings are accepted when the endpoint and decoded term are correct. SQLite test databases and invalid-batch inputs are created in temporary oracle directories and removed afterward. Python bytecode output is disabled. The exact-edit check compares bytes directly in the scorer.

`manifest.json` records initial file hashes, editable filenames, and protected input hashes. Protected files and the manifest are created read-only where file modes support it. More importantly, scoring reconstructs the expected manifest from the evaluator's own definitions: editing a local manifest or substituting new protected hashes cannot authorize changed inputs. Keep the exact evaluator revision with the evidence; a later changed fixture definition is not the same evaluation. This integrity check is not a security boundary against hostile code with access to the evaluator itself.

## What a result means

Passing establishes that the candidate outputs satisfy these bounded acceptance checks. It does **not** establish private reasoning depth, whether the agent reserved judgment, why it chose a repair, or whether an actual BLACKICE provider invocation occurred. The scorer does not grade prose, planning vocabulary, step counts, or plan verbosity.

To assess the provisional-judgment change, use separate frozen prepatch and postpatch environments with matching prompts, model/settings, and fresh case folders. Preserve the external tool/action traces to inspect whether evidence changed behavior. Report a first postpatch-only run as **postpatch acceptance evidence**, not measured improvement. Even a matched comparison is evidence for these tasks, not a universal reasoning-quality guarantee.

## Test the evaluator

```sh
node --test tests/planning-behavior.test.mjs
```

Tests require the same Python environment; `PLANNING_BEHAVIOR_PYTHON` can name its executable. They falsify both original debugging defects, either one-cause-fits-all repair, removed retry behavior, once-only listeners, suppression of distinct same-term events, a wrong retry boundary, broad typo correction, non-atomic SQLite imports, unconditional table creation, and ignoring the CSV path parameter. Correct distinct repairs, listeners without returned promises, equivalent URL encodings, and both controls must pass. Additional checks cover root overwrite refusal, input/manifest tampering, interpreter failure, process timeout, and CLI JSON/exit codes.
