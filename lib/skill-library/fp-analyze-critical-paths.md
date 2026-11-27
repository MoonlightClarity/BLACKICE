# Analyze Execution Dependencies

Analyze execution dependencies, overlap, queueing, startup and latency to locate the longest necessary path. Derive speedup bounds and distinguish usable completion from early screen display.

## Primitives

Identify the start event, usable-result event, tasks, durations, prerequisite edges, resource contention, and synchronization. Total work is the sum of work performed. The critical path is the longest dependency-constrained path to the result. Parallel tasks can increase total work without increasing latency by the same amount.

## Procedure

1. Define the user's completion boundary. “Window drawn,” “controls usable,” “model loaded,” and “first valid response” are different events. Measure the one the task requires.
2. Build a timeline from observed starts, finishes, waits, and dependencies. Distinguish mandatory prerequisites from operations that happen earlier only because of implementation order.
3. Calculate each task's earliest finish from its duration plus the latest finish among its prerequisites. Trace backward from the result to identify the controlling path.
4. Inspect resource contention. Two independent tasks sharing one saturated disk or GPU may not achieve their isolated durations when run together.
5. Estimate the maximum useful gain from each candidate change. Speeding a task with spare time before its consumer may have no effect on the completion boundary.
6. Consider removing unnecessary dependencies, deferring unrelated work, reducing repeated setup, or overlapping independent operations. Preserve the readiness conditions required for valid actions.
7. For repeated items, separate fixed cost from per-item cost. A model T(n) = a + bn helps compare batching or retained initialization, but include waiting time and memory introduced by the batch.
8. Remeasure the full timeline after the change. A faster first stage can reveal a formerly hidden later bottleneck.

## Worked example

Initialization A takes 3 seconds. It enables B and C, each taking 5 seconds independently. The usable result requires both. Ideal elapsed time is 3 + max(5,5) = 8 seconds, although total work is 13 seconds. Reducing B to 2 seconds leaves C controlling the result, so total time remains 8 seconds. Reducing A to 1 second yields 6 seconds. Making the screen appear sooner does not establish that required controls are ready.

## Output and check

Return the completion boundary, dependency diagram or table, critical path, predicted gain, and observed gain. State where contention or measurement uncertainty changes the simple graph calculation. Identify both the old and new controlling paths.

## Failure boundary

A timeline records what happened; it does not automatically reveal which ordering is necessary. Verify dependency claims against data and resource ownership. Do not remove initialization barriers that protect correctness merely to improve a visual timestamp. A warm retained process and a cold start are separate benchmark conditions.

## Reference

- [OpenCilk: Work, span, and parallelism](https://www.opencilk.org/doc/tutorials/opencilk-concepts/)
