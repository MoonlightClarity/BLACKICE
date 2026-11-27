# Benchmark Comparable Work

Use this method when choosing between implementations, runtimes, models, or optimizations. Establish that both sides perform the same required work before interpreting a timing difference.

## Primitives

Define task input, required output quality, artifact identity, configuration, execution environment, measurement boundary, warm state, concurrency, and resource use. Distinguish time to first result, total latency, sustained throughput, and successful completions. Faster failures are not throughput improvements.

## Procedure

1. Write the comparison question precisely. A choice for interactive single-user latency may differ from a choice for maximum batch throughput.
2. Freeze representative inputs and the acceptance condition. Preserve image resolution, token counts, output length rules, numerical tolerance, and required side effects where relevant.
3. Record versions, model or data hashes, hardware, precision, thread counts, offloading, and environment settings. Change only the factor under comparison unless the question explicitly compares complete configurations.
4. Define start and stop events. Include preprocessing, transfer, queueing, or startup when they are part of the user's actual experience. Measure component time separately when diagnosing a mechanism.
5. Separate cold and warm conditions. Use representative repetitions, alternate ordering when drift matters, and avoid mixing one side's initialization with the other side's steady state.
6. Validate outputs for every measured configuration. A backend may silently use fewer samples, shorter context, lower resolution, or a fallback algorithm.
7. Report useful distributions or ranges, completed case counts, errors, and resource peaks. Explain excluded runs through a rule established by the experiment, not by whether their results were inconvenient.
8. Interpret differences against measurement noise and practical requirements. Investigate a surprising gain before treating it as a general property.

## Worked example

Backend A processes a screenshot as four high-resolution tiles. Backend B processes one resized image and finishes twice as fast. This establishes the speed of two different pipelines. To compare execution efficiency, match the image representation; to compare practical configurations, test whether both preserve the text needed for the task. A result that loses the decisive label cannot satisfy the same quality constraint.

## Output and check

Return a compact comparison contract, configuration table, completed-work evidence, timing results, quality results, and limitations. Separate estimated resource requirements from measurements. If one configuration cannot complete the workload, record that outcome rather than replacing it with an easier input without disclosure.

## Failure boundary

One synthetic kernel does not establish application performance. A short prompt does not establish long-context behavior, and matching a random seed does not guarantee identical numerical execution. Profilers can add overhead, so use instrumented runs to explain behavior and appropriately measured runs to report user-facing timing.

## References

- [NVIDIA: Nsight Compute Profiling Guide](https://docs.nvidia.com/nsight-compute/ProfilingGuide/index.html)
- [PyTorch: Numerical accuracy](https://docs.pytorch.org/docs/stable/notes/numerical_accuracy.html)
