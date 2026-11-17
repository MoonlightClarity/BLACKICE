# BLACKICE .105 UX concept audit: existing capability representation

Scope: source .105 (66ded2a), fresh disposable Electron Skills/Knowledge captures coordinated with ux_flows, and focused synthetic store/DOM tests. This is a bounded part of the whole-app audit, not evidence of every live workflow. No live profile, application records, release or install changed.

## Coherent model already present in code

| Human concept | Actual relationship and place |
| --- | --- |
| Conversation | A stable chat family contains individual execution runs. A model is selected for execution; the conversation is not a model instance. |
| Chat folder | Organization of conversations, not a working-directory permission or context boundary. .105 nested folder rendering already exists. |
| Working folder | Filesystem context and saved knowledge applicability. Distinct from organizational folders, even when labels say folder in both places. |
| Memory | Durable note, fact, assumption or decision with sources and directed relationships. Knowledge shows these records. Sources/relationships describe evidence, not instruction authority. |
| Skill | Reusable procedure, discoverable through search/read, not an executable task or proof it was used. Separate Skills workspace; shares underlying storage/editor implementation with memories without making the concepts identical. |
| Reasoning module | Per-response optional reasoning behavior (inference, feasibility, etc.). Not an installed skill or separate provider. The retained subagents field is normalized on; it is not a current selectable toggle. |
| Goal | An explicit objective and completion criteria, optionally bounded by deadline/turn count. Not autonomy. |
| Autonomy | Continuation policy and permitted models; conversation, current-goal, or BLACKICE-wide operator scope. BLACKICE-wide coordinates from a conversation, does not enable every old chat. |
| Directory mode | Staged context and durable saved work for execution. Not a filesystem folder browser. |
| Activity | Human-facing updates, tool calls, and separately selected internal structured outputs. Internal outputs hidden by default. Preserve this existing search/filter capability. |
| Swarm project | Coordination ledger containing workers, scoped work items, dependencies, evidence, recorded phases and integration records. Not the same object as an executable workflow graph. |
| Work item | A bounded outcome owned by a worker, with completion criteria and dependencies. Its recorded phase is not by itself proof of a worker execution. |
| Native Swarm launch | Host-bound coordinator can submit real delegated work; the regular UI/connector ledger is not itself the launch adapter. |
| Connection/model | Covered by inventory lane; do not invent another provider-specific ontology. |

Principal sources: public/next/chat/{model,folders,execution-preferences,ontology-preferences,autonomy,goals,activity-inspector,render}.mjs; public/next/workspaces/{knowledge,knowledge-model,skills,swarm}.mjs; public/planning-module-policy.mjs; lib/{knowledge,skills-catalog,conversation-autonomy,swarm-native-tools,swarm-direct-tools}.mjs.

## Implemented corrections

1. Skills normal rows now say Saved procedure, matching inspector Source. Disabled external Codex status/errors remain visible only after explicitly entering external diagnostics, rather than making unavailable capabilities look like normal Skills failures. Diagnostic functionality retained.
2. Memory relationships now open the related memory through the existing entry loader. Show its title when already available; otherwise Open related memory. Exact ID remains in the button title. Existing search/filter context and unsaved drafts remain intact; no relation or memory data rewritten.
3. Swarm create/edit forms use Work to cover, Done when, Responsibilities and limits; generic examples replace coding-only Owned files or interfaces. Stored fields and semantics unchanged.
4. OAuth Swarm tool description no longer falsely says native engine registration is absent. It explains the separate native coordinator adapter. Connector-local identity metadata remains compatible.

## Verified existing behavior, not new fixes

- Skills editor already rewrites its header to Saved skills; the raw shared memory HTML template alone was misleading. No unnecessary header change retained.
- Memory filing and applicability are already separately labeled in .105.
- Autonomy UI already explains independent Goal and three scopes.
- Swarm archive/trash/restore editing is already present in .105.
- Activity already offers Updates / Tool calls / Internal outputs; preserve it, do not replace with another ledger.

## Remaining high-value gaps

### Swarm to actual agent work: access gap, not a wording-only fix
server.mjs:227 registers createNativeSwarmTools. engine.mjs attaches those tools through the real runtime, with relay_swarm_launch only for a writable coordinator with the delegate scheduler, not a delegated worker. lib/swarm-native-tools.mjs restricts projects to recorded coordinator/worker membership. A human-created UI project is not automatically the project of a fresh chat.

Do not add a misleading Run with agent button that merely starts an unrelated chat.
Smallest feasible follow-up:
- expose project coordinator and known owning conversation as human-readable metadata;
- when an owning native conversation is resolvable, provide Open coordinating chat;
- for human/connector-owned projects, implement an explicit host-recorded handoff binding with revision/idempotency, rather than guessing a native actor ID or cloning project state;
- run the existing delegation mechanism only after that binding exists, retain the project/work-item identity, and show actual launch state separately from recorded completion.
This requires real handoff integration and tests for stopped owner, repeated action, missing conversation, concurrent revision and partial dispatch. It is not implemented in this patch.

### Memory triage
Sources and relationships were previously inert raw IDs; navigation is now usable. Creating/editing those links still has no UI controls, and no bulk curation/merge exists. The store has a shared 300 active-entry bound for memory and skill. Do not silently merge/delete records or change applicability to address bloat. A later focused triage flow should expose duplicates/obsolete entries with deliberate edits and retained history.

### Terminology and progressive detail
Planning, Directory and Calibration still require product knowledge; tooltips explain them but are weak discovery. Prefer short inline explanations and sensible defaults over more ontology. Swarm detailed receipt sections remain heavy with internal identity/revision language; move technical evidence into progressive details without hiding current work status or implying dispatch occurred.

## Verification

- Skills/catalog/navigation suites: 22 passed.
- Swarm board/HTTP/native tools/native engine suites: 31 passed.
- Knowledge relation/management/model and Swarm wording/layout suites: 24 passed.
- Fresh disposable coherence harness before/after Skills: passed create/edit, navigation retention, source filters and external diagnostics. Saved post-fix catalog pixels inspected at .build/ux-flows-postskills-20261117/04-skills-catalog.png.
- Final combined run: 73 tests passed, zero failures/skips/cancels; git diff --check passed. Latest relationship/Swarm rendered captures are being recorded by the coordinating audit lane.
- No claim of live end-to-end agent efficacy; no provider turn or external action performed.
