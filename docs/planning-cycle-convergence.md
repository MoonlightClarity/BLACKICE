# Bounded Planning cycle convergence

Planning's public response parser checks shape, while the host readiness evaluator checks freshness, dependencies and actual evidence. The response runtime must also reject child relationships that cannot be accepted by the host, before recording a provider response as successful.

## Relationships checked before acceptance

- A saved child key keeps its complete original request, including objective, criteria, sources and execution target. A new key is for genuinely different work, not a way to conceal or repeat a failed child.
- A new analytical child cannot repeat the parent's objective under the same normalization used by child admission. Workflow work still belongs to the operational owner; the runtime does not guess routing from keywords or silently change verification requirements.
- Every required terminal child with a captured result source must appear in childResults with its exact key and source ID. This includes failures and cancellations. Optional, pending and missing-source children never require invented results.
- Every supplied aggregation must match a current terminal host child and its captured source. Unrelated source IDs are not interchangeable evidence.

All detected child relationship issues are supplied together to the existing single bounded format repair. The original output and failed attempt remain durable. Repair uses the same captured sources, profile and provider-turn budget. A second invalid output remains failed; the repair limit is not increased.

## Readiness feedback

For a refinement, the host captures stageReview after dependency rebinding and before the new attempt is admitted. It names the previous public response and includes the current authoritative readiness projection. The prompt receives this diagnostic alongside the previous response and actual source records. A format repair preserves that exact snapshot.

The diagnostic is not new evidence. Failed children remain failed and prevent strict dispatch as before, even when their failure is correctly aggregated. The change does not promote unknown facts, forge receipts or erase material limitations.

After child processing, the service refreshes input links and readiness. A parent that is already analysis-ready can return on the final pass even if an optional pending child was visited. Required pending children and genuinely unresolved stages remain bounded by existing pass, recursion and provider-turn limits.

## Historical retry

An explicitly retried stage may already contain a pre-fix response that changed a bound child request. The initial mismatch allows a fresh bounded response attempt, without rewriting the historical response or driving children first. Only after the new response passes validation and the unchanged host binding guard can the service synchronize the original children. Required children remain required even if omitted from the replacement response. Invalid repair, cancellation and exhausted budgets do not authorize child work. Independently stale prerequisite checks still apply.

## Regression coverage

Synthetic tests cover missing failed-child aggregation, simultaneous changed contract and missing aggregation, exact-self recursion, invalid repair exhaustion, optional/pending/missing-source cases, stable ready stages, preserved failed-child dispatch blocks, and final-pass optional versus required children. Historical captured bodies can be replayed offline without provider calls; private task records are never committed as fixtures.
