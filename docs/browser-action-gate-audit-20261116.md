# Browser action gate removal audit, 2026-11-16

Base: 30c4a7f7d5ec75d32f924399daa9af3e56620d93 (.101). Isolated candidate only; no installed app or live task changed.

## Verified restrictions removed
- Application-specific pre-dispatch history gate, including its implementation. No runtime checks, reservations or reconciliation through it remain. Existing history files are untouched. Historical parsers remain available but do not authorize actions.
- Independent native browser generic effect veto: explicit new calls are no longer blocked by old claims, another task's effect, unknown outcomes, duplicate destination/payload or failed receipt storage. No replacement approval is requested.
- Receipts remain observational: native request/response evidence and caller interpretations are distinct; a successful tool return does not invent external acceptance.
- Same call-ID transport recovery returns saved results without replay; changed arguments under the same ID remain invalid. Cancellation remains respected. Explicit new calls can dispatch again, including potentially duplicate submissions.

## Attribution and evidence
The application gate originated in commit 65c3d1d436bf72dbce7f82e17b0c8cc966cf6b19. It classified ATS URLs and submit labels, scanned loose application/history files and legacy registry claims, and threw APPLICATION_HISTORY_* before input. This was deliberate app logic, not missing Chromium support.
The generic guard was independent of Planning mode. It fenced repeated unknown effects and could request native owner review.
A historical report described rejected clicks, but the raw rejected tool responses and error codes were not independently recovered. The exact rejection cause therefore remains unproven; a later narrative is not a captured dispatch trace.

## Separate capability gaps and remaining boundaries
Source inspection found directory upload rejected (webkitdirectory), native SELECT-only select support, fill type restrictions, compatibility-extension readiness requirements, and a showOpenFilePicker shim rather than full filesystem API. These are capabilities/integration gaps, not application-history policy. No claim of full Chromium parity.
Stale references, changed documents, covered/disabled elements, tab ownership and user cancellation remain existing target/lifecycle behavior. No changes made to these in this patch.
Legacy planning-contract runtime still has its own generic contract/effect constraints; only its application-history gate is removed here. Workspace effect enforcement is unchanged. Consequently this is not a claim that every browser guard across all legacy execution paths is gone.
No browser smoke test, real application, install, release or task replay performed.

## Synthetic validation
Focused receipt/engine/workspace suite: 36/36 passed after preserving passive native evidence notes.
Combined tests include application history parsing, operation descriptors, planning runtime, independent guard, engine, lifecycle and workspace effects. See final2.tap for final authoritative results. Earlier failing runs retained alongside it for provenance.
`nFinal combined result: 152/152 passed; git diff --check clean.

## Degraded receipt storage and replay scope
Pending identities are shared across guards in a weakly registered scope. Saved outcomes use durable lookup; compact identity markers remain while the guard scope lives, so later disk loss cannot turn an identical call into new input. Payloads are not retained in memory. Unsaved identities retain only digest/compact failure metadata while their guard scope lives. At most 32 results of at most 64 KiB each are retained; evicted/oversized results report unavailable without redispatch. Compact identities cannot be discarded while live guards may reuse them; the scope is reclaimed once guards are unreachable. New IDs remain unrestricted. No cross-process/restart guarantee exists when durable receipts could not be saved, nor after the in-memory guard scope has been reclaimed.
