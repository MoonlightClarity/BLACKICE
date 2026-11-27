# Reason About Interventions and Counterfactuals

Define the change whose consequences matter, then determine what the available evidence can say about it. Use this when a decision requires “what would happen if we did this?” rather than a prediction from existing correlations.

## Primitives

- An intervention changes a mechanism or assignment; observing its value is a different operation.
- A causal contrast compares outcomes under defined alternatives for the same target population.
- Identification connects the contrast to observable data through assumptions; estimation calculates it from finite data.

## Procedure

1. Specify the action, comparator, eligible population, outcome, and follow-up interval. Resolve versions of the action that could produce different results.
2. State the contrast: total average effect, effect within a group, direct effect, or a counterfactual for a particular case. Do not substitute one for another.
3. Describe how actions were assigned and outcomes observed. Use randomization evidence or a causal model to identify plausible confounding and selection.
4. Examine whether the comparison requires consistency, exchangeability, overlap, or additional structural assumptions. In practical terms, ask whether the action is well-defined, comparable cases exist, and alternative causes are accounted for.
5. Estimate the contrast using a design appropriate to those conditions. If identification is unavailable, produce justified bounds, scenario results, or a proposed comparison that can resolve the gap.
6. Connect the result to the intended decision. Include uncertainty and the conditions under which the result would transfer to the user's setting.

## Worked example

Suppose employees who voluntarily attend a training session complete tasks faster. The decision is whether assigning the session to all eligible employees would improve completion time over the next month.

Volunteers may differ in motivation or prior skill. The observed volunteer difference is therefore not automatically the assignment effect. Randomly assigning invitations could estimate the effect of that invitation policy. If some invitees do not attend, comparing assignment groups answers the policy question; comparing attendees with nonattendees reintroduces selection unless additional assumptions and methods justify it.

If the user instead asks about the effect of actually attending, name that separate estimand and identify what further information or design is needed. The causal question controls the comparison.

## Check and output

Produce the intervention definition, causal contrast, assignment mechanism, identifying assumptions, estimate or bounds, and decision implication. Check that the comparator is feasible and that outcome measurement is the same across alternatives.

## Failure boundary

A predictive model can forecast outcomes accurately while giving wrong intervention advice. Do not declare causality from temporal order alone. When evidence is incomplete, state a useful conditional conclusion and pursue the decisive comparison rather than converting all uncertainty into a refusal to reason.

## Reference

- Hernán and Robins, causal questions and identification: https://miguelhernan.org/whatifbook
