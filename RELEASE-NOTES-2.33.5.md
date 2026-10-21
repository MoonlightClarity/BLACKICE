# BLACKICE 2.33.5: durable history and release reliability

## Reliability fixes

- Apply the 1,000-job admission limit to unfinished work. Completed receipts no longer prevent new authorized actions after a lifetime total of 1,000 jobs.
- Keep terminal job metadata in memory and load full receipts only when requested. Status, job listings, revocation, and restart readiness no longer copy completed action payloads.
- Build public job listings from one consistent metadata snapshot so concurrent admissions cannot duplicate or omit rows between internal pages.
- Preserve exact retry identities and the original version-1 receipt files. Validate hydrated receipts against their indexed hashes. A missing, changed, corrupt, or uncertainly written receipt blocks new actions until storage recovery; work is never automatically replayed.
- Keep cancellation available for an authenticated owner's active work when receipt storage fails. Report an unsaved cancellation request honestly, and retain the executor lease until active work has physically settled during shutdown.
- Retain sanitized native restart, window reopening, lifecycle-request, and desktop-detach failures in support diagnostics.

## Windows packaging and release checks

- Include all desktop runtime JavaScript modules in the installer, including the restart and runtime-record helpers. Bind the same inventory to the application fingerprint so omitted or changed helpers invalidate earlier release evidence.
- Require public installer metadata to match the exact application version and artifact filename. Validate signing policy types and verify the declared signed publisher against the configured publisher.
- Keep explicitly unsigned releases supported under the existing optional-signing policy. Internal application and profile identifiers remain unchanged.
- Update release instructions to the current BLACKICE installer commands and paths. Correct navigation/startup test fixtures and the new connector setup surfaces to follow the existing visual system.

## Compatibility and verification

Existing connection grants, profile data, and receipt formats are retained. The metadata index and startup validation still grow with retained history; this change does not introduce automatic receipt deletion or a constant-memory disk index.

Use the accompanying candidate verification report for actual test and packaging results. Public distribution still requires evidence for the exact installer, installation and shortcut integrity, profile backup/restore, and diagnostics redaction. Building an installer does not publish it or establish those remaining results.
