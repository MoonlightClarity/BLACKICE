# Model Conservation Networks

Use this method when quantities move through a system and the explanation must account for where they come from, go, or accumulate. Choose a boundary and conserved quantity before fitting a trend or optimizing a component.

## Primitives

Identify the control volume, quantity stored, inflows, outflows, internal transformations, units, and time interval. For a strictly conserved quantity, internal transformations cannot create net total quantity. Species, inventory categories, or work items may have genuine generation and consumption terms even when a broader total is conserved.

## Procedure

1. Define the system boundary and the quantity being counted. Mass, energy, electric charge, and item counts have different conservation claims; do not transfer one law by analogy alone.
2. List every crossing of the boundary, including returns, leakage, waste, recirculation, and delayed transfers. Keep internal flows separate so they cancel when compartments are combined.
3. Write accumulation = inflow - outflow + generation - consumption for the selected quantity. Set generation or consumption to zero only when justified by the physical or accounting model.
4. Convert all terms to compatible units and time boundaries. Distinguish a stored amount from a flow rate, and distinguish volume flow from mass flow when density changes.
5. For a network, write one balance per relevant compartment and check the combined system. A valid local transfer must leave one compartment and enter another consistently.
6. Use initial conditions and measurements to solve for the unknown. If the balance fails, compute the residual and compare it with measurement uncertainty before inventing a hidden mechanism.
7. Check limiting cases: no inflow, closed outlet, steady state, or zero storage. These often reveal a wrong sign, missing term, or unjustified steady-state assumption.
8. Test the proposed explanation with a measurement at the boundary most likely to resolve the residual.

## Worked example

A tank receives 5 kg/s and discharges 3 kg/s. With no other mass transfer, stored mass rises at 2 kg/s, so it gains 120 kg over one minute. Observing only 90 kg gain leaves a 30 kg residual. Possible explanations include an unmeasured outlet, timing mismatch, or measurement error. Declaring steady state would erase the very accumulation the observations require.

## Output and check

Return the boundary diagram or table, balance equations, unit conversions, solved quantities, residual, and evidence supporting each flow. Show that internal transfers cancel in the system total. Keep measured values distinct from inferred values introduced to close the balance.

## Failure boundary

Not every useful quantity is conserved. Information, economic value, entropy, and task quality require their own models; a mass-balance analogy cannot establish their laws. Even mass-flow shortcuts such as equal inlet and outlet rates require the relevant steady-state assumptions. Preserve accumulation when the process is transient.

## Reference

- [NASA: Conservation of Mass](https://www1.grc.nasa.gov/beginners-guide-to-aeronautics/conservation-of-mass/)
