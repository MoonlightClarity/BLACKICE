# BLACKICE 2.39.7 — Interrupted-task recovery and bounded history

This patch release continues the BLACKICE 2.39 line with recovery of browser tabs stranded by interrupted task workers and fixes for oversized persistent run history.

## Browser ownership and continuity

When a task worker fails or is cancelled, BLACKICE suspends ordinary idle agent tabs and returns their ownership to the user's browser workspace. Tabs the person has interacted with remain visible. Pages with an unsettled interaction, a pending download, or protected content remain held for inspection rather than being reassigned while work is unresolved.

During startup, BLACKICE compares saved tab owners with the actual, loaded run-history records. Only tabs whose owner run is verified **failed** or **cancelled** are reclaimed. Active runs, unknown run IDs, and reserved ChatGPT tabs are untouched. A later agent may explicitly take ownership of a reclaimed tab using its observed URL and document ID. Recovery never replays browser clicks, uploads, form submissions, or other uncertain effects.

The contained browser remains BLACKICE's own browser. The recovery path does not require external Chrome, Work mode, a paid API, or a new approval mechanism.

## Run-history memory and crash recovery

Run history uses bounded event projections while retaining durable conversation messages, task states and planning evidence. Oversized legacy histories are migrated by streaming from a preserved, hash-verified original archive before JSON parsing. Writes use coalesced persistence to avoid retaining many simultaneous large serialized snapshots.

The startup migration boundary accepts already-compacted histories in the safe range instead of repeatedly failing on the next restart when the compact form cannot be reduced further. An original full-history archive is retained rather than overwritten. Completed task effects are not automatically replayed after a crash or restart.

## Testing and release verification

Targeted regressions cover terminal ownership classification, browser handback, guarded future takeover, busy/protected tabs, failure reporting, ownership API compatibility, run-history migration, and repeated startup. Installed application verification and the Windows NSIS installer are separate gates from source-level tests.

This source checkpoint does **not** itself claim a fresh NSIS installer has been installed, its runtime acceptance has passed, or the GitHub release has already been published. The release workflow remains responsible for a matching full-source verification receipt and Windows candidate validation before publication.

## Chat response validation and email sign-in recovery

Final-response validation now distinguishes analytical answers from action plans, preserves bounded coverage evidence, and records transferred browser-tab observations without replaying actions.

Broad job-application requests now activate browser sign-in guidance. Before recording a human sign-in blocker, a task-owned tab receives one read-only, same-origin inspection for an observed email or magic-link alternative. The recovery guidance reuses a single sourced applicant email and scoped mailbox access when authorized, without inventing credentials, bypassing CAPTCHA, or duplicating submissions. Targeted regressions cover these paths; actual site availability remains dependent on the observed page.

## Quiet historical planning notices and compatibility

Historical failed planning cycles no longer leave a generic attention banner above later messages. Active progress and current review/input requests remain visible; archived task evidence is retained.

Startup now recognizes the browser-owner recovery phase. Legacy request receipts preserve their historical replay identity, older task schemas retain their original instruction contracts, and explicitly shared workflows preserve their ownership and dependencies with Planning Off.

The source suite includes native hidden viewport and protocol checks. The explicitly opt-in SMB-share integration fixture requires an owner-supplied share and is reported separately when unavailable.

## Guarded frontend controls

The existing frontend MCP tool now supports document-bound snapshots and guarded click, fill, press, scroll and drag requests while retaining raw CDP access and existing grants. Native Electron verification covers click, fill, clear, keyboard, scrolling, stale-document rejection and snapshot visibility. Native drag remains unverified.

## Installer integrity repair

The packaged planning evidence reference is now explicitly allowed and included in the application fingerprint. Installer integrity still checks every shipped file against reviewed tracked source. This supersedes the unpublished 2.39.6 candidate that was stopped by the integrity gate.
