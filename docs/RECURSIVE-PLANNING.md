# Recursive, chronological planning

Planning On uses the saved task as a revisable work tree. The agent decomposes work before attempting it, performs one eligible operation, records the actual outcome, and returns to planning to reassess the result and remaining work. Before the final response, that return is an explicit saved review. Thinking or evidence can send the agent back to an earlier step while retaining the earlier attempt and its reported effects.

This guide describes task-tool schema 10, including the executable branches and revisit operations introduced in schema 9. The broader standard for substantive reasoning remains in [PLANNING-DEPTH.md](PLANNING-DEPTH.md).

## The unit of work

An executable `action` leaf represents one smallest meaningful tool operation or one bounded reasoning question. It has:

| Field | Meaning |
| --- | --- |
| `operation` | `{kind:"tool", tool, action?, target}` or `{kind:"reasoning", target}`. |
| `result` | The expected work product, without predicting an analytical finding. |
| `note` | The concrete procedure saved before doing the work. |
| `doneWhen` | An observable completion criterion. |
| `evidence` | The actual result or finding when the action is completed. |

A file read, one exact patch, one cohesive test invocation, or a comparison of two specified observations can be a leaf. A phase such as “research, implement and test” needs child operations. Individual keystrokes are usually too small to be useful. A genuinely atomic request may have one leaf; neither a minimum step count nor a longer outline establishes depth.

Use `sequence` for chronological siblings, `parallel` for independent paths, and `choice` for alternatives. Independence does not enable simultaneous operational calls under Planning On. Groups derive their status from their children and have no executable `operation` of their own. An unexecuted assignment can be expanded into a group; a dispatched operation must retain its leaf and definition until its outcome is reconciled.

Unknown future detail calls for a specific discovery or reasoning leaf. Save the next level of decomposition after that observation, before attempting the newly identified work.

## The work loop

The intended progression is **plan → think or work → return to planning → think → respond**. The work and planning portions repeat when needed. A separate inspection tool call is a separate leaf. Replanning can add or refine remaining steps, update observations, revisit the earliest affected step, or confirm that the checked result is sufficient. A status update alone does not record that reassessment.

The following Python-like pseudocode is illustrative control flow. BLACKICE does not execute it as a Python planning program, and the helper functions are not public APIs.

```python
while True:
    plan = read_current_plan()

    if new_evidence_changes_an_earlier_result(plan):
        save_actual_outcome_of_any_attempted_work()
        revisit(earliest_affected_step(plan), reason=observed_change())
        continue

    if next_required_condition_is_unknown(plan):
        save_discovery_step_before_that_choice(plan)
        continue

    work = next_eligible_work(plan)
    if work_contains_multiple_meaningful_operations(work):
        save_recursively_decomposed_substeps(work)
        continue

    activate_one_leaf(work)
    if work.operation.kind == "reasoning":
        outcome = answer_one_bounded_question(work)
    else:
        outcome = dispatch_one_attached_operation(work)

    save_actual_finding_or_blocker(work, outcome)
    if outcome_changes_the_remaining_work(outcome):
        save_revised_steps_and_observed_facts(plan, outcome)

    if an_eligible_leaf_remains():
        save_review("continue", next_step=next_eligible_leaf())
    elif a_real_blocker_remains():
        save_review("blocked", actual_limits=recorded_blockers())
        return compose_truthful_partial_response()
    else:
        save_review("respond", checked_result=recorded_findings())
        return compose_final_response()
```

The connected `blackice_edit_plan` API exposes the same operation bindings, nested Boolean branches, observed facts and revisit edits. Every task write uses the `expectedRevision` from a current `relay_task` read. Conflicts require a fresh read and a merge that preserves other authors' changes. Planning reads and edits stay available during execution; they do not need their own recursively planned leaves. Record concise decisions, observations and procedures rather than private reasoning.

## Returning to planning before the final response

Schema 10 adds `relay_task action:"review"`. After actual thinking or tool work and its saved outcome, reassess that finding against the requested result and the remaining plan. Make any necessary structural changes first; then save a review at the current revision:

