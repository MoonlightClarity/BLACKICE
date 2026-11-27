# Trace Interface Contracts

Use this method when composed software fails despite individually plausible components. Follow a concrete value through interfaces and locate the first boundary where the producer's meaning differs from the consumer's interpretation.

## Primitives

Record the producer, consumer, field name, representation, unit, range, null semantics, identity, ownership, and version. Distinguish the value itself from its serialized form. A field named “timeout” has no complete meaning until its unit, reference point, and treatment of zero are known. An error is also data with a contract.

## Procedure

1. Select one failing input and its expected externally observable result. Assign a correlation identity that survives the relevant boundaries.
2. Sketch the actual path through parsing, validation, adapters, transport, storage, business logic, and presentation. Include generated schemas and background jobs only where the input crosses them.
3. Capture the value immediately before and after each boundary. Use narrow logging or existing traces and avoid printing secrets. Preserve absent, null, false, zero, and empty string as distinct observations.
4. Write the contract on both sides of each boundary. Check units, encoding, enum values, timestamp zones, field renames, defaults, truncation, and whether identifiers belong to the same namespace.
5. Locate the earliest divergence from the intended semantics. A later exception often exposes an earlier conversion defect; do not assume the throwing component created it.
6. Repair the responsible translation or shared contract. When a backward-compatible conversion is required, specify precisely which old input it accepts and how it distinguishes old from new.
7. Exercise the failing value across the complete boundary and one representative edge value. Verify the final effect, not merely that each function accepts the intermediate object.

## Worked example

A caller supplies a timeout of 30 seconds. Its adapter multiplies by 1,000 and sends 30,000. A second adapter assumes incoming values are still seconds and multiplies again. The final timer waits about eight hours. Inspecting only the timer shows a valid positive integer. Tracing value and unit reveals that the second conversion is the first semantic defect. Fix that boundary and verify that 30 seconds arrives as 30,000 milliseconds exactly once.

## Output and check

Produce a short boundary ledger with actual values, declared meanings, and evidence locations. Identify the first mismatch, the conversion rule that fixes it, and the observed end-to-end result. For optional fields, include at least one absent-versus-explicit-value check when that distinction caused the problem.

## Failure boundary

Matching field names or TypeScript shapes does not establish matching semantics. Do not normalize away evidence before capturing it. When observation itself transforms data, inspect the raw representation at a nearer boundary. A successful isolated mock is insufficient if it bypasses the adapter under investigation.

## Reference

- [Google SRE: Effective Troubleshooting](https://sre.google/sre-book/effective-troubleshooting/)
