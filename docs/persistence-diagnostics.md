# Local persistence diagnostics

Opt in for one BLACKICE server launch with `BLACKICE_PERSISTENCE_DIAGNOSTICS=1`. The default is off. This instruments specialized browser-settings initialization and saves; other persistence callers can use the same trace helper. It does not change retry delays or write policy.

Records use the existing bounded local DiagnosticsStore (default three 256 KiB segments, 1,000 retained events, 128 pending records) and at most 64 events per operation. No automatic upload is added. Existing user-requested support exports can include these sanitized records. Unset the variable and restart to stop new persistence records; normal bounded retention applies to existing records.

Metadata includes allowlisted operation/phase/roles, elapsed and phase timing, attempt number, process-local sequence, Node error code/errno/syscall, Node/libuv/OS numeric versions and platform. The support envelope carries the application version. Source/destination are semantic roles, never paths. Messages, stacks, credentials, URLs and user content are excluded.

`errno` is the Node-exposed value, not a captured Win32 last-error value. `nativeWin32Error` remains null. A failure records unknown commit outcome, not proof that nothing changed. `rename-reported-success` means the rename promise fulfilled, not fsync/durability, native attribution, or proof about another writer. No antivirus, indexing or sharing-lock cause is inferred. Cleanup failures are separate phase observations and do not revise an already reported rename success.

Instrumentation is best effort. Synchronous and asynchronous sink failures are swallowed, records may be dropped at bounds, and diagnostic failure never changes the original write result or thrown error object. The reusable helper is `createPersistenceTrace(record, operation)`; use its `run` method for measured phases and pass its trace to `renameWithRetry` for individual attempts.
