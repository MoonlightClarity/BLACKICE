# Recursive planning in current BLACKICE

**Current contract:** canonical work items, **contract version 2 / task schema 14**, shipped with BLACKICE 2.39.23 and present in 2.39.27. This replaces the older rule that every file read, page inspection or form input must first become a separate model-authored action leaf. Preserved old tasks and captured native provider catalogs may still use their legacy schema; see the [archived schema-10 guide](history/RECURSIVE-PLANNING-SCHEMA10.md).

## What the plan represents

BLACKICE retains **one authoritative saved intent contract**, shared by the preparatory Plan, operational agent, human editor, continuation and final review. It contains:

| Element | Meaning |
| --- | --- |
| `goal` | The result the task is trying to achieve |
| `criteria` | Evidence needed to say whether the result was achieved |
| `workItems` | Cohesive pieces of work with an objective, owner, resource keys, allowed effects, dependencies and criterion IDs |
| `instructions` | Requirements to preserve or assess while working |

A work item can cover an entire form or a complete source inspection. The model can inspect a form, enter several fields, correct validation, submit once and verify the destination **within that same appropriate work item**. The host journals the separate operations; the plan does not need a new leaf or a model-authored completion status after each keystroke.

Use smaller work items when the objective, ownership, dependency, resource boundary or evidence criterion actually differs. Grouping unrelated goals into one vague work item is not a substitute for task decomposition. Conversely, splitting ordinary inputs solely to satisfy an old bookkeeping rule is no longer required.

## Plan → work → reconsider → respond

1. **Understand the goal and facts.** Distinguish verified constraints from preferences and unknowns; do not invent personal or external facts.
2. **Save the canonical plan.** Name meaningful work items, resources, dependencies, intended effects and outcome criteria. The accepted Plan is handed to the executor without a second model translating it into a different executable outline.
3. **Admit applicable work.** In Forced mode, the runtime checks the current owned work item, dependencies, resources, permitted effects and relevant plan epoch. A decision with unresolved material inputs must not be silently treated as settled.
4. **Execute and observe.** Actual file, command, browser and Workbench operations are recorded in the **host journal** with their real dispatch and result state. A model's assertion is not an operation receipt.
5. **Reconsider after new evidence.** Revise affected intent when observed facts change the path. Return to the relevant earlier work or verification rather than following a stale plan or manufacturing extra steps.
6. **Reconcile uncertain effects.** A dispatched action may have happened even when its answer was lost. Inspect retained destination evidence before any replay that could duplicate an external submission, installation or other effect.
7. **Review the result against criteria.** Final review uses the saved current contract and durable journal, not only the model's recent prose. Report confirmed effects, unresolved cases and limits rather than presenting attempted work as success.

This is iterative and chronological; it is **not** an executable Python program and does not mean one call always equals one plan step.

## Plan version vs operation journal

The canonical contract separates three clocks:

- **Plan epoch:** material changes to goal, scope, ownership, dependencies or criteria.
- **Work-item focus/lease:** the work currently owned and eligible for an operation.
- **Journal sequence:** the actual chronology of reserved, dispatched, settled, observed and reconciled operations.

Ordinary reads, field changes and UI observations advance the journal without constantly rewriting the intent plan. An unrelated sibling's progress does not inherently invalidate independent work. Saving a user correction affects subsequent applicable admission; it does not retroactively cancel an operation already dispatched.

## Evidence and completion

The current contract recognizes four criterion mechanisms:

| Criterion | What counts |
| --- | --- |
| **Observation** | Distinct resources actually observed and supported by host evidence |
| **Source coverage** | Full delivered coverage of one concrete, versioned source (not a count of entities mentioned inside it) |
| **External confirmation** | Distinct **new destination-confirmed effects** tied to admitted operations and matching receipts |
| **Judgment** | A supported semantic assessment grounded in relevant host evidence |

A click is not a completed application; a successful tool return is not proof that a remote server accepted a change; a previous record is not a newly completed result. An empty response or timeout does not prove the action failed. The host preserves uncertainty until appropriate verification can confirm or refute the effect.

For exact schema fields and receipt matching, read [Planning contract v2](planning-contract-v2-20261105.md) and `public/planning-contract-model.mjs`. For substantive decision quality, see [Planning depth](PLANNING-DEPTH.md) and [Metacognition](METACOGNITION.md).

## Modes, editing and older tasks

| Mode | Current behavior |
| --- | --- |
| **Forced** | Requires an applicable current owned work item and its execution conditions; operations are journaled and checked |
| **Advisory** | Allows ordinary work without requiring that canonical plan gate; other host protections still apply |
| **Off** | No automatic planning requirement; does not waive authority, cancellation or replay protection |

The Planning UI and outside connector both read the saved task. For a **canonical v2 task**, use its current `expectedRevision` and **one `replace_contract` edit** to update the authorable intent contract. Omit the host-owned `planEpoch` and never invent operation receipts in an edit. Conflicts require rereading and merging instead of overwriting someone else's change. Editing a plan alone does not run the task.

Existing legacy tasks can retain prior graph operations, revisions and historical outcomes. A previously completed legacy leaf is not upgraded into an independently verified external effect merely because the new code understands contract v2. Native sessions can retain their captured tool catalog until a supported settled handoff/migration boundary. Follow the contract actually returned by the current task, not a schema example from a different era.

The shared editing-awareness guard is explained in [Planning awareness](../PLANNING-AWARENESS.md). The original pre-release design and its honest acceptance boundaries are preserved in [Planning contract v2](planning-contract-v2-20261105.md).
