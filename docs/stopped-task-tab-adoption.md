# Stopped-task tab adoption

> Status: Implemented in published 2.40.75. Source regressions cover ownership checks; the release's native smoke tests did not exercise end-to-end stopped-task adoption.

The model can use `take_ownership` for another task's tab after that task has stopped and settled. It must supply `expectedOwnerKey` from `ownershipCandidates`, plus the observed URL and document identity. Candidate eligibility is advisory; durable effect history and ownership are rechecked at dispatch.

The existing browser page and unsent form state are preserved. Adoption does not navigate, reload, close, submit, or repeat an operation. Child tabs retain their previous ownership and are detached from the adopted parent. The transfer receipt records the previous and new owners and the source run.

Active, queued, paused, awaiting-input, unsettled, or unknown owners are not eligible. A historical restart is not an active run. A missing run is not evidence that it stopped. Human-retained, reserved, protected, busy, downloading, or actively dispatching pages remain protected. Historical uncertainty is preserved and exposed as inheritedEffects on the adopted tab and transfer receipt, not treated as a blanket veto. Native and planning effect journals are read without clearing their records; unavailable history is explicitly marked unknown. Capacity and cancellation still apply.

Lifecycle is checked again after asynchronous effect verification. The final check and ownership mutation are synchronous on the host event loop, serialized with browser operations. A resumed source task either becomes active before that check and blocks adoption, or resumes afterward and finds that it no longer owns the adopted tab. Concurrent adopters cannot both acquire the same observed owner.

Same-conversation continuation remains supported without adoption. If adoption is unavailable, the model should open its own tab and continue independent authorized work instead of stopping all research.

Unknown owners, including connection-owned tabs with no engine run, retain their existing explicit transfer path. A settled shared conversation can transfer when no engine run or direct action is using it. Prior restart or uncertain effects are not declared resolved: adoption only changes ownership. Existing effect-conflict protections remain in place, and the new owner must inspect outcomes before repeating a possible submission.
