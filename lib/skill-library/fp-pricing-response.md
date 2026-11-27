# Derive Pricing Response Thresholds

Calculate how a price cut or increase changes contribution and required sales volume. Derive the break-even quantity with variable costs, demand response, customer mix and capacity steps made explicit.

## Primitives

Revenue equals realized price times quantity. Contribution equals quantity times price minus incremental unit cost when that cost is constant. Demand response depends on the available alternatives, purchase timing, customer mix and context. An observed association between price and volume is not automatically a causal demand curve.

## Procedure

1. State the objective: contribution, revenue, market entry, capacity use or another explicit outcome. Identify constraints such as service capacity and contractual commitments.
2. Establish baseline realized price, quantity and incremental costs for comparable transactions. Include discounts, refunds and fees rather than using a list price.
3. Derive the break-even condition. With unchanged fixed costs, require Q1(P1 - V1) to exceed Q0(P0 - V0). Solve for the needed quantity ratio when the denominator is positive.
4. Add changed costs, capacity steps and cannibalization. Separate genuinely additional sales from customers who would have purchased at the original price.
5. Assess demand evidence by segment. Distinguish randomized price exposure, a credible natural change, stated preferences and uncontrolled historical correlations.
6. Design the smallest informative authorized test. Define the eligible population, comparison condition, contribution outcome, duration and effects on repeat purchase before interpreting the result.
7. Test customer and competitor responses over time. Pulling a purchase forward or attracting a high-cost segment can produce a short-term gain with a different long-term result.

## Worked example

A product sells 1,000 units at 10 with incremental cost 6. Baseline contribution is 1,000 times 4 = 4,000. Cutting price to 9 leaves contribution of 3 per unit. The new volume must exceed 4,000 / 3, or about 1,334 whole units, to improve total contribution.

A forecast of 20% more units produces 1,200 times 3 = 3,600, a decline despite additional sales. A claim that the discount needs only 11.1% more volume uses a revenue threshold and answers a different question. If the new volume requires overtime that raises unit cost, recompute the threshold.

## Output and check

Return the objective, baseline, threshold equation, response evidence and segment-specific test or decision. Verify units, margins and whether the denominator is positive.

## Failure boundary

Do not extrapolate a local elasticity across a large price change or different market. A negative unit contribution cannot be repaired merely by selling more units unless a separately evidenced complementary benefit changes the economic unit.

## Reference

[OpenStax: Elasticity and Pricing](https://openstax.org/books/principles-economics-3e/pages/5-3-elasticity-and-pricing) provides the elasticity context. The threshold derivation and example are original.
