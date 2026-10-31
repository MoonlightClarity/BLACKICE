# BLACKICE Planning browser — architecture candidate

## Purpose

Planning is a dedicated application organized by conversation and concurrent requests. Its central technique is **defamiliarization**: required, task-specific questions make an agent examine aspects of a problem that its ordinary response would tend to omit.

A planning-tool call is transport, not evidence that analysis or an external action occurred. The durable unit is a public response to a defined module, with its exact inputs, required fields, sources, challenges, and authorship. The application records what was produced and exposes what remains unsupported.

The current dogfooding loop and installation of its candidate are paused. This work is isolated in the development checkout. Existing conversations, plans, browser sessions, and resumes are preserved.

## Workspace

The existing Planning navigation entry opens the Planning browser.

- A conversation rail groups related work without forcing all requests into one execution thread.
- Each conversation can have several open request tabs. Each tab retains its own selected module, Outline/Graph view, draft fields, expansion state, and worker state.
- Outline displays recursive containment. Graph displays containment alongside explicit dependency, consumption, support, challenge, and knowledge relationships.
- The inspector displays the selected module's question, required response fields, actual response, sources, inputs, challenges, children, and assigned worker.
- Legacy plans remain an explicit view. Existing self-reported steps are not silently relabeled as validated graph responses.

Only the active request renders its graph; other requests retain their sessions and can continue running. Graph identifiers must be scoped so switching requests does not mix selections or SVG relationships.

## Defamiliarization modules

Modules impose different analytical obligations. They are not interchangeable status cards.

| Module | What it makes explicit |
| --- | --- |
| Frame | Desired outcome, real constraints, alternative framing, pivotal assumption, and decision-changing unknown. |
| Inquiry | Question, competing explanations, discriminating observation, smallest useful check, findings, and remaining uncertainty. |
| Evidence | Claim, source assessment, support, contradictions, and limits. |
| Comparison | Criteria, strongest options, tradeoffs, opportunity cost, and sensitivity of the choice. |
| Decision | Recommendation, strongest alternative, opportunity cost, key assumption, discriminating observation, and reversal condition. |
| Action | Requested outcome, procedure, observed result, verification, and remaining dependency. A written assertion is not an external receipt. |
| Synthesis | Answer, converging evidence, strongest challenge, unresolved matters, and implications. |

A useful decision response names an actual alternative and displaced use of time. “Consider alternatives” and “there are tradeoffs” do not supply those work products. Validation can establish the shape and provenance of a response; it cannot certify that prose is insightful or true.

Required fields are bounded for storage, not scored by arbitrary word counts. Missing grounding, unanswered challenges, and stale inputs remain separate visible conditions even after every required text field has a value.

The templates are shared between the backend and UI. A future template change must not reinterpret an old response without preserving its original contract.

## Recursion and graph structure

Containment answers “what work is inside this module?” A module can gain children when its question still contains distinct consequential questions or work products. Each child has its own contract, response, sources, and ownership.

A parent response does not erase unfinished children. Conversely, independent branches remain available when a sibling is blocked. Recursion expands substantive work rather than producing a leaf for each mechanical click.

Edges have distinct meanings:

- **depends_on** records an actual prerequisite.
- **consumes** binds a consumer to an exact producer response and optionally one field.
- **supports** and **challenges** preserve the relationship between a claim and relevant work.
- **informs** records context without inventing a prerequisite.
- **knowledge** resolves and snapshots an existing scoped knowledge record.
- **contains** is derived from parent identifiers.

Containment and execution prerequisites are acyclic. Semantic relationships may be cyclic when arguments bear on one another; they are not execution loops.

A consumed response retains its immutable identity and revision. Inputs that track the latest answer become visibly stale when that answer changes. Explicit pinned inputs support legitimate historical or as-of comparisons. Earlier responses and their evidence are retained.

## Public responses and sources

The application distinguishes:

1. A module definition and its required questions.
2. A draft or human-authored response.
3. A response returned by an actual model attempt.
4. A response that satisfies its declared field contract.
5. The quality and limits of its grounding.
6. An external effect established by an actual receipt.

None of those states automatically establishes all the others.

User-supplied material is a first-class source, with its content, hash, author, and origin recorded. It remains user-provided evidence. Knowledge links resolve real entries and revisions. Runtime evidence enters through a host-owned writer. A model cannot create verification by supplying a source-shaped name.

The trusted runtime writer captures a module revision, its ownership and inputs, and then records the actual returned public output with run/thread metadata. The ordinary HTTP editing interface cannot manufacture that metadata, set a completed flag, or attach a model result by claiming a tool succeeded.

Invalid structured responses remain incomplete attempts with their actual output retained for inspection. The system does not conceal them with an automatic success label. It records public answers and work products, not private chain-of-thought.

## Concurrent requests and subagents

A conversation is an organization boundary. A request is a work boundary. A module or assigned subtree is an ownership boundary.

Distinct requests can run concurrently in the same conversation without sharing a native model thread. Independent nodes can be edited concurrently using node revisions. A global request revision supports snapshots and history, but it is not the only concurrency control for unrelated branches.

A worker claims a specific module revision. Another worker cannot replace that response while pretending to hold the same claim. Changed inputs, cancelled attempts, and late completions are reconciled against the captured attempt instead of being accepted as current work.

