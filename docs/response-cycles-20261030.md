# Recursive response cycles

Implementation note, 2026-10-30. This describes the five-stage response architecture and its operational boundaries. The contracts support bounded, inspectable work with configured models; this change makes no measured claim about model accuracy, latency or cost.

## Lifecycle and ownership

A Planning request contains real `kind: "cycle"` container nodes. Each container owns five ordered stage nodes and can contain further cycles beneath a particular stage. Containers have no model response. Host descriptors live in `request.responseCycle.cycles`; the read projection exposes `request.cycles`, stage readiness, progress and current Plan references.

| Stage | Stored kind | Public output and purpose |
| --- | --- | --- |
| Feasibility | `viability` | Existing typed requirements: objective, essential inputs versus preferences, inspected evidence, supported inference, permitted omission, consequential unknowns and dependent work. |
| Inference | `inference` | Bounded interpretations, alternatives, uncertainties and typed claims distinguishing `observed`, `inferred` and `unknown`. |
| Plan | `plan` | Editable proposed steps, acyclic dependencies, explicit acceptance criteria and unresolved prerequisites. |
| Think | `think` | Evaluation of available results against current criteria, contrary evidence, uncertainty and concise public decision rationale. |
| Respond | `respond` | Complete final answer and explicit coverage of every current criterion, including visible limitations. |

For an operational run, `ResponseCycleService.forRun()` prepares Feasibility, Inference and Plan before workflow agents execute. The engine receives the exact recorded Plan body and reference as task context. At the normal workflow completion boundary, `finishRun()` captures actual outputs and tool activity, then drives Think and Respond. The stages run through the response-only Planning runtime with no BLACKICE action tools attached. Workflow agents remain responsible for operations.

A standalone analytical cycle has host execution context `required: false`. A linked cycle must have a terminal host execution disposition before its post-work stages can pass. Fatal workflow errors and cancellation save the corresponding cycle settlement without additional model calls. They do not start further response turns merely to complete the five labels.

Readiness has two separate meanings:

- `analysisReady`: the recorded stage is usable for subsequent analysis.
- `dispatchReady`: the stage's essential prerequisites and required child dependencies permit dependent operational work.

Properly examined essential unknowns can be analysis-ready while dispatch remains held. Feasibility can identify unaffected workflow branches; the engine holds dependent nodes and descendants while retaining independent useful results. A recorded final response can have outcome `satisfied`, `partial` or `unresolved`. Completing the response does not establish that every requested effect occurred.

## Typed public contracts

[`public/response-cycle-model.mjs`](../public/response-cycle-model.mjs) defines templates, strict JSON schemas, parsers and pure readiness evaluation. Feasibility retains the existing requirements envelope. The other four stages require `values`, `grounding`, `openQuestions`, `challengeResponses`, `checks`, `subproblems` and `childResults`, plus their stage-specific fields.

| Structure | Required content |
| --- | --- |
| `checks[]` | Declared check `id`, `assessment`, `sourceIds`, concise public `note`. Applicability is evaluated against host context. |
| `inferences[]` | `id`, `claim`, `basis`, `sourceIds`, `limitation`. Observed and inferred claims require captured source references. |
| `acceptanceCriteria[]` | `id`, `label`, observable `description`, `verification` of `response`, `evidence` or `effect`. |
| `steps[]` | `id`, `label`, `description`, `dependsOn`, `criterionIds`, `sourceIds`. Every criterion needs proposed work; foreign references and dependency cycles are rejected. |
| `criterionResults[]` | Current `criterionId`, `assessment` of `satisfied`, `unsatisfied` or `uncertain`, `sourceIds`, host `receiptIds`, concise `rationale`. |
| `coverage[]` | Current `criterionId`, `disposition` of `addressed`, `partial` or `unresolved`, `sourceIds`, an exact `responseExcerpt`, and any required `limitation`. |

`values.answer` is the complete delivered response. Coverage excerpts must occur in that answer. Partial or unresolved coverage must disclose its limitation there. Think publishes concise evaluative findings and rationale; the contract does not request or store private reasoning transcripts.

