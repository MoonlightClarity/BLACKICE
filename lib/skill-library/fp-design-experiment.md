# Design an Informative Experiment

Choose experimental conditions and measurements that can answer the actual question. Use this before an A/B comparison, a performance benchmark, or a test involving several interacting factors.

## Primitives

- The experimental unit receives a condition; repeated measurements on that unit are not necessarily independent replications.
- Randomization reduces systematic assignment differences; blocking compares conditions within known sources of variation.
- An interaction means the effect of one factor depends on another factor's setting.

## Procedure

1. State the decision, effect of interest, outcome measurement, and minimum difference that would matter. Specify the target workload or population.
2. Identify factors to vary, factors to hold fixed, and nuisance variation such as machine, order, time, or task difficulty.
3. Select a design matching the question: paired comparison, randomized groups, blocks, factorial combinations, or another justified structure. Include relevant interactions instead of assuming isolated factor effects add.
4. Define execution order, resets, controls, replication, failure handling, and raw records. Confirm that the measurement path can detect the relevant difference.
5. Set the intended analysis and stopping rule before inspecting results. Account for sequential monitoring if decisions will be made repeatedly as data arrive.
6. Run the experiment, preserve deviations and failures, and compare the resulting evidence with the planned question. Follow up only on a concrete unresolved effect or design limitation.

## Worked example

Suppose two backends and two numerical precisions are candidates. Testing backend A only at higher precision and backend B only at lower precision confounds the two factors.

Run all four combinations on the same representative tasks, randomizing order within task blocks. Hypothetical times are A/high = 12 seconds, A/low = 10, B/high = 11, and B/low = 6. Lower precision saves two seconds under A and five under B, suggesting an interaction worth checking.

Task quality must be measured alongside speed if correct execution is required. Repeating one easy prompt many times does not establish performance across different tasks. The design should represent both execution variability and the intended task variation.

## Check and output

Produce the factor table, experimental unit, assignment and blocking scheme, measurements, analysis, and stopping rule. Verify that all planned cases actually ran and that failed runs remain accounted for. Distinguish exploratory findings from comparisons specified in advance.

## Failure boundary

A complex design is unnecessary for a question a simple controlled comparison can settle. Randomization does not fix invalid measurement or missing outcomes. Do not choose a favorable subset after seeing results and describe it as the original experiment.

## Reference

- NIST, selecting experimental designs by objective and factors: https://www.itl.nist.gov/div898/handbook/pri/section3/pri33.htm
