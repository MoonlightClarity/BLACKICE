# Test Metrics Against Adaptive Behavior

Use this method when a measure becomes a target, a ranking, a payment basis or an agent objective. Treat the target's introduction as a change to the system. Inspect how participants can alter the score, the measured population or the timing without producing the intended result.

## Primitives

Define the latent outcome, recorded measure, measurement process, participant actions and decision rule. A metric can fail through manipulation, selection, omission, delay or a changed relationship with the outcome. Measurement error and deliberate gaming are different mechanisms and require different repairs.

## Procedure

1. State the outcome in observable terms independent of the current score. For example, identify whether a user can complete the task after assistance.
2. Trace how raw events become the score. Inspect numerator, denominator, exclusions, aggregation, attribution and measurement window.
3. Enumerate feasible score-improving actions that leave the intended outcome unchanged or worse. Include legitimate local optimization as well as deliberate manipulation.
4. Examine which cases can disappear from measurement. Track refused, abandoned, transferred and incomplete work where relevant.
5. Construct a small adversarial example for each important failure route. Calculate the score before and after to prove that the loophole exists.
6. Repair the observation or decision rule. Use complementary evidence only when it measures a distinct failure route; more dashboards alone do not improve validity.
7. Reassess after deployment. Look for distribution shifts, bunching around thresholds, displaced work and deterioration in unmeasured outcomes.

## Worked example

A service reports 95% success across 100 attempted cases: 95 succeed and five fail. A new filter rejects 30 difficult cases before the system labels them attempted. Of the remaining 70, 69 succeed. Reported success rises to 98.6%.

That increase does not establish improved usefulness. If rejected cases count as unmet requests, completed successes fell from 95 to 69 per 100 arriving requests. Record both admission and conditional success, with clear denominators. The rejection may still be appropriate for an explicit capacity policy, but the claim must describe the actual tradeoff.

## Output and check

Produce a metric lineage, at least one calculated loophole, revised denominators and an evaluation plan tied to the intended outcome. Recompute historical results under the revised definition where comparable records exist.

## Failure boundary

A correlation changing after incentives change is not proof of dishonesty. Do not discard a useful measure merely because it is imperfect. Identify the concrete failure mechanism and how the revised evidence addresses it.

## Reference

[Bengt Holmstrom: Pay for Performance and Beyond publications](https://economics.mit.edu/people/faculty/bengt-holmstrom/publications) provides research context for performance signals and incentives.
