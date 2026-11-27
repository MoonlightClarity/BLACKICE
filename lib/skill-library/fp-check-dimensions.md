# Check Dimensions and Units

Use units as constraints on a calculation before trusting its numbers. Apply this to performance, memory, finance, physical quantities, and any formula that combines measurements from different sources.

## Primitives

- A quantity is a number with a unit and meaning. Equal dimensions do not guarantee equal meanings.
- Adding requires compatible quantities; multiplication and division transform units.
- Rates describe change per interval. Stocks, totals, percentages, and averages require explicit denominators.

## Procedure

1. Write every input with its unit, scope, and denominator. Distinguish bytes from bits, decimal from binary prefixes, total requests from requests per second, and percentage points from relative percentages.
2. Express the desired output unit. Build the formula from relationships that connect the inputs to that output.
3. Cancel units symbolically before substituting values. An unmatched unit identifies a missing factor, incorrect rate, or incompatible quantity.
4. Convert inputs once into a consistent system. Preserve exact conversion factors and delay rounding until the result is interpreted.
5. Check semantic compatibility after dimensional compatibility. Two monetary amounts may refer to different years, currencies, or billing intervals; two durations may be overlapping rather than additive.
6. Evaluate one easy case independently and compare against a plausible scale. State the final unit and the assumptions that make the formula apply.

## Worked example

Consider a hypothetical attention cache with two stored tensors, 24 layers, eight key/value heads, 4,096 positions, 64 elements per head, and two bytes per element. The direct element count is:

cache bytes = 2 × 24 × 8 × 4,096 × 64 × 2 = 201,326,592 bytes.

Dividing by 1,048,576 gives 192 MiB. Dividing by 1,000,000 gives about 201.3 MB. Both report the same quantity with different prefixes. Using query-head count instead of key/value-head count would be a semantic modeling mistake even though the units still cancel. The expression also excludes other allocations, so it is a cache estimate rather than a total device-memory requirement.

## Check and output

Produce the symbolic formula, labeled inputs, conversions, and calculated result. Check both dimensions and meanings. If an input is uncertain, retain the range in the final unit instead of displaying extra decimal places.

## Failure boundary

Dimensional consistency can reject an impossible formula; it cannot establish the correct coefficient, mechanism, or input. Dimensionless factors can still be wrong. Do not treat a calculation that passes units as a substitute for checking the actual implementation or measurement boundary.

## Reference

- MIT, dimensional reasoning and approximation: https://ocw.mit.edu/courses/18-098-street-fighting-mathematics-january-iap-2008/pages/syllabus/
