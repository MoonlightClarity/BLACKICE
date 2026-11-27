# Balance Thermal Power

Use this method when reasoning about heating, cooling, temperature limits, or why a system initially works and later slows down. Separate the rate of energy input from stored energy and the ability to remove heat.

## Primitives

Identify heat-generating components, power P in watts, thermal capacity C in joules per kelvin, temperature T, ambient temperature, transport paths, and thermal conductance G in watts per kelvin. A lumped model assumes each represented node has approximately uniform temperature and that its chosen properties adequately describe the operating range.

## Procedure

1. Choose the thermal boundary and important nodes. Include the chip, enclosure, heatsink, air, or fluid only at the detail needed to explain the observation.
2. Trace energy inputs and outputs. Electrical power may become heat, useful mechanical work, radiation, or stored energy; do not automatically assign every input watt to one thermal node.
3. Write a storage balance. For one node with constant C and linear conductance to fixed ambient, C dT/dt = P - G(T - Tamb).
4. Derive steady state by setting the storage term to zero. Under those assumptions, temperature rise is P/G. Derive the response time scale tau = C/G separately.
5. Distinguish changes to capacity from changes to conductance. More thermal mass delays heating but does not lower the eventual temperature in this simple constant-power model.
6. Check whether properties and transport remain approximately linear. Radiation, convection changes, fan control, phase changes, and temperature-dependent power may require additional terms or nodes.
7. Compare the predicted transient and steady behavior with measurements. A mismatch can identify contact resistance, sensor placement, changing ambient, or an omitted heat path.
8. Evaluate a proposed change against both peak temperature and response time, then verify under a representative sustained load.

## Worked example

A hypothetical component dissipates 20 W and has conductance 2 W/K to ambient. Its predicted steady temperature rise is 10 K. With thermal capacity 100 J/K, the time constant is 50 seconds. Doubling capacity to 200 J/K doubles the response time but leaves the 10 K steady rise unchanged. Doubling conductance instead reduces the steady rise to 5 K and, at the original capacity, reduces the time constant to 25 seconds.

## Output and check

Produce the thermal network, energy balance, assumed parameters, steady rise, response time, and measured comparison. State whether temperatures are absolute values or differences. Identify the parameter whose uncertainty most affects the design decision.

## Failure boundary

A single uniform-temperature node can hide local hot spots. A cooling rating under one airflow or ambient condition is not automatically transferable to another. Distinguish watts from watt-hours and temperature from heat. A brief successful run establishes only transient behavior unless the system reaches its relevant sustained operating condition.

## Reference

- [Modelica Standard Library: Heat transfer components](https://doc.modelica.org/Modelica%204.0.0/Resources/helpDymola/Modelica_Thermal_HeatTransfer_Components.html)
