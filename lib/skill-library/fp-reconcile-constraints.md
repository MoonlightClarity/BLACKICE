# Reconcile Constraints and Feasibility

Turn competing requirements into a concrete feasibility question. Use this when a plan appears impossible, options satisfy different subsets, or a claimed limitation may actually be a preference or design choice.

## Primitives

- Hard constraints define the feasible set; preferences rank choices within it.
- A lower bound can prove infeasibility even before a full solution is built.
- A conflict belongs to a set of requirements and assumptions, not automatically to the user's objective.

## Procedure

1. Express the decision variables and their units. Translate requirements into equalities, inequalities, allowed states, or explicit predicates.
2. Separate user requirements, physical limits, observed resource limits, and preferences. Keep inferred restrictions visible and testable.
3. Construct a candidate satisfying all hard constraints, or derive a lower bound that every candidate must meet. Check coupling between resources instead of assessing each constraint in isolation.
4. If no candidate is found, distinguish search failure from proven infeasibility. Remove one condition at a time or use an appropriate solver to isolate a small conflicting subset.
5. Investigate alternatives that change the mechanism while preserving the outcome: parallelism, reuse, decomposition, scheduling, or another representation. Recalculate the constraints for each.
6. Present the feasible solution or the exact incompatibility. If a requirement must change, identify the smallest relevant tradeoff; do not silently relax it.

## Worked example

A hypothetical job has three serial stages requiring two, three, and one hours. The deadline is four hours away. With unchanged stages, the critical path is six hours, proving the serial plan cannot meet the deadline.

Adding a second worker does not help if every stage strictly depends on the previous result. But inspection may show that two hours of the middle stage can begin from an earlier independent input. Rewriting the dependency graph yields a four-hour critical path. That is a different feasible mechanism, not a relaxed deadline. If the dependency is real and irreducible, the remaining options are faster stages, reduced requested work, or a changed deadline.

## Check and output

Produce the variables, hard constraints, one feasible candidate or a supported conflict, and the consequence of each proposed change. Verify candidate feasibility directly. Report a solver's tolerance or bounded search limits when they affect the conclusion.

## Failure boundary

Do not describe an untested method, unavailable tool, or lack of imagination as a physical impossibility. Conversely, do not promise feasibility because constraints are inconvenient. Approximate numerical satisfaction must not conceal a violated deadline, memory bound, or other discrete requirement.

## Reference

- Boyd and Vandenberghe, convex optimization resources: https://web.stanford.edu/~boyd/cvxbook/
