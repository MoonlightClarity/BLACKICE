# Outcome-review expectation provenance

The existing outcome assessment may optionally emit up to four compact concerns.
Each records a task clause, explicit/inferred/uncertain basis, counterexample
inputs, expected and observed behavior, probe classification, source identity
claim, admitted evidence references, and proposed/resolved/uncertain status with
a prior concern key and reopening rationale.

This is interpretation metadata, not an additional review phase or an execution
contract. Missing or incomplete concerns do not reject an otherwise valid
assessment. No decision, completion rule, source-edit permission, or task authority
is created by filling in these fields.

Normalization retains only references already admitted by the ordinary assessment
citation machinery. Task-clause substring presence records a textual anchor,
not semantic entailment. Source identity supplied by the model remains a claim.
A host-generated evidence snapshot signature allows later reviews to recognize
identical versus changed evidence; a changed signature does not itself prove a
changed source, fresh defect, or need for repair.

Up to four bounded prior concern summaries accompany the next existing review.
Full normalized details stay in ordinary assessment history. Long fields report
omitted character counts; summaries identify themselves as bounded. Previous
resolutions remain fallible model interpretations, never instructions.

Review guidance distinguishes expected negative-test rejection from unexpected
behavior and malformed probes. It expressly rejects existential assumptions from
universal validation constraints. Reopening a concern should identify decisive
new evidence or a specific flaw in the previous interpretation, not merely cite
the same exception again.

Tests use image validation rather than benchmark-specific assertions. They
verify vacuous universal handling guidance, expected-rejection versus probe-error
classification, admitted reference binding, evidence freshness signals, bounded
history, and ordinary completion without optional provenance. These tests prove
data flow and compatibility, not that every model will reason correctly. A paired
model experiment remains necessary before claiming reduced review drift.
