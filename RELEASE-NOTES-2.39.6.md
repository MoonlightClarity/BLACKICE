# BLACKICE 2.39.6 — Interrupted-task recovery and bounded history

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