Models cannot write host readiness, execution state, completion flags, provenance or effect receipts. A satisfied effect criterion requires a matching host receipt with the correct criterion binding, current evidence, successful state and observed-effect verification. Captured tool success alone is not that verification; the current generic workflow capture records tool activity without manufacturing verified-effect receipts.

These checks establish shape, reference validity, freshness, recorded dependencies and receipt bindings. They do not independently prove that prose is true, an inference is sound, or a source is trustworthy. An analytically complete evaluation can truthfully report an unsuccessful outcome.

## Recursive subproblems

A `subproblems[]` entry requests a smaller problem using `key`, `title`, `objective`, `reason`, `required`, `sourceIds` and `acceptanceCriteria`. The host creates the child cycle and binds its full request. Reusing a key with a different objective or completion contract is rejected. Child source selections must come from the parent stage's captured evidence; explicitly selected parent results and execution observations remain available to the child.

Each child uses the same five stages. Its Plan must preserve the parent-requested criterion IDs, descriptions and verification types; additional criteria and clearer labels are allowed. The parent aggregates terminal findings through `childResults[]` entries containing the bound `key`, current result `sourceId`, public `summary` and `usedFor` explanation.

Required children hold dependent operations until their host-derived state is completed, outcome is satisfied and `dispatchReady` is true. A failed, cancelled or unresolved child can still supply a truthful finding for parent analysis. Optional children do not create hard graph dependencies. Recursive execution uses finite host budgets and retains unfinished findings for inspection when a limit is reached.

## Plan only: one contract for people and supervising models

`planningExecutionMode` accepts `automatic` or `plan_only`. Plan only requires Planning On; the engine rejects the combination of Planning Off and Plan only. Ordinary Planning Off skips the response pipeline. Managed schedule admission still checks its host-backed deployment readiness.

Plan only stops after a usable Plan with state `paused_after_plan`, without dispatching workflow agents. Reading, creating a cycle and editing a Plan save or inspect graph data. An explicit Run starts stage work; an explicit Continue uses the current Plan revision to resume the original conversation. A linked run whose operations are still pending retains the Plan boundary when its stages are rerun.

The local/paired-human HTTP API is:

| Method and path | Operation |
| --- | --- |
| `GET /api/planning-browser/requests/:requestId` | Read current graph, cycle metadata and revisions. |
| `POST /api/planning-browser/requests/:requestId/cycles` | Create a cycle using `title`, `purpose`, optional `parentNodeId` and execution mode. |
| `POST /api/planning-browser/requests/:requestId/cycles/:cycleId/run` | Run stages using the selected execution mode. |
| `POST /api/planning-browser/requests/:requestId/cycles/:cycleId/plan` | Save the complete typed Plan body in `plan`. |
| `POST /api/planning-browser/requests/:requestId/cycles/:cycleId/continue` | Continue from the exact recorded Plan. |
| `POST /api/planning-browser/requests/:requestId/viability/answer` | Answer a current essential factual question; `nodeId` selects the root or nested Feasibility stage. |

Cycle creation, Run, Plan editing and Continue carry a stable `clientRequestId` and `expectedRequestRevision`. Run, editing and Continue also require `expectedCycleRevision`; child creation checks `expectedParentRevision`. Plan editing and continuation additionally require `expectedPlanRevision` and `expectedPlanResponseId`. Derive these from the latest read; host-owned metadata is excluded from the edited Plan body.

The factual-answer body uses `requirementId`, `answer`, `expectedNodeRevision`, `expectedResponseId` and a stable `clientRequestId`. The HTTP route accepts optional `nodeId`, retaining the existing default root-readiness selection; provide it explicitly for a particular root or nested stage. The host checks that the exact question is still current before recording the answer.

In Plan only, Answer rechecks only the selected Feasibility stage, preserves the saved Plan response revision and leaves the cycle paused. New evidence can invalidate downstream readiness; refresh or revise the Plan before an explicit Continue. In automatic mode, Answer rebuilds the checked child/parent preparation through Plan and may resume the one saved original intent when its current dependencies permit dispatch. It does not create a new task intent, and identical retries recover the same continuation.

Supervising callers use the same service:

