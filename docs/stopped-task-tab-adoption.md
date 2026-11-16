# Stopped-task tab adoption

> Status: Current source behavior on this feature candidate, not proof of release or installation.

The model can use `take_ownership` for another task's tab after that task has stopped and settled. It must supply `expectedOwnerKey` from `ownershipCandidates`, plus the observed URL and document identity. Candidate eligibility is advisory; durable effect history and ownership are rechecked at dispatch.

The existing browser page and unsent form state are preserved. Adoption does not navigate, reload, close, submit, or repeat an operation. Child tabs retain their previous ownership and are detached from the adopted parent. The transfer receipt records the previous and new owners and the source run.

Active, queued, paused, awaiting-input, unsettled, unknown, or restart-interrupted owners are not eligible. A missing run is not evidence that it stopped. Human-retained, reserved, protected, busy, downloading, or uncertain-effect pages remain protected. Native and planning effect journals are read without clearing or transferring their records. Capacity and cancellation still apply.

Lifecycle is checked again after asynchronous effect verification. The final check and ownership mutation are synchronous on the host event loop, serialized with browser operations. A resumed source task either becomes active before that check and blocks adoption, or resumes afterward and finds that it no longer owns the adopted tab. Concurrent adopters cannot both acquire the same observed owner.

Same-conversation continuation remains supported without adoption. If adoption is unavailable, the model should open its own tab and continue independent authorized work instead of stopping all research.

Shared conversation owners and unknown owners, including connection-owned tabs with no engine run, require their existing explicit transfer path. Restart-interrupted history stays protected rather than being silently declared safe. The original task may continue using its tabs or explicitly transfer them after reconciliation.
