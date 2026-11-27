# Audit Sampling and Selection

Audit selection bias in benchmarks, surveys, and reported success rates. Compare the target population with admitted, observed, completed, missing and excluded cases; retain crashes in the appropriate denominator.

## Primitives

- The target population is the group the claim concerns; the observed sample is the group with usable records.
- Selection can depend on the outcome or its causes, distorting an observed relationship.
- Missing information is not automatically a negative outcome or a random omission.

## Procedure

1. Define the target population, unit of analysis, time interval, and outcome. Identify the denominator implied by the claim.
2. Trace entry into the observed data: eligibility, invitation, participation, execution, logging, completion, filtering, and inclusion in analysis.
3. Count exclusions at each step where records permit. Ask whether exclusion depends on the action, outcome, a shared cause, or a measurement failure.
4. Compare observed and excluded cases using available characteristics. Consider how plausible outcomes among missing cases would change the result.
5. Use an appropriate design, weighting, model, or bound only when its assumptions are defensible. Present subgroup results when a pooled estimate conceals differing selection mechanisms.
6. Report the result for the population it actually supports and identify the most useful missing observation for wider generalization.

## Worked example

A hypothetical benchmark launches 120 tasks. Eighty return answers: 70 correct and ten incorrect. Forty terminate with execution errors. Reporting 70/80 = 87.5% describes correctness among returned answers.

If the intended metric is successful completion across launched tasks, the result is 70/120 ≈ 58.3%. Both ratios are mathematically valid, but they answer different questions. The execution errors cannot disappear merely because an answer grader had no text to score.

If the forty cases are still running, classify them as unresolved at the cutoff rather than final failures. A deadline-based metric can count failure to finish by that deadline, provided the deadline was part of the definition.

## Check and output

Produce the target population, selection path, counts, missing-case treatment, and the supported scope. Show alternative denominators when they reveal a material difference. Check that repeated attempts do not masquerade as independent cases.

## Failure boundary

A biased sample cannot always be repaired by collecting more of the same kind of data. Weighting requires information about selection and adequate overlap; it is not an automatic correction. When assumptions are unavailable, give useful bounds or a narrower conclusion instead of manufacturing representativeness.

## Reference

- Hernán and Robins, selection and measurement bias: https://miguelhernan.org/whatifbook
