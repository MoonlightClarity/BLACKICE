# Analyze Computational Complexity and Scale

Use this method when a solution works on a small example but may fail at realistic size. Identify the quantities that grow and derive their effect on time, memory, and data movement before extrapolating.

## Primitives

Record input dimensions, data distribution, dominant operations, storage, fixed costs, and the range of intended use. Distinguish worst-case, average-case, amortized, and observed cost. The symbol n is useful only after specifying whether it means records, tokens, pixels, vertices, or something else.

## Procedure

1. Define the actual scale variables. A graph may depend on vertices and edges; a matrix operation on three dimensions; an image model on both patch count and sequence length.
2. Count dominant work from the algorithm's structure. Nested loops, repeated scans, sorting, pairwise comparisons, and retained intermediates provide candidate growth terms.
3. Derive memory separately. Streaming can reduce retained state while preserving total work; caching can trade memory for repeated computation.
4. Include fixed setup and important constants for the relevant range. A method with better asymptotic growth can still be slower below its crossover point.
5. Measure several sizes spanning a meaningful range with comparable input structure. Compare observed ratios with candidate models and inspect residuals rather than fitting one attractive curve.
6. Examine adversarial or unusually dense inputs when they affect the requirement. Random inputs may never exercise the expensive branch.
7. Forecast the next target scale with a range and stated assumptions. Check whether cache, memory capacity, parallelism, or I/O boundaries introduce a regime change before that target.
8. Choose the change that alters the binding growth term: indexing, avoiding repeated work, reducing candidate pairs, streaming, or using an appropriate algorithm. Verify output equivalence.

## Worked example

An implementation compares every pair of n items. Its pair count is n(n-1)/2. Increasing n from 1,000 to 10,000 raises pairs from 499,500 to 49,995,000, about 100 times. A tenfold extrapolation from input count would badly underpredict work. An index that limits each item's candidates can change observed scaling, but its guarantee depends on data distribution and index behavior.

## Output and check

Produce the scale variables, derived work and memory expressions, measured points, plausible cost model, and target-size forecast. Identify which assumptions are mathematical properties of the algorithm and which are empirical properties of the workload.

## Failure boundary

Big-O hides constants and does not predict exact runtime. A fitted exponent over a narrow range is not proof of an algorithmic bound. Output size can itself impose a lower limit: producing every pair still requires quadratic-sized output even if candidate discovery becomes faster. Validate the required result before celebrating reduced work.

## Reference

- [MIT: Introduction to Algorithms](https://ocw.mit.edu/courses/6-006-introduction-to-algorithms-spring-2020/)
