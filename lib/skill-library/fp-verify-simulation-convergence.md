# Verify Simulation Convergence

Use this method when a numerical simulation supports a scientific or engineering conclusion. Determine whether the implementation solves its stated equations accurately, then determine whether those equations represent the physical situation adequately.

## Primitives

Record governing equations, assumptions, boundary and initial conditions, discretization, grid or time step, solver tolerances, reported quantity, and experimental reference. Separate code verification, calculation verification, and physical validation. Small solver residuals address only part of this chain.

## Procedure

1. Define the quantity used for the decision: peak temperature, integrated force, failure time, or another explicit output. Numerical accuracy can differ substantially between quantities from the same run.
2. Check implementation against a suitable analytical solution, manufactured case, or independently established numerical reference. Compare actual boundary conditions and units.
3. Verify iterative convergence at a fixed discretization. Track both residuals and the decision quantity; a tiny residual does not by itself establish physical accuracy.
4. Refine spatial and temporal resolution in a controlled sequence. Keep other factors fixed and inspect whether the quantity approaches a stable value.
5. Estimate discretization error only when the refinement behavior supports the chosen method. Oscillatory or non-asymptotic changes do not justify a convenient extrapolated answer.
6. Check conservation and known qualitative constraints. Integrated balances can reveal errors that attractive plots conceal.
7. Compare with physical measurements separately, accounting for measurement uncertainty, parameter uncertainty, and mismatch between experiment and simulated conditions.
8. Investigate discrepancies by category: coding defect, incomplete solver convergence, discretization, input uncertainty, or inadequate physical model. Repair the responsible layer and repeat the affected check.

## Worked example

A flow solver's residual falls below its configured threshold on a coarse mesh. The predicted force is 12 units. Two refinements give 9 and 8.3 units while iterative residuals remain small. The solver has converged for each discrete problem, but the force has not yet been established as mesh-independent. Comparing the coarse value directly with an experiment and tuning a physical coefficient could compensate for numerical error rather than improve the physical model.

## Output and check

Return the governing-model identity, decision quantity, solver evidence, refinement table, conservation residual, and physical comparison. State which uncertainty components were estimated and which remain unresolved. Keep numerical convergence evidence distinct from agreement with one measurement.

## Failure boundary

Two codes can agree because they share the same assumption or defect. Agreement with an experiment can arise from compensating errors. A finer grid is not automatically more accurate when boundary conditions, instability, or implementation are wrong. Do not report more numerical digits than the supported accuracy, and do not treat a visually smooth field as convergence evidence.

## Reference

- [NASA: Verification Assessment](https://www.grc.nasa.gov/www/wind/valid/tutorial/verassess.html)
