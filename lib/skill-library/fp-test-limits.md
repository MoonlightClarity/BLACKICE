# Test Limits and Boundary Cases

Derive what a claim must do in easy or extreme situations, then compare that requirement with its actual behavior. Use this to catch structural errors before relying on realistic-looking outputs.

## Primitives

- A limiting case simplifies a relationship while preserving an essential property.
- A boundary can be numerical, logical, temporal, or structural.
- Failure at one valid case can refute a universal claim; success on several cases does not prove it.

## Procedure

1. State the formula, algorithm, or explanation and its intended domain. Identify parameters and states that can vary.
2. Select cases with predictable outcomes: zero input, one element, equal alternatives, no change, complete saturation, absent dependency, or very large scale.
3. Derive each expected result independently from the meaning of the problem. Do not use the questioned formula to generate its own expected answer.
4. Evaluate the proposed model on those cases. Check signs, monotonicity, continuity where appropriate, and boundedness as well as exact values.
5. Investigate a mismatch. Determine whether the model is wrong, an assumption ceases to hold, or the selected limit lies outside the domain.
6. Repair the model or narrow its stated domain, then test an interior case and the affected boundary again. Carry remaining restrictions into the practical conclusion.

## Worked example

Suppose fraction s of a task is serial and the remainder runs p times faster. Ignoring additional overhead, total normalized time is s + (1 − s)/p, so speedup is its reciprocal.

Check p = 1: speedup is one. Check s = 1: adding parallel capacity gives no improvement. For s = 0.2 and arbitrarily large p, speedup approaches five. A proposal claiming twentyfold speedup from parallelizing only the remaining 80% contradicts this model.

This does not prove twentyfold speedup is impossible under every redesign. Eliminating serial work, changing the algorithm, or reusing results changes the model. The limit distinguishes additional parallel capacity from those different mechanisms.

## Check and output

Produce a small table of case, independently expected behavior, observed model behavior, and implication. Include the relevant domain condition. If the test finds a contradiction, give the smallest reproducible example or corrected relationship.

## Failure boundary

Do not assume all systems are linear, continuous, or monotonic. Thresholds, phase changes, rounding, and discrete choices can create legitimate discontinuities. Limits outside the model's stated assumptions are opportunities to identify its scope, not automatic evidence that the model is useless.

## Reference

- MIT, extreme-case reasoning: https://ocw.mit.edu/courses/18-098-street-fighting-mathematics-january-iap-2008/pages/syllabus/
