# Trace Evidence and Provenance

Connect a consequential claim to the observations and transformations that support it. Use this when multiple reports seem to agree, evidence changes over time, or a result depends on an opaque summary.

## Primitives

- An observation is an event or measurement; a report is a representation of it.
- Several reports can share one underlying source and therefore provide less independent support than their count suggests.
- Transformations can change scope, precision, or meaning even when each document appears credible.

## Procedure

1. Extract the specific claim being evaluated. Preserve its subject, quantity, conditions, time, and version.
2. Follow citations, links, identifiers, logs, or artifact references toward the original observation. Stop at the closest accessible primary record and state any remaining gap.
3. Record who observed what, how it was obtained, when it happened, and which exact artifact or population it covers.
4. Group reports by shared origin. Distinguish independent observations, independent analyses of the same data, and simple republication.
5. Inspect transformations that could alter the conclusion: filtering, aggregation, translation, extrapolation, omitted failures, or stale versions.
6. Base the conclusion on the underlying evidence and its scope. Retrieve one missing consequential record or perform an available direct check instead of collecting more copies of the same assertion.

## Worked example

Suppose four articles report that a service completes a task in two seconds. Three link to the same vendor announcement. The fourth describes an independent experiment, but times only the final processing stage.

There are two evidence origins, and they measure different boundaries. The vendor figure may include a demonstration under selected conditions; the independent figure supports a stage-level result. Neither independently verifies the total time for the user's workload. A useful next action is to inspect the original method and run one comparable end-to-end measurement, not count four agreeing headlines.

If the service changed versions after those reports, preserve the historical result while separating it from the current claim. An accurate old observation does not automatically describe the present build.

## Check and output

Produce a short claim-to-source map with original record, event date, version, measurement boundary, transformations, and independence group. Check that each cited item actually supports the nearby claim and that several citations have not become several imagined experiments.

## Failure boundary

Provenance establishes origin, not truth. A primary source can be mistaken, selective, or self-interested; a careful secondary analysis can add value. When the original record is unavailable, use the accessible evidence with a clear scope instead of inventing a source or treating the entire question as unanswerable.

## Reference

- W3C, entities, activities, and derivations in provenance: https://www.w3.org/TR/prov-primer/
