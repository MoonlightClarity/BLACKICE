# BLACKICE release notes

This file summarizes meaningful changes. Older source notes remain recoverable through Git history rather than as hundreds of permanent files in the current tree.

## BLACKICE 2.40.85 — recovered development and browser freshness

- Restores the accepted Runtime workspace and editable native tool contracts, and integrates the published 2.40.84 source, overnight development, all thirteen morning repair commits, and recovered work in progress. Original histories and recovery copies remain intact.
- Retains Self-driving in Goal Mode and the browser, provider-loop, and action-receipt repairs from the separate development lines.
- Requires a fresh Chromium compositor boundary before capturing a parked browser page, preventing a previous rendered frame from being returned as the current screenshot.
- Adds an independent accepted-development lineage check to the existing automatic release workflow. Publication requires an explicit review bound to the release version, application fingerprint, accepted tip, and observed inclusion or omission; a reviewed exception remains possible with a visible warning.
- The recovered application passed the full Windows source qualification: 10,831 assertions passed, zero failed, and 15 disclosed optional skips. Three mandatory live Chromium fixtures ran separately and passed.
- Recovery-candidate clean installation and upgrade from published 2.40.84 passed. A separate source-equivalent build also passed an upgrade from the actual custom 2.40.84 variant. These checks exercised the hidden native runtime, profile retention, and uninstall; they do not claim a visible desktop inspection.
- The production release workflow builds and validates its exact installer and records its checksums and installation evidence with the release. Source qualification and recovery-candidate checks are preserved separately.

## Previous published Windows release: 2.40.84 (November 26, 2026)

- Retained Astra's Codex public OAuth client compatibility patch: permit only exact localhost/127.0.0.1 loopback callbacks with bounded ports, preserve approved Codex grants, and reject untrusted redirect destinations.
- Added **Self-driving** as an editable starting objective within ordinary Goal Mode. It uses the existing Goal scheduler, constraints, Stop, deadlines, and revision-checked controls; it is not a separate autonomy engine or permission mode.
- Improved browser action causality, recovery diagnostics, provider-host failure-loop classification, and distinct failure receipts without treating uncertain effects as completed or safe to replay.
- Preserved the compact Goal status strip and validated the Self-driving editor at desktop and narrow-screen widths.
- **Unsigned Windows installer:** Windows cannot verify a BLACKICE publisher identity. Compare the Setup SHA-256 and release manifest before use.
- Local upgrade and cleanup protocol: preserve the existing profile and user work, verify the new installation and restart before cleanup, retain one verified previous-version rollback installer, and remove only audited regenerable build/staging/cache artifacts. Do not delete model data, chats, receipts, credentials, or source trees.
- The Windows release is qualified by its own source-test receipt and fresh GitHub-hosted installation/uninstallation verification, recorded alongside the release. This does not establish that every unattended workflow succeeds.

## Still in active development

- Autonomous Goal reliability and completion-evidence accounting continue to be tested against actual external effects, not model-authored completion claims.
- Local model performance, context management, and MiniCPM improvements are active evaluation work; no general capability gain is asserted from these source changes.
- The current installed build, user-visible runtime, and any later production installer require their own identity and runtime evidence; report actual outcomes rather than inferring installation from source qualification.

## Earlier published Windows release: 2.40.83 (November 25, 2026)

- Windows in-place upgrades now ask BLACKICE to exit normally, then retire only the prior installation's detached remote-availability and Crashpad helper processes before replacing files.
- Normal BLACKICE shutdown still preserves remote availability. The update step does not remove Relay profile data or close another installation.
- The assisted Windows installer offers to launch BLACKICE again after installation completes.

## Earlier published Windows release: 2.40.82 (November 25, 2026)

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
