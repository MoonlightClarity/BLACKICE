# Prove Invariants Across State Changes

Show why a required property remains true as a system evolves. Use this for counters, resource limits, permissions, deadlines, ownership, protocols, and other claims involving “always” or “never.”

## Primitives

- State contains the variables needed to express the property.
- A transition describes an allowed state change, including exceptional and concurrent behavior.
- An inductive invariant holds initially and is preserved by every allowed transition.

## Procedure

1. State the property precisely and define its variables and domain. Separate the desired safety property from progress claims such as eventual completion.
2. Describe valid initial states and all relevant transition types: normal operations, retries, failures, cancellation, resume, reset, and concurrent interleavings.
3. Check the base case: every valid initial state satisfies the proposed invariant.
4. For each transition, assume the invariant and the transition's preconditions, then derive the resulting state. Show the invariant still holds or construct a violating transition.
5. Strengthen the invariant or repair the transition when needed. Avoid strengthening it into a premise that excludes a valid reachable state merely to make the proof work.
6. Check representative traces or a finite model as an implementation aid. State whether the result is an argument, bounded model check, or formal proof and the assumptions on which it depends.

## Worked example

Suppose a resource pool has capacity three and reserved count r. The desired invariant is 0 ≤ r ≤ 3. Initially r = 0. Reserving one unit should require r < 3 and then set r to r + 1; release requires r > 0.

If the check and increment are separate concurrent operations, two workers can both observe r = 2, both pass the check, and both reserve, producing r = 4. Each local check looked valid, but the combined transition violates the invariant.

An atomic check-and-reserve transition prevents that interleaving. The proof must also cover failed reservations, duplicate releases, and recovery state if those operations exist. Validating the ordinary increment alone leaves the global property unproved.

## Check and output

Produce the state definition, invariant, initial-state argument, transition-preservation argument, and any counterexample. Check that assumptions match the real system and that concurrency has not been silently serialized.

## Failure boundary

An invariant proves only the stated property under the modeled transitions. It does not establish eventual progress, performance, or correctness of omitted code. Passing finite examples does not prove all executions, but a valid counterexample is sufficient to identify a failure requiring repair.

## Reference

- Lamport, checking inductive invariants: https://lamport.azurewebsites.net/tla/inductive-invariant.pdf
