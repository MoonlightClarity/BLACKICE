# Estimate Scale and Dominant Terms

Construct a useful approximate answer when exact inputs are unavailable or unnecessary. Use this to compare options, reject impossible plans, and identify which measurements are worth obtaining next.

## Primitives

- A mechanistic estimate decomposes the total into countable contributions.
- Bounds should reflect plausible inputs, not decorative precision.
- Relative uncertainty in a tiny term may matter less than modest uncertainty in the dominant term.

## Procedure

1. Define the requested quantity, its unit, and the boundary of the estimate. Clarify whether the question concerns typical, peak, cumulative, or worst credible behavior.
2. Break the quantity into a small number of interpretable factors or additive components. Prefer counts, rates, durations, and sizes that can be independently checked.
3. Assign a central estimate and plausible limits to the uncertain factors. Label invented scenario values as assumptions; use observed reference quantities when available.
4. Compute the scale with rounded numbers, then recompute carefully if the answer is near a decision threshold. Account for correlation before combining simultaneous extremes.
5. Rank contributors by their effect on the result. Refine the most consequential uncertain input rather than polishing every factor equally.
6. Check the result through another decomposition or an external capacity bound. Use disagreement to locate a missing component or denominator, then give the estimate and the next useful action.

## Worked example

Suppose a collection contains 10,000 documents averaging 2,000 tokens. At an assumed four encoded bytes per token, text occupies roughly 80 million bytes, or 80 MB.

An embedding design creates ten chunks per document, with 768 four-byte coordinates per chunk. That adds 10,000 × 10 × 768 × 4 = 307.2 MB before index and metadata overhead. The initial intuition that raw text dominates storage is wrong in this scenario.

If chunk count plausibly ranges from five to fifteen, vectors range from 153.6 to 460.8 MB. Measuring actual chunk counts is therefore more useful than refining the four-byte text approximation to several decimal places. A sample of representative documents can settle that input cheaply.

## Check and output

Produce the decomposition, central scale, justified range, dominant contributor, and whether the decision changes within that range. Keep units visible. If a bound is intentionally conservative, identify the assumptions that make it conservative.

## Failure boundary

A Fermi estimate is not a guarantee or a measured benchmark. Do not multiply unrelated worst cases and call the result typical, or report a narrow interval from guessed inputs. When the decision lies near the estimate's uncertainty, obtain the decisive measurement instead of asserting extra confidence.

## Reference

- MIT, educated estimation and approximation: https://ocw.mit.edu/courses/18-098-street-fighting-mathematics-january-iap-2008/pages/syllabus/
