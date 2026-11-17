# 2.39.102 exact-source validation plan

Status: Reference. Revised retirement source preparation only. Prior 150d76 build and smoke evidence is preserved but does not qualify this revision.

## Source and evidence boundaries

Reviewed integration base: 8286305063c35af6fed2f2842ac162f9ad2019b3. Metadata is isolated from installed .101 and all active work. Preserve the prior owners, commits, logs and action ledger. The startup candidate remains separate pending review; adding it changes the candidate and requires a new source identity.

Existing integration receipts cover 41 tests plus hidden Skills/embedded Knowledge and Swarm/Knowledge rendering, followed by 144 browser/autonomy/folders/history tests. These are bounded suites, not an aggregate full-suite pass. Live browser/autonomy execution remains unverified for this combined source.

## Remaining qualification

1. Freeze the final commit/tree and confirm the reviewed source, version, lockfile and release-note inclusion. Check the remote version reservation again before publishing.
2. When authorized and without disturbing the user's active tasks, run the repository's aggregate suite on that exact clean source. Preserve the command, environment, output and any failures; do not relabel earlier-source results.
3. Build only the accepted source. Record installer/signature evidence, installer hash, package fingerprint, native password-manager assets and all copied runtime files.
4. The runtime remains the pinned .101 payload. Compare every path, size and SHA-256 against the [65-file inventory](runtime-inventory-2.39.101.json): 63 backend files plus LICENSE and manifest.json. resources/llama.cpp is outside appFingerprint. Reject missing, changed or unexpected files; record a separate package runtime inventory digest.
5. Exercise packaged behavior in a disposable profile, including Skills' embedded Knowledge editor, chat folders with autonomy controls, informational alerts and native receipt recovery using synthetic fixtures only. Never replay a real application or other external action as a smoke test.
6. Coordinate any installation/restart with current live work and required authorization. Preserve user data and action records. After installation, verify version/source fingerprint and the same complete 65-file runtime inventory before claiming completion.

No full suite, build, install, publication, startup merge, or live task is authorized by this document. Historical source notes remain historical and are not installation receipts.