Explicit Run module actions start scoped response workers. Automatic delegation respects configured subagent settings and capacity. Model choice and reasoning effort are preserved. Opening a tab, creating a draft, or viewing a graph does not start a model call.

Cancellation is recorded and the executor must settle. Restart, profile maintenance, and background learning include these workers in the application's active-work accounting. A persisted running claim from a different host is not replayed when its actual settlement is unknown.

## Bidirectional development

The visible workspace, human-facing HTTP API, and authenticated direct connector share one authoritative graph store. A separate demonstration graph is not used. Saved changes emit `planning.browser.updated`, so an open workspace can observe external edits. UI changes persist through the same node-revision checks and remain readable externally.

The new direct tools are `blackice_planning_graph_read` and `blackice_planning_graph_write`. They use the existing `read` and `planning:write` scopes, stable request IDs, durable jobs, and authenticated external-agent authorship. They can inspect and edit request structure, module questions, relationships, sources, and external public responses. The trusted runtime writer is not exposed. Graph editing does not launch a worker.

Large results are bounded and paginated, including response history, source content, edges, and captured input references. A revision conflict returns the current state instead of silently overwriting another editor's work.

BLACKICE's existing development interface also provides workspace reads and guarded patches, commands, app DOM inspection, screenshots, and frontend evaluation. The contained browser exposes its own tabs and guarded actions. Development and verification use those interfaces; no Chrome session is required.

The actual synthetic preview round trip was verified on 30 October 2026. An API edit changed a module from revision 6 to 7 and appeared in the open contained-browser workspace without a reload. A subsequent UI save persisted the distinct title at revision 8, which was read back through the authenticated API. The fixture title was restored at revision 9. No model was requested by either operation.

## Request and schedule viability

The same module framework can express feasibility, value, and supported inference for ordinary requests and scheduled work.

A viability module should recover relevant supplied or saved facts, identify a material dependency, distinguish a supported inference from an unknown personal fact, and determine which unresolved issue changes the next useful action. Independent useful work can remain available.

Scheduled activation is a consumer of those results. An unresolved essential input should be visible while the schedule is still a disabled draft. This is factual setup, not a recurring approval ritual.

The earlier setup-guidance edits are preserved but have not been presented as completed integration of this new architecture. The user's ordered address test remains pending: observe Luna asking for the genuinely missing address before modifying either resume.

## Implementation boundaries

New components:

- public/planning-browser-model.mjs — shared module templates, structured-response validation, graph projection, recursive Outline rows.
- lib/planning-browser.mjs — persisted requests, sources, node revisions, ownership, attempts, response records, and history.
- lib/planning-browser-runtime.mjs — bounded module workers and host-origin response capture.
- lib/planning-browser-http.mjs — human-facing catalog and editing API; no public runtime writer.
- lib/direct-planning-browser-tools.mjs — authenticated bidirectional graph access through durable direct jobs.
- lib/response-profile.mjs — analytical response capability profile and structured-output contract.
- public/next/workspaces/planning-browser.mjs — conversation/request navigation, Outline/Graph, fields, sources, and worker controls.
- public/next/planning-browser.css — responsive workspace presentation.

The server registers the new API, static assets, lifecycle accounting, and notifications. The existing Planning view remains available for legacy work.

Native planning-response workers use a fresh restricted analytical session, disable ambient integrations and declared operational features, verify the new thread's effective feature states and sandbox, and send the required JSON schema through `turn/start.outputSchema`. This does not claim a universal zero-tool allowlist. A missing essential control fails visibly before inference and does not mark the chosen model unavailable.

OpenAI Responses receives strict structured output with no attached tools. Compatible APIs use a prompt contract plus host validation and explicitly report that distinction. None of these paths silently changes the selected model or effort.

## Verification

Verification uses controlled fixtures while real-model dogfooding is stopped. The critical properties are:

- Concurrent requests remain distinct under one conversation.
- Independent node writes both survive; stale writes to the same node conflict.
- Required module fields differ by analytical purpose.
- A tool call, forged provenance, or writable completion flag cannot create a completed model response.
- Downstream responses retain exact input revisions and expose staleness appropriately.
- Missing grounding, challenges, and unfinished children remain visible.
- Subagent claims, cancellation, duplicate starts, late results, and capacity are reconciled.
- UI selection, drafts, keyboard interaction, graph relationships, and worker controls remain scoped to the correct request.
- New views and APIs do not overwrite legacy plans or launch models as a side effect of opening the workspace.

Passing those checks demonstrates the application's contracts. Semantic quality still needs later review of actual task-bound responses; the graph makes that review possible rather than assuming a filled form proves analysis.

The integrated verification completed with **279 tests passed, zero failures, zero skips**, across the graph model, store, module runtime, provider profile, HTTP API, UI, direct graph tools, contained-browser schemas, existing providers, remote-access gateway, and legacy planning organization. Syntax checks passed and the source hashes remained stable. The report is `verification/planning-browser-integrated-final-20261030.json`; the original test output is retained alongside it. Subsequent UI-only readability adjustments receive their own focused verification.

The bidirectional preview receipt is `blackice-planning-browser-preview-20261030-2/bidirectional-roundtrip.json` in the dated development directory. Its SHA-256 is `974086ce04c1c193b4a12f253b68f7d7b42e7d484a720fb19c2fed8c74a77399`.

