# Cross-operation requirement attention

> **Status: Engineering reference.** This describes a source implementation or internal contract, **not a guarantee for every installed or published version**. Verify the relevant source revision and release notes before applying operational details. See [documentation map](README.md).

## Observed failure boundary

A public-task invariant remained in the original task and requirement ledger,
but decomposition assigned its ID to mutation/validation leaves only. The
separate leaf owning a query operation lacked that assigned ID. A later source
review described validation globally even though one public operation retained
its old default behavior. Additional targeted assertions covered several other
paths, not that operation/invariant combination.

This is evidence of an applicability/attention gap, not evidence that task text
was erased. The expected query behavior was inferred from a broad invariant,
not stated as an explicit operation-specific exception rule. Do not encode a
benchmark-specific exception or treat grader knowledge as task authority.

## Bounded change

directoryRequirementScope preserves exact IDs/statements for assigned clauses
and lexical all/every/each/any candidates. These appear in existing decomposition,
work, and source-review payloads and saved results. Work on another operation can
see a candidate even when its ID was assigned elsewhere.

Selection is deliberately non-exhaustive and not semantic classification. Quoted
claims, local quantifiers, and irrelevant statements remain unassessed candidates.
Instructions ask the existing worker/reviewer to assess applicability across
owned public operations, including queries, preserve explicit versus inferred
scope, and perform small useful checks. No extra model phase, mandatory mapping,
pass/fail inference, or automatic completion gate is added. The full original
task remains available. Only compact counts and retrieval instructions are mandatory
inline; full clauses use normal lossless evidence packing with exact saved refs
when needed. Scope is recomputed from the supplied run-ledger snapshot. This does
not refresh that ledger from later user corrections: those remain separately
available through existing authoritative context/summary reload and take priority
over this attention index. End-to-end effective-contract freshness is not claimed.

## Verification and remaining limitation

An inventory-domain fixture intentionally assigns a universal identifier clause
only to a mutation leaf. It verifies that the query leaf and existing review
receive its exact unassessed scope, that persisted records retain it, and that
absent test mappings still cannot establish completion. A second fixture checks
quotations and replacement-ledger freshness. Existing repository review and
Directory tests remain passing.

These deterministic tests prove propagation and non-escalation, not that a
specific model will infer the correct semantics or improve a benchmark score.
A fresh paired model trial is still needed before claiming behavioral benefit.
