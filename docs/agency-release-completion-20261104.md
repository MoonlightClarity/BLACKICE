# BLACKICE 2.39.17 — release and runtime completion

**BLACKICE 2.39.17 was published, its installer passed verification on disposable CI, and the existing desktop completed its separately authorized five-file runtime activation and native restart.** The final runtime observations were captured at **2026-11-04 19:47:56.000 UTC**. The native restart completed earlier, at **2026-11-04 19:44:26.320 UTC**.

This record follows the unchanged [candidate behavioral report](agency-behavior-report-20261104.md) and [methods](agency-behavior-methods-20261104.md). Their publication and activation fields were pending when those documents were written. This later record closes those release/runtime steps without changing their behavioral findings. The [machine-readable receipt](../verification/release-runtime-2.39.17-20261104.json) contains the public-safe hashes and status fields.

## Published source and installer

| Evidence | Verified value |
| --- | --- |
| Release | [v2.39.17](https://github.com/MoonlightClarity/BLACKICE/releases/tag/v2.39.17), published 2026-11-04 19:39:22 UTC |
| Exact source and tag commit | [8c85f45b9294d2280a1212e07a2f83d7d6f0b831](https://github.com/MoonlightClarity/BLACKICE/commit/8c85f45b9294d2280a1212e07a2f83d7d6f0b831) |
| Publishing CI | [Run 41898296728](https://github.com/MoonlightClarity/BLACKICE/actions/runs/41898296728), attempt 1, completed successfully; workflow and tag commits match the release source |
| Application fingerprint | `eacfa5c845901152a47d2e51465e88d41d2e04d342964dea983191decb447477` |
| Installer | [Blackice-2.39.17-Setup.exe](https://github.com/MoonlightClarity/BLACKICE/releases/download/v2.39.17/Blackice-2.39.17-Setup.exe), 154465457 bytes |
| Installer SHA-256 | `a0f9e953a136f66afb341564e70f4ea90cd1d59dcb1c558d4b8f31cd7c03cdff` |
| Public readiness | [Passed; publicReleaseReady=true](https://github.com/MoonlightClarity/BLACKICE/releases/download/v2.39.17/blackice-public-readiness.json); unsigned release |

The public-release metadata was checked at 2026-11-04 19:40:36.983 UTC. The root checker matched the GitHub asset digest, published checksums, and exact installer workflow binding. **It did not download the installer binary a second time locally.** The prepublication build/readiness assets retain their historical build-time publication flags; the published status above comes from the verified GitHub release metadata.

The [Windows installer receipt](https://github.com/MoonlightClarity/BLACKICE/releases/download/v2.39.17/blackice-windows-install-validation.json) records a successful install and uninstall on the **disposable CI Windows machine**, both with exit code 0. Cleanup passed with no remaining installation files, registrations, or shortcuts. The installer was not run on the existing desktop for this update.

The [complete source gate](../verification/windows-2.39.17.json) covered 614 files and 7,038 tests: **7,029 passed, nine permitted optional skips, and zero failures, required skips, cancellations, or todos**. [Source-test provenance](https://github.com/MoonlightClarity/BLACKICE/releases/download/v2.39.17/blackice-source-test-provenance.json) binds that receipt and unchanged source index to the final release commit. These source tests were not rerun in the publishing workflow; the workflow performed its separate installer/runtime verification.

## Existing desktop: five files and a native restart

The activation receipt records five files applied at 2026-11-04 19:41:47.886 UTC. This was a scoped update of the existing runtime, **not a new installer run on this desktop**. The captured file verification reports all five hashes matching the intended application fingerprint.

| Runtime observation | Captured result |
| --- | --- |
| Before version | 2.39.16 |
| Before application fingerprint | `fbf7dc618371aa52c5745c1768e54542dfa1a9a2b92428380e02c624ce5359ef` |
| After desktop and API versions | Both 2.39.17 |
| After application fingerprint | `eacfa5c845901152a47d2e51465e88d41d2e04d342964dea983191decb447477` |
| Native restart completion | 2026-11-04 19:44:26.320 UTC |
| Process identity | Changed; process identifiers are omitted |
| Profile and window mode | Preserved |
| API health | HTTP 200, connected, 0 active turns |
| Observation capture | 2026-11-04 19:47:56.000 UTC |

The following repository-relative file hashes come from the activation receipt; local installation/profile paths and connection, session, request, job, and process identifiers are omitted.

| Activated file | SHA-256 before → after |
| --- | --- |
| `lib/engine.mjs` | `0a87b1f5b75bbbbb1288c3849f670dc09783689c5688b8e3e94d10abff20db2b` → `a56836a09057c1c5de1fc81e7fbbea62b23a4a9a0d13f0f4eaea5c4bb83b7ebd` |
| `lib/planning-sequence.mjs` | `c95ad024ae8c8dbc2c2cdaff8e797a1f3c751d10975f4066597a3981b219bcf4` → `54bf1005f9abc0aa4ef81914122319a86876595babd806eb007e42309300912e` |
| `lib/provider-output-schema.mjs` | `c46268c4bb96c5913ded522a9c8931b5e37c31011a223b9a8df25977dc93d290` → `8b1277bd22d548a64905543140dfb83935f036fac01ef25c5c12acd75b4a44e7` |
| `lib/providers.mjs` | `6932eb39fae37ca490c24d890544c1c878b03dcb8880e5fc64e6d3e337102417` → `85cd8e833308b5b98240cf72c6c7254b157ce136f0e73c41b1b871aff3abb80b` |
| `package.json` | `d048bd9cb4946f2c840ff5941988fc19c1415bd6815d88b47f2bddda739672ad` → `fe8f058905dbca4b2c19324cb4c88ce6302fb661d5e8b5bc17b6f17dfc6f30b7` |

## Behavioral limits remain

Publication and a healthy restarted runtime do not establish successful model agency. Two central semantic failures remain in the preserved decision-component output: the general SQL answer volunteered an unrequested production-experience deficit; the role assessment imposed an unsupported credential gate/HOLD and omitted the fit and degree drafts it claimed to prepare.

The final forced form trial failed after **64 execution responses and 69 tool calls**, with no successful form open, fills, or submission. The separate seven-case component failed aggregate validation because its backup answer omitted the required typed comparison. Its original `host-validation.json` was never written. The later four structural accepts and three rejects are separate diagnostics, not four behavioral passes.

No new behavioral model test or native inference was requested for these completion checks. The captured connection observations record no model start or provider turn. The full [behavioral report](agency-behavior-report-20261104.md) and [original evidence bundle](../verification/agency-20261104/evidence-map.md) remain unchanged.
