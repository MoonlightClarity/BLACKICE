# BLACKICE 2.39.77

## Diagnostic-driven execution hardening

- Count parallel read-only discovery failures as one recovery opportunity instead of prematurely treating a batch as repeated failed recovery. Repeated recovery failures and the hard silent-call cap remain enforced; mutation handling is unchanged.
- Discover conventional named Node tests in test/, tests/, and the repository root, with verification snapshots and coverage bound to the same source.
- Allow report revisions to cite historical host-dispatched command receipts without replaying completed commands or presenting historical stdout as current verification.
- Preserve malformed outcome-review assessments, field diagnostics and usage, and permit bounded review-only correction against the same candidate and evidence. Invalid assessments never become accepted completion by coercion.

## Evidence and remaining limits

Regression tests cover these general mechanisms. The isolated guard-only live trial produced artifacts passing 12/12 machine contract groups and 78/100 structured quality, but selected correct source paths from the outset: read-error recovery was not exercised in that trial. It still stopped on the separately addressed malformed-review path; the exact rejected historical field was not retained by the old implementation. These results do not establish universal correctness, causality, or default-on suitability.

This is an incremental hardening release. Planning/Directory defaults and module pruning are unchanged. Further targeted post-install benchmarks remain necessary. Installer verification is recorded separately by the release workflow.