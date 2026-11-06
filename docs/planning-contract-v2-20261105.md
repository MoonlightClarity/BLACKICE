# Planning contract v2: plans, work items, and operation receipts

## Status and decision

This document describes the implementation on `planning-execution-redesign-20261105`, based on commit `4df03d1b7eff8f5c7afecee7cc7037581e177942`. The complete Windows source suite passed for the frozen application and source bindings, and the native city-tolerance check passed at the Plan-only boundary. Native operational acceptance remains incomplete because provider/model constraints interrupted attempts; the latest native attempt was stopped at user direction. The versioned source and native verification receipts record these distinct scopes without claiming full native operational acceptance. Successful hosted verification of the exact Windows installer remains required before public release. Existing tasks and provider sessions retain their captured contracts until a supported, settled migration boundary is used.

Use one canonical plan of bounded work items. Keep the actual operation lifecycle and evidence in the existing host journal. Forced planning requires a current owned work item and applicable execution conditions; it does not require a separate model-authored plan node for every input, click, read, or validation correction.

The runtime remains responsible for authority, resource conflicts, cancellation, durable admission, uncertain effects, and evidence-backed accounting. The model remains responsible for interpreting the task, choosing useful work, explaining decisions, and proposing grounded outcomes. A model's narrative is not a receipt.

## Evidence motivating the change

A cancelled dynamic-form run produced 579 completed tool callbacks, of which 379 were task bookkeeping. Forty-two of 46 failed callbacks concerned the planning protocol. One first-name entry required five calls: activate a task leaf, read, fill, read, and mark the leaf done. The run produced no confirmed external completion.

The implementation explains this behavior. `lib/planning-sequence.mjs` associates one primary dispatch with one active leaf, matches that leaf's tool/action, and requires a model-written disposition before another primary operation. Its `reportedOutcome()` derives reported completion from task status and prose evidence. `lib/planning-policy.mjs` directs the model to expose and manage these operations explicitly.

The same run also showed why removing enforcement wholesale would be inadequate. Partial source reads were described as complete coverage, a prior outcome was classified as new, and repeated Submit actions returned the same validation error. Successful tool delivery, truthful source coverage, and the requested external result are separate facts.

Only aggregate findings are included here. Personal application records, contact data, attachments, and raw traces are not release inputs.

## One plan and three kinds of state

The task store owns the accepted plan. The preparatory Plan, executor, human editor, continuation context, and completion controller refer to that same document. The handoff validates and adopts the accepted document deterministically; it does not ask a second model to author a different executable outline.

| State | Meaning | Advances when |
| --- | --- | --- |
| Plan epoch | Version of material intent and constraints | Goal, scope, ownership, dependencies, or outcome criteria change |
| Work-item lease | Current owned execution focus | A worker takes or releases work, or relevant context is revoked |
| Journal sequence | Actual execution chronology | An operation is reserved, dispatched, settled, observed, or reconciled |

Routine observations and field changes advance the journal without revising the plan. Unrelated sibling progress does not invalidate another worker's context. A material user edit affects the next relevant admission; it does not rewrite a previously dispatched operation or its late result.

Canonical task actions declare separate field sets. `plan` accepts only `action`, `expectedRevision`, and the authorable `contract`; omit the host-owned `contract.planEpoch` when copying a read contract. Only `focus` and `assess` use top-level `expectedPlanEpoch`. `describe.actionFields` exposes the complete action-specific lists, and the host names unexpected fields and the allowed fields in its rejection. The strict action allowlists and legacy task catalogs are unchanged.

The new contract has an explicit version. Legacy documents and tool catalogs keep their original semantics. Old `done` text can be retained as a legacy report; migration must not relabel it as independently verified success.

The original accepted Plan remains immutable authoring provenance. Material work-item edits advance the canonical task's epoch; the current task and journal drive completion. Final review receives a host-generated snapshot tied to the accepted Plan, current epoch and journal sequence. It is checked again before publication. If the review is incomplete, stale, or too large, the fallback reports the current supported counts, unresolved operations and recorded findings. Unchecked worker completion prose remains in history rather than becoming the final result.

## Work items and conditions

A work item represents cohesive work against a bounded resource: for example, inspect a source, produce an artifact, or complete and verify a particular form. It records the desired outcome, owner, allowed resource/effect scope, applicable conditions, discovery needs, and progress budget.

