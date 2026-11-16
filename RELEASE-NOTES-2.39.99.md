# BLACKICE 2.39.99 — isolated release preparation

**Status: unpublished, untagged local 2.39.99 candidate.** A nonpublishing Windows installer was built from exact source commit `2eb5d7d05a1cbaa4e55db30fcf7ce5e8027d3f89` (tree `f2c7d0dde524a6791eefc432cce6296bf3f2e030`): `Blackice-2.39.99-Setup.exe`, 115,733,947 bytes, SHA-256 `46d8fc5115b1a4a7f3c487f3a0cc73a73c8ec2cd8d55a132778a277b7fb08b34`. It is **unsigned** (Windows Authenticode `NotSigned`, no verified publisher), and has **not** been published, installed, or executed. The existing artifact was checked for static packaged-source equivalence, not installed application behavior. **This later notes-only amendment is not contained in that already-built installer.**

## Changes included in the local candidate

- **Swarm project management:** a separate bidirectional project/worker board with task scope, owner, dependencies, progress, blockers and durable evidence. Native worker handoffs and source-side dispatch admission distinguish reservation, attempted provider calls, accepted outcomes and unresolved external effects. A provider result is not automatically proof of completed work.
- **Navigation, Skills, and browser cleanup:** Swarm replaces the *visible* Planning tab; the underlying Planning implementation, saved data and supported deep-link route remain. Skills catalog/detail navigation is available. Browser cleanup offers exact conversation/task previews, protected-page preservation, explicit review for limited DOM inspection, and guarded native closure of selected tabs. It does not silently close Personal, foreign, active, dirty, unreviewed or otherwise protected pages.
- **Cronjobs and local-model usability:** the existing optional workflow name appears as a primary **Title**, with its original 160-character bound, fallback and persistence retained. Results/history headings use that title. Local-model settings link directly to the official llama.cpp releases page; metadata discovery remains under Advanced.
- **Focused UI corrections:** whitelist checkbox layout fixes are retained. Cleanup Preview now refreshes enabled state when a screenshot or native Browser action becomes idle, without changing the selected conversation or bypassing ownership, pending-effect, and reviewed-only closure guards.
- **Startup observability, not a startup-speed fix:** bounded critical-path spans and durable incomplete-launch evidence separate direct-job enumeration/stat/open/read, parsing, validation, hashing, indexing and recovery. Diagnostic monitoring is non-gating and its terminal lifecycle is cleaned up. These changes help investigate the slow launch; they do **not** establish its root cause, a faster installed launch, or acceptable instrumentation overhead.

The separate unfinished conversation-folders lane is **not included**. No model architecture, authorization policy, scheduler semantics, or external job-application outcome is claimed as part of this version-only preparation.

## Source provenance and test evidence

The **tested predecessor** is local commit `320047f1f110dee2a5e2c2a4f0c02d47971647d0`, tree `e7c525aa618865a18a3093ef7a920cc5e15a4bf9`, with package version **2.39.98**. Its Windows source suite `full-win32-source-320047f-20261116-001` reported **8,891 total, 8,880 passed, zero failed, 11 optional skipped, zero required skipped and zero cancelled**. The official terminal receipt reports source and application fingerprint unchanged. The full TAP has SHA-256 `c8240ad9dd8a3d3553afa9d80d8ebac652d5800e61b2f70f9641c33d95c12eb1`.

The earlier `3552b72` Windows suite **failed** (8,867 passed, 11 failed, 11 optional skipped); its original receipt is retained. The later 320047f source incorporated narrowly reviewed UI/test corrections, and an independently confirmed functioning Python 3.12.16/SQLite 3.53.1 interpreter was used for the Planning evaluator through a process-local override. The separate 50/50 focused and 19/19 Planning evaluator checks are additional predecessor evidence, not 2.39.99 release qualification.

**The exact 2.39.99 source at `2eb5d7d05a1cbaa4e55db30fcf7ce5e8027d3f89`** passed **40/40 focused release checks**, with its own source-index and application-fingerprint evidence. It has **not** undergone a full Windows source suite or installed-runtime acceptance. Predecessor `320047f` results remain predecessor evidence; neither test scope nor provenance may be silently upgraded.

A bounded **static** inspection of the existing unsigned installer compared all **780** packaged `resources/app` files against `2eb5d7d`: **706 raw-byte-identical runtime files**, one builder-normalized `package.json` (only development-only top-level `scripts` and `devDependencies` removed), and **73 approved byte-identical extras**, with no missing, unexpected or mismatched files. This supports static payload/source equivalence for the **previously packaged source only**, not native execution, live-model efficacy, or startup-speed improvement. The amended release notes are not included in that artifact.

As independently checked by root at approximately 2026-11-16 01:42 UTC, GitHub `main` and the public `v2.39.98` reference both pointed to `0101d3f88cc7f3f139394a1c943b899511668a90`. The local combined 320047f source is **not** that public tag. This preparation branch uses a **local Git repository** as `origin`, not GitHub. Existing `.github/release-request.json` refers to an older completed 2.39.97 publication request and is intentionally untouched; no 2.39.99 publication request was made.

### Eleven optional checks not exercised by the predecessor Windows source suite

The following exact named tests were skipped, **not passed**:

1. Relay-owned sign-in and local storage survive a full process restart without foregrounding.
2. live contained input updates application state and delivers editing keys without OS focus.
3. offscreen contained input updates application state and delivers editing keys without OS focus.
4. restored hidden browser tabs defer requests until used and never load closed or replaced pages.
5. native popups preserve OAuth routing and remain independent when their opener closes.
6. actual hidden Chromium fill commits trusted form state across replacement empty Unicode and iframe cases.
7. live background accessibility actions change only a dedicated non-activating fixture and leave foreground and cursor untouched.
8. rendered Chat Directory controls reach the real engine and persist independently.
9. hidden isolated Chromium composer validates real layout and one-click send wiring.
10. installed Himalaya sends exact MIME to disposable loopback SMTP and strips Bcc headers.
11. real headless Firefox operates disposable pages and keeps its own sign-in across a clean restart.

## Remaining release gates

The source-owned public release check against the existing installer is **blocked** (`publicReleaseReady:false`). Artifact-integrity passed, but **six required gates lack accepted evidence**: `evidence-bound-to-build`, `evidence-bound-to-installer`, `required-tests`, `installed-integrity` (including shortcut), `profile-backup-and-restore`, and `diagnostics-redaction` (including credential checks). The two signing gates are informational under the present optional-signing policy; they do not establish a verified publisher. No predecessor or missing receipt was borrowed to make these gates pass.

Real installed-profile startup tracing, the actual root cause and wall-time change of the slow launch, live-model efficacy, native Browser busy/idle Preview acceptance on **this exact version**, installation integrity, and the eleven skipped optional native integrations remain unverified. Earlier disposable Electron/Chromium acceptance does not establish installed-app equivalence. No full-profile hashing or real-profile instrumentation is authorized by this preparation.

The existing unsigned artifact and its 780-file static audit are bound to **prior exact commit `2eb5d7d05a1cbaa4e55db30fcf7ce5e8027d3f89`**, version `2.39.99`, source index/fingerprint and installer SHA-256 above. **This amended notes-only commit is not already packaged** and must not inherit that artifact's static-equivalence or release-check results as a new-commit receipt. Any future source test, package review or release qualification must identify the applicable exact Git commit/tree, package version, application fingerprint, source index, optional skipped checks and installer SHA-256 where applicable. Root alone controls any further build, full-suite authorization, installation, restart, publication or tag.
