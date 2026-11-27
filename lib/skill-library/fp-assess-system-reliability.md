# Assess System Reliability

Use this method when a system depends on several components or a redundancy proposal claims to prevent failure. Define exactly what counts as system failure, then derive it from the dependency structure and shared causes.

## Primitives

Identify the required function, mission interval, component failure events, dependency graph, repair behavior, switching behavior, and common causes. Reliability over an interval is the probability of completing that interval without the defined failure. Availability concerns whether the system is operational at a time or over time, including repair.

## Procedure

1. Define the system-level success condition and relevant interval. A component can fail without system failure if the required function remains available through another path.
2. Build the failure structure. In a series dependency, every required component must work. In a parallel arrangement, at least one adequate path must work. Include switching and coordination components.
3. Determine which events can reasonably be treated as independent. Shared power, software, configuration, environment, operator action, and maintenance can create common causes.
4. Under justified independence, multiply component reliabilities for a series system. For independent parallel components, multiply their failure probabilities to obtain the probability that all fail.
5. Add shared dependencies explicitly rather than hiding them inside an independence assumption. Examine the failure combinations that defeat the required function.
6. Use failure data with the correct exposure, censoring, and operating conditions. Distinguish a modeled probability from an observed rate or a claim based on no observed failures.
7. Compare interventions by the failure mechanism they remove. Independent power may improve resilience more than duplicating another process on the same machine.
8. Verify the actual failover or recovery behavior where it matters. A redundant component that cannot receive work under failure does not provide the modeled protection.

## Worked example

Two independent components each have a 0.01 probability of failing during a specified interval. If either alone can provide the required function, their joint failure probability is 0.0001 under independence. But if both require a shared power source with failure probability 0.02, overall failure cannot be below that shared event. Duplicating the components again does not remove the power dependency.

## Output and check

Produce the success definition, dependency diagram, assumptions, calculation, dominant failure combinations, and evidence for the proposed improvement. Report whether the result concerns first failure, continuous availability, or recovery time. Verify the assumptions most responsible for a large claimed benefit.

## Failure boundary

Independent failure formulas are wrong when common causes dominate. Component reliability figures from different conditions or intervals cannot be multiplied without reconciliation. Zero observed failures does not establish zero risk. Do not turn this analysis into an unrelated approval ritual; use it to identify the concrete engineering change that improves the required behavior.

## References

- [NIST: Series model](https://www.itl.nist.gov/div898/handbook/apr/section1/apr182.htm)
- [NIST: Parallel or redundant model](https://www.itl.nist.gov/div898/handbook/apr/section1/apr183.htm)
