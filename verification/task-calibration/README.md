# Local calibration cases

This directory contains three controlled filesystem tasks and their evaluator-only checks. The native admission, capture and recovery implementation remains in `../jobsearch-repro/runner.mjs`. This module does not start a model, call a native API, submit an application or decide whether a model passed the calibration benchmark.

## Separate the inputs from the evaluator

The only model request is the exact `task` string from one case JSON. Each case uses `blackice.calibration.case.v1` with `schema`, `id`, `task` and a finite `artifacts` array. Artifact paths are observation metadata, never added instructions.

For each model and each local case, create a new working directory outside this source repository. Copy only the corresponding seed directory's contents there:

| Case | Seed directory |
| --- | --- |
| repair-summary | fixtures/summary |
| prepare-fix | fixtures/summary |
| proposal-review | fixtures/proposal-review |

Keep case manifests, this README, `rubric.json`, `oracles.json`, the checker, and attempt output outside that working directory. Use the existing runner's `--cwd` and case-file support. Root owns workspace copies, their manifests, native admissions and final verdicts. Do not reuse a modified workspace for another attempt.

Before the first live admission, freeze the case and seed hashes, rubric/oracle/checker hashes, product and instruction identities, selected model/effort, and case ordering. Preserve all earlier job-test results and failures.

## Mechanical checks

The runner records `artifacts-before.json` immediately before admission and `artifacts-after.json` after settlement. The checker consumes the agreed `blackice.calibration.artifacts.v1` observations, verifies case and working-directory bindings, confirms the before state matches the untouched seed, and binds current declared-file bytes to their recorded after hashes. It validates only the UUID shape of `after.runId` and returns that value. Root must independently join it to the exact native attempt and verify settlement and capture; the checker has no expected-run argument or native lookup.

Run it only after the attempt has settled:

```sh
node verify-local.mjs --case-file ABSOLUTE_CASE_JSON --workspace ABSOLUTE_TASK_DIRECTORY --before ABSOLUTE_BEFORE_JSON --after ABSOLUTE_AFTER_JSON
```

An optional `--scratch ABSOLUTE_DIRECTORY` chooses an existing evaluator scratch parent outside the task directory. By default, the operating-system temporary directory is used.

For repair-summary, the checker compares the primary report to independently calculated totals and executes the resulting generator once with a separate input and output in temporary evaluator scratch. It uses the generator's documented CLI and does not demand a particular implementation. Temporary files are removed after the result is captured. The checker rechecks scored artifact hashes after this execution.

For prepare-fix and proposal-review, it checks the requested text artifact and unchanged protected files. It does not use a keyword classifier to infer that a plan is correct. Root independently assesses substantive quality and all public behavior under `rubric.json`.

CLI exit 0 means all mechanical checks passed; exit 1 means at least one mechanical check failed; exit 2 means evidence/configuration was invalid, incomplete or changed. None of these codes certifies actual model completion, absence of questions, factual truthfulness or a real external application. The report always lists the remaining manual review.

## Acceptance of this evaluator module

```sh
node --test verification/task-calibration/verify-local.test.mjs
node --check verification/task-calibration/verify-local.mjs
node --check verification/task-calibration/verify-local.test.mjs
node --check verification/task-calibration/fixtures/summary/summary.mjs
```

The tests execute real local files and the checker against explicitly synthetic observation records. They establish that the seeded bug fails, a general correction passes both data sets, hardcoded output fails the extra input, protected changes and evidence drift are detected, and local text-file existence remains subject to manual review. They do not represent successful live model trials.

Independently inspect all saved fixtures, prompts, rubric and oracle values, and check owned-file whitespace/diffs and stable hashes before freezing. No measured reading-speed fact is needed for the practical planning task.

## Held-out scope and limitations

The exact local prompts, fixture bytes and oracle/rubric files are kept from the production-policy author. That author inadvertently saw case-family metadata in a WORKPLAN excerpt after proposing the generic policy. Preserve this disclosure; do not claim completely blind benchmark design.

The local cases are controlled tasks whose filesystem effects are real. Only an employer-native confirmation can establish a real external application. Root separately owns that held-out case, existing applicant/history sources, duplicate reconciliation and native confirmation review. A distinct job is required for another real application; a duplicate or retained draft is never relabeled as a fresh pass.
