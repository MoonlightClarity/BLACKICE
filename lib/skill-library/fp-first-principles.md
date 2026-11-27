# First Principles Reasoning

Use first-principles reasoning to explain an unfamiliar mechanism, diagnose a persistent failure, challenge an inherited assumption, or compare competing designs across domains. Select a small set of relevant methods and use them to complete the task.

## Start with the actual question

Restate the required result and the constraint that makes the question difficult. Use the user's current objective and corrections. A proposed implementation is a candidate, not automatically a requirement: distinguish "run this model locally" from "run it through this backend." Preserve an explicitly required implementation. For a routine lookup or obvious edit, act directly; do not add a reasoning worksheet.

## Rebuild a useful model

1. **Choose the boundary and representation.** Name what is inside the system, the time horizon, and the observable input and output. Use an equation for quantities, a state machine for transitions, a causal graph for interventions, or a table for alternatives. Include only detail that changes the answer.
2. **Classify the premises.** Separate definitions, mathematical relationships, observations, established empirical findings, and assumptions. Explain why each consequential premise applies here. A customary workflow, benchmark claim, price, regulation, or model capability is not a physical law. Retrieve current authoritative evidence when its validity matters.
3. **Reduce the mechanism.** Identify the entities, resources, transformations, dependencies, and constraints that generate the result. Build the simplest model that preserves the relevant distinctions. Account for units, conserved quantities, nonlinearities, incentives, information gaps, and boundary conditions where they matter.
4. **Generate alternatives from the mechanism.** Change a binding constraint, representation, interface, or sequence. Keep the current approach as a baseline. Explain what each alternative would change and what remains unchanged. Transfer an analogy only after mapping its relationships and identifying where they fail.
5. **Find the decisive unknown.** Locate the assumption whose plausible variation changes the recommendation. Derive a threshold or a prediction that distinguishes competing explanations. Prefer a small comparison that resolves the choice over collecting more undirected observations.
6. **Act and check.** Perform the authorized calculation, source inspection, experiment, implementation, or other next action. Compare the result with the predicted observations. Repair the model when evidence disagrees; retain contradictions instead of explaining them away. Continue toward the requested deliverable.
7. **Report the supported result.** Give the answer or work product, the key premises and evidence, the material uncertainty, and the check that supports the result. A method being available or followed does not establish that its conclusion is correct.

## Select methods by the difficulty

Start with one domain method. Add one or two foundational methods when they resolve a concrete difficulty. Read additional bodies only when needed; do not load the whole library or complete every method serially. Search the native skill catalog and read the returned ID using the advertised tool schema. These are native IDs, not file paths or commands.

| Difficulty | Useful native skill IDs |
| --- | --- |
| Inherited approach seems unavoidable | `library-fp-decompose-first-principles`, `library-fp-track-assumptions` |
| Requirements conflict | `library-fp-reconcile-constraints`, `library-fp-expose-tradeoffs` |
| Magnitude or feasibility is unclear | `library-fp-estimate-scale`, `library-fp-check-dimensions` |
| Evidence supports several explanations | `library-fp-compare-hypotheses`, `library-fp-design-discriminating-test` |
| An intervention is claimed to cause improvement | `library-fp-reason-interventions`, `library-fp-design-experiment` |
| Data may misrepresent the target population | `library-fp-audit-selection`, `library-fp-define-measurement` |
| A decision depends on uncertain inputs | `library-fp-test-sensitivity`, `library-fp-value-information` |
| Inference quality changed after conversion | `library-fp-isolate-model-runtime-failures`, `library-fp-analyze-quantization-error` |
| A model does not fit in memory | `library-fp-calculate-memory-liveness`, `library-fp-budget-context-and-kv-cache` |
| Retrying or concurrent actions corrupt state | `library-fp-recover-idempotent-effects`, `library-fp-model-concurrent-interleavings` |
| A release appears to lose changes | `library-fp-reconcile-version-lineage` |
| A physical prediction seems inconsistent | `library-fp-model-conservation-networks`, `library-fp-test-limits` |
| A business grows without producing cash | `library-fp-unit-economics`, `library-fp-cash-timing` |
| People optimize a metric instead of the goal | `library-fp-incentive-design`, `library-fp-metric-gaming` |
| A policy or product feature fails in use | `library-fp-policy-mechanism`, `library-fp-user-task-model` |

## Worked example: local inference

A hypothetical 1.5-billion-parameter model uses 3 billion bytes for 16-bit weights alone: parameter count multiplied by two bytes. That is neither total peak memory nor a prediction of task quality. Add the actual vision components, KV cache, temporary allocations, and runtime overhead without double-counting shared weights.

If a quantized build loses accuracy, distinguish quantization error from conversion, tokenization, preprocessing, and backend computation. Compare the same checkpoint and task at matched precision across backends, then vary precision with other inputs held constant. Inspect the earliest reproducible numerical or task-level difference. A smaller unquantized model is another design option, but it does not isolate the cause because model architecture and training also changed.

The deliverable is a measured feasible configuration and a supported explanation of the failure, or a bounded comparison that identifies the next decisive test. A list of speculative backends is insufficient when the task requests a working implementation.

## Transfer without overclaiming

After a successful case, retain a reusable trigger, mechanism, boundary, and independent example. Keep the rule narrow enough that a counterexample could disprove it. Use procedures as aids to judgment; do not turn them into extra permission requirements or claim measured reasoning gains without evaluating actual outputs.

## Reference

[Mahajan, Street-Fighting Mathematics, MIT OpenCourseWare](https://ocw.mit.edu/courses/18-098-street-fighting-mathematics-january-iap-2008/pages/syllabus/) introduces dimensional analysis, limiting cases, approximation, and related tools for constructing tractable models. The task procedures and examples above are original.
