# Reason About Cache Validity

Use this method when a system reuses an old result, repeats expensive work unnecessarily, or behaves differently after clearing a cache. Define the equivalence relation that makes reuse correct before selecting an expiration strategy.

## Primitives

Identify the cached value, producer, complete semantic inputs, dependency versions, consumer, scope, freshness requirement, and refresh behavior. A cache key claims that two requests are equivalent for the cached result. Time-to-live limits age; it does not by itself prove semantic equivalence.

## Procedure

1. State what the cached object represents. Separate compiled code, parsed metadata, model weights, generated responses, and user-visible state because each has different dependencies.
2. List every input capable of changing that object. Include artifact identity, configuration, preprocessing, schema, account scope where relevant, and dependency content.
3. Derive a key from those inputs or an authoritative generation/version identifier. A path or model name can identify a location without identifying its current content.
4. Define validity independently from key equality. Some values require revalidation, a freshness bound, or invalidation after a mutation.
5. Trace invalidation through dependent caches. Changing a source may invalidate a parsed object, an index, and a derived result; invalidating only the final display can leave stale intermediate state.
6. Inspect concurrent refresh. Ensure an older refresh cannot overwrite a newer generation, and decide whether callers may use the previous value while refresh proceeds.
7. Test one meaningful dependency change and one irrelevant change. The first should invalidate or revalidate; the second should preserve useful reuse.
8. Measure cost and hit behavior after correctness is established. Cache clearing is a diagnostic intervention, not a complete explanation or permanent repair.

## Worked example

A model preprocessing cache is keyed by model name and image path. The tokenizer or image processor changes while the names stay constant. Reused entries now correspond to a different transformation. Adding the relevant processor revision and image content identity distinguishes the inputs. Including an unrelated window position would only reduce hit rate without improving correctness.

## Output and check

Return the dependency list, semantic key, validity rule, invalidation events, and concurrent-refresh policy. Verify that changing a relevant input changes the resulting cache identity or triggers supported revalidation. Record whether the observed repair addresses one stale entry or the general invalidation path.

## Failure boundary

No finite time-to-live guarantees correctness for a value that must reflect a mutation immediately. Conversely, immutable content-addressed objects do not need repeated expiration merely because time passed. HTTP cache rules apply to HTTP semantics; transfer their distinction between identity, freshness, and validation without assuming every application cache uses identical headers or behavior.

## Reference

- [IETF RFC 9111: HTTP Caching](https://www.rfc-editor.org/rfc/rfc9111.html)
