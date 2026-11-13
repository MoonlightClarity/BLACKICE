# BLACKICE 2.39.75

This release combines Directory, Storage, Goal tool exposure, and repository completion hardening. It retains the persistent Goal mode and conversation browser tabs introduced in 2.39.74.

## Changes

- New Directory histories use `.blackice/directory/<conversationId>` instead of the historical `.shadowdancer` default. A persisted conversation location is shared by writing, context reads and imports, rebuilds, and continuation. Existing histories remain in place; this release does not migrate or delete them. Custom locations are supported by the resolver, not a new graphical location picker.
- Directory Context uses the shared BLACKICE theme rather than a separate dark-blue palette.
- Storage shows individual managed workspace items and allows selected cleanup rather than treating the entire workspace as one deletion target. Consent is bound to the preview snapshot. Linked, unsupported, protected, and externally managed paths remain excluded from cleanup.
- Native Goal tools use the expected dynamic tool catalog format, with protocol regression coverage.
- Repository completion distinguishes unknown requirement mapping from demonstrated implementation failure. Report revision can use typed host-owned evidence without treating model prose as host-observed test results.

## Verification scope and limits

Release verification records source tests, rendered controls, and exact installer checks separately. Synthetic tests are not evidence of an unattended live benchmark or a completed real job-search run. The completion changes address reproduced evidence and report-revision boundaries; they do not establish that every model will satisfy every task or eliminate all possible completion failures.

BLACKICE continues to ship an unsigned Windows installer. Windows has not verified a publisher identity.
