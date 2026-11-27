# Update Beliefs with Base Rates and Evidence

Revise a belief according to how expected the evidence is under competing explanations. Use this when a positive test, surprising observation, or collection of reports appears stronger than its actual discriminatory value.

## Primitives

- A prior describes uncertainty before the current evidence, relative to a relevant reference class.
- A likelihood describes how probable the observation is if a hypothesis holds.
- Posterior odds equal prior odds multiplied by the likelihood ratio for the evidence.

## Procedure

1. Define the hypotheses and the observed event precisely. For a binary calculation, make clear what the alternative includes.
2. Establish a grounded prior from relevant frequencies, earlier evidence, or a defensible range. Do not substitute the desired conclusion for the prior.
3. Estimate how likely the event is under each hypothesis. Distinguish P(evidence given hypothesis) from P(hypothesis given evidence).
4. Update numerically when inputs are supported. Otherwise describe the direction and relative strength of the update without invented percentages.
5. Check dependence before combining observations. Repeated reports of one event, repeated readings with shared bias, and tests derived from the same data do not automatically supply independent likelihood ratios.
6. Test sensitivity to consequential prior and likelihood uncertainty. Translate the updated belief into the task's next action, which may depend on the cost of being wrong rather than a universal confidence threshold.

## Worked example

Suppose a hypothetical defect occurs in 1% of units. A detector flags 90% of defective units and 5% of sound units. Among 10,000 units, expect about 100 defects and 9,900 sound units. The detector produces about 90 true flags and 495 false flags.

A flagged unit therefore has probability 90/(90 + 495) ≈ 15.4% of being defective under these assumptions. The detector is informative: it increased the probability from 1% to 15.4%. It did not make a flag equivalent to a confirmed defect.

Reading the same detector log twice adds no independent evidence. A second test may help, but its relationship to the first must be assessed before multiplying likelihood ratios.

## Check and output

Produce the hypotheses, reference class, inputs or qualitative basis, update, sensitivity, and decision implication. Verify probability normalization and denominators. State whether evidence was independent, conditionally independent under a model, or dependent.

## Failure boundary

Bayesian notation does not make guessed numbers objective. A narrow posterior can be misleading if the hypothesis set excludes the real cause or the likelihood model is wrong. Keep structural uncertainty separate from precision inside a selected model.

## Reference

- Stanford, Bayes' theorem and conditional probabilities: https://web.stanford.edu/class/archive/cs/cs109/cs109.1204/lectureNotes/LN04_cond_bayes.pdf
