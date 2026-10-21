# BLACKICE 2.30.0: validation scope

This release adds human editing presence, scoped worker plan-read receipts and affected-action review to the shared Planning application. Email gains managed Google and Microsoft browser sign-in, encrypted refresh credentials, a fixed Himalaya token helper, and a responsive connection screen. CLI access-code issuance and agent redemption enable setup without manual code relaying; Copy handles denied clipboard writes without losing drafts. Experimental Chat Mode appears in the main picker with an honest availability state. The release retains independent swarm scheduling, remote human and agent access, headless Electron operation, browser tabs and request blocking, model lists, dropdown contrast, chat renaming, search, and draft recovery.

Acceptance reports under the isolated `blackice-2.30.0-shared-editing-email/work` directory record actual results, timestamps, source hashes and application fingerprints. Counts and completion status come from those reports. This document defines the required scope; an unexecuted or failed check is not a pass.

## Windows regression

`scripts/verify-awareness-regression.mjs` runs every `*.test.mjs` file beneath `tests/`, including nested files, with four concurrent files and a bounded overall deadline. The report retains the complete actual test-file argument list, full TAP checksum, actual counts and named skips, exact runtime fingerprints, and complete source inventories before and after execution. Inventories include tests, scripts and documentation as well as runtime code.

Planning cases use real durable stores and runtime scheduling. They cover revision conflicts, atomic edits, invalid graphs, preservation of evidence and checkpoints, visibility filtering before pagination, renamed chat titles, damaged records, and verified client provenance. Worker tests hold a coordinator or sibling while independent work starts; release work after a human dependency edit; prevent a completion report from impersonating a running worker's exit; and exercise a coordinator with 48 saved prerequisites. Delegated children remain scoped to assigned work. Earlier native task tool schemas retain their original definitions.

Planning awareness cases use real stores, tool dispatch and HTTP routes. They verify expiring presence without draft text, scoped invalidation, delivery receipts, relevant prerequisites and branch controls, independent work, interrupted reads, restart behavior, and stale editor revisions. A held worker's affected file write must remain unexecuted until a fresh task read. An operation already in flight must retain its true result when a human save arrives.

Remote checks cover pairing entropy, one-use and expiry behavior, bounded failed attempts, hash-only credential storage, scopes, revocation, Host and Origin checks, stripped identity headers, one-use forwarding capabilities, stream closure, and isolated ownership of the configured Tailscale route. Agent bearer credentials remain restricted to machine routes. A narrowly scoped capability attributes paired-human plan edits and editing presence without opening human management APIs to agent credentials. Email registration and consent mutations require the host interface.

OAuth tests exercise actual owned loopback callbacks, PKCE and state validation, one-use responses, verified account identity, requested permissions, encrypted persistence, token rotation, rejected refresh, cancellation during exchange and atomic rename, maintenance draining, and secret-free public state. Frontend tests hold delayed responses and file imports to check revision conflicts, cancellation, close/reopen, secret clearing and draft preservation. No real provider or user mailbox is used by these fixtures.

Browser tests cover real Ghostery rule parsing and matching, bundled-list availability, bounded refresh and retained usable filters on failure, global and exact-origin preferences, stale-tab rejection, per-tab counters, and the contained browser boundary. Frontend cases hold delayed responses to verify tab selection, pinned versus following views, neighboring selection on close, keyboard navigation, address drafts, and truthful setting updates.

The retained suite covers model selection and dropdowns; chat rename and content search; task settlement; admitted file and native callbacks; project, operation and inbox recovery; legacy schemas; planning-before-answer sequencing; providers and tools; browser routing; read-only generic desktop inspection; and local email persistence.

Four historical integration cases remain explicit opt-ins: two contained-browser fixtures, external headless Firefox, and generic desktop accessibility. Their named skips are recorded separately. Native headless, CLI pairing and OAuth email acceptance are required for this release. No required case may fail, be cancelled or time out.

## Rendered web interface