```json
{
  "action": "review",
  "expectedRevision": 7,
  "review": {
    "decision": "respond",
    "summary": "The selected bundle satisfies the budget and timing constraints, and its price is lower than the other feasible bundle. The requested comparison is complete."
  }
}
```

Use `decision:"continue"` with one `nextStepId` when another saved eligible leaf is needed. Use `decision:"respond"` when selected work and checks are complete. Use `decision:"blocked"` when an actual reported blocker remains and no owned ready work can proceed. Unchosen alternatives can remain pending; they are not falsely marked done. A read, a completion status, or a republished historical plan does not substitute for the review. An initial plan followed immediately by review without a reported current-turn finding or blocker is rejected.

The runtime records the review's actor, scope, reviewed revision, concise summary, and fingerprints of the relevant saved work, actual dispatch record and accepted direction. The review write does not invalidate itself. Changed facts, operations, artifacts, relevant work or user direction require a fresh review. Review concerns the caller's assigned work; an independent sibling's pending task does not block a completed worker handoff. The coordinator's broader editing rights do not expand the handoff's review scope.

Scoped handoffs check their own operation history. A coordinator-owned external receipt can remain uncertain while a verification worker returns its observation for the coordinator to reconcile. Global final review still rejects an uncertain external effect as completed. Earlier review summaries compact against the task's actual storage budget; a mandatory current review can use the existing 64,000-character state reserve while retaining agent provenance. Ordinary agent edits keep their existing 56,000-character limit.

A premature final response remains an unpublished candidate while the same accepted task returns to planning. A compliant model can review within one provider turn; the runtime does not require a fixed number of turns, steps or tokens. A review never executes work, automatically repeats an effect, proves hidden reasoning quality, or substitutes for an actual observation. Its summary records findings, gaps, and the next decision, not private reasoning.

## Conditions and observations

When a material user policy or observed condition selects among results, targets, parameters or next actions, the agent must save a `choice` group with a structured branch and observed facts before using the selected result or acting on a path. A reasoning leaf can compare inputs, but conditional prose in its note or evidence does not replace the executable decision. Use the alternatives and operators the actual task needs; a deterministic atomic request can remain one action, with no artificial branches or operator quota.

The conditional decision still matters when every result feeds the same subsequent operation. For example, a policy may select a primary candidate, a fallback candidate or a hold result before writing one selection file. The choice children can be bounded reasoning leaves that record those alternative results; one shared write follows the choice and uses the selected result. This does not require duplicating output actions across branches. Ordinary arithmetic without a material conditional selection needs no artificial branch.

A choice has `branch:{if,then,elif?,else}`. `then`, each `elif[].then`, and `else` name distinct direct child paths. The runtime checks IF, then ELIF clauses in order. The first true clause selects its child. ELSE is selected only after every preceding clause is false. An earlier unknown stops fallthrough, even if a later clause could be true. `selectedChildId` is derived from the rule and facts; manually overriding it cannot contradict the rule.

Expressions are structured data:

| Expression | Meaning |
| --- | --- |
| `true`, `false` | Boolean constants. |
| `{ "fact": "ready" }` | Truth test of an observed value. |
| `{ "and": [expression, expression] }` | All operands must be true; a false operand can resolve the result. |
| `{ "or": [expression, expression] }` | A true operand can resolve the result. |
| `{ "not": expression }` | Boolean negation; NOT unknown remains unknown. |
| `{ "xor": [expression, expression] }` | Boolean parity: true for an odd number of true operands. An unknown operand leaves the result unknown. |
| `{ "compare": { "left": operand, "op": "==", "right": operand } }` | Comparison of `{fact:id}` or `{value:literal}` operands. |