One form work item can include reading controls, entering multiple fields, using a custom dropdown, uploading an authorized attachment, inspecting validation, correcting input, submitting, and observing the result. It must not grant arbitrary mutations across unrelated destinations.

Separate conditions by when they apply:

- **Entry conditions** establish whether work can begin.
- **Commit conditions** establish whether a particular external commitment is permitted.
- **Completion conditions** establish whether the requested result occurred.

Observation must remain possible when it is needed to establish a later commit condition. List placement and a model's preferred order are not themselves hard dependencies. Reject real dependency cycles before dispatch and explain the participating conditions. Preserve independent ready work when another item is blocked.

Already-established workflow ownership, execution configuration and user authorization remain captured constraints or instructions. Do not invent a completion prerequisite to re-prove them unless the user expressly requests that verification. Preserve actual task-relevant resource prerequisites and the complete inherited criteria.

Declare only the task-authorized effects needed within the work item's bounded resources. Include `observe` for its own verification and recovery. Include `opaque` when authorized browser behavior cannot be classified before dispatch. This leaves resource scope, prerequisites, evidence requirements and uncertain-effect protection in force.

## Operation lifecycle and effects

Evolve the existing `.sequence` persistence into the new contract's operation journal. Preserve durable reservation, host call identity, payload conflict checks, atomic writes, actual ownership, interrupted uncertainty, and late-result handling. Do not create a second competing journal.

An operation envelope binds the task, work item, owner/lease, plan epoch, tool catalog, host operation ID, provider/session/call identity, resource descriptor, and evidence references. Sensitive payloads belong in the existing access-controlled evidence store; the journal uses bounded identities and digests.

Delivery state and effect state are distinct:

| Delivery state | Meaning |
| --- | --- |
| Reserved | Durable admission exists; dispatch has not been established |
| Dispatched | The action may have reached the tool or destination |
| Returned | An actual tool result is recorded |
| Cancelled before dispatch | The host can establish that no dispatch occurred |
| Interrupted | Settlement is incomplete |

| Effect state | Meaning |
| --- | --- |
| Not applicable | No relevant mutation was attempted |
| Unconfirmed | The interaction occurred; the requested effect is not established |
| Confirmed | Applicable evidence establishes that particular effect |
| Absent | Applicable evidence establishes that the attempted effect did not occur |
| Unknown | It may have occurred; replay requires reconciliation |

The host records routine return automatically before the next cohesive interaction. A returned fill does not need a separate model call to acknowledge that the tool returned. A successful upload remains an upload; a successful click remains an interaction until the required external confirmation is observed.

If persistence fails after an actual effect, preserve the result and uncertainty. Never convert a storage failure into permission to repeat the action.

A verified later confirmation can settle the effect while the original transport delivery stays interrupted. The confirmation retains its actual observing operation and the original effect linkage. Conversely, a reservation with no live owner that never reached the durable dispatch boundary records no dispatched effect. A live reservation still occupies resources and outcome capacity. These facts must be consistent in admission, continuation and final review.

## Scope, classification, and concurrency

Work-item effects are explicit: include `observe` wherever inspection is needed; `interact` and `commit` do not imply it. Native browser tab inventory has the stable host resource `browser:relay`, including when a caller supplies a tab or control hint. Declare that resource for narrow inventory work; a site's `origin:` or `url:` scope covers its page operations. Inventory evidence keeps its browser identity and does not inherit a listed page's origin or document scope.

Denied admissions report the requested effect, bounded exact concrete resource identities, the focused item's allowed effects, and matching owned work-item IDs. When several owned items match but the current focus does not, `TASK_CONTRACT_FOCUS_REQUIRED` requests selection of one matching item. Missing effects and uncovered resources remain explicit scope failures. These denials create no operation reservation or dispatch and require no material plan edit when an existing matching item can be selected.

Use trusted descriptor/handler metadata and actual target observations to classify resources and effects. Do not trust model-supplied `readOnly` labels. Do not maintain divergent policy lists that disagree with the attached tools.

The runtime distinguishes observations, interactions/mutations, external commitments, and recovery/control. Browser classification must account for custom controls, autosave, uploads, and submission. Where semantics are not established, preserve conservative possible-effect treatment and explicitly report the limitation; never infer domain success from an input receipt.

