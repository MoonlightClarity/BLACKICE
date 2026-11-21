# MiniCPM benchmark controller

This package contains reusable, offline-tested controller APIs for a file-based MiniCPM coding comparison. It does not start a model by being imported. A caller supplies the exact task configuration, source and runtime manifest, scaffold identity, connection identity, and native execution evidence.

## Contents

- controller/campaign-controller.cjs applies the guarded campaign state transitions.
- controller/campaign-journal.cjs and campaign-driver.cjs provide durable complete-state persistence and the native guarded driver.
- controller/qualification-driver.cjs provides a separate, permanently unscored first-D0 qualification and explicit closure of a settled incomplete attempt.
- controller/runtime-observation.cjs and context-publication-observation.cjs reconcile current runtime settings with awake properties and independently copied lifecycle bytes.
- controller/policy-observation.cjs reconciles actual delivered instruction evidence.
- controller/prompt-composition.cjs, policy-source-versions.cjs and policy-contract.cjs reconstruct the full initial prompt from explicitly reviewed source combinations and validate retained qualification evidence.
- controller/managed-route-observation.cjs validates the strictly unscored first-D0 route before authoritative host-attempt capture is available.
- controller/run-conditions.cjs validates the frozen comparison manifest and observed admission, continuation, and final conditions.
- controller/controller.cjs and controller/native-api.cjs define owned operations, receipt recovery, and native request construction.
- controller/evidence.cjs projects complete recorded tool and Directory evidence without converting missing observations into success.
- controller/read-owned-thread.cjs and controller/reproject.cjs copy or inspect explicitly identified saved evidence.
- controller/controller-cli.cjs supports recovery of existing owned work. Its legacy fresh-start route is intentionally unavailable; use the guarded campaign API.
- packet/METHOD.md is the exact generic method fixture, including its trailing newline.
- native-baseline.json is explicitly synthetic idle-runtime test data. It contains no captured user profile, machine configuration, connection, native session, or applicant information.

## Offline checks

From the repository root, run:

```text
node --test verification/minicpm-infrastructure/controller/controller.test.cjs verification/minicpm-infrastructure/controller/run-conditions.test.cjs
```

The controller tests use local temporary files, generated native response fixtures, and the repository public/mission-model.mjs module. They do not launch a live model or perform an application submission. The synthetic idle fixture preserves the unavailable-router, unloaded-runtime, and unknown-applied-revision cases. Its exact byte hash is checked before use; all original unknown-condition assertions remain.

## Driver integration

campaign-controller.cjs exports createCampaign, planNext, commitOperation, recordSubmission, acceptResponse, recordConditions, bindPayload, attachTranscript, and finalize.

A native driver must atomically persist the complete returned campaign envelope, including the frozen manifest, bindings, conditions, and nested controller, before submitting each planned effect. Persisting only the nested controller loses the campaign conditions. Reconcile the recorded operation and its durable result before planning another operation.

Selected benchmark starts require an explicit input.benchmarkBudget.wallMs. The authored request binds that budget, and the host enforces its immutable createdAt-derived deadline independently of controller polling or receipt collection. Cancellation and execution settlement remain distinct; slow reporting cannot extend the admitted budget.

Fresh admission and finalization require matching observed conditions. Missing observations stay unknown. Restoring configuration after observed drift does not erase that drift. Cleanup remains possible for proved owned work even when the comparison is disqualified.

The server benchmark profile is a tool and file boundary. Selecting it alone does not establish all comparison conditions, an operating-system sandbox, a loaded model, live tensor capture, or a completed benchmark. The durable driver is included in this extension. Verified live capture, instruction qualification, and actual model/runtime parity remain distinct observed gates; source tests do not satisfy them.

The actual unscored D0 is closed as qualification-incomplete with its failed evidence preserved. Source checks do not turn that attempt into a model result. A further D0 needs a verified installation of the repaired tool/deadline contracts, current instruction and runtime evidence, and a fresh attempt directory.

See [Native MiniCPM qualification and comparison](native-driver-readiness.md) for exact CLI handoff/recovery, qualification, runtime observation, and capture requirements. The current extension's targeted tests are documented there.

## Source and evidence

The generic implementation and method packet originate from source candidate 630c6819026a13e65ba7549fc25f611d7ebaeaf3. The published idle fixture is newly fabricated and labeled as such; the corresponding test title, exact fixture hash, and synthetic-label assertions are the only test adaptations.

Historical machine observations, private run records, raw native receipts, and application context are outside this reusable package. They are not needed to run its offline tests. A passing offline test does not claim an actual MiniCPM result.
