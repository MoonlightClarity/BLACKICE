# Track Consequential Assumptions

Expose the premises that could change the result without turning every missing detail into a blocker. Use this for plans, estimates, diagnoses, and comparisons that depend on facts not yet established.

## Primitives

- An assumption is a premise used provisionally, not a fact made true by repetition.
- Consequence depends on how the premise influences the decision; uncertainty alone does not determine priority.
- Several conclusions can depend on the same premise, so one failed assumption may invalidate multiple branches.

## Procedure

1. State the present conclusion or next action. Work backward to the premises needed for it to hold.
2. Label each consequential premise as observed, derived, stipulated by the user, assumed, or unknown. Attach evidence or the reason for using the assumption.
3. Identify the dependency: what changes if the premise is false? Separate numerical changes from changes that reverse the chosen action or invalidate an outcome.
4. Assign a plausible range or alternative state where possible. Use a qualitative range when numbers would be invented.
5. Check the premise whose resolution has the greatest practical effect relative to cost and delay. Continue independent work and actions that remain useful across plausible states.
6. Update dependent conclusions when evidence arrives. Preserve the previous premise and correction when they explain a changed decision; do not rewrite history as if the fact had always been known.

## Worked example

A proposed service costs a hypothetical $1 per active hour. A task uses 30 active hours monthly, so the estimate is $30. Three premises matter: idle time is unbilled, storage is included, and active capacity is reliably available.

Suppose storage could add $2–$4 but billing all idle time could add hundreds. The billing rule is the priority check. Capacity matters if missed sessions would prevent completing work; it does not need an invented reliability percentage. While checking these premises, an agent can still implement a provider-neutral adapter that remains useful under either billing policy. Once the billable period is confirmed, recalculate the estimate and state which uncertainty remains.

## Check and output

Produce a short table containing premise, status, evidence, consequence if false, and next check. Include only premises that affect the answer or execution. Check that a shared premise has not been counted as several independent reasons for confidence.

## Failure boundary

Do not request confirmation merely because a premise is unknown. Inspect available evidence, make a reasonable assumption where its consequences are limited, and state a conditional result where useful. Do not silently assume away a hard requirement or a material difference in the user's intended outcome.

## Reference

- NASA, assumptions and requirements in system design: https://www.nasa.gov/reference/4-0-system-design-processes/
