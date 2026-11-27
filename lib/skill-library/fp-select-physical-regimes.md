# Select Physical Regimes

Use this method before transferring a result between scales or simplifying governing equations. Determine which effects dominate in the actual operating range. A familiar formula remains useful only while its assumptions match the physical regime.

## Primitives

Identify characteristic length, time, velocity, material properties, boundary conditions, geometry, and competing physical effects. Construct dimensionless ratios from the governing balance where possible. These ratios compare mechanisms; they are not decorative numbers added after choosing an answer.

## Procedure

1. State the quantity to predict and the candidate model. List the assumptions that make that model applicable: negligible inertia, constant density, small deformation, uniform temperature, or another specific simplification.
2. Identify terms representing the competing effects in the governing equations or balance. Estimate their characteristic magnitudes with consistent scales.
3. Form ratios of those magnitudes. For fluid inertia relative to viscosity, Reynolds number is rho V L / mu under the conventional definitions.
4. Evaluate the ratios across the operating range, including plausible uncertainty. A ratio near a transition region requires more care than one separated from it by orders of magnitude.
5. Compare prototype and target in geometry, boundary conditions, and the dimensionless groups relevant to the desired result. Matching one group does not guarantee full dynamic similarity.
6. Choose the simplest approximation supported by those comparisons. Preserve effects that can materially alter the decision even if their contribution is small elsewhere.
7. Test a limiting case or obtain a measurement near the disputed regime. Use this to decide between models rather than averaging incompatible formulas.
8. State the range over which the conclusion can be transferred, and identify the first likely regime change beyond it.

## Worked example

A small flow prototype uses the same fluid and speed as a device ten times larger. Reynolds number is then ten times smaller if the characteristic length is ten times smaller. Geometric similarity alone does not preserve the inertia-to-viscosity ratio. Increasing prototype speed could match Reynolds number, but that may change compressibility or other effects. The experiment must match the groups relevant to the claimed result or quantify the mismatch.

## Output and check

Produce a table of effects, characteristic scales, dimensionless ratios, selected approximations, and supported operating range. Explain which comparison justifies dropping each term. Keep measured correlations tied to their original regime and boundary conditions.

## Failure boundary

Thresholds are context-dependent; do not treat one transition value as a universal law for every geometry. Dimensional consistency is necessary but cannot identify a unique physical mechanism. Similar ratios can still conceal different roughness, boundary conditions, or instability. A scale model is evidence only for the aspects of similarity that have actually been established.

## Reference

- [NASA: Similarity Parameters](https://www1.grc.nasa.gov/beginners-guide-to-aeronautics/similarity-parameters/)
