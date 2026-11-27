# Derive the User's Task Model

Use this method when a requested feature or proposed interface may be standing in for an unresolved user task. Identify the outcome the user is trying to produce and the information and actions required to reach it. Preserve explicit requirements while improving the implementation that fulfills them.

## Primitives

A task changes an initial state into a desired state under constraints. The user must obtain information, make decisions and perform actions. A feature is one possible means of enabling those operations. The user may already use workarounds, other tools or help from another person.

## Procedure

1. State the task in terms of a completed user outcome. Include the situation, trigger and constraints that determine whether the result is useful.
2. Reconstruct the current workflow from observation, available artifacts or a concrete example. Separate what the user does from what the system assumes they do.
3. Identify necessary information, decisions, actions and dependencies. Mark steps created only by the current interface or organizational arrangement.
4. Examine where the task fails, becomes ambiguous or requires unnecessary work. Describe the mechanism: missing information, incompatible data, unclear state, unavailable action or coordination delay.
5. Generate alternatives that satisfy the same outcome. Keep the user's explicit preferences and constraints in the comparison instead of replacing them with a designer's preferred task.
6. Build or specify the smallest complete flow that reaches the outcome, including the consequential final step and its observable result.
7. Verify the flow using representative task inputs. Check task completion and recovery from likely errors rather than merely checking whether the requested control exists.

## Worked example

A user asks for a dashboard of failed jobs. The practical task is to find the job that requires attention, understand why it failed and resume it without duplicating completed work.

A table with red rows addresses only recognition. Derive the required information: job identity, failure cause, completed effects and available continuation. Derive the actions: inspect evidence, correct the input if needed, resume from a valid point and confirm completion. The dashboard is complete when a user can perform that sequence with a representative failed job. Its visual polish cannot substitute for the missing continuation action.

## Output and check

Return the task statement, current and proposed flow, required information, failure points and observed completion criterion. Check that every proposed feature supports a task step and that no required outcome disappears during simplification.

## Failure boundary

A task model is a hypothesis until grounded in the relevant user's situation. Do not infer needs solely from demographic labels or a generic persona. A user-requested feature remains a requirement unless the user has delegated the choice of solution.

## Reference

[GOV.UK: Learning about users and their needs](https://www.gov.uk/service-manual/user-research/start-by-learning-user-needs) supports grounding needs in evidence.
