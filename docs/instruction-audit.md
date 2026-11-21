# Instruction audit

Open **Config → Behavior & profile → Instructions**, beside **SOUL.md** and **USER.md**.

The current execution core contains only BLACKICE operating mechanics. SOUL.md owns behavioral defaults; selected skills own task procedures; the current user request owns the goal and constraints. Tool schemas and host settings supply actual operations and preconditions.

## Inspect an execution

Choose a saved turn or paste its ID. Expand a section to read the exact captured text, its source, layer, inclusion reason, revision, character count and hash. Tool definitions have their own section for the descriptions and parameter guidance advertised to the model; they are separate from skill deliveries. Delegated workers have separate captures. Export downloads the complete captured audit as readable text.

Current built-in mechanics and saved execution snapshots are separate. Historical turns created before audit capture are labelled unavailable; current source is never presented as their historical payload. Provider-owned hidden instructions are outside BLACKICE's capture boundary.

SOUL is fixed at execution admission. Editing it changes subsequent executions; the audit retains the revision actually used. Skill snapshots record the owner-edited or bundled source that was delivered. Owner edits replace bundled skills, deletion does not restore old bundled content, and selected skills are no longer silently skipped at 20,000 characters. Actual model context admission still applies.

The audit records instruction-bearing sections and adapter additions. USER.md facts, ordinary task bodies, conversation history and general tool outputs are not copied into the audit. An active persistent goal is an explicit exception: its exact injected goal contract is captured, including the objective and execution limits. Successful skill reads record the delivered method and source. Duplicate reads of the same method are counted without storing the body repeatedly.

## Keep instructions small

Change behavior in SOUL.md and task procedures in the relevant skill. Avoid copying those policies into the execution core or tool-routing notes. The previous universal analytical essay is retired. Optional planning records and old assistant checklists do not create user approval requirements.

The source view makes conflicts inspectable; it does not certify that arbitrary natural-language instructions are semantically consistent. Tests cover source ownership, exact payload capture, skill overlays, routing, effect recovery, snapshot stability and UI export.
