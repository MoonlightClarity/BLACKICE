# BLACKICE 2.39.84

## Goal control revision races

- Pause and Resume tolerate a revision increment only when the exact observed goal identity, generation, status, and current run still match. Unrelated telemetry no longer makes the same intent stale.
- Changed goals, replacement runs, and incompatible status transitions remain conflicts. The UI refreshes conflicted state rather than automatically retrying a mutation.
- The direct bridge uses the same observed-intent guard as the UI. Existing effect receipts and pause/resume duplicate protection are unchanged.

## Verification limits

Focused tests and the combined source regression suite are separate from installed live-provider behavior. This release does not resume or retry any real application automatically. Publication and installation require separate verified receipts.