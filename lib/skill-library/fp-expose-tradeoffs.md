# Expose Tradeoffs and Dominated Options

Separate feasibility from preference, then show what must be exchanged to improve an objective. Use this when alternatives win on different dimensions or a weighted score hides the reason for a recommendation.

## Primitives

- Hard requirements determine which options qualify; preferences determine which qualifying option is best.
- An option is dominated when another is at least as good on every relevant objective and better on one, under the stated conditions.
- Weights represent value judgments, not properties discovered inside the data.

## Procedure

1. Identify the user's outcome, hard requirements, and consequential preferences. Reuse established priorities rather than asking for them again.
2. Define comparable measures and boundaries for each objective. Separate measured values, uncertain estimates, and unverified claims.
3. Remove options that violate actual requirements. Investigate apparent violations caused by a current configuration or unsupported assumption before rejecting a potentially useful option.
4. Identify dominated alternatives using the relevant dimensions and uncertainty. Retain an option when an omitted capability or uncertain value could change dominance.
5. Compare the remaining tradeoffs in practical units. Use thresholds, scenarios, or explicit user preferences before introducing numerical weights.
6. Recommend and execute the authorized next action. State the deciding tradeoff and the conditions under which another option would become preferable.

## Worked example

Consider three hypothetical inference configurations that all meet a required quality threshold. A uses 3 GB and takes eight seconds, B uses 4 GB and takes ten seconds, and C uses 5 GB and takes five seconds. Assume their other relevant properties are equal and the measurements are reliable.

B is dominated by A: it uses more memory and takes longer. A and C remain a real tradeoff. On a device with only 4 GB available, C is infeasible under the tested configuration. On a larger device with a strict six-second limit, C is the qualifying choice.

If C's quality was measured on different tasks, the comparison is not ready for those conclusions. Align the workload before treating its speed as a comparable benefit.

## Check and output

Produce the qualifying options, comparison table, dominated choices with reasons, remaining tradeoff, and recommendation. Check that a hard requirement was not reduced to a small weight that another benefit can compensate for.

## Failure boundary

Do not invent preferences or precision to force a single numerical winner. A recommendation can be conditional while still giving a clear next action. Avoid expanding the comparison to every imaginable dimension; include factors that could realistically change the user's decision.

## Reference

- Boyd and Vandenberghe, optimization and competing objectives: https://web.stanford.edu/~boyd/cvxbook/
