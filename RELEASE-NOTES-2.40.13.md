# BLACKICE 2.40.13

Status: source candidate. These notes do not establish a local installation or public release.

- Directory now derives blocked dependencies from the recorded prerequisite state. It distinguishes these unperformed steps from actionable work and unresolved effects, and lets a turn report a blocker without marking work complete. Independent alternatives remain actionable.
- The outline shows the upstream action that blocked each dependent step. Maximal receipts record the final decision and counts, regardless of whether a tool was called.
- Turn receipts use a separate read-only endpoint from the editable Directory outline. Receipt depth does not control the action ledger or its decisions.
- This addresses the Directory failure observed after a stale browser reference. It is not a fix for the underlying browser navigation or verification page.
