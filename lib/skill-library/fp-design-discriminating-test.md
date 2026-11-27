# Design a Discriminating Test

Choose a test that can change the explanation or next action. Use this when repeated inspection produces more detail without resolving why something happened.

## Primitives

- A test is useful when plausible hypotheses predict different observations.
- A test result is interpretable only if the measurement path can detect the relevant difference.
- Cost includes execution time, disruption, setup, and the work delayed while waiting.

## Procedure

1. List the leading explanations and the decision they affect. Keep the observation that needs explaining separate from the explanation itself.
2. Identify a variable or measurement on which their predictions differ. Prefer a comparison that changes one relevant cause while controlling other consequential conditions.
3. Write the predicted outcomes before running the test. Include ambiguous, failed, and mixed results rather than forcing every response into success or failure.
4. Check that the observation can distinguish the predictions at the expected scale. Add a positive control or known case when the instrument or harness may be responsible.
5. Choose the least costly test with meaningful discriminatory power. Consider a short sequence when the first result determines which second test is valuable.
6. Execute, record the actual outcome, and update the explanation. Follow the corresponding action branch; design another test only for a remaining consequential ambiguity.

## Worked example

A model produces different answers in two applications. Candidate causes are different input tokens, different model computation, or different decoding behavior.

First record the token sequence supplied to each model. If sequences differ, align them and rerun. If sequences match, compare next-token scores under identical deterministic settings. Matching scores but different sampled outputs points toward decoding; differing scores points toward computation, weights, or state.

Before trusting a score comparison, check the same application against itself on a repeatable input. If that control varies because state is not reset, the cross-application comparison is not yet isolating the intended cause. This sequence is more informative than trying many unrelated prompts and counting disagreements.

## Check and output

Produce the competing predictions, controlled conditions, measurement, result branches, actual observation, and next action. Check that an unexpected result is preserved as evidence instead of relabeled to fit the favored explanation.

## Failure boundary

A test that rules out one candidate does not prove the remaining candidate when the list is incomplete. A failed harness is evidence about the harness, not the target system. Do not keep testing after the relevant mechanism is sufficiently established to perform and verify the authorized repair.

## Reference

- Heckerman, Horvitz, and Middleton, choosing observations by information value: https://www.erichorvitz.com/nonmyopevi.htm