A recognized commitment binds its destination/object, form or document identity where relevant, payload and attachment digests, work item, existing authorization, and required evidence. This does not add a new user approval for every action. Existing task authorization persists.

Use resource conflicts to control concurrency. Independent observations can run together; disjoint work can continue. Conflicting mutations are serialized or version checked. An uncertain effect blocks conflicting commitments while permitting observations and independent work. Reads of a mutable browser document still obey document/reference validity and navigation conflicts.

## Evidence and completion

Evidence objects identify actual source versions, delivered ranges, truncation, browser documents, artifact digests, operation results, and external confirmations. Interpretations are labeled as interpretations and cite their observations.

Complete source coverage is a computable property. Repeating lines 1–37 does not cover a 93-line document. Coverage must refer to one stable source version, or to an explicitly complete structured query. Metadata must describe what reached the worker or the authoritative query, not an unbounded backend fetch that was later truncated.

Completion is criterion-specific. Mechanical criteria use declared verifiers and real evidence; qualitative judgments remain grounded claims. An arbitrary `done` label cannot create a confirmed external outcome.

Choose criteria by what the host can establish:

| Kind | What its count measures |
| --- | --- |
| `observation` | Distinct observed resource identities, not entities or eligible options mentioned inside a document. |
| `source-coverage` | Complete delivered ranges for one exact concrete source version; omit `targetCount` or use `1`. |
| `external-confirmation` | Distinct new destination-confirmed effects, excluding prior, absent, duplicate and unlinked records. |
| `judgment` | An evidence-backed semantic assessment; each distinct owning work item contributes at most one assessment. |

Use grounded judgments for sufficiency, eligibility, comparisons and other conclusions. Source coverage needs the exact source identity that produces versions and delivered ranges. `workspace:` and `origin:` select scopes and cannot identify a source coverage target.

New-authoring feasibility validation rejects source coverage counts above one and the known scope-only `workspace:` and `origin:` selectors before a Plan or material edit is saved. Historical normalization, projection and reads retain their existing behavior. The host's exact resource matching, stable-source coverage, receipt checks and inherited-criterion guard are unchanged. Current canonical analytical stages and execution share the same authoring guidance; historical pipeline and schema-13 instructions retain their captured behavior.

Canonical criteria may include an optional `accuracy` field governed by the existing `taskAccuracySchema` and `validateTaskAccuracy` rules. Preserve inherited required criterion metadata in full, including accuracy, through the preparatory Plan, canonical normalization, and projection. This lets the canonical document represent the workflow's existing accuracy requirements; the whole required criterion is still checked before admission.

Accuracy applies to the outcome or criterion it governs. The current Infer, Feasibility, Plan, Think, and Respond pipeline and canonical execution share guidance that preserves user-approved alternatives, substitutions, granularity, and tolerances. An exact count or receipt requirement must not silently make an unrelated input field require literal text or finer precision. Feasibility can use a supported authorized equivalent that satisfies the intended result, and execution can make that ordinary choice without requesting permission again. Consequential facts and unsupported equivalences must not be invented. Later user corrections flow through refreshed intent findings before a changed Plan is adopted; unrelated exact requirements and the full inherited-criterion guard remain intact. Historical pipeline instructions retain their captured behavior.

Target counts use canonical outcome identities and confirmation evidence. Duplicate receipts, aliases, prior records, successful clicks, and uploads do not inflate the count. Uncertain commitments reserve their potential quota until reconciled when the task requires an exact maximum.

### Evidence normalization and declared receipt meaning

The host binds each evidence record to an admitted operation and work item. Its deterministic content identity excludes the observation timestamp, so re-delivering the same result cannot move an old observation to the end of the journal. A normalized record is an integrity-checked observation, not a credential or authority token. Only the host adapter can introduce these records through the runtime; task actions cannot author confirmations.

Coverage uses zero-based half-open intervals. Combine only matching resource, stable source version, unit and total. The latest distinct observed version in host journal order supersedes older coverage; a newly observed partial version cannot borrow the earlier version's remaining lines. An unknown version remains unknown. Changes observed by another work item still invalidate a stale coverage claim for that resource. This certifies the delivered observed version, not perpetual freshness of the underlying source.

Outcome IDs are scoped by resource identity. Host-bound effect aliases unify duplicates transitively; any prior alias keeps the whole group out of the new-outcome count. An unlinked history receipt cannot establish a new effect. The latest distinct authoritative status observation controls its current confirmed/absent state, with all earlier records retained. The unit being counted must match the request: distinct positions or workshops are different from distinct transport receipts or payload hashes.

