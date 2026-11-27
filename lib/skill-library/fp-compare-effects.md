# Compare Effects and Practical Magnitude

Quantify how alternatives differ and whether that difference matters for the decision. Use this when averages, percentages, p-values, or small benchmark samples are being treated as a complete comparison.

## Primitives

- The estimand specifies which difference matters: absolute change, relative change, ratio, probability, or another quantity.
- Sampling uncertainty and practical consequence answer different questions.
- Failure to establish a difference is not evidence that alternatives are equivalent.

## Procedure

1. Define the population, outcome, comparison, and effect scale. State the magnitude that would change the action before interpreting the result.
2. Inspect the data structure. Identify pairing, clustering, repeated observations, unequal exposure, missing outcomes, and baseline differences.
3. Calculate the effect using an analysis appropriate to that structure. Preserve paired information when the same cases receive both conditions.
4. Quantify uncertainty with a justified model, interval, or resampling procedure. Inspect outliers and distributions; an average can conceal important tail behavior.
5. Compare the plausible effect range with the practical threshold. Distinguish clear benefit, clear harm, practical equivalence supported by the design, and unresolved difference.
6. Report the effect in interpretable units, the uncertainty, and the decision it supports. If more data are needed, specify which uncertainty must shrink and why.

## Worked example

Suppose ten tasks are timed under two implementations. Most tasks are much slower than others, so comparing separate pooled averages wastes useful information. Compute each task's time difference and analyze those paired differences.

Assume the estimated average improvement is 0.8 seconds with a defensible uncertainty interval from −0.2 to 1.8 seconds. The evidence permits a small slowdown and a substantial gain. If the user needs at least one second improvement, the result is unresolved. If the change is effectively free and reversible, deploying to a bounded test setting may still be worthwhile; that decision uses costs as well as uncertainty.

Conversely, a measured 0.01-second improvement can be precisely estimated but irrelevant if users cannot benefit from it.

## Check and output

Produce the estimand, effect size, uncertainty interpretation, practical threshold, and resulting decision. Check whether percentages mean relative change or percentage-point change. Identify the independent unit underlying uncertainty calculations.

## Failure boundary

Do not read a p-value as the probability that the hypothesis is true. Do not call two alternatives equivalent merely because a test lacks significance. Equivalence and noninferiority require a meaningful margin and an analysis that can support that claim.

## Reference

- NIST, statistical comparison and process analysis handbook: https://www.itl.nist.gov/div898/handbook/dtoc.htm
