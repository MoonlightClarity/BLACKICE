# Test Distribution Transfer

Use this method when a model or decision rule moves to a new population, location, device, time period, or task. Identify what changed and test the mechanism by which that change could affect the result.

## Primitives

Record input distribution, target definition, relationship between inputs and targets, measurement process, selection process, and deployment support. Distinguish a different mix of familiar cases from unfamiliar cases or a changed causal mechanism. A new label for the environment does not specify the relevant shift.

## Procedure

1. Describe source and target settings in operational terms: who or what is sampled, when, with which instruments, under which rules, and with which target definitions.
2. List plausible changes by type. Inputs may have different frequencies; outcome prevalence may change; measurement can change; or the relationship used for prediction can cease to hold.
3. Compare distributions and coverage for relevant features and subgroups. Check whether target cases occupy regions poorly represented in the source data.
4. Inspect failure patterns by the proposed shift mechanism. A scanner change suggests image-processing comparisons; a time shift suggests temporal validation; a policy change suggests rechecking labels and incentives.
5. Construct a matched test where feasible. Hold the underlying case fixed while changing the sensor, presentation, or pipeline, or compare similar cases across environments.
6. Evaluate the task metric and any decision threshold in the target setting. A stable ranking can coexist with miscalibrated probabilities or a poor threshold after prevalence changes.
7. Test a focused adaptation and verify on separate target cases. Reweighting familiar cases cannot create evidence for regions with no source support.
8. Report where transfer is demonstrated, where it fails, and which mechanism remains unresolved. Continue useful bounded work without claiming universal portability.

## Worked example

An image classifier performs well at site A but poorly at site B. Labels have the same definition, yet the camera and background differ. Testing matched objects photographed with both cameras shows that predictions change with the image pipeline. This supports a measurement-related explanation. Retraining on more site-A images may leave that mechanism untouched; matching preprocessing or adding representative target measurements is a more focused experiment.

## Output and check

Return a source-target difference table, support assessment, mechanism-specific test, subgroup results, and adaptation result. Tie the conclusion to an explicit deployment population and time range rather than the phrase “generalizes well.”

## Failure boundary

An aggregate score can hide failure in a small important subgroup. A visual difference between datasets does not prove it causes the performance gap. Conversely, similar marginal feature distributions can conceal a changed relationship with the target. Separate descriptive shift detection from evidence that a particular shift explains the error.

## Reference

- [WILDS: A Benchmark of in-the-Wild Distribution Shifts](https://arxiv.org/abs/2012.07421)
