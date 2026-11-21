# Instruction clarity work plan

User request: simplify and clarify every BLACKICE skill, tool description and related model-facing instruction. Prefer observable actions and outcomes over abstractions. Length follows usefulness. Remove unrequested guardrail language. Add Modular Development to BLACKICE.

## Execution and ownership

- Backend: BLACKICE direct connector; connection 8e8aaf0a-3ce8-4f15-b529-f87a6060f803, observed server 2.40.70. No model-backed BLACKICE run is used.
- Task root: C:\Users\user\Documents\Codex\BLACKICE-instruction-clarity-20261121
- Base: 28f8e0f51be0bc55e73eb9afab1bc1ebeea765e8, including owner instruction controls and the new skill creation UI/endpoint.
- Tools: blackice_run_command(command, requestId, timeoutMs); blackice_get_job(jobId, offset, limit); blackice_workspace_read(action, path, requestId); blackice_workspace_write(action, path, text or oldText/newText, expectedHash, requestId). Actual schemas were discovered from the installed connector. Commands execute in PowerShell; each command explicitly selects this root.
- Read/check example: Set-Location 'C:\Users\user\Documents\Codex\BLACKICE-instruction-clarity-20261121'; node --test tests/skill-library.test.mjs.
- Files are edited and checked through the same Windows backend. The shared checkout and other isolated lanes remain outside this task's write ownership.
- Coordinator owns this plan and final verification/audit report. Each worker owns only its assigned files. Description edits preserve call shapes. Reproduced stale-schema defects and the user-requested maxTurns/file-scope fixes are separately implemented and tested below.

## Modules

