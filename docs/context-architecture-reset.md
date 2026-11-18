# Context architecture reset (2026-11-18)

## Direction

Reduce persistent context poisoning rather than rename it. Remove active planning modules; offer only intentionally selected, release-owned immutable skills. Replace automatic memories with explicit user-controlled workflows. Do not automatically generalize outcomes into guidance or promote workflows into modules. USER remains blank-template by default and owner-controlled. No adoption requires compatibility shims.

## First milestone: Directory retirement

Directory does not meet the required cross-conversation isolation guarantee: different conversation IDs may resolve to one explicit root, and saved summary state is merged/reloaded without proving conversation ownership. Folder isolation alone does not establish conversation isolation. Therefore execution is unavailable, rather than advertised as safe. Admission, direct/prepared/class execution, managed context injection and the context HTTP surface reject with DIRECTORY_RETIRED. Existing records are not deleted or transformed. This is retirement, not a repaired isolation claim.

## Remaining dependency map (not implemented)

- lib/engine.mjs: saved module policy admission/inheritance; completion review calls; time management wrapper; module-derived tool availability; developer prompt assembly; automatic learning selection and knowledge catalog injection; after-run learning scheduling. Remove model-guidance and extra review-loop integration independently of cancellation, effects reconciliation, deadlines and ordinary delegation.
- public/planning-module-policy.mjs and lib/modular-completion.mjs: module registry/instructions and model review controller. Skills must not reuse all injected instructions or invoke these loops under a new label.
- lib/knowledge.mjs: model memory/skill save, patch and remove; global/workspace retrieval; catalog context. Release-owned skills must expose search/read only. Existing saved skills must not silently become trusted bundled skills.
- lib/learning.mjs and lib/analysis-quality.mjs: post-run extraction, admission and automatic generalization. Retire background generation and automatic ingestion, not just UI labels.
- lib/skills-catalog.mjs: restore reviewed bundled catalog as release assets, immutable through all model-facing APIs; no automatic broad loading. Tool operational instructions remain with actual tools.
- Existing engine workflow graph and workflow-assignment.mjs describe executable user work; they are not a replacement memory store. Workflow definitions need explicit user authorship/approval, visible steps and inputs, explicit invocation, and must not acquire authority from observed task output.
- UI, HTTP/control/native/direct tool catalogs and packaging tests must remove active module/memory controls and stale capability claims together. Old records may remain recoverable outside active context.

## Enforcement limits

Structured tool read-only rules do not create an operating-system boundary against an unrestricted shell running as the same Windows user. Do not promise otherwise or change OS access controls without approval. Runtime cancellation and actual tool/service permission controls remain independent of skills.

## Verification

Focused directory-retirement.test.mjs covers admission, inherited configuration, direct/prepared/class runner, managed context and HTTP routes. Existing tests asserting successful Directory execution are superseded and require retirement during integration. No aggregate pass or install is claimed by this milestone.
