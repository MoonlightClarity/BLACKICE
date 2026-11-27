# Decompose from First Principles

Replace an opaque conclusion with a small model whose parts and relationships can be checked. Use this when convention, analogy, an existing implementation, or a product label is carrying too much of the argument.

## Primitives

- Definitions fix meanings; observations describe cases; mechanisms connect changes; assumptions fill gaps.
- A constraint is a limit on feasible behavior. A current design choice is not automatically a constraint.
- Decomposition must preserve the interactions needed to reconstruct the whole.

## Procedure

1. Name the requested result and the claim that currently limits it. Write the claim precisely enough that a counterexample could matter.
2. Separate definitions, measured facts, established domain knowledge, design choices, and assumptions. Do not call an unsupported premise a first principle.
3. Identify the smallest components and interactions that determine the result. Select a representation that exposes those interactions: equations for quantities, graphs for dependence, state transitions for behavior, or geometry for spatial constraints.
4. Reconstruct the conclusion from those components. Give every important connection a mechanism or evidence source. Leave unexplained links visible.
5. Vary a design choice while holding actual constraints fixed. Derive an alternative and check whether it preserves the requested behavior.
6. Test the reconstructed model on one known case and one boundary case. Use discrepancies to revise the decomposition, then execute the next useful comparison or implementation step.

## Worked example

Suppose an application is said to require a particular inference backend because its model is available in that backend's file format. Decompose the requirement into model architecture, tensor values, tokenizer, image preprocessing, generation rules, memory, and executable kernels.

The file format is a representation choice. Correctly computing the architecture with available memory is a real requirement. An alternative backend is feasible only if it can represent those tensors and execute the required operations, including image handling. Matching the parameter count alone proves little. The next useful test is a small fixed input with comparable intermediate or final outputs across implementations. Conversion success is an intermediate observation, not equivalent behavior.

## Check and output

Produce the primitive facts, relationship model, derived conclusion, and one actionable test or alternative. Check that recombining the parts explains the original behavior and that each alleged hard limit has a stated basis.

## Failure boundary

First-principles reasoning does not mean rejecting accumulated empirical knowledge or reinventing every lower layer. Stop decomposing when another layer cannot change the decision. Do not replace a measured constraint with a more appealing assumption merely because the assumption produces a simpler story.

## Reference

- NASA, logical decomposition and design solutions: https://www.nasa.gov/reference/4-0-system-design-processes/
