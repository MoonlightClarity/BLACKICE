# Task-relative accuracy and Plan only

BLACKICE records the accuracy needed for a requested outcome. Feasibility, Inference, Plan, Think, and Respond carry these targets through their findings and acceptance criteria. Further detail is useful when it could change the result or satisfy an unmet constraint.

Use **exact** accuracy for a cutoff, calculation, or other constraint needing an exact result; a **bounded estimate** when an explicit range suffices; and **qualitative** accuracy for a supported explanation without meaningful numerical precision. These choices describe the task's needs, without assigning a probability of correctness.

## The accuracy contract

An `accuracy` object can appear on a feasibility requirement, a Plan acceptance criterion, or a child question's acceptance criterion. It has seven fields:

| Field | Meaning |
| --- | --- |
| `mode` | `exact`, `bounded_estimate`, or `qualitative`. |
| `tolerance` | The acceptable error or range; required for a bounded estimate. |
| `decisionThreshold` | A cutoff that changes the decision, or an empty string when none applies. |
| `evidenceNeeded` | The observations or supplied premises sufficient to establish the criterion. |
| `consequence` | What a wrong finding would change or violate. |
| `unknownPolicy` | `block`, `assumption`, `range`, or `omit`, describing permitted treatment of unresolved uncertainty. |
| `stopWhen` | A concrete condition under which further checking is unnecessary. |

If supplied, all seven fields must be present. Evidence, consequence, and stopping condition must be nonempty; tolerance may be empty outside bounded estimates. Existing responses can omit `accuracy` or use `null`, without fabricated defaults. New strict output schemas require the property, allowing the complete object or `null` where no separate target is needed.

### Exact comparison from given premises

Suppose fictional North seats four, South seats six, both are free, and the task asks which seats at least five. A criterion's `accuracy` can be:

```json
{
  "mode": "exact",
  "tolerance": "",
  "decisionThreshold": "Capacity is at least 5 seats.",
  "evidenceNeeded": "The supplied capacities: North 4, South 6.",
  "consequence": "An incorrect choice would fail the capacity requirement.",
  "unknownPolicy": "block",
  "stopWhen": "Compare both capacities with 5 and check the two-seat difference."
}
```

The fictional premises define the task; real-room measurements and reservation checks add no relevant evidence. “No decision-changing unknown” is valid here. An exact decision does not always require an exact input: supported bounds wholly above or below five can settle eligibility. A range crossing the cutoff remains material; obtain sufficient evidence to resolve the decision, without demanding an unnecessary precise point value.

### A bounded comparison

For a rough comparison using supplied cost ranges of 40–60 and 180–220 units:

```json
{
  "mode": "bounded_estimate",
  "tolerance": "Use the supplied intervals; exact point prices are unnecessary.",
  "decisionThreshold": "Option A's upper bound is below option B's lower bound.",
  "evidenceNeeded": "The supplied 40–60 and 180–220 cost intervals.",
  "consequence": "A reversed ordering would change the preliminary recommendation.",
  "unknownPolicy": "range",
  "stopWhen": "Establish non-overlap; finer precision cannot change the ordering."
}
```

The remaining uncertainty about each exact price need not block this comparison. If the intervals overlap, the same stopping condition is unmet; revise the conclusion or obtain evidence relevant to the requested distinction.

## Evidence, uncertainty, and recursion

An uncertainty policy does not change a requirement's recorded `resolution`. A permitted range or assumption still needs supporting sources, a value, and an explicit qualification. An essential finding recorded as `unknown` remains unresolved. Existing `inferable` and `omissionAllowed` restrictions still apply. An explicit accuracy target that forbids omission cannot be bypassed by an omission finding.

Child questions should resolve a gap that could change the outcome or satisfy a real constraint. Their acceptance criteria carry the requested accuracy. A child Plan must preserve a parent-requested target; changing a bound child's contract invalidates its previous binding. Stop when the target is met, while retaining relevant qualifications in Think and Respond.

## Inspecting and editing with Plan only

In the Planning workspace, choose **Plan only** under **Execution** before running a cycle. The corresponding request setting is `planningExecutionMode: "plan_only"`; `automatic` remains the default. Mission requests using Plan only need Planning On. A prepared cycle pauses after its saved Plan, before the parent cycle's operational work, Think, and Respond. Required analytical child work may be used while preparing that Plan.

Review the saved targets and stopping conditions, then edit acceptance criteria, steps, dependencies, or accuracy in **Edit the saved Plan**. Merely opening a legacy criterion does not add a target. **Save plan** records a revision and leaves the cycle paused. Reading and editing do not continue execution.

Humans and supervising models use the same revision-bound boundary. Edit and Continue requests name the current request revision, cycle revision, Plan node revision, and Plan response ID. Changed inputs require review of the current version. The UI preserves conflicting drafts and disables Continue while edits are unsaved. Downstream findings captured from an older Plan become stale when its target changes. Explicit Continue uses the saved current revision and remains subject to normal admission checks.

## What the host establishes

The host validates structure, allowed values, evidence references, dependency relationships, revision freshness, and recorded outcome structure. It enforces the pause and preserves provenance. Judging whether a tolerance is appropriate, a source supports a claim, or another observation could change a decision still requires substantive evaluation. A well-formed target or a ready response is not an independent proof of semantic correctness.

Implementation references: `public/task-viability-model.mjs`, `public/response-cycle-model.mjs`, `public/next/workspaces/response-cycle-ui.mjs`, and `lib/response-cycle.mjs`.
