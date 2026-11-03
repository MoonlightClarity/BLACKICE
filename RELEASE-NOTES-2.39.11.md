# BLACKICE 2.39.11

## Scheduled work recovery

- Reconcile an interrupted scheduler receipt against its exact settled run in saved conversation history. A blocked run is recorded as blocked, releasing the overlap slot without marking the task complete or replaying its effects.
