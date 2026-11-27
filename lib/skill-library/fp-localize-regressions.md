# Localize Regressions

Use this method when a behavior worked before and fails now. Convert that history into a controlled comparison that narrows the responsible change. The objective is a causal candidate with a reproducible failure, not a list of suspicious recent edits.

## Primitives

Identify a known-good state, known-bad state, executable predicate, environment, input, dependencies, and measurement noise. “Good” and “bad” describe the selected behavior under the selected conditions. A revision that cannot build is neither good nor bad for a runtime predicate unless buildability is the behavior being investigated.

## Procedure

1. Reproduce the reported defect at the current bad state. Write the smallest observation that distinguishes success from failure, including required output or a meaningful performance threshold.
2. Recheck the good state with equivalent inputs and environment. If it now fails too, investigate changed dependencies, persisted data, hardware, or external services before blaming source history.
3. Separate the changes into candidate dimensions: source, configuration, data, dependencies, build artifacts, and runtime. Hold all but one dimension fixed where feasible.
4. Bracket the first failing change. Use history bisection for a stable transition, or reduce a patch/configuration set when the history is unsuitable.
5. Mark untestable revisions as untestable. Investigate flaky classification with repeated matched runs or a stronger predicate; do not turn inconclusive observations into convenient labels.
6. Inspect the smallest remaining difference and derive a mechanism connecting it to the failure. Test a focused reversal or correction while preserving other current work.
7. Verify the failing case and one neighboring case that exercises the intended new behavior. The candidate fix must remove the defect without silently undoing a requested capability.
8. Record the environmental and artifact identities that made the result reproducible.

## Worked example

Startup rose from 4 seconds to 20 seconds across 32 commits. The same input profile and machine reproduce both endpoints. Bisection narrows the change to synchronous scanning of a large directory before the first usable screen. A focused experiment defers that scan and restores startup while preserving the scan's eventual result. A title change in the same commit is correlated with the regression but has no supported mechanism.

## Output and check

Return the predicate, verified endpoints, narrowed change, causal mechanism, intervention, and observed result. Separate first observed bad revision from proven root cause when several dependent changes remain inseparable.

## Failure boundary

Bisection assumes the chosen predicate has a useful progression through history. Reverts, intermittent defects, changing test infrastructure, or interaction between branches can violate that assumption. Adapt the comparison rather than forcing a single culprit. A large passing test suite does not replace the focused reproducer that defines this regression.

## Reference

- [Git: bisect documentation](https://git-scm.com/docs/git-bisect)
