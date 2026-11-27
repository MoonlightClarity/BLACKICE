# Compare Competing Hypotheses

Evaluate explanations against observations instead of accepting the first coherent story. Use this for ambiguous failures, conflicting reports, scientific questions, and surprising behavior.

## Primitives

- An explanation earns support by predicting evidence that alternatives predict less well.
- Plausibility before observing a result differs from fit to that result.
- Multiple causes can coexist; an initial hypothesis list need not exhaust reality.

## Procedure

1. Describe the observation without embedding its presumed cause. Include the baseline, timing, reproducibility, and exceptions.
2. Generate a small set of materially different explanations. Include measurement or selection error when it plausibly produces the observation.
3. For each explanation, state a mechanism and at least one expected observation. Prefer predictions that differ between candidates.
4. Compare existing evidence with those predictions. Mark support, contradiction, and missing information separately; do not score repeated versions of the same evidence as independent.
5. Rank candidates qualitatively unless defensible likelihoods and priors are available. Identify which new observation would most change the ranking.
6. Perform that check when authorized and available. Update the explanation set, including combinations or a new candidate when all current ones fit poorly.

## Worked example

A small model answers arithmetic correctly in one setup and fails in another. Candidate explanations include changed weights, different tokenization or prompt formatting, a runtime computation defect, and nondeterministic decoding.

A weight-file hash can test whether the files differ, but identical files do not prove identical interpretation. A fixed token sequence with deterministic settings removes one formatting and sampling pathway. Comparing selected intermediate outputs can locate a computation divergence. Testing another question distinguishes a stable defect from an isolated weak capability.

The useful conclusion is the candidate best supported by those comparisons, with remaining alternatives named. “Quantization is possible” is a hypothesis; a controlled comparison isolating numerical representation is stronger evidence.

## Check and output

Produce a compact hypothesis table containing mechanism, distinctive prediction, observed evidence, and next discriminating check. State which candidates were weakened and why. Preserve failed checks because they constrain future explanations.

## Failure boundary

Do not invent precise probabilities to make a qualitative ranking look scientific. Do not require an arbitrary number of alternatives when one explanation has decisive evidence. Avoid endlessly expanding the list: after a concrete observation identifies the mechanism well enough to act, perform the repair and verify its predicted result.

## Reference

- Stanford, conditional probability and Bayesian updates: https://web.stanford.edu/class/archive/cs/cs109/cs109.1204/lectureNotes/LN04_cond_bayes.pdf
