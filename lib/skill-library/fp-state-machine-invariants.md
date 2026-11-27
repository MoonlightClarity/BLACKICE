# State Machine Invariants

Use this method to derive legal states, transitions, and invariants for tasks that can run, pause, fail, cancel, or resume. Convert verbal expectations into predicates over explicit state, using the smallest model that exposes the defect.

## Primitives

Identify the entity, its identity, persistent fields, transient fields, events, and external effects. A state is the information needed to decide what may happen next. A transition is a change caused by an event. An invariant must hold initially and remain true after every permitted transition. Progress requirements, such as eventual completion, are separate from invariants that exclude forbidden states.

## Procedure

1. Write the relevant user requirement as a falsifiable sentence. Replace “handles cancellation” with “after cancellation becomes effective, this task admits no new work.”
2. List only states and fields that can change the requirement's truth. Include pending callbacks, active children, persisted deadlines, revision numbers, and restart recovery when relevant.
3. Write a transition table: source condition, event, guard, state update, external effect, and resulting condition. Mark which changes are atomic and which contain a wait.
4. Check the initial state and each transition against the invariant. A guard before an asynchronous wait does not prove the same condition after the wait. Check the point where the effect actually becomes committed.
5. Construct a short counterexample sequence for each questionable transition. Include interruption between state persistence and effect admission, stale callbacks after cancellation, and recovery from saved state.
6. Repair the transition or representation that permits the counterexample. Consolidate one invariant at its authoritative boundary rather than copying incomplete checks across callers.
7. Verify the smallest failing sequence and one adjacent valid sequence. Preserve legitimate transitions while excluding the demonstrated violation.

## Worked example

A task checks that it is active, waits for resource availability, then starts a child. Cancellation can occur during the wait. The initial check passes, cancellation changes the task to stopped, and the callback still starts work. Rechecking the current task generation and active status at child admission closes this gap. Merely disabling the Cancel button changes no transition and cannot establish the invariant.

## Output and check

Return the invariant, compact transition table, counterexample, changed authoritative boundary, and observed verification. State which effects were already committed before cancellation; stopping future work does not undo completed work. An acceptance check should distinguish an admitted child from a proposed or queued child.

## Failure boundary

A model can preserve its invariants while omitting an important real state. Compare the model with actual persistence, callbacks, and external receipts. Do not infer eventual completion from the absence of illegal transitions, or redefine a user's requirement to make a flawed transition appear valid.

## Reference

- [Lamport: Time, Clocks, and the Ordering of Events](https://lamport.azurewebsites.net/pubs/time-clocks.pdf)