`scripts/planning-remote-ui-qa.mjs` drives the actual server and frontend in an owned headless Edge process with disposable application data and deterministic local fixtures. It preserves prior UI journeys and adds Planning, tabs, protection and remote Settings. It checks source hashes and full application fingerprints before and after, records page exceptions, captures internal screenshots and verifies cleanup. The historical `revised-workspace-ui-qa.mjs` remains the prior release's runner.

Retained checks include compact model rows; readable reasoning, planning, history and Settings dropdowns; chat renaming; message and output-filename search; matching-turn navigation; catalog Retry; draft preservation; and composer-only shortcuts. Chat and composer geometry are measured at 320, 390, 768, 1180, 1440 and 1920 pixels. Six fake model turns and three held direction requests exercise late success, failure, cancellation and settlement without external provider traffic.

The Planning journey operates the saved plan through the rendered editor and actual HTTP routes. It checks the catalog, objective and steps, dependencies, conflict recovery, unsent chat drafts, retired Methods navigation, and narrow layouts. A concurrent edit must retain the user's draft, show the current revision for review, and require a subsequent deliberate save. Outline and map represent the same stored work. The new awareness journey advertises an actual focused edit, preserves field identity and caret through status updates, saves a correction, observes the affected worker guard and independent worker success, and clears the guard through a real task read. At 320 pixels the editor must fit and hiding it must release presence while retaining the draft.

The new Email journey uses the production OAuth manager with ephemeral encrypted storage and deterministic provider responses. Its actual loopback callback verifies PKCE and provider identity. Google registration import stays local until deliberate save, conflict recovery retains typed values, and pending consent preserves compose fields and advanced setup. The report measures dark dropdown contrast and 320-pixel geometry and records the exact permitted CLI interface fixture trace. It starts no email process and reads no mailbox; actual executable acceptance is separate below.

The Activity journey exercises visible tabs and protection through the production frontend with a deterministic contained-browser controller. The separate native browser acceptance verifies the actual Electron request hook. Remote Settings uses the real access manager with an isolated fake Tailscale transport, so pairing and token controls can be exercised without altering live routes.

Clipboard recovery uses browser-local denied, pending and selection-copy fixtures with the production UI and shared writer. It verifies exact source retention, no premature success, retry, 320-pixel layout, and preservation of an unsent chat draft, selection and scroll. The rendered fixture never reads or writes the OS clipboard or changes permissions. Native clipboard authorization and frame boundaries have separate focused tests.

Experimental Chat Mode checks preserve route metadata, explicit unavailability, saved selections and the exact setup tab handoff. Browser protocol tests correlate a result with its invocation, invalidate handles after navigation, and bound cancellation without resubmitting. The native owned-page transport probe establishes that Electron exposes the required protocol; it does not establish a real ChatGPT response schema or completion. Production agent turns remain unavailable until a reviewed response adapter exists. Corrupt optional Chat Mode state must leave ordinary BLACKICE startup and chat available while preserving the damaged bytes for recovery.

## Real Electron CLI pairing

`scripts/remote-access-native-qa.mjs` launches an actual Electron host with a disposable headless profile, then uses the real native command and bundled Node-mode helper. It exercises browser-code compatibility, scoped agent issuance, stdin redemption, private credential files, real gateway/API authentication, duplicate redemption, attempted scope widening, read-only restrictions, expiry, revocation, disabled-host behavior and normal cleanup. Issuance must not activate the host window or start another profile.

The fixture replaces only Tailscale command output and DNS routing with owned local peers. TLS validation stays enabled against a fixture certificate. No real route, trust store, live credential, user profile or provider is changed. Reports omit codes, bearer credentials and command stdin/stdout, bind the full candidate inventory and executable hash, and require every reviewed scenario to pass without forced cleanup.

## Retained remote human and agent runtime coverage

`scripts/remote-agent-runtime-qa.mjs` starts the actual BLACKICE server, remote gateway and durable stores in a disposable profile. An owned fake transport replaces Tailscale configuration; a local compatible model endpoint provides measured inference receipts.

