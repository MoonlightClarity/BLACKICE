# Sequence Decisions to Learn and Preserve Options

Choose an action order that produces the requested outcome while learning before consequential commitments. Use this when some work is reusable, some decisions close alternatives, and information arrives through doing.

## Primitives

- Dependencies constrain order; uncertainty can make one order more informative than another.
- Reversibility concerns actual recovery cost, not whether an action is described as temporary.
- An option has value only if preserving it could improve a later decision within the available time.

## Procedure

1. List the concrete actions needed for the outcome. Mark prerequisites, duration, reusable outputs, and choices that commit resources or exclude alternatives.
2. Identify observations produced by those actions. Ask which uncertain decision each observation could change.
3. Move cheap, discriminating, and useful actions before expensive commitments when the delay is justified. Do not postpone work whose value is robust across plausible results.
4. Parallelize independent actions where ownership and interfaces are clear. Account for coordination and resource contention rather than assuming parallel work is free.
5. Set reconsideration triggers tied to observations or deadlines. Specify what changes after success, failure, or an ambiguous result without preauthorizing unrelated actions.
6. Execute the first ready actions, retain their evidence, and update the remaining order as dependencies resolve. Continue toward the requested result rather than stopping at a sequencing diagram.

## Worked example

Suppose integrating a new inference backend would take five days, while a one-hour compatibility test can reveal whether it supports a required image operation. A one-day provider-neutral interface would be useful under either backend.

Run the compatibility test before committing five days to the backend-specific integration. The reusable interface can begin in parallel if it does not depend on the unresolved operation's shape. If the test passes, proceed with integration. If it fails, inspect whether a small adapter can supply the missing operation; do not assume the entire backend is unusable from one incomplete attempt.

If a delivery deadline is tomorrow, the same five-day path is infeasible regardless of option value. The sequence must respect the actual time available.

## Check and output

Produce an action order, dependencies, reusable work, informative observations, and explicit update triggers. Check that the next action is ready and perform it when authorized. Record what evidence supports each consequential commitment.

## Failure boundary

Do not turn reversibility into an approval ceremony or preserve every option forever. Delaying a decision can itself be costly or irreversible. A useful sequence ends in delivery, with uncertainty resolved only as far as needed to perform and verify the user's requested work.

## Reference

- NASA, iterative design and decision analysis context: https://www.nasa.gov/reference/4-0-system-design-processes/
