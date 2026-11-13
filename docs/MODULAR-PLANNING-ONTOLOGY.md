# Planning modules in current BLACKICE

> **Status: Current source guide (2.39.81).** The source contract is [planning-module-policy.mjs](../public/planning-module-policy.mjs), with the visible choices in [Chat](../public/next/chat/chat.mjs). A source version is not proof that an older installed application has received it. See [release 2.39.81](../RELEASE-NOTES-2.39.81.md).

BLACKICE provides **eight optional Planning modules**, each with an explicit **On** or **Off** choice. **Directory** is a separate On/Off execution choice. In the 2.39.81 source, unspecified module choices and Directory start **Off**; explicit current selections and saved user choices are preserved. This favors straightforward tool use unless additional reasoning has a demonstrated purpose for the task.

In Chat, expand **Planning → Modules** to see the choices. Collapse or expand the module grid without changing its selections. A conversation's choices apply to its subsequent turns. **Save default** records the displayed choices for future chats; changing one conversation does not rewrite old conversation history or saved choices in another conversation.

## What the eight switches mean

| Module | Use when | Opportunity cost |
| --- | --- | --- |
| **Intent inference** | The requested result or constraints have consequential ambiguity. | Can introduce needless interpretation into a clear task. |
| **Feasibility** | A real capability or dependency may change the next action. | Speculative prerequisites can delay useful work. |
| **Task decomposition** | Distinct objectives or dependencies benefit from explicit substeps. | Can fragment simple work and generate overhead. |
| **Conditional logic** | Observed facts require different IF/ELIF/ELSE paths. | Unneeded branches distract from execution. |
| **Recursive reassessment** | New evidence materially changes the plan. | Can repeatedly reopen settled decisions. |
| **Metacognition** | A meaningful assumption warrants a focused countercheck. | Additional reflection may consume time without adding evidence. |
| **Anti-overalignment calibration** | Invented requirements or an excessively broad stop threaten the user's authorized goal. | Its guidance can be redundant on routine tasks. |
| **Outcome verification** | The result needs confirmation from files, commands, records, or a remote destination. | Verification costs time and can itself produce mistakes. |

**Delegation is not a ninth selectable Planning module.** The internal policy retains a compatibility field for subagents, but the [source](../public/planning-module-policy.mjs) normalizes it to available delegation rather than a user-facing On/Off override. A worker should be delegated only when separable work makes its coordination and token cost worthwhile, not merely because the tool exists.

## Semantics and limitations

- **On** instructs the selected model to apply that method where relevant. It is not evidence that the method succeeded, and it does not guarantee a new provider call or a plan record for every action.
- **Off** disables the *additional* module instruction. It does not disable ordinary reasoning, authorized tools, retained planning data, durable effect protection, or user requirements.
- **Directory On** changes the selected response execution path; it is independent of the eight switches. Directory Off uses ordinary Chat behavior. A module choice does not silently switch models.
- Model calls, elapsed time, tokens, review steps, and verified outcomes matter when judging a configuration. All modules On is not automatically the highest-quality or fastest choice. See [Planning and Directory trade-offs](PLANNING-TRADEOFFS.md).
- Operational receipts remain authoritative about effects. A browser click is not an accepted application; a completed model response is not proof of a completed external operation. Never replay an unresolved consequential effect without reconciling the previous attempt.

For tasks with several independent paths, a genuinely blocked field or submission should normally block only that exact path, while other authorized work continues. Unverified assumptions are not new hard gates. The model should still distinguish supplied facts, sound inference, and unknowns rather than making unsupported personal declarations.

## Legacy state is not a current control

Earlier documents describe **Forced / Advisory / Off**, **Plan-only**, and four-state **Mandatory / Optional / Forbidden / Auto** module controls. Those are historical implementations, not current Chat controls. Version-1 policies can be normalized for compatibility: Mandatory, Optional and Auto map to On; Forbidden maps to Off; the retired delegation selection is not carried into new work. This is a migration rule, **not** a way to select those old states in 2.39.81.

The old [canonical recursive-planning guide](RECURSIVE-PLANNING.md), [planning-depth report](PLANNING-DEPTH.md), and [November 12 audit](../PLANNING-DIRECTORY-AUDIT-20261112.md) are preserved as historical records. The canonical work-item/operation-journal implementation may still be relevant to existing saved tasks and direct tools; those internals do not re-enable the retired user-facing controls. Consult the exact task's returned contract before editing it.

## Evidence and maintenance

The current behavior is implemented and exercised by [the module policy](../public/planning-module-policy.mjs), [the Chat controls](../public/next/chat/chat.mjs), [binary policy tests](../tests/planning-binary-runtime.test.mjs), and [Chat grid tests](../tests/next-chat-ontology-grid.test.mjs). Tests establish their reported source behavior, not success on every provider or installed runtime.

For the full guide map and document-status labels, return to the [documentation index](README.md).