| ID / state | Observable behavior and interface | Failure / invariants | Owner and files | Dependencies | Acceptance |
| --- | --- | --- | --- | --- | --- |
| S / complete | Every bundled skill explains when to use it, what to do, and what result to observe. Modular Development is discoverable/readable by ID and normal search. | Preserve IDs and owner overrides; no omitted steps caused by shortening; report unavailable tools concretely. | skill_content: lib/skill-library/*.md, index.json, lib/release-skills.mjs; focused skill-content tests if existing phrase checks need semantic updates. | Existing loader from base; no new loader required. | Read all saved bodies; parse manifest; use actual library list/read/search for all skills and new skill; run relevant skill/library tests. Record before/after sizes and substantive edits. |
| D / complete | Direct connector descriptions explain actions, necessary fields, returned jobs/results and recovery using real implementation behavior. | Keep schema keys, types, required fields, scope checks and execution behavior unchanged. Remove redundant policy prose. | clarity_review: descriptive text in lib/direct-execution-api.mjs, lib/direct-task-context-schema.mjs, lib/direct-*-tools.mjs, lib/chatgpt-bridge.mjs, lib/chatgpt-bridge-tools.mjs and any real descriptions in lib/chatgpt-tool-catalog.mjs. | Base direct handlers and schema. | Compare definitions excluding descriptions to base; syntax/import and applicable direct catalog tests. Review each action against handlers; record count and size delta. |
| N / complete | Native tools explain which action to choose, valid inputs, observable results and concrete error recovery. | Preserve runtime behavior and schema shape; no invented permissions or capabilities. | native_tools: descriptive text in lib/codex.mjs, lib/browser.mjs and native lib/*-tools.mjs excluding D files; additional native schema sources only after coordinator assignment. | Base handlers and schema. | Compare definitions excluding descriptions to base; syntax/import and applicable native tool tests. Review short and long descriptions, including browser stale-ref recovery and scalar file paths. |
| P / complete | Shared prompt text clearly connects the user's task to available actions without duplicate workflow essays or unrequested reconfirmations. Audit records each inspected surface. | Preserve user-editable instruction snapshot/control behavior and existing user customization. No hidden change to provider limits or host enforcement. | root: prompt prose in lib/instruction-store.mjs, lib/harness-identity.mjs, lib/task-completion-guidance.mjs, lib/tool-routing.mjs, lib/engine.mjs, lib/task-state.mjs and other identified prompt builders; plan and final audit. | Base prompt composition; S/D/N final artifacts for integration. | Inspect assembled instruction sources, run applicable instruction/skill-delivery/capability tests, inspect composed diff and schema equality; write exact tested state and outstanding runtime activation status. |

## Verification notes

Text-only changes use explicit content inspection plus existing behavior checks. The new skill requires real loader/search delivery checks. No live provider benchmark is required or claimed. A full repository test suite is not presumed necessary for every wording edit; relevant existing tests and integration boundaries will be selected from actual changed files. A failed check is investigated; expected prose may be updated only when the changed instruction is deliberate, while retaining the behavior assertion.

## Progress

- Verified current source and installed version.
- Created isolated worktree from the current source; confirmed absolute root and absence of inherited AGENTS.md files in inspected ancestors.
- Inventory, parallel audits, source edits, owner-editor updates, and final tests are complete. Local candidate packaging is complete; activation is the remaining step.

## Expanded scope from user corrections

- Stale code schemas: repair active returned recipes and make supported native Continue/Retry refresh provider-pinned tool definitions when descriptor content changes. Preserve task identity and saved context; do not ask the model to migrate its own catalog.
- maxTurns: default to null, preserve omitted/null/explicit finite values through validation, persistence and execution; fix the direct union-type validator that rejected its own nullable schema.
- File discovery: distinguish cwd, requested absolute paths and selected search roots. A workspace-only miss is not proof of global absence. Follow actual cursors and report incomplete coverage.
- Tool boundary: keep observable task actions in tools; put schema/catalog selection, request identity, durable jobs, revisions and defaults in the host. Audit specialized/developer capabilities separately from ordinary task tools without silently removing supported operations.

## Implemented modules and observations

- All 36 existing skills rewritten; Modular Development added and found through actual catalog search. Existing bodies 123393 -> 63477 characters. All 37 current bodies total 67046 characters.
- Five visual guide sources now use the requested brief and observable checks. Removed unrequested universal style mandates.
- Native and direct tool/recovery prose checked against current field/action definitions; current descriptor shapes remain unchanged.
- Actual direct validator bug: declared JSON Schema type arrays rejected valid null values. Reproduced and corrected, with handler-level regressions.
- Actual native resume bug: thread/resume keeps old tool definitions while sending new developer guidance. New canonical descriptor fingerprint selects the existing context-preserving handoff on mismatch. Four initial regressions: 1 passed/3 failed before the fix; integrated current-catalog subset passed 13/13 after it. Property-order stability and additional continuation checks are included in final integration.
- Project methods and Planning help no longer teach retired current-plan operations. Canonical authoring guidance is delivered on demand by describe.
- Automatic freshness, null defaults, and file-root resolution belong to host code. Instructions now use actual returned state rather than prescribing invented bookkeeping.

## Verification status

- Skill/project/visual composed suite: 169/169 passed, zero skipped.
- Native metadata shape comparison: 36 instances / 35 unique names matched base excluding description strings.
- Direct current live catalog shape comparison: 46 tools matched base excluding description strings.
- Final affected-scope integration: 653/653 tests passed across 79 files, zero skipped/cancelled/TODO. Historical text snapshots remain immutable where they describe historical captures.
- Seven active owner overrides and the common instruction revision were saved through the owner editors and read back exactly. The independent test user skill remains unchanged.
- No live model/provider benchmark is used or claimed. The unsigned local 2.40.71 candidate is built and verified; publication was not performed. Installation is pending.

## Final candidate

- Final integrated result: verification/instruction-clarity-integrated.json (653 passing tests, 79 files).
- Status capabilities now list actual registered model-starting tools while preserving modelStarted:false/providerTurns:false for the read-only status call.
- Candidate application fingerprint: 5428c23b8786aa1523f2068370c150150eb6d544fb1f127a13de0688da3c47e9.
- Installer SHA-256: 24f4298df76c02e395c249817173441e4f4590bf9cf92c947a0a17db5a21d481.
