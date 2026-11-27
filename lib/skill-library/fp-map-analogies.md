# Map Structural Analogies and Transfer

Use a familiar problem to generate a testable method for a different one. Apply this when two domains appear related, a successful approach might transfer, or a resolved case could become a reusable reasoning rule.

## Primitives

- A structural analogy maps relationships and constraints, not merely similar words or appearances.
- A useful transfer preserves the relationship responsible for the source method's success.
- Mismatches define the analogy's limits and often reveal the most informative test.

## Procedure

1. State the target problem and the part of the source problem that appears useful. Keep the target's objective and constraints unchanged.
2. Map entities, relationships, operations, and invariants explicitly. Identify which elements have no target counterpart and which target elements the source lacks.
3. Name the mechanism that makes the source method work. Check whether that mechanism survives the mapping rather than assuming similarity is sufficient.
4. Derive a concrete target prediction or procedure. Specify a case where the analogy should work and a case where a consequential mismatch could break it.
5. Test the transfer against those cases and revise or discard the mapping accordingly. Preserve a failed transfer as a boundary on the lesson.
6. Extract a concise reusable rule: trigger, operation, expected result, and counterconditions. When saving a lesson is part of the task, include a fresh validation case instead of merely memorializing the original success.

## Worked example

Inventory accounting suggests a method for reconciling a task queue. Map stock to pending tasks, incoming shipments to newly accepted tasks, and removals to completed or cancelled tasks. The balance equation can reveal missing work.

The analogy breaks if execution attempts are counted as tasks. A retry creates a new attempt without necessarily creating a new user objective. Separate task identity from attempt identity before balancing counts. A duplicated delivery can also produce multiple effects from one task, so outcome reconciliation needs its own accounting.

The transferable rule is therefore not “all queues are inventories.” It is “choose a stable counted entity, define creation and removal events, and reconcile its state across an interval.” Test that rule on a queue with retries and cancellations.

## Check and output

Produce the mapping, preserved mechanism, consequential mismatch, target procedure, and observed test result. State the reusable lesson at the narrowest scope that still transfers usefully.

## Failure boundary

An analogy proposes a model; it does not prove it. Do not import a source domain's goals, permissions, or assumptions into the target. When the mechanism fails to transfer, keep any useful representation but derive the target behavior from its own evidence.

## Reference

- MIT, analogy as a problem-solving method: https://ocw.mit.edu/courses/18-098-street-fighting-mathematics-january-iap-2008/pages/syllabus/
