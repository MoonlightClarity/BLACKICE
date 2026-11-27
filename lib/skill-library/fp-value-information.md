# Value Information Before Gathering It

Investigate uncertainty because resolving it can improve an action. Use this when research is expanding, several tests are possible, or waiting for more certainty competes with completing the task.

## Primitives

- Information has decision value when it can change an action or improve its timing or execution.
- The value of perfect information is an upper bound on the value of a less informative test, under the same decision model.
- Test cost includes money, time, disruption, and lost opportunities.

## Procedure

1. List the available actions, consequential unknown states, and outcomes that matter to the user. Use grounded probabilities or explicit scenarios rather than invented precision.
2. Determine the best action using current information and the losses or benefits it implies.
3. For a proposed observation, describe possible results and the action each would lead to. If every result leaves the action unchanged, look for a different practical benefit before gathering it.
4. Estimate the expected improvement from the resulting decisions. Use a perfect-information bound when it can cheaply rule out an expensive test.
5. Subtract observation cost and delay. Consider sequences when one result determines which follow-up test would be useful, and retain independent work that can proceed now.
6. Perform the best worthwhile observation or take the justified action. Update the calculation only when evidence changes the decision, not as a ritual after every tool call.

## Worked example

Suppose action A loses 90 units if an unknown defect is present and zero otherwise. Action B always loses 12 units. With a defensible defect probability of 0.2, A's expected loss is 18 and B's is 12, so current information favors B.

With perfect information, choose B when the defect is present and A otherwise. Expected loss becomes 0.2 × 12 = 2.4. Perfect information is therefore worth at most 12 − 2.4 = 9.6 units.

A test costing 12 units cannot pay for itself solely through this decision, even if flawless. Choose B without that test. A cheaper imperfect test requires calculation using its actual accuracy and the decisions following each result; its value is not automatically 9.6.

## Check and output

Produce the current action, candidate observation, result-dependent actions, value estimate or bound, cost, and next executed step. Check whether the test changes the action and whether waiting makes an option expire.

## Failure boundary

Not every uncertainty needs a probability. Use qualitative dominance or bounds when numerical inputs are weak. The analysis concerns the decision at hand; information can have additional reusable value, but name that benefit instead of assuming unlimited future usefulness.

## Reference

- Heckerman, Horvitz, and Middleton, value of observations: https://www.erichorvitz.com/nonmyopevi.htm