A declarative receipt binding names observed DOM attributes or JSON fields, exact accepted status values, destination identity, and form-identity fields. The adapter must extract the actual current values and match a unique admitted effect at the exact destination. The declaration records the accepted meaning of those fields; host extraction does not prove arbitrary business semantics. Missing or ambiguous linkage remains unconfirmed. A history record without a matching new admitted effect is prior evidence. No matching row by itself is not proof of absence.

A preparatory Plan may leave confirmation matching unbound until the actual destination fields are observed. Inspect a current snapshot's `semanticRecords` and `forms`; map the observed DOM or JSON identity fields to actual form control names and the concrete destination. Do not invent fields, paths, status values, or form names to complete a Plan. Keep discovery, binding refinement, and outcome observation within one cohesive criterion-owning work item with authorized `observe`. Select that item as the current focus before rereading the retained result. A separate discovery item's observation does not automatically establish another item's criterion.

An unknown or unconfirmed submission retains its original admitted operation, effect identity, and journal. Refine the existing outcome criterion's binding using observed facts, ensure its owning work item permits the required observation, then refocus that item and re-observe the retained commit. Do not repeat the external submission while its effect remains uncertain. A further submission requires applicable strict absence evidence resolving the pending effect and an otherwise valid new admission.

An absence-only status binding may use `confirmedValues: []` only when `absentValues` contains one or more values actually observed at the destination. Both lists empty is invalid. Such a binding can establish absence only through the applicable record, destination, identity, and effect correlation; it cannot establish success. Positive status values may be added only after actual observation. HTTP or error prose, empty history, and prior or unrelated receipts do not establish absence.

Refining a status predicate does not rewrite retained proof. The host rechecks the retained record against its original binding digest and concrete destination; its canonical outcome identity and confirmed, absent, or prior meaning must remain unchanged. That record remains linked only to its original admitted effect. Changed extraction that leaves exact matching unavailable or ambiguous supplies no new proof and cannot clear a newer pending effect. Fresh distinguishable receipt facts continue to require the existing exact destination, identity, and unique-effect checks.

The host also fingerprints complete bounded selected-record source facts separately from the binding-selected receipt digest: observed DOM data attributes plus normalized record text, or canonical JSON. Only two valid source digests of the same format that differ can bypass the retained old-alias guard; the candidate receipt must still satisfy the ordinary destination, identity, and unique-effect checks. Equal, missing, malformed, or oversized source metadata retains the conservative guard. Binding changes, identity ordering, prior/status reinterpretation, and cosmetic DOM attributes cannot reassign the same fact. Existing extracted-record digest bytes stay compatible. A later byte-identical receipt still needs actual request or occurrence correlation; a new click or timestamp alone is insufficient.

Generic visible confirmation text without structured identity is a separate acceptance requirement. Native `dom-text` evidence needs retained native POST/document correlation and a declared canonical subject identity; arbitrary AJAX text does not inherit that correlation. A synthetic portal with ideal data attributes is insufficient proof of compatibility with ordinary sites. Workflows that depend on an unsupported correlation path remain gated on separate production validation.

Qualitative assessments cite real relevant evidence IDs and apply only to judgment criteria at the current material plan epoch. An old assessment cannot certify a changed criterion, and no assessment can turn a partial read or a successful click into a mechanically verified outcome.

## Recovery, progress, and Stop

Track progress using the work item, resource, attempted effect, relevant observed state, and validation result. Cosmetic plan edits, new node IDs, repeated reads, or reworded notes are not evidence of material progress.

After unchanged validation, permit inspection and correction but do not sustain an identical commit loop solely through planning churn. A genuine relevant change can allow a new attempt. A blocked work item stays visible while independent work proceeds.

Transport uncertainty and known validation failure have different retry rules. Inspect an unknown external effect before any conflicting replay. Keep settled effects and confirmations across context compression, provider turnover, and application restart.

An explicit user Stop forbids subsequent admission and automatic rollover. Cancellation is not rollback: admitted work may settle later, and its real receipt remains attached to the original operation. A future authorized continuation must use the actual saved state, not repeat confirmed effects or count them twice.

## Provider and UI compatibility

