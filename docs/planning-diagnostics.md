# Canonical Planning diagnostic

> **Status: Historical documentation.** This preserved release-era design, evaluation, or migration record is **not current usage guidance or deployment evidence**. Do not infer present defaults, tool contracts, or installation state from it. See [current documentation](README.md) and [source release notes](../RELEASE-NOTES.md).

This developer-only HTTP surface validates authoring against an immutable saved native snapshot. It is not a task continuation, execution test, or proof of completed external effects. It adds no ordinary model-facing tools.

## Routes

All routes use the server's existing authenticated session, Host and same-origin checks.

- POST /api/planning-diagnostics/capture: sourceRequestId, sourceCycleId, expectedSourceRevision, clientRequestId, profile { model, effort, serviceTier }, limits { maxProviderTurns, maxCycles, maxDepth, maxPassesPerStage }.
- POST /api/planning-diagnostics/{id}/run: expectedRevision, captureHash, clientRequestId.
- GET /api/planning-diagnostics/{id}: saved graph, readiness, capture manifest, durable reservations and outcome.
- POST /api/planning-diagnostics/{id}/cancel: empty object.

Capture requires the original host canonical schema-14/contract-2 source, actual saved workflow agent identities and immutable attachment hashes. Native attachment hashes are carried by exact attachment:sha256:<64 lowercase hex> resource keys; an optional raw sha256 must agree. The attachment IDs and set scope must match the saved run exactly. Identical content under separate saved IDs remains valid. It records exact original-to-diagnostic source mappings, original request/run hashes, authoring policy, explicit model profile and runtime context/timeout. It does not refresh sources, read attachment paths, create an Engine run, install a contract or manufacture workflow ownership.

Every capture needs explicit limits. A deliberately small first diagnostic profile is 12 logical model invocations, one root cycle, depth zero and two normal generation/refinement passes per stage. This permits one normal refinement, while a required analytical child produces an honest scope stop. It does not silently discard the child. Allowed maximums are 24 invocations, four cycles, depth two, three passes. Increasing limits requires a new capture, not editing or restarting a spent one.

The invocation limit includes stage generation, normal refinement, format repair and semantic review. Each dispatch first persists a nonrefundable reservation keyed to its actual attempt. Duplicate reservation is no-dispatch. Cancellation retains consumed reservations; an interrupted host never replays uncertain work. A second store cannot interrupt a live process owner. An apparently reused PID is conservatively treated as busy. Physical HTTP retries may occur inside an invocation; physicalRequestCeiling is null and no hard physical-request guarantee is offered.

Only an unforgeable process-local capability admits diagnostic module work. Knowing a diagnostic ID does not authorize ordinary module, graph-edit, cycle-run, continuation, answer, adoption or publication paths. The snapshot's authoring policy takes the same canonical validation path as native Planning, including browser receipt, confirmation and attachment-scope normalization, but is not executable ownership. dispatchReady remains false.

Completed means canonical authoring passed against the captured historical inputs. Limited means a declared call/pass/child scope or unresolved stage prevented a complete canonical Plan. Failed, cancelled and interrupted remain distinct. No diagnostic result claims native Engine resumption, accepted applications, effect enforcement or semantic certainty.

Synthetic tests: node --test --test-concurrency=1 tests/planning-diagnostics.test.mjs. Provider calls and real saved graphs are not needed for these tests.

Limits are per capture. Independent explicitly requested captures can run concurrently within the existing global module-worker capacity. A retry of one active capture joins the same operation; a different run identity cannot start another copy. Diagnostic readiness refreshes and new user answers are rejected. Only exact host-derived child context/results may extend the original frozen source set.
