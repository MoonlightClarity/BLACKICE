# Bound the System

Define exactly what the reasoning includes, over what interval, and through which interfaces. Use this when an apparently correct local explanation fails to explain total cost, capacity, behavior, or outcome.

## Primitives

- A boundary separates modeled state from external conditions; it does not make external effects disappear.
- Stocks exist at an instant, flows cross boundaries over time, and interfaces transmit effects.
- A useful boundary is chosen for the question. It need not match an organization chart, file tree, or product name.

## Procedure

1. State the quantity or behavior to explain and its observer. Specify the interval: one request, a complete task, steady operation, or an entire lifecycle.
2. List what can materially contribute to that outcome. Include supporting processes, queues, shared resources, human steps, and external services when they affect the question.
3. Mark each contributor inside the model or external. For every external contributor, state its supplied input, imposed condition, or measured effect.
4. Trace at least one complete path from input to the observed outcome. Record where work, data, money, time, or responsibility crosses the boundary.
5. Test a wider and a narrower boundary. If the answer changes materially, retain the difference explicitly instead of presenting one answer as universal.
6. Choose the smallest boundary that accounts for the requested outcome. Carry the boundary statement into comparisons so alternatives are measured on the same basis.

## Worked example

Suppose a local model has 1.5 billion parameters stored at two bytes each. The weight calculation gives 3.0 GB in decimal units. A device has 4.0 GB available. It is tempting to conclude that inference fits.

The required boundary is a running inference request. Add a hypothetical 0.7 GB cache, 0.5 GB activations and temporary buffers, and 0.3 GB runtime allocation. The estimated peak becomes 4.5 GB. The weight file fits; the modeled request does not. If some buffers are reused rather than simultaneous, measure the actual peak before summing them. If CPU offload is considered, widen the boundary to include transfer time and host memory.

## Check and output

Produce a boundary statement, included components, external inputs, time interval, and one complete path. Check that alternatives use the same measurement boundary and that a consequential interface is not represented as free or instantaneous.

## Failure boundary

Do not expand the boundary indefinitely. Include a component because it can change the answer, not because it exists. A boundary diagram is not evidence of the quantities placed on it. Record measured and assumed values separately, and continue with bounded assumptions where precision is unnecessary.

## Reference

- NASA, system design and logical decomposition: https://www.nasa.gov/reference/4-0-system-design-processes/
