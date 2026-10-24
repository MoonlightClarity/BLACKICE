# BLACKICE 2.33.13: planning, Fast mode and background email

See [RELEASE-NOTES-2.33.13.md](RELEASE-NOTES-2.33.13.md) for Fast mode, aligned Multi-select controls, compatible API recovery, durable planning and contained background email. Candidate verification and public release status are recorded separately.

# BLACKICE 2.33.5: durable history and release reliability

See [RELEASE-NOTES-2.33.5.md](RELEASE-NOTES-2.33.5.md) for durable job history beyond the former lifetime limit, compact metadata queries, restart diagnostics, complete desktop runtime packaging, and stricter installer evidence checks. Candidate verification results are recorded separately from public release status.

# BLACKICE 2.30.0: shared editing awareness and OAuth email

See [RELEASE-NOTES-2.30.0.md](RELEASE-NOTES-2.30.0.md) for per-step human presence, runtime plan-read receipts, relevant-change checks, and managed browser sign-in for email. [2.29.0](RELEASE-NOTES-2.29.0.md) introduced the shared Planning application, remote access, headless mode, browser tabs and request filtering.

# BLACKICE 2.28.0: readable choices and easier chat management

- Replace oversized model cards with compact searchable lists in the composer and Connections. Keep exact model IDs, availability, saved defaults and explicit access checks; move supporting metadata into Details. Filtering supports case and accents, and composing text or pressing Enter in the catalog does not accidentally submit a provider form.
- Apply a shared dark theme to all native dropdown controls and their open option lists, including reasoning, planning, chat history and Settings. Disabled choices remain distinguishable and readable.
- Make Rename the first action in active and archived chat menus, add F2 from a focused row or More button, and make the open chat title directly editable through the rename form. Capture the target chat so renaming another row never opens it or disturbs the current draft. Failed saves retain the edited name; late responses preserve newer focus and navigation.
- Search saved user and assistant messages and registered output filenames from the sidebar and Ctrl+K. Show concise matching previews, open the matching turn, and keep Trash behind its explicit filter. Build the allowlisted search index from retained conversation records; do not read arbitrary file contents for each query. Unicode case and accent matching, pagination, malformed responses and damaged-history indicators are handled explicitly.
- Refresh the full loaded search extent atomically. Preserve visible pages after a partial refresh failure, retry the complete refresh and reject stale results after query changes. A delayed result cannot switch away from a newer Plan choice or editor interaction.
- Keep completed responses unread until the actual app window has focus and the conversation end is visible. Scope Ctrl+Enter to the editable chat composer so search, Rename and Settings fields cannot send another draft. Keep cached chats after a catalog refresh failure and provide an accessible, coalesced Retry action.

This is a guarded local update from the inspected 2.27.0 source and installed runtime. The complete Windows regression and owned-browser journey bind their results to the candidate's exact files. Acceptance requirements, fixture scope and update preservation are documented in [UI-VALIDATION.md](UI-VALIDATION.md). The Windows Setup archive is not rebuilt.

# BLACKICE 2.27.0: roomier chat and steadier navigation

- Give Conversation more width and keep the supporting plan compact. The header's **Plan** button hides or restores it without losing the draft, selected step or saved task. Desktop visibility is remembered independently of narrow-screen pane choices.
- Separate model, Reasoning and Planning settings from attachments and message actions. Stop and Send remain adjacent and independently reachable at narrow widths. Options and Reasoning popovers fit the viewport.
- Remove the duplicate working-folder chip, repeated routine activity above the composer, redundant selected-step heading and configured-model ready card. Keep the working folder and planning explanation in Options, and show actionable connection, attachment and request states.
- Simplify New chat to one invitation, draft starters and direct Methods/Projects access. Align the welcome content with the composer. Keep the Latest control attached to the reading area as the composer grows.
- Preserve Inbox keyboard focus and scroll during refresh, add arrow/Home/End navigation between tabs, and prevent delayed Inbox actions from reopening a view the user left. Actual task and run receipts are retained. A pending save remains locked when its original draft is reopened, while edits to another draft remain untouched.
- Preserve Settings field selection and keyboard focus through asynchronous refreshes, including disclosure summaries and action buttons. A disabled former action falls back to a reachable enabled control.