Its scenarios include browser pairing, scoped credentials, legacy and current MCP requests, REST access, rejected forged identity and insufficient permissions, repeated stable task IDs, continuation with saved context, shared plan edits and revision conflicts, paired-human edits and attribution, event streaming, revocation, and durable state after restart. Identical retries must recover one admitted task; changed content with the same request ID must conflict. Reports exclude pairing codes, cookies, tokens and secret header values. The prior native runtime report is retained as historical evidence; this release verifies the changed remote paths through the complete HTTP, gateway and agent API regression suites.

This validates real local gateway and runtime behavior. It does not establish public internet connectivity, every external MCP client's compatibility, or arbitrary provider behavior. Live Tailscale configuration is preserved during acceptance; public publication remains an explicit choice in Settings.

## Real Electron lifecycle

`scripts/headless-desktop-qa.mjs` launches the actual candidate Electron app with a newly owned `--profile-dir`. It verifies headless startup, encrypted storage, the contained browser adapter, normal reopening into the same instance, background/show actions, API shutdown, headless restart with the same explicit profile, and graceful `--quit` handoff. It requests no model turns and does not use the live profile.

A pass requires all lifecycle checks, normal exit, marker cleanup, removal of disposable state, unchanged fingerprints and no forced cleanup. Headless mode is an Electron background process, not an operating-system service. Shutdown pauses dispatchers; restart does not silently replay external work.

## Real Electron and Himalaya email

`scripts/email-oauth-native-qa.mjs` starts an owned native Electron fixture with a disposable profile and the installed Himalaya 2.2.1 executable. It verifies Windows encrypted storage, generated Gmail and Graph configuration parsing, actual Electron execution of the fixed token helper, an owned loopback OAuth callback, encrypted grant reopening and background refresh, and real local Maildir listing, search and reading. Read operations must retain message flags. Draft creation must write only an unsent local artifact and start no CLI process.

The report binds the complete candidate inventory, runtime fingerprint, Electron and Himalaya executable hashes, exact owned CLI invocations, normal cleanup and the required scenario list. It explicitly records that real account login, provider transport, live mailbox connection and message delivery were not tested. Local fixture success cannot establish that the user's Gmail or Outlook account is connected.

## Retained Electron browser protection coverage

The browser protection acceptance uses a disposable Electron profile and controlled pages. It verifies the contained session hook, a blocked matching request, allowed ordinary content, observed counters, exact-site exceptions, preference persistence and cleanup. Its report binds the bundled engine and filter data, integration sources and full application fingerprint. Its 2.29 native report remains historical evidence; this release retains the unchanged implementation and runs all browser protection regression cases.

The shipped engine is Ghostery adblocker 2.20.1. Original package sources, list provenance, digests and licenses are preserved under `lib/vendor`. This is network matching; the integration does not install a full extension, inject third-party page scripts, or establish that all browsing is safe.

## Guarded installation and rollback

`scripts/install-awareness-update.mjs` accepts only the SHA-256-pinned `baseline-awareness-2.29.0.json`. That baseline contains 577 source files, 308 installed files and 447 preserved source extras. The updater rejects changed originals, missing baseline files, collisions with preserved extras, incomplete reports, and evidence for another candidate. The isolated candidate inherits every original source file and is frozen in a complete manifest before final verification.

`--prepare` constructs the complete proposed file map, original and new checksums, acceptance hashes and plan checksum while BLACKICE can remain open. After review, the normal-close helper requires fresh idle observations of the exact installed process and records its acknowledged graceful exit. `--commit PLAN_SHA256` reconstructs and verifies that proposal and its bound idle/close receipts. BLACKICE must remain closed. The updater checks rollback copies, writes only reviewed application files, and verifies source and installed runtime equality plus the explicit installed inventory. A failure rolls back its own changes while retaining any later conflicting edit.

The OAuth token helper is included in installation, packaging and runtime fingerprint verification. Profile data, model connections, sign-ins and network configuration remain outside this patch. The installation receipt records actual counts, fingerprints, preservation checksums and rollback location. Normal reopening must verify the updated native application and retained profile without performing provider work. This updates the local runtime; it does not rebuild or publish a public Setup installer.
