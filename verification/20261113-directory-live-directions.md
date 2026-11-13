# Directory live directions

Base: b379656 (2.39.80).
Observed defect: the parent remains main-opening while Directory disposable child sessions run. Parent pendingDirections was queued, but Chat only checked delivery==='queued' and displayed "Direction delivered" for queued:true.

Fix: private run/node Directory router tracks phase identities without assigning parent resume IDs. Active targets receive live directions through the existing runtime steer method; opening targets wait for IDs. Claims persist before dispatch, duplicate/race events do not replay attempts, and abort/closed/replaced phases are checked after persistence. Provider queued, rejected, uncertain and acknowledged outcomes remain distinct. Later phases still receive accepted user context through the existing authoritative context path.

Verification: native Node focused run 83 passed, zero failed (including serialized in-flight attempt recovery: uncertain, no replay):
- directory-directions.test.mjs
- directory-modes-engine.test.mjs
- next-context-controls.test.mjs
- model-switching.test.mjs

Coverage includes current-child routing, opening/parallel ID races, provider queue acknowledgement, mismatched receipt, persistence failure, cancellation during persistence, no duplicate delivery and rendered queue/uncertainty messages.
No live job-search interaction, real submissions, installed hotpatch, provider efficacy trial or full-suite claim. Runtime acknowledgement does not prove the model followed the direction.
