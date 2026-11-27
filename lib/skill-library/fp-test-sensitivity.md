# Test Sensitivity and Decision Thresholds

Find which changes would alter a result or decision. Use this when a recommendation depends on uncertain inputs, a model has many parameters, or apparently precise rankings are fragile.

## Primitives

- Local sensitivity describes nearby response; global sensitivity considers a meaningful range.
- A decision threshold is where the preferred action changes, which may matter more than a small numerical variation.
- Parameters can move together, and changing model structure can matter more than changing parameter values.

## Procedure

1. State the baseline conclusion, model, and decision criterion. Identify the assumptions that could plausibly change the selected action.
2. Choose credible ranges or scenarios from evidence and context. Preserve dependencies such as higher demand increasing both revenue and operating cost.
3. Vary one influential input to understand the mechanism, then test joint scenarios where interactions matter. Use derivatives only within their valid local region.
4. Solve for break-even values or threshold crossings when possible. Compare those values with the plausible input range.
5. Test alternative model structures if the conclusion depends on an uncertain mechanism, omitted constraint, or extrapolation.
6. Report what remains stable, what can reverse, and which measurement would resolve the relevant uncertainty. Act on robust conclusions while obtaining information needed for fragile ones.

## Worked example

Two hypothetical service plans have costs A = 25 + 0.20h and B = 5 + 0.80h, where h is monthly usable hours and prices are in the same currency.

Setting the costs equal gives 20 = 0.60h, so the break-even point is about 33.3 hours. At 20 hours, A costs 29 and B costs 21. At 60 hours, A costs 37 and B costs 53. The preferred plan depends on usage.

If expected usage is 50–70 hours, A is robustly cheaper under the model. If usage is 20–60, measuring likely demand matters. If one plan bills idle time, the definition of h changes and a structural correction is needed before further arithmetic.

## Check and output

Produce the baseline, varied inputs, justified ranges, threshold values, stable conclusions, and decision-sensitive uncertainty. Check whether a claimed robust result survives correlated changes and whether a threshold sits near an actual operating limit.

## Failure boundary

A sensitivity sweep over arbitrary ranges cannot establish robustness outside them. Do not interpret a flat local derivative as global irrelevance when thresholds or interactions exist. More scenarios are useful only when they address a plausible way the decision could change.

## Reference

- NIST, sensitivity coefficients within uncertainty analysis: https://www.itl.nist.gov/div898/handbook/mpc/section5/mpc5.htm
