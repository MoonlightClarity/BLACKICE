# BLACKICE 2.39.30

## Changes

- Adds owner-scoped task contracts, explicit task-context handles, and semantic outcome evidence for supported direct and native execution paths.
- Preserves canonical plan refinements and prior outcome identity across supported task continuations. Pending or uncertain effects require reconciliation rather than silent duplicate dispatch; deliberate user-directed repeats preserve prior evidence.
- Adds bounded resource-history recall and correlated rejection/receipt alternatives. Missing history remains unknown, not proof that an action never occurred.
- Adds bounded recovery from eligible transient receipt-read failures during direct-job startup. Recovery validates the complete staged inventory before making execution available, retains integrity failures, and exposes safe filename/stage/OS-code diagnostics without raw receipt content.
- Keeps status responsive during subsequent recovery scans; the first initialization still waits for its receipt scan.

## Verification and limits

The locally installed 2.39.30 package was checked against product fingerprint `1c6ed213ebba9802ac9c55e7052f951de90cd8836794bc39a51141822f4b7a75`; connector storage and a harmless browser read succeeded. Publication attaches independently generated Windows release evidence for the published installer. A CI rebuild can differ byte-for-byte from a local installer while preserving the verified product fingerprint; use the published checksums for its exact bytes.

This release does not guarantee external exactly-once effects, completeness of all prior history, or correctness of model judgment. Protected task admission applies only where the supported execution adapter supplies the required task context and host boundary. Unsupported transports are not represented as covered. Startup recovery does not automatically clear integrity failures or replay prior actions. Existing clients may need to refresh their app tool catalog to expose newly available tools.

The Windows installer is unsigned. No operating-system security exclusions are required or configured by this change.