This is a guarded local update from the inspected 2.26.0 source and installed runtime. Validation uses deterministic local fixtures and owned headless Edge. Complete acceptance requirements and limits are in [UI-VALIDATION.md](UI-VALIDATION.md); timestamped reports bind actual results to this candidate. The Windows Setup archive is not rebuilt.

# BLACKICE 2.26.0: control, navigation, and recovery

- Navigate between chats and New chat during a pending Send or Save for later. Drafts, locks, errors and queue receipts remain owned by the originating request. Late success or failure preserves another chat's draft and current selection.
- Retain Stop's execution lease while admitted provider or native tool callbacks finish. Actual late tool receipts survive cancellation and connection exit. Late answers stay withheld; a continuation cannot overlap unfinished work from the same conversation. The existing total-run deadline remains active through native callback drainage.
- Recheck persisted explicitly queued work after a successful runtime reconnect. Paused dispatch and passive saved tasks remain paused or saved; a failed reconnect starts nothing.
- Show Working, Stopping or Finishing in the global header until work settles. Empty unavailable or missing plans open Conversation on narrow screens while retaining explicit pane choices. Planning and Reasoning controls no longer overlap in the mobile composer.
- Preserve map keyboard focus and pan through live updates and responsive resize. Keep keyboard focus on an enabled zoom control at scale limits. Workspace availability reflects dispatcher, maintenance and storage blockers; planning descriptions respect Off.

The existing gradient and transparency surfaces and editable SVG assets are retained. This is a guarded local installed-runtime update from the inspected 2.25.0 files; no public Setup.exe is rebuilt. Current validation requirements and fixture limitations are in [UI-VALIDATION.md](UI-VALIDATION.md). Completed receipts record the actual results and exact candidate hashes.

See [BLACKICE 2.25.0](RELEASE-NOTES-2.25.0.md) for adjustable visual planning, SVG visuals, and harness identity. [BLACKICE 2.24.1](RELEASE-NOTES-2.24.1.md) documents earlier control and recovery work. [BLACKICE 2.24.0](RELEASE-NOTES-2.24.0.md) documents the background workspace and capability scope. Entries below are historical; earlier Bridge and general external-browser offerings are retired.

# BLACKICE 2.22.0 — black ice, usable processes, and honest application support

