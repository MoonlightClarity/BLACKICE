# Planning tool exposure and bidirectional state

Planning has distinct durable objects: canonical task intent/runtime state, recursive module graphs, response-cycle programs, and direct execution outcome evidence. Exposing one does not imply the others are available. Tool admission, module completion, and confirmed external effects are different results.

## Shared surfaces

- Canonical task intent: native `relay_task` and direct `blackice_get_plan` / `blackice_edit_plan` retain their shared TaskStore contracts. Exact revision checks remain mandatory. Direct task-contract/context tools bind execution to canonical source identity rather than copying a model claim into host evidence.
- Recursive graphs: native coordinator `relay_planning_read` / `relay_planning_write` and direct `blackice_planning_graph_read` / `blackice_planning_graph_write` share graph reads, sources, responses, hierarchy/dependencies, `doneWhen`, skip reasons, assignments, program XML reads and CAS writes. Mutations remain inert. Attempts and live host execution status are readable without exposing raw model prompts or private protocol payloads.
- Explicit module execution: `relay_planning_module` / `blackice_planning_module` run an exact saved revision or cancel an exact attempt. Admission returns before analytical completion. Read attempts and response history for the eventual result. Response-only workers intentionally receive no action tools. This is not a general operational executor.
- Response cycles: existing native `relay_control` cycle actions and direct response-cycle actions use the same host service. Canonical Plan edits are now exposed in native control schema12 and direct edit schema. Frozen schema11 and earlier historical catalogs are not expanded or rewritten.
- Outcomes back into planning: authenticated canonical reads append `directExecution` evidence from the host outcome store. Local UI and native reads require an explicit verified attachment. Native evidence is a separate bounded payload and cannot modify the authoritative task state. UI renders a separate evidence disclosure. Source revision/digest/epoch mismatch is stale, not success. UNKNOWN effects remain unresolved, not automatically replayed.

## Authority and scope

Native coordinator graph controls are bound to the active canonical conversation. Cross-conversation reads/writes and forged actors are rejected. Secondary/delegated agents and response-only analytical workers do not inherit coordinator controls. Native provenance records supervising-model authorship rather than claiming human or OAuth authorship.

Direct operations continue to require OAuth scope and durable job ownership. Module run/cancel requires both commands:run and planning:write. Native retries use host-derived request IDs and persistent graph receipts. Publishing the tools is not a substitute for the existing operation admission, destination commit, semantic identity, and evidence validation controls.

Projection is read-only and evidence-only. It does not mark criteria complete, satisfy canonical admission, authorize a destination commit, overwrite an outcome, or repair an uncertain external effect. Remote browser/agent credentials are not OAuth grants. Forwarded readers never use the local attachment projection, including expired or consumed forwarding credentials. RemoteAgentAPI can project only when its host provides an explicit verified resolvePlanningClient mapping; none is assumed by matching IDs.

## Deployment checks

The source integration does not update an already installed app or refresh an existing connector's cached tool metadata. Release/install and connector catalog refresh are separate requirements. Verify the served tools/list, complete JSON schemas, and the actual caller-visible catalog after deployment, then run a disposable cross-surface read/edit/run/result test. Preserve historical chats' saved native catalogs; start a new native conversation when testing newly added controls.

The installed 2.39.57 app inspected during this work advertised 39 backend tools, while this existing connected conversation exposed only 30 definitions. Its cached planning edit schema was also older and structurally opaque; `blackice_task_contract`, `blackice_task_context`, and browser `taskContext` fields were absent. An observed commit without an owner/tab binding was correctly rejected as `DIRECT_TASK_REQUIRED` before effects. Existing backend create/bind support cannot repair missing caller metadata by itself. That is a remaining deployment/catalog issue, not evidence that the source handlers are absent. The added module tool increases the configured host catalog by one. No source-only unit test proves that the caller has received refreshed metadata.

## Regression coverage

Tests exercise UI/store to direct and native reads, tool writes back to UI/store, canonical contract edits, optimistic concurrency, provenance, module admission and final response readback, exact cancellation, orphan UNKNOWN status, source staleness, owner isolation/revocation, remote identity separation, frozen native schemas, historical catalogs, coordinator restrictions, and response-only worker isolation. Independent review additionally checks snapshot consistency and persistent native retry identity.

## Canonical creation and binding

For a new shared canonical document, call `blackice_edit_plan` with a new taskId, expectedRevision 0, and the sole operation `{type: 'create_contract', contract: ...}`. The host validates and atomically writes schema 14 intent at epoch 1/revision 1 with standalone metadata and authenticated provenance. Existing IDs and concurrent creation conflict; reread rather than replaying blindly. Legacy `create` remains legacy and is never silently migrated.

Then `blackice_task_contract` bind_plan binds that exact canonical task/revision into direct outcome accounting; bind associates the observed destination/control with its work item and criterion. Binding is not a submission. Direct reads project host outcome evidence back alongside the same canonical intent. The transport regression exercises creation, list/detail/UI visibility, bind_plan, observed-control binding, and readback with a mock browser and no provider turns or external effects.

Validation completed for this change set: 1,606 broader Planning/direct/Engine regression cases passed across 135 files, including rerunning environment-dependent fixtures against existing Python/Electron installations. The final integrated create/bind/parity suite passed 87/87. Live caller catalog verification and deploying source changes remain separate from these source tests.
