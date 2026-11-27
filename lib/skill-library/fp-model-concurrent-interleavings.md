# Model Concurrent Interleavings

Use this method when correctness depends on the order of events from multiple workers, callbacks, processes, or requests. Replace the vague claim “these run at the same time” with a small schedule that demonstrates how an invariant can fail.

## Primitives

Identify shared state, each actor's local state, reads, writes, waits, messages, commit points, and the invariant. Preserve each actor's program order. Add cross-actor ordering only when a real synchronization or message relationship establishes it. Wall-clock timestamps can help investigate a trace but do not by themselves establish all causal ordering.

## Procedure

1. State the invariant and select the shared object whose changes can violate it. Examples include one task owner, monotonic revision numbers, or at most one admitted effect for an intent.
2. Reduce each actor to relevant steps: read, decide, await, write, publish. Keep local computations together unless they access changing state.
3. Enumerate interleavings around the shared reads and commits. Begin with the schedule that gives both actors the same stale observation. Do not brute-force unrelated operations.
4. Track the shared state and each actor's cached view after every step. Mark the exact step where an invariant first becomes false.
5. Choose a correction matching the invariant's scope: atomic compare-and-swap, transaction, serialized owner, generation token, or a commutative merge. A lock in one process cannot serialize another process unless they share its mechanism.
6. Reproduce the critical ordering with a controllable barrier or deterministic scheduler where available. Also check a valid independent operation so the repair does not unnecessarily serialize unrelated work.
7. Inspect recovery and cancellation. A stale worker that wakes later must not publish into a replacement task merely because the task name is unchanged.

## Worked example

Workers A and B read a counter at revision 8 with value 10. A computes 11 and B computes 11. Both write revision 9, so two increments produce 11. Checking revision only during the initial read does nothing. An atomic “write only if revision is still 8” allows one write; the other must reread and recompute. The final value becomes 12 while preserving both increments.

## Output and check

Return the minimal failing schedule, invariant, synchronization scope, and corrected schedule. Record whether the verification controlled the relevant ordering or merely ran many probabilistic repetitions. Name the exact shared boundary protected by the repair.

## Failure boundary

A passing stress run does not prove that a rare schedule is impossible. Conversely, a theoretical schedule is irrelevant if an actual transaction excludes it. Preserve documented ordering guarantees and distinguish memory visibility, process concurrency, distributed delivery, and application-level ordering; they require different mechanisms.

## Reference

- [Lamport: Time, Clocks, and the Ordering of Events](https://lamport.azurewebsites.net/pubs/time-clocks.pdf)