- Replaced generic slate decoration with original fractured black ice surfaces, a sculpted ice plate, purpose-specific SVG illustrations, and a matching multi-resolution native window icon. Reading surfaces remain calm; button width and height follow their labels, with visible focus and reduced-motion support.
- Reduced the main navigation to Chat, Activity, and Settings. Projects is directly accessible from the header and empty Chat. The graph canvas remains under Workspace → Advanced.
- Projects now start with an outcome, optional reusable method, and ordered steps. Expected results and acceptance checks are visible in the plan. Ask agent to plan prepares an editable Chat request and preserves existing draft text without sending it.
- Added eight original reusable methods, custom methods, and an extensible task/step ontology shared by human UI and relay_project. Built-ins can be adapted into copies. Preview writes nothing; use creates only a draft. Reapplying method inputs preserves authored context and replaces the exact previous generated block.
- Added owners, priorities, dates, tags, notes, milestones, attention filters, blockers, and next actions. Tracking can change while work is active; attempted execution definitions and evidence stay immutable. Manual checkpoints remain distinct from reviewed task completion.
- Native Codex accepts exact user-registered model IDs absent from its catalog, retains hidden and paginated entries, and disables model fallback for exact native requests. Catalog visibility and actual inference access are separate. Removing a custom default keeps it explicitly unavailable instead of silently choosing another.
- Actual inference checks completed for all nine models advertised by the installed native endpoint, including both hidden entries. This proves those requests on the tested account; it does not enumerate secret server-side IDs or establish every reasoning/tier combination.
- Added documented model candidates absent from the live catalog, with source and lifecycle labels. Check access performs one bounded exact native request; adding the ID to choices is separate. Neither changes the default. Checks are scoped to the account/connection and can recover saved status without replaying a lost request. The documented Spark candidate stays retired; the actual endpoint rejected that exact ID as unsupported.
- Removed attachment file-type exclusions from browser/native selection, drops, clipboard File objects, and server admission. Every format is preserved with its original name and checksum; decoder limitations are visible without preventing attachment. Existing size and task limits still apply.
- Added local PDF text extraction, page search, and page-image rendering through bundled PDFium workers. Scanned pages can be viewed as pixels; automatic OCR is not included. Password-protected, damaged, or over-limit documents remain available as original files.
- Added run-scoped working-copy export and bounded raw-byte reads so arbitrary formats can be used with compatible local tools. Export creates a separate file, never overwrites a previous copy, and never opens or executes it. Existing persistent native conversations retain their old attachment tool schema honestly.
- Tested four larger Windows applications and classic Notepad in bounded private-desktop fixtures. Notepad passed capture, accessibility inspection, semantic edit, and readback. Writer, Inkscape, and Krita did not produce a usable private window; Blender failed the current GUI executable admission check before launch. The UI now records those limitations.
- Increased private application startup observation to 15 seconds within the existing launch deadline. Added sanitized process/window diagnostics, explicit startup phase and exit codes, and cleanup evidence. Ending failed history no longer claims processes stopped without proof.
- Preserved the configurable ChatGPT bridge, scoped approval reuse, Chat Mode handoff guard, typed connector timeout, and read-only saved-status recovery from 2.21.
- This is a local application update. Final regression, browser, native-model, application, and installation evidence is recorded in UI-VALIDATION.md. Windows setup archives require a separate rebuild.

# BLACKICE 2.21.0 — clearer everyday work and a steadier ChatGPT bridge

- Added a coherent shared interface layer: readable system typography, calm dark slate surfaces, clear cyan primary actions, larger targets, visible focus and restrained motion. Existing ice artwork remains a subtle brand accent.
- Chat now offers honest selected-model readiness, labeled New chat / Send / Stop controls, safe draft starters, and direct ChatGPT bridge access. Secondary scheduling actions live in message options. The laptop drawer closes correctly, preserving desktop preferences.
- Settings puts common preferences first. Models & connections explains provider connection and model selection as distinct stages, reports what was saved, and points validation to the relevant input.
- Codex discovery includes hidden catalog entries, follows every page, and labels hidden entries in the model choices. Refresh models rereads a connected catalog without restarting active turns or changing the saved default; failed refreshes retain the last catalog with a visible error. Native catalog IDs and routing names both work as defaults.
- Every user can save whether the copied bridge handoff reuses authorization for the exact request or asks once before that handoff. Existing settings load compatibly. These preferences do not bypass host-required tool confirmations.
- Both bridge transports instruct ChatGPT to remain in Chat Mode and use the configured connector. A best-effort check rejects direct Work Mode redirect answers without completing the request. It permits ordinary explanatory mentions and code/quoted examples; it is not a host-mode lock.
- Bridge connection deadlines show a distinct Connector timed out error with recovery guidance. Pending requests offer Check saved status, a read-only check that keeps the same request and draft. Handoffs check existing work before retrying; an uncertain write is never automatically replayed.
- Activity remembers the selected surface, opens an existing task first, distinguishes viewing from task state, and preserves inspected evidence while Follow live is held.
- Projects emphasize the next action, compact task summaries and actual acceptance-check counts. Details and inspection position survive refreshes; save/action controls stay reachable.
- Workflow shortcuts affect only the visible workspace. Per-workflow viewport memory, visible skip targets and expanded modal keyboard handling address adjacent navigation defects.
- Repeated status receipts reuse one toast instead of stacking over controls, and compact modal receipts sit above footer actions. Narrow Chat retains its New chat label and gives the folder control and Send separate space.
- This is a local application update. Rebuild the Windows installer before distributing an installer archive. Verification for this exact build is recorded in UI-VALIDATION.md after the final checks.