Keep the common contract independent of provider wire formats. Response-only preparation remains fresh and tool-free. Its bounded schema does not grow with operation history and stays within the actual schema normalizer's limits.

Native tool catalogs have lifecycle boundaries. Codex attaches dynamic tools at thread start; Vibe supplies its run bridge when creating/loading a session; API transports construct their tool set for the run. A changed contract/catalog requires an explicit compatible continuation boundary. Preserve the selected model, effort, authority, transport receipt identity, and uncertainty.

Provider pending-call journals remain transport recovery records linked to the host operation ID. Finalization waits for admitted callbacks and uses settled evidence. A provider turn limit is not task completion, and a user Stop is not a budget rollover.

Application shutdown keeps setup's existing probe cancellation and drain semantics. After `setup.close()`, the host waits for already admitted setup check/confirm responses, including their connector snapshot, before closing remote-access and connector dependencies. New requests still receive HTTP 503. The additional drain covers only those already admitted responses.

The interface shows three distinct projections: intended outcomes/work-item progress, actual operation history, and semantic plan changes. Journal activity must not create fake plan revisions or outcome progress. Keep the recent view bounded, with complete paged history available. Preserve focused editors, local drafts, actual context-delivery records, and public-only output.

Forced, Advisory, and Off retain their advertised meanings. Forced additionally requires current work-item readiness; Advisory does not gate ordinary work on that readiness; Off requires no plan. Authority, cancellation, truthful effects, and replay protection remain independent of planning mode.

### Actual context delivery

A tool handler returning a plan is not proof that the provider received it. Context readiness advances only after the accepted provider wire payload or native bridge write contains the exact plan result. A compacted-away, rejected, partially written or replaced result cannot acknowledge delivery. Large contracts use a bounded manifest and exact revision/hash/offset pages; every required page must actually arrive before that snapshot is treated as delivered. Routine operation observations do not cause new plan-delivery requirements.

### Captured compatibility boundary

New browser and workspace workflows use task schema 14 and canonical contract 2. Existing tasks keep their captured schema. Authorized VM workbench workflows still explicitly capture schema 13 with a visible compatibility reason while their host effect and control-restoration verifier is ported. They retain the requested planning mode and existing verification duties. This is a declared adapter boundary, not proof that every workflow has moved to the new contract.

Lost filesystem-write replies remain uncertain unless an applicable trusted reconciliation adapter establishes the expected result. A later generic file read alone does not prove the original attempted write. Likewise, native form navigation and arbitrary JavaScript fetch submission need distinct actual browser correlation evidence; support for one does not establish support for the other.

## Ordinary quality findings

Respect the user's handling of ordinary instruction violations. When an ordinary preference is explicitly audit-only, record and report the finding against the actual content and effect without blocking, rewriting, or retracting an otherwise authorized action. Do not silently promote a quality issue into an authority barrier.

This does not make every instruction optional. Actual authorization, resource ownership, cancellation, uncertainty protection, and truthful outcome accounting remain mandatory. No policy label may grant unrelated authority or manufacture qualifications or confirmation evidence.

## Acceptance and rollout

Start with a coherent production-path slice: one canonical plan, several interactions within a bounded form work item, a validation correction, one real fixture commitment, a confirmation, and an accurate final response. The trace must not rely on manual per-field plan/read/activate/done calls.

Required negative and recovery cases include out-of-scope effects, parallel observations, real dependency cycles, partial source coverage, unchanged validation, an accepted commit with a lost response, duplicate/previous outcomes, relevant user edits, competing ownership, cancellation, and explicit continuation.

Use a disposable rendered portal and synthetic profile with an independent server ledger. Exercise the common engine through the actual Codex, Vibe, Responses, Messages, and compatible Chat adapter paths with deterministic transcripts. Then run ordinary uncoached tasks through available actual providers. Provider combinations unavailable for live testing remain explicitly unverified.

Extend the fixture to 20 distinct outcomes to test sustained work, bounded context, complete history, and accurate counts. Record latency and call counts as diagnostics; do not substitute an arbitrary bookkeeping-percentage target for genuine completion and recovery.

Publication and production rollout require the new contract, migration, provider, UI, and end-to-end evidence together. Parser tests, synthetic aggregate results, and successful first tool calls remain diagnostic evidence within that larger requirement. Each production workflow remains gated on its applicable acceptance evidence.