- `relay_control`: actions `planning_cycle_create`, `planning_cycle_run`, `planning_cycle_edit_plan`, `planning_cycle_continue` and `planning_cycle_answer`, with `graphRequestId`, optional `cycleId` and a `cycle` payload. Answer uses the selected Feasibility `nodeId` and its question revision fields; the shared control payload also carries `expectedRequestRevision` and `clientRequestId`.
- Direct tool `blackice_planning_cycle`: actions `create`, `run`, `edit_plan`, `continue` and `answer`. Answer requires `nodeId`, `requirementId`, `answer`, `expectedNodeRevision` and `expectedResponseId`. The tool uses existing `commands:run` and `planning:write` scopes. Its outer `requestId` identifies the durable direct action; `graphRequestId` identifies the Planning request. The adapter supplies its actual durable job ID as the service's `clientRequestId` and records the authenticated caller receipt. Read current metadata with `blackice_planning_graph_read`.

Human edits, supervising-model edits and authenticated external-agent edits retain distinct provenance. Pending action receipts are saved before continuation dispatch. An identical retry recovers the admitted run or completed receipt; reusing an action ID for different content conflicts. Continuation keeps the original task/conversation identity and checks the exact Plan again under the graph lock.

## Freshness, display and compatibility

Readiness is recomputed from current host records. Source additions, removals, content or provenance changes; changed node revisions; revised prerequisite responses; and changed required child results can invalidate an earlier finding. Historical snapshots remain inspectable. A paused Plan cannot continue against stale evidence. If a Plan changes during operational execution, the existing outputs remain available and require review against the new revision.

Preparation stages receive their relevant current evidence. Their own later execution records are introduced to Think and Respond, so completing work does not itself invalidate the earlier Plan. Explicitly selected evidence for a recursive child is carried across that boundary. Managed runs from the same schedule use distinct per-run graphs after the shared deployment admission check.

Display names come from request/cycle titles and purposes, stage labels, step descriptions, criterion labels and source titles. Stable IDs and hashes remain internal bindings for APIs, provenance, recovery and exact revisions; they are not the primary navigation labels.

The operational engine retains the existing workflow graph and task-state planning machinery, including recursive conditional branches and nested Boolean evaluation. This response-cycle schema adds no Boolean expression language. Typed Plan dependencies and acceptance criteria are passed as the current execution context; the existing executor continues to own its branch selection and action ordering. Saved native sessions retain their published control schemas through `control-tools-legacy.mjs`; new sessions use control schema version 5.

## Bounds and verification

Default recursion limits are depth 4 (root depth 0), 24 cycles per request and 8 children per stage. A driving operation shares a budget of 160 stage admissions with its children, with at most 3 refinement passes per stage. The contract also bounds a response to 120,000 characters, a field to 8,000 characters, a Plan to 40 criteria and 80 steps, and each response to 8 subproblem requests. Existing graph/storage limits remain in force. `stageAttempts` records durable stage attempts, not a model-quality or cost metric.

[`tests/response-cycle-model.test.mjs`](../tests/response-cycle-model.test.mjs) checks pure contracts, freshness, recursion, evidence and outcome rules. [`tests/response-cycle.test.mjs`](../tests/response-cycle.test.mjs) exercises the real store/runtime with synthetic providers, including the execution boundary, inert Plan edits, uncertain-continuation recovery, recursive aggregation, unmet child prerequisites, caller provenance and settlement without further provider turns. Run these alongside the engine, Operations and adapter suites when changing admission, cancellation, per-run isolation or exposed APIs. These tests establish deterministic host behavior; they are not a benchmark of model reasoning quality.

Primary implementation: [`lib/response-cycle.mjs`](../lib/response-cycle.mjs), [`public/planning-browser-model.mjs`](../public/planning-browser-model.mjs), [`lib/planning-browser.mjs`](../lib/planning-browser.mjs), [`lib/planning-browser-runtime.mjs`](../lib/planning-browser-runtime.mjs), [`lib/planning-browser-http.mjs`](../lib/planning-browser-http.mjs), [`lib/direct-response-cycle-tools.mjs`](../lib/direct-response-cycle-tools.mjs) and [`lib/engine.mjs`](../lib/engine.mjs).
