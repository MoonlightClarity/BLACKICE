# Define the Measurement

Specify how an abstract property becomes an observation. Use this before interpreting benchmarks, comparing performance, optimizing a metric, or deciding whether a requested outcome was achieved.

## Primitives

- A construct is what matters; a measurement is the procedure used to observe it.
- A proxy can correlate with the construct while failing under optimization or changed conditions.
- Precision, repeatability, and validity are different properties of a measurement.

## Procedure

1. Name the property and the decision it informs. State what an increase or decrease would mean in the user's task.
2. Define the observable event, unit, denominator, population, start condition, and end condition. Include how missing, failed, repeated, or unfinished cases are counted.
3. Describe the collection path: instrument, log, evaluator, timestamp, sampling method, or human judgment. Identify possible delay, bias, resolution limits, and interference.
4. Check a known case or independent measurement. Confirm that the procedure detects a meaningful difference and does not merely repeat a self-reported success claim.
5. Select an aggregation that answers the question. Distinguish typical from tail behavior, per-case from per-user averages, and task success from successful tool calls.
6. Apply the measurement consistently and retain enough raw evidence to explain a surprising result. Revise the metric if it rewards behavior that does not produce the intended outcome.

## Worked example

“Startup takes ten seconds” is ambiguous. Define start as the operating system launching the process and end as the first successful response to a specified user interaction. A visible window is an intermediate event.

Collect both window-visible and interaction-ready timestamps across repeated cold starts. If the window appears after three seconds but the interaction succeeds after ten, report those two measurements separately. Exclude unrelated background work only through an explicit boundary, and describe machine load when it materially affects the comparison.

If one run never becomes responsive, do not omit it from the success count or pretend it had the mean duration. Record failure and the observation window.

## Check and output

Produce a measurement definition another operator could apply, a known-case check, the observed result, and the main limitations. Check that the denominator includes the cases implied by the claim and that the chosen endpoint matches the user's outcome.

## Failure boundary

Do not turn every task into a benchmark project. Use the smallest observable that distinguishes completion or the relevant difference. A reliable instrument can measure the wrong construct perfectly; improving precision cannot repair a proxy that no longer represents the objective.

## Reference

- NIST, measurement process characterization: https://www.itl.nist.gov/div898/handbook/mpc/mpc_d.htm
