# BLACKICE 2.40.4 candidate

This is a source candidate, not a publication or installation receipt.

## Scope

- First-class file search searches observed workspace and normal user folders without requiring an index or profile hints. Bounded results, explicit roots, cancellation and continuation are supported. This does not expand OS permissions or impose a sandbox.
- Retired Directory execution and control fail closed because conversation-folder isolation was not established. Existing records are preserved; old Directory conversations cannot resume through Off. Start a new ordinary conversation instead.
- Automatic learning, mutable memory/skill APIs, module-driven automatic review and old Autonomy/Swarm execution are retired. Release-owned, read-only task-scoped skills replace mutable skill admission; owner-authored workflows require explicit approval before use.
- The To-do tab is an owner-managed nested outline, not a scheduler or orchestrator. Previous Swarm records have a selective read-only preview and are not imported automatically.
- Mediated file tools protect identity, release skills, workflow and outline stores. Shell/native access is not an OS security boundary.
- Ordinary browser work can continue with explicit degraded compatibility status when the auxiliary extension fails. Extension load does not prove every page patch ran; native picker/passkey limitations remain.
- Manual native children with a saved Goal run their initial turn and keep that Goal paused until explicitly resumed. Objective and turn budget are retained.

## Verification and exclusions

Focused tests exercise search, preservation, explicit retirement, provider transport, real TODO HTTP/UI persistence and browser compatibility. Earlier failed and timed-out full-suite evidence is retained. Exact final Windows suite and installer qualification remain separate release gates.

No live-model job-search benchmark or throughput improvement is claimed. No real applications were submitted by release testing. The separate orchestrator and self-drive prototypes are not included. No fixed retry limit is introduced. Existing profile content and user data are not silently migrated.
