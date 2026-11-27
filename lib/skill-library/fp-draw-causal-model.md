# Draw a Causal Model

Make proposed causal relationships explicit so that a correlation, comparison, or adjustment can be evaluated. Use this when explaining why an outcome changes or deciding what data would identify an effect.

## Primitives

- An arrow represents a proposed direct causal influence relative to the modeled variables.
- A common cause can create association; a mediator transmits an effect; conditioning on a common effect can create selection bias.
- A graph encodes assumptions. Drawing it does not establish those assumptions.

## Procedure

1. Define the intervention or exposure, outcome, population, and time interval. Name variables precisely enough to distinguish measurements from the underlying constructs.
2. Draw plausible causal arrows using domain knowledge and temporal order. Include shared causes of exposure and outcome, important mediators, and selection into the observed data.
3. Distinguish observed variables from unmeasured ones. Explain uncertain arrows and retain plausible alternative graphs when they imply different conclusions.
4. Trace paths linking exposure and outcome. Identify paths that represent the desired effect and paths that could produce association without that effect.
5. Choose measurements or adjustment variables according to the causal question. Do not automatically adjust for every available variable, especially descendants of the intervention or selection variables.
6. Derive a testable prediction, suitable comparison, or limitation from the graph. If feedback matters, add explicit time indices instead of forcing simultaneous feedback into an acyclic graph.

## Worked example

Suppose slower computers are more likely to receive a new optimization backend. Let C denote computer capability, B backend choice, and L latency. Plausible arrows are C → B, C → L, and B → L.

A raw comparison may show larger latency under the new backend because those computers were slower before installation. Measuring capability, comparing each machine under both backends, or randomizing backend order can address this alternative explanation.

If backend installation also changes batch size, that variable may mediate part of the total effect. Holding batch size fixed answers a different question from evaluating the complete deployed change. The graph helps name that difference before selecting the analysis.

## Check and output

Produce the graph, meanings of arrows, unmeasured variables, intended effect, and the comparison justified by the assumptions. Check temporal order, selection into the data, and whether an adjustment changes the estimand.

## Failure boundary

Do not infer causal direction solely from correlation or a model's predictive importance. A graph with omitted causes can support a wrong conclusion. When several plausible graphs remain, identify conclusions shared across them and the observation that could resolve consequential differences.

## Reference

- Pearl, causal assumptions and graphical models: https://escholarship.org/uc/item/6d71p32b
