# Test Whether Evidence Supports the Claim

Compare a claim with what its evidence actually establishes. Use this when a citation sounds relevant, a test passed, or a local result is being generalized into a broader conclusion.

## Primitives

- Support depends on the relationship between evidence and claim, not the authority of a source alone.
- “Some,” “all,” “can,” “usually,” and “must” impose different burdens.
- An intermediate result can be necessary for an outcome without being sufficient for it.

## Procedure

1. Rewrite the claim as a precise proposition. Identify subject, predicate, population, conditions, time, and quantifier.
2. Summarize the evidence in equally precise terms. Separate observations from the source's interpretation and from your additional inference.
3. Align the two descriptions. Look for changed versions, populations, measurement boundaries, causal language, or stronger quantifiers.
4. Ask whether the evidence could be true while the claim is false. Construct a concrete scenario; if one exists, identify the missing bridge.
5. Supply the bridge through an available check, narrow the claim to the supported scope, or present the additional inference explicitly with its assumptions.
6. Recheck the conclusion after revision. Keep valid partial evidence while removing the unsupported extension.

## Worked example

A parser accepts a new configuration file. The proposed claim is “the application now uses the new configuration.”

The evidence proves that this file is syntactically acceptable to the parser under the tested conditions. It could be true while the application reads a different path, caches an old version, rejects a later semantic condition, or never reaches the loading code. The missing bridge is runtime consumption.

Inspect the running process's resolved path and effective configuration, or exercise behavior that distinguishes old from new values. If that observation succeeds, the broader claim gains support. If only parsing was checked, report precisely that parsing passed and continue the authorized runtime check rather than calling the implementation complete.

## Check and output

Produce the exact claim, supported proposition, missing bridge if any, and corrected conclusion. Check that a negative result is not overstated: failing to find evidence differs from evidence that something does not exist.

## Failure boundary

Demand evidence proportional to the claim. An ordinary reversible action does not require proof against every imaginable failure. Focus on plausible gaps that change the result. Do not turn source limitations into blanket distrust, or use narrower wording to conceal that the user's requested outcome remains unfinished.

## Reference

- NIST, reporting results and uncertainty with sufficient context: https://www.nist.gov/pml/nist-technical-note-1297/nist-tn-1297-7-reporting-uncertainty
