# Derive Unit Economics

Use this method when a business, service or proposed feature looks attractive because its revenue is large, its users are growing, or its average cost appears low. Convert those impressions into a model of what one additional economically meaningful unit earns and consumes.

## Primitives

Choose a unit: order, customer-month, completed job, occupied room-night or another delivered outcome. Define its price, refunds, directly consumed inputs and service obligations. Separate costs that vary with volume from costs fixed over the specified horizon. A cost can be fixed this month and avoidable next year. Customer counts, transactions and active usage are different denominators.

## Procedure

1. Specify the decision and horizon. Expansion, temporary operation and long-term investment require different cost boundaries.
2. Draw the unit's revenue and resource ledger. Include payment fees, support, returns, retries, delivery and unpaid usage when they actually follow the unit.
3. Calculate contribution as realized unit revenue minus incremental unit cost. Derive total operating contribution by adding the contributions of each segment; subtract fixed costs once.
4. For a constant positive contribution, derive break-even volume as fixed cost divided by unit contribution. Mark this as conditional on unchanged prices, mix and capacity.
5. Identify thresholds that break the linear model: another employee, capacity tier, volume discount, congestion, sales commission or service-level commitment. Recalculate by interval.
6. Inspect acquisition and retention separately. Compare a dated stream of customer contribution with acquisition cost; do not multiply today's margin by an unsupported lifetime.
7. Select the observation that most changes the decision, such as support minutes per high-usage customer. Use a range for uncertain inputs and state the volume or cost threshold at which the recommendation reverses.

## Worked example

A service receives 20 per customer-month. Infrastructure costs 4, payment and refund costs average 1, and support averages 3. Contribution is 12. With monthly fixed costs of 6,000, the simple break-even point is 500 customers. At 400 customers, contribution is 4,800 and the operating shortfall is 1,200.

A new support hire becomes necessary above 450 customers and adds 2,400 monthly. Break-even in that interval is therefore 8,400 / 12 = 700 customers. The original 500-customer answer misses the capacity step. If heavy users consume twice the infrastructure and support, model that segment separately before expanding.

## Output and check

Return the unit definition, cost ledger, equation, capacity intervals and decisive sensitivity. Verify that all quantities share a time period and denominator. Reconcile modeled totals with available records.

## Failure boundary

Contribution is not cash flow, accounting profit or proof of future demand. Avoid allocating unrelated fixed costs to a marginal decision, while retaining avoidable fixed costs for an expansion or shutdown decision.

## Reference

[OpenStax: Costs in the Short Run](https://openstax.org/books/principles-economics-3e/pages/7-3-costs-in-the-short-run) supports the cost distinctions. The workflow and example are original.