# BLACKICE 2.20.0 — configurable ChatGPT bridge

- A shared request queue connects BLACKICE to ChatGPT Chat Mode through MCP tools or an existing local-command connector such as Avalon.
- Every installation can choose its connector name, connection mode, local port, and public HTTPS endpoint. Paths derive from the installed app; connection tokens are generated per installation.
- The optional authenticated MCP listener runs with BLACKICE and can be enabled or disabled in Connection settings. A portable stdio/HTTP adapter is included for other MCP hosts.
- BLACKICE agents can enqueue requests and inspect replies with `relay_chatgpt`. External ChatGPT tools read the requested context and save an answer without starting a second model call.
- Waiting, completed, and cancelled states are durable. Exact retries are idempotent; conflicting answers and cancelled-request completions are rejected.
- The bridge panel preserves drafts, selected requests and refresh state. Models and the command palette link directly to it.
- This bridge requires a ChatGPT conversation to process the handoff. It does not wake Chat Mode or provide an unattended subscription inference endpoint.

# BLACKICE functional update — October 17, 2026 (local build)

- Shared persistent projects with dependent tasks, explicit acceptance criteria, separate review runs and bounded repair loops.
- Human and agent use the same plans through Projects & capabilities and relay_project. Completed reviewed methods can be saved and reused as fresh drafts.
- Actual native-model QA covers timer/cron dispatch, model-initiated subagents, swarm synthesis, review/rejection/repair, dependency gating and capability reuse.
- Fixed scheduled-tick postponement on edits, full-history queue starvation, late subagent cancellation, and missing child execution receipts.
- Projects pause after restart and Stop all; run IDs and intent receipts preserve provenance without blind replay. Review verdicts remain explicitly agent-reported.
- Local update only; installer archives require rebuilding. System service execution, broad connector certification and complete n8n/Hermes parity are outside this verified slice.

# Relay 2.19.0

Persistent defaults, continuous context, finite schedules, native browser discovery, and visible tool outcomes.

- **Response defaults** in Configure saves reasoning, 900k/custom context, and automatic compression. New chats inherit choices; explicit conversation settings keep precedence. Model capacity still applies.
- Oversized private Codex conversations import full archived history in bounded chunks and compact within one ephemeral native session before the actual task. API conversations use selected-model summaries without tools. Original messages remain saved and exported. Failed compression stops before actions.
- Native BrowserOS Neo discovery reads its own local metadata, verifies real MCP schemas, starts an installed browser headlessly when needed, and reconnects after changed ports or disconnects. No Codex MCP setup is required; BrowserOS itself is not bundled.
- Browser playbooks favor actually completing authorized website work and checking page results. Browser SDK descriptions remain intact within the progressive catalog budget; excessive descriptions are explicitly marked.
- Failed calls are visible beside the conversation independently of the final answer. Returned errors, missing tools, native failed commands/edits/MCP actions and unavailable browser readiness remain auditable after restart. Recovered errors retain their failure receipts.
- Models explicitly marked without tool support receive no callable tool catalog and a clear chat limitation. Unknown capability is not silently disabled.
- Optional schedule limits stop new jobs after a lifetime iteration count, duration, or end instant. Retries and duplicate deliveries do not count again. Existing queued/running work finishes. Limits never reset silently across pause or restart.
- End-date editors retain the exact original instant through repeated daylight-saving hours and disclose the timezone offset before saving.
- Existing persistent native sessions retain their original tool schema through continuation/retry; configuration guidance describes only their actual fields.
- The registered **Relay-2.19.0-Setup.exe** updates the installed program and Desktop/Start Menu shortcuts while retaining the separate profile.

Validation evidence is recorded separately. Actual local BrowserOS form submission proves that tested path; it does not establish login reuse on every website or measured Windows cursor non-interference.

## Previous release: 2.18.0

Carry substantial work from an outcome to checked milestones, then into repeatable operations.

