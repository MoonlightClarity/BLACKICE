# BLACKICE release notes

This file summarizes meaningful changes. Older source notes remain recoverable through Git history rather than as hundreds of permanent files in the current tree.

## Current source: 2.40.83

- Windows in-place upgrades now ask BLACKICE to exit normally, then retire only the prior installation's detached remote-availability and Crashpad helper processes before replacing files.
- Normal BLACKICE shutdown still preserves remote availability. The update step does not remove Relay profile data or close another installation.
- The assisted Windows installer offers to launch BLACKICE again after installation completes.

## Previous published Windows release: 2.40.82 (November 25, 2026)

- Improved local skill discovery for natural-language task descriptions using an in-memory SQLite FTS5 index alongside conservative local semantic matching.
- Skill retrieval remains sensitive to edits and deletions; skill content and owner revisions remain authoritative.
- Fallback search still works when FTS5 is unavailable. No cloud inference or additional model downloads are required for this feature.

## Earlier integration candidate: 2.40.81 (unpublished)

- Consolidated provider/model selection and retirement of integrations that could not be qualified.
- Continued improvements to goal continuation, browser action recovery, task and effect receipts, and SQLite-backed operational history.
- These source changes are not evidence that every workflow works unattended.

## Earlier published Windows checkpoint: 2.40.80 (November 24, 2026)

- Integrated MiniCPM-related local model, chat continuation, and execution-recovery changes.
- Improved browser lifecycle and action-result reporting.
- Publication, installer hashes, and exact-source verification belong to that release's GitHub release record, not to the newer source branch.

A source commit or a passing test does not establish that a Windows installer was published or tested. Publication follows the separate Windows release process.
