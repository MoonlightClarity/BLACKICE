# Agency evidence map — 4 November 2026

## Recorded outcome

The full forced form task failed. The one-request seven-case component also has original aggregate status `failed`; it did not run a mandatory execution cycle. This bundle preserves evidence for review and does not certify a behavioral pass.

Read the [results report](../../docs/agency-behavior-report-20261104.md), [methods](../../docs/agency-behavior-methods-20261104.md), and [manifest](manifest.json) together.

| Evidence | Files |
| --- | --- |
| Exact fictional model input and original contract | [input-cases.json](input-cases.json), [prompt.txt](prompt.txt), [developer-instructions.txt](developer-instructions.txt), [request.json](request.json), [output-schema.json](output-schema.json), [method.json](method.json) |
| Actual serialized body value, without headers | [wire-request.json](wire-request.json) |
| Exact public final response | [model-output.json](model-output.json), [model-output.txt](model-output.txt) |
| Safe original-run metadata and failure | [component-run-summary.json](component-run-summary.json), [component-validation-error.json](component-validation-error.json) |
| Later unchanged-validator diagnostic | [component-posthoc-validation.json](component-posthoc-validation.json) |
| Independent review of each original draft | [semantic-review.json](semantic-review.json) |
| Failed full execution, kept separate | [forced-form-summary.json](forced-form-summary.json) |
| Model-free checks and focused regressions | [offline-validation.json](offline-validation.json), [offline-wire-validation.json](offline-wire-validation.json), [regression-summary.json](regression-summary.json) |
| Original source/artifact hashes and public checksums | [manifest.json](manifest.json) |

The original component runner stopped before writing `host-validation.json`. That artifact is absent. The post-hoc file is new diagnostic work on the unchanged final answer, not a recovered original acceptance result. Four structural accepts do not mean four behavioral passes.

The reviewed [runner source](../verify-agency-component-20261104.mjs) is copied byte-for-byte. Running it with `--prepare --output-dir <new absolute directory>` performs preparation and model-free checks. A live evaluation separately requires `--live --prepared-dir <reviewed absolute directory> --output-dir <new absolute directory>` and would make a new external model request; no new request was made to assemble this bundle. Normal repository dependencies and the actual source tree are required. The published runner can reproduce the method against its checkout; exact historical source reproduction additionally requires the snapshot hashes in the manifest to match.

Copied input and output artifacts are unchanged. Derived summaries contain only allowlisted fields, and the manifest records source hashes. Raw provider reasoning, response bodies containing reasoning, events, headers, local profiles/session identifiers, absolute local paths, and the full source clone are excluded. The `privateReason` field in the published answer is an explicitly requested final explanation about fictional cases; it is not provider hidden reasoning.

The [complete source gate](../windows-2.39.17.json) passed: 614 files, 7,029 passed tests, 9 permitted optional skips, and no failures or required skips. Publication, Windows installer verification, and activation remain pending. Older unrelated verification has not been replaced.