- Saved milestones are visible directly in the conversation: one current action, the actual saved completion count, a checkable finish condition, a blocker when needed, and a concrete completed win. Full plans, evidence and checkpoints stay behind optional disclosures.
- `relay_task` extends existing durable plans with `doneWhen`, agent-reported `evidence`, a `blocked` state with a reason, and a checkpoint's single `nextAction`. Existing plans remain readable. The former 32-step count ceiling is removed; the existing bounded storage budget still applies.
- Milestones guide autonomous work. They do not add approvals or require the user to advance every step. Simple conversation and quick work need no saved plan. Swarm guidance gives the coordinator ownership of shared milestones and tells workers to preserve concurrent progress.
- **Draft next action** prepares a continuation without overwriting an existing or newer cross-window draft. Normal Send retains the selected model, reasoning, context and files.
- **Make repeatable** opens setup from a completed task. It carries the original admitted input, complete workflow, working folder and attachments together, including full swarms. It starts in manual/off mode and creates nothing until the user saves. Later follow-up graphs cannot silently replace the original workflow.
- Milestone changes retire stale next actions; reopened or changed completion criteria retire stale evidence. Earlier versions remain in history. Agent claims stay distinct from file-byte checks.
- Stream, HTTP and conversation-cache merges respect task identity and revision order. Completed responses reload authoritative saved state. Older native Codex conversations retain their original tool schema; new conversations and supported provider sessions receive milestone fields.
- The Windows installer is **Relay-2.18.0-Setup.exe**. It updates the registered program and existing Desktop/Start Menu shortcuts while keeping the separate Relay profile.

The visible-working-set and action-first approach was informed by [i-have-adhd](https://github.com/ayghri/i-have-adhd). These are original Relay implementations, not a copied skill catalog. Current verification evidence and scope are recorded separately; broad Windows non-interference coverage remains unproven.

## Previous release: 2.17.0

Turn a reusable outline into a clear task, then edit and send it as an ordinary conversation. Prompts remain optional.

- **Outline** beside the model picker opens optional reusable task, method and checklist outlines. They share one section-and-variable editor. Rendering produces plain Markdown in the normal editable composer; **Use in draft** never sends a message or starts work.
- Built-in templates are immutable starting points. Custom outlines support saving, readable history, revision restoration, recoverable deletion and Undo. Saved markers distinguish custom copies, and Trash supports restoration after reopening. Portable JSON supports moving definitions between Relay installations.
- Editing moves, nests or deletes whole section branches so their child steps stay attached. New sections appear after the selected branch at the same level.
- Agents can inspect and render the same library through `relay_prompts`, and help maintain custom templates when requested.
- Applying a prompt checks the original draft's ownership. Switching chats or editing a draft while the library is open preserves the newer draft.
- The submitted message contains the rendered text. Queued work, retries and exports retain that exact task text instead of resolving a template again after it changes.
- Structured messages receive useful automatic chat and Inbox titles instead of a repeated section heading. Explicitly renamed titles and the exact submitted message are preserved.
- The normal Windows distribution is **Relay-2.17.0-Setup.exe**. It updates the registered program, Desktop and Start menu shortcuts, and Windows uninstall entry. Saved chats and settings remain in the separate Relay profile.

The black conversation-first interface, searchable provider/model picker, optional schedules and swarms, automatic auditable memories/skills, targeted file and knowledge patches with Undo, Max/Ultra reasoning and user-controlled concurrency remain available. No per-tool permission gates were added. Setup is unsigned by default; signing is optional and no paid service, audience or closed beta is required. Packaging does not publish anything.

Release validation must use this exact 2.17 candidate's version, application fingerprint and installer hash. Earlier 2.16 tests and installation receipts are historical. Current validation counts belong in the candidate's recorded verification report after they run; they are not assumed here. The optional outline-and-template workflow is inspired by [Catalyst](https://github.com/MoonlightClarity/Catalyst).

The two optional 2.12 live Windows non-interference runs did not pass their cursor-position assertions. Background text and button actions reached the fixture, but the cause of observed pointer movement is unproven. This release does not claim complete live non-interference or universal Windows/site compatibility.
