# BLACKICE 2.40.80 — Public release and verification

**Status (November 24, 2026):** The public GitHub release and hosted Windows installer validation are confirmed. Owner-machine upgrade is recorded separately; hosted installation alone does not establish its completion.

## Exact release identity

- **Public release:** [BLACKICE v2.40.80](https://github.com/MoonlightClarity/BLACKICE/releases/tag/v2.40.80)
- **Immutable tag and publication source:** `1040de1ec5389db14868324eaebeaecb5a9438a0`
- **Source under full-suite test:** `25ef06da50cf05e89f5d678b6734056f8ffb14ec`; the publication commit adds only the passing receipt and release request
- **Source-index SHA-256:** `b4cee7905c234a06913f343d8eb9fec5b791245db0e6c6b1562c59f7f4be34b3`
- **Application fingerprint:** `20e4479a0cbd1752eac020bf890f2b82d9b6c558fa8df9f2c6f74190b7b18e98`
- **Public Setup.exe SHA-256:** `d2c57fb0159a2eb2a241afc79646a6539ea9ce0abec64b9876a780e63cb17e3b` (159,347,615 bytes)
- **Signing:** unsigned. Windows does not attest a verified publisher identity.

The locally produced installation candidate had different Setup.exe bytes; the public installer above is the artifact verified by the hosted release workflow. Never substitute its local hash when checking a public download.

## Source verification

The exact Windows source suite recorded **10,561 tests: 10,549 passed, zero failed, 12 optional unexecuted skips, zero cancelled, zero todo**. The TAP log has SHA-256 `ec2069c041a6a63e26f55a2815e263aea75452a9954d357f13137c0ff658751d`. The tracked source receipt is `verification/windows-source-publication-2.40.80.json`, with SHA-256 `cfdfa89df4a0de0992e781be372840c4d32f62a8c15bdd5211ea0d02e2ad3470`. The official source release gate and documentation integrity check passed.

Three of the optional skips are historical MiniCPM benchmark suites whose original externally pinned November 20 snapshot was absent. The original test source was retained byte-for-byte, and its SHA-256 checks remain enforced when that snapshot exists. These benchmarks were **not executed or passed** and do not substantiate model-quality or end-to-end task-success claims. The remaining nine skips are optional native/contained-browser fixture checks; unexecuted checks are never credited as passes.

## Public Windows verification

[GitHub Actions run 45374218647](https://github.com/MoonlightClarity/BLACKICE/actions/runs/45374218647) completed successfully. The public release includes the Setup.exe, manifest, checksums, source-test provenance, installation validation, runtime-integrity and runtime-validation receipts, release receipts, GitHub validation, and public readiness.

Independent public asset download and SHA-256 checks verified **all ten uploaded assets**. The hosted Windows Setup.exe installation passed (exit code 0); runtime integrity, native startup/restart/shutdown, profile backup and restoration, diagnostics redaction, registration, shortcuts, and uninstall cleanup were checked by the hosted workflow. Cleanup passed with no forced termination and with the disposable profile sentinel intact.

The separate isolated Electron browser-capacity lifecycle smoke passed: an idle feed renderer was reclaimed, an unfinished form stayed live, and a reclaimed feed resumed without evicting the form. Its fixture used a disposable profile and loopback pages rather than a real user browser.

## Owner-machine installation

**Pending separate verification at this publication checkpoint.** An existing owner installation should not be interrupted before an explicit in-progress overnight Goal reaches its deadline and idle state. The local updater must use the exact *published* installer hash above, retain the existing profile, and subsequently verify installed package version, source fingerprint, Windows registration, shortcuts, and reopened runtime identity. The owner-machine result must be added only after observing its installation receipt.

## Limits

This record proves specific software/source and installer checks. It does not independently prove successful applications on employers' websites, consistent unattended job-search throughput, completed historical MiniCPM coding benchmarks, or all model/provider workflows. External effects must be reconciled from destination acknowledgments and saved receipts rather than inferred from tests or a GitHub release tag.

For product changes, see [2.40.80 release notes](../RELEASE-NOTES-2.40.80.md). For historical failures and retained original benchmark pins, see [MiniCPM full-suite repair](MINICPM-FULL-SUITE-REPAIR-20261124.md).
