# Test Semantic Properties

Use this method to derive behavioral laws for software with varied inputs, then construct counterexamples. Apply it when the behavior warrants testing and keep the test effort proportional to the defect or requirement.

## Primitives

Identify the function or process, valid input space, observable output, state, and an independent behavioral property. Useful relations include conservation, ordering, round trips, idempotence, monotonicity under stated conditions, and equivalence under transformations. Distinguish a true requirement from a convenient pattern that merely resembles one.

## Procedure

1. State the behavior independently of the implementation. For a sorter, “output has the same multiset and is ordered” is more informative than reproducing the sorting algorithm in a test.
2. Select one property that would expose a consequential defect. Write its assumptions explicitly: valid encodings, permitted rounding, identity semantics, or allowed state changes.
3. Construct inputs around boundaries and structural variety. Include empty collections, repeated values, extreme but valid magnitudes, Unicode, and operation sequences only where relevant to the contract.
4. Use an independent oracle when available. Otherwise compare related executions through a justified metamorphic relation, such as changing an irrelevant label without changing a numerical result.
5. When a case fails, reduce the input while preserving the failure. A short counterexample often reveals the representation or boundary condition responsible.
6. Repair the behavior and retain the small counterexample as a regression case. Keep the broader property when it guards a real input family.
7. Check whether the property itself was false. Update an incorrect test only from the intended contract and evidence, never merely because the implementation disagrees.

## Worked example

A serializer and parser should preserve a structured value within their documented data model. Randomly generated nested objects reveal that an empty array returns as null. Shrinking reduces a large object to a single empty array. The round-trip property exposes a semantic loss that a “does not crash” test would miss. If the format intentionally normalizes object key order, byte-for-byte equality would be the wrong property.

## Output and check

Produce the property, assumptions, input strategy, minimal counterexample, and observed corrected behavior. Explain why the property tests the contract rather than mirroring the implementation. For stateful processes, include the shortest operation sequence that breaks the law.

## Failure boundary

Round trips can pass when encoder and decoder share the same error. Compare an external example or independent implementation when interoperability is the goal. Monotonicity and idempotence are not universal: retries may represent new intent, and adding data can change an estimate in either direction. Generated input volume is not a substitute for a meaningful property.

## Reference

- [Hypothesis: What is property based testing?](https://hypothesis.works/articles/what-is-property-based-testing/)
