# BLACKICE 2.40.80 — MiniCPM and harness-recovery integration

**Release source:** BLACKICE 2.40.80 for Windows x64. See the public [GitHub Releases page](https://github.com/MoonlightClarity/BLACKICE/releases) for actual publication status, exact installer checksum, and verification artifacts. A versioned source commit or a local installer is not proof of public publication.

## Integrated changes

- Carry forward the 2.40.79 local candidate and the accumulated MiniCPM-related context, provider, chat-continuation, goal execution, recovery, and testing repairs.
- Preserve native command terminal outcomes and distinguish accepted tool execution from verified external progress; keep incomplete or uncertain effects inspectable.
- Improve job-search-intent classification and distinguish native browser *select* input rejection from a dispatched form action, without rewriting saved job-search instructions or treating refusal as an employer decision.
- Repair the contained-browser data-page capacity lifecycle, with targeted regression and native smoke coverage.
- Classify the MiniCPM repair report in the documentation index. Preserve exact source and test receipts so integration failures can be analyzed independently.

## Qualification boundaries

The source test suite and installed Windows installer must pass the repository's exact-source release checks before a public release can be published. Named optional test skips are **not tests that passed**.

Three retained *historical* MiniCPM benchmark test modules require an original pinned November 20, 2026 external fixture tree that is absent from the current source checkout. Their original test contents are preserved byte-for-byte as `tests/minicpm-*.historical.mjs` and still execute with unchanged frozen SHA-256 pins when that tree exists. Without it, the wrapper explicitly reports three named, unexecuted skips. An incomplete or corrupted fixture tree fails the original assertions instead of being treated as available or silently passing.

A narrow supervised local-model inference/streaming smoke check is not an end-to-end MiniCPM agentic benchmark, a claim of parity with another model, or a guarantee of unattended multi-site completion. External ATS submissions, outreach, task progress, and website conditions still require actual evidence from the relevant destination. The overnight job search is a diagnostic workload; these changes do not alter its objective or saved instructions.

## Windows installation and release

The public workflow binds the source version, complete source-test inventory, exact application fingerprint, Windows installer, installation checks, profile backup/restore evidence, diagnostics-redaction check, release tag, and SHA-256 assets. An unsigned installer does not imply a verified Windows publisher. Install the verified published `Blackice-2.40.80-Setup.exe` only after checking its checksum against `SHA256SUMS.txt` and preserving any running goals and local profile state.

For detailed repair provenance and original test limitations, see [MiniCPM full-suite repair](docs/MINICPM-FULL-SUITE-REPAIR-20261124.md). For broader current usage, see [README](README.md) and [release instructions](SIGNING-AND-RELEASE.md).