Comparisons support `==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `not in`, `is`, and `is not`. Numbers and Booleans follow numeric equality/ordering; text uses character ordering; lists use element equality and lexicographic ordering where their elements are comparable. Membership accepts a list on the right, or text on both sides. Identity checks support None or Boolean identity; use equality for numbers, text and lists. Invalid type combinations remain unresolved with a diagnostic.

This is a bounded, Python-like condition language, not arbitrary Python or JavaScript evaluation. Bare known facts use Python-like truthiness: `False`, `0`, empty text, empty lists and observed None are false. Boolean XOR does not perform integer bitwise operations; compare non-Boolean facts explicitly before XOR.

`plan.facts` stores named observations with `id`, `value`, optional `known`, and `evidence`. Values may be Booleans, finite numbers, text, null, or flat lists of those scalar values. Known observations require nonempty evidence. Use the observed constituent values in compound branch expressions; do not hide a multi-input policy in a model-computed eligibility/readiness fact. Actual source-reported Boolean flags and direct binary observations remain valid facts. Updating the input facts reevaluates the same branch rule; revisit previously attempted affected work while retaining its history.

| Saved fact | Interpretation |
| --- | --- |
| `{ "id":"ready", "value":null }` | Unknown. |
| `{ "id":"ready", "value":false, "evidence":"The check failed." }` | Known false. |
| `{ "id":"field", "value":null, "known":true, "evidence":"The response explicitly returned None." }` | Known None, available for `is`/`is not` comparisons. |
| `{ "id":"count", "value":4, "known":false }` | Unknown despite retaining an earlier value. |

Missing fact IDs are unknown. An excluded alternative is reported as unselected; it is not fabricated completed work. Unknown conditions within an excluded outer path do not block the selected path.

## A complete plan example

This example starts with one active file read and an unresolved downstream choice. The task supplies reference text and identifies the input as text; the read has not happened yet. After reading, save the outcome and update `readable` and `read_error` from the actual response. A successful read can record `read_error` as observed None using `known:true`.

The JSON can be passed to `normalizeTaskPlan` and the schema 9 Planning On validator. For an actual `relay_task` call, replace `expectedRevision:1` with the revision just read and use evidence from that task.

```json
{
  "action": "plan",
  "expectedRevision": 1,
  "goal": "Compare input.txt with the supplied reference when readable, or report the observed obstacle.",
  "plan": {
    "layout": "sequence",
    "facts": [
      { "id": "format", "value": "text", "evidence": "The task specifies UTF-8 text input." },
      { "id": "readable", "value": null },
      { "id": "read_error", "value": null }
    ]
  },
  "steps": [
    {
      "id": "read_input",
      "title": "Read input.txt",
      "kind": "action",
      "status": "active",
      "operation": { "kind": "tool", "tool": "relay_workspace", "action": "read", "target": "input.txt" },
      "result": "The returned input content or actual read error.",
      "note": "Read input.txt once with the workspace reader.",
      "doneWhen": "The tool response supplies the file content or an explicit read failure."
    },
    {
      "id": "choose_check",
      "title": "Select the next check from observed input facts",
      "kind": "choice",
      "branch": {
        "if": {
          "and": [
            { "fact": "readable" },
            { "not": { "compare": { "left": { "fact": "read_error" }, "op": "is not", "right": { "value": null } } } },
            { "compare": { "left": { "fact": "format" }, "op": "in", "right": { "value": ["text", "markdown"] } } }
          ]
        },
        "then": "compare_text",
        "elif": [
          { "if": { "compare": { "left": { "fact": "read_error" }, "op": "is not", "right": { "value": null } } }, "then": "record_read_error" }
        ],
        "else": "choose_format_reader"
      }
    },
    {
      "id": "compare_text",
      "parentId": "choose_check",
      "title": "Compare the returned text with the supplied reference",
      "kind": "action",
      "status": "pending",
      "operation": { "kind": "reasoning", "target": "The returned input text versus the supplied reference text" },
      "result": "An exact match finding or the observed discrepancy.",
      "note": "Compare the returned text with the supplied reference character by character.",
      "doneWhen": "The comparison identifies equality or the exact differing text."
    },
    {
      "id": "record_read_error",
      "parentId": "choose_check",
      "title": "Identify the obstacle shown by the read error",
      "kind": "action",
      "status": "pending",
      "operation": { "kind": "reasoning", "target": "The actual input.txt read error" },
      "result": "The observed obstacle and its immediate consequence for the comparison.",
      "note": "Interpret the returned error against the requested input path without guessing missing contents.",
      "doneWhen": "The finding names the observed error and whether the requested comparison can proceed."
    },
    {
      "id": "choose_format_reader",
      "parentId": "choose_check",
      "title": "Choose a reader for the observed format",
      "kind": "action",
      "status": "pending",
      "operation": { "kind": "reasoning", "target": "The observed input format and available readers" },
      "result": "One appropriate reader or an explicit unsupported-format finding.",
      "note": "Compare the observed format with available readers and identify the reader needed for the next saved operation.",
      "doneWhen": "The decision names one reader and target or records why no available reader fits."
    }
  ]
}
```

## One operation per attempt

For attached operational tools under Planning On, a persisted dispatch record enforces one active eligible action globally and one dispatch per leaf attempt. It checks the saved tool name and optional action, current prerequisites, ownership, current plan awareness, and any earlier unresolved result. A reasoning leaf cannot dispatch an operational tool. An unrelated plan edit or another read does not reset a consumed attempt.

A returned tool result does not automatically mark the action done. Save `done` with actual evidence, `blocked` with the actual blocker, or `skipped` with its reason before the next operational call. Completion keeps the prospective `result`, `note`, `doneWhen`, and operation; correct a malformed completion payload without repeating work already performed. Planning On also rejects multiple new completion claims in one plan update.

Delegation is an orchestration envelope: Planning On permits one worker assigned to the current active leaf. The worker reserves its actual operation, so the parent delegation call does not occupy a second enclosing dispatch. Worker scope and chronological prerequisites still apply.

## Returning to earlier work

Use an edit operation such as `{ "type":"revisit", "stepId":"read_input", "reason":"The input changed after the comparison." }` with the current revision. Revisit accepts an existing leaf or group; revisiting a group includes its subtree.

When repeated observations change the same live decision, save the new observation, revisit that earlier decision, and update its affected facts and remaining path before acting. Preserve its prior attempt rather than hiding the change in a new generic reconciliation step or overwriting the earlier evidence. Distinct requested snapshot assessments can keep separate decisions and artifacts: an accurate cached assessment does not become false merely because a later authoritative assessment uses newer data. Revisit the decision whose current conclusion is superseded, without inventing a cycle through historical snapshot work.

First save any active affected attempt's actual outcome. Revisit increments its attempt number and preserves its prior status, definition, evidence and relevant reasons in `pastAttempts`. Each snapshot's `at` is the time it was archived by the revisit, not proof of the original execution time. The current target becomes pending. Previously attempted dependent work is blocked for reassessment; previously pending or skipped affected work stays pending. Chronological successors and inherited or explicit dependencies are included, while unaffected independent work is retained. An affected path now excluded by a Boolean condition stays pending/unselected with its earlier attempt preserved.

Revisit does not undo a file change, submission, or other effect, and it does not execute a retry. Reassess existing read/write results from their receipts and actual effects; do not automatically repeat those operations because their dependent status changed. Inspect preserved effects before deciding what further work is appropriate. The UI exposes prior attempts and queues “Return to this step” through the normal revisioned editor. Dispatched unresolved leaves cannot be removed, promoted to groups, or redefined to evade outcome reconciliation; this preservation also applies to human edits.

## Interrupted calls and observation reconciliation

When a dispatch may have run but its result was lost, record the original leaf's uncertainty as a blocker. Keep the task-unique `callId` returned in its `planning.sequence` annotation or subsequent unresolved-dispatch receipt. This is distinct from the provider's session-scoped tool-call ID. Once no call is still live, an allowed read-only observation can inspect the destination; merely changing a plan, marking a leaf done, or starting another attempt does not resolve the uncertain effect.

Save that observation as a separate active leaf with its own tool operation. After its actual successful read-only result, complete it with evidence and `reconciliation:{callId,outcome,evidence}`. `outcome` is `"confirmed"` when the earlier effect is observed, or `"absent"` when the check establishes absence. For example, the observation leaf can carry:

```json
{
  "reconciliation": {
    "callId": "original-write-call",
    "outcome": "absent",
    "evidence": "The subsequent successful destination read found the original contents and no attempted change."
  }
}
```

The attached-tool guard checks that the referenced call exists and the observation is a distinct, later successful read-only dispatch. A reasoning claim or failed read does not qualify. Saving the reconciliation records the disposition of the original dispatch; it does not replay that dispatch or claim a failed effect succeeded. Replan or revisit only after preserving the observed result. If reconciliation persistence is unconfirmed, the tool receipt says so and further effects remain blocked until the record is recovered.

## Planning modes and native continuity

**On** applies prospective definitions, recursive decomposition instructions, one-active-leaf discipline, outcome recording, and attached-tool sequencing. **Off** disables automatic planning requirements and sequential dispatch gating; existing saved plans remain available. Off does not erase history or allow a live unresolved dispatch record to lose its definition. Historical `auto` and `maximal` settings normalize to On. Planning does not select or increase provider reasoning effort; effort and response length are separate controls.

Native provider sessions retain their original tool catalogs. Continuing or retrying a native session with an older task schema under Planning On starts a fresh provider session through the saved handoff path, using schema 10. The BLACKICE task ID, conversation relationship, saved plan, parent run chronology and bounded handoff context are retained. This is a provider-session refresh within the same BLACKICE conversation. Current-schema sessions do not need this planning upgrade; cached schema 9 remains unchanged, and Off does not trigger the planning upgrade.

The structured `operation`, `branch`, `plan.facts`, `revisit`, and `reconciliation` instructions apply from schema 9 onward; `review` is available from schema 10. A run using an older catalog must follow that catalog's declared fields and edits; global planning guidance does not add unsupported operations to a frozen catalog.

## Bounds and evidence limits

| Item | Current bound |
| --- | --- |
| Current plan tree | 200 nodes including groups; depth 8. |
| Plan representation | 64,000 characters in the plan normalizer; task/context budgets can impose additional limits. |
| Observed facts | 200; scalar text up to 2,000 characters; flat lists up to 200 scalars. |
| Each condition expression | Depth 24; 512 nodes, including comparison operands. |
| Ordered ELIF clauses | Up to 198, also constrained by the plan's child/node budget. |
| Revisit reason | 1–1,000 characters. |
| Inline attempt history | Latest 8 snapshots per leaf; `pastAttemptsOmitted` counts earlier omitted snapshots. |
| Sequential dispatch record | 4,096 dispatch identities and a 2 MiB record bound. |
| Saved review summaries | At most 1,200 characters each; latest 16 reviews within 12,000 serialized characters. |
| Runtime outcome markers | Latest 32 actor/scope markers, separate from review summaries and rolling plan history. |

These are bounded records, not an unlimited history archive. A valid typed operation cannot prove that a natural-language target or shell command contains only one meaningful operation. The dispatcher matches tool/action identity; it does not establish semantic equivalence between the stated target and every tool argument. Provider-native built-in tools outside the attached BLACKICE gateway are not intercepted by this sequencing guard. They receive the planning instructions, but the guard cannot certify their decomposition or ordering.

Saved evidence and Boolean facts are reported observations. Structural validation, dispatch receipts and deterministic tests do not establish hidden reasoning quality, the truth of an inference, or end-to-end real-world success.

## Implementation and tests

The main implementation is in `lib/planning-policy.mjs`, `lib/task-plan.mjs`, `lib/planning-logic.mjs`, `lib/planning-revisit.mjs`, `lib/planning-review.mjs`, `lib/planning-completion.mjs`, `lib/planning-sequence.mjs`, `lib/planning-edits.mjs`, `lib/task-state.mjs`, and `lib/engine.mjs`.

Relevant tests are `tests/planning-logic.test.mjs`, `tests/planning-recursive-integration.test.mjs`, `tests/planning-recursive-ui.test.mjs`, `tests/planning-review.test.mjs`, `tests/planning-sequential-dispatch.test.mjs`, `tests/planning-sequential-engine.test.mjs`, `tests/planning-completion-contract.test.mjs`, and `tests/planning-note-limit.test.mjs`. These exercise condition evaluation, revisions and revisits, review freshness and scope, preserved history, dispatch/recovery behavior, native catalog handoffs, editor behavior, and completion contracts. Actual model behavior requires the separate evaluations described in [PLANNING-BEHAVIOR-EVAL.md](PLANNING-BEHAVIOR-EVAL.md).
