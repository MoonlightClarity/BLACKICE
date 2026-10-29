# BLACKICE

BLACKICE is an open-source Windows workspace for AI agents, local files and commands, browser work, editable plans and recurring tasks. It runs on your computer and keeps its saved workspace in your Windows profile.

**Current release: 2.36.1 for Windows x64.**

**[Download the Windows installer](https://github.com/MoonlightClarity/BLACKICE/releases/download/v2.36.1/Blackice-2.36.1-Setup.exe)** · [Release and verification records](https://github.com/MoonlightClarity/BLACKICE/releases/tag/v2.36.1) · [2.36.1 release notes](RELEASE-NOTES-2.36.1.md) · [Checksums](https://github.com/MoonlightClarity/BLACKICE/releases/download/v2.36.1/SHA256SUMS.txt)

The Windows installer is unsigned. Compare its SHA-256 with the checksum attached to the same release.

## Current project state

The 2.36.1 checkpoint brings together the browser, planning, recurring-work and frontend changes:

- **Contained browsing by default.** Agent web work starts in BLACKICE's own browser. Native Codex sessions exclude the installed `browseros-neo` auto-routing skill when the contained browser tool is attached.
- **Continuity across recurring work.** Compatible recurring agent tasks retain their conversation and Planning task, including when their instructions are edited.
- **Planning tied to the user's outcome.** Planning separates practical constraints from preferences and unknowns and records observed results. Plan provenance and agent guidance distinguish the user's instructions from an agent's earlier choices.
- **Less repeated frontend work.** Chat and sidebar updates avoid copying complete conversation histories and retain rendered rows where possible. Direct development tools can inspect and profile BLACKICE's actual desktop UI and Electron host.

This release also includes the [2.36.0 restart, startup-progress and browser-compatibility changes](RELEASE-NOTES-2.36.0.md). Development remains active; the release evidence and current limits are described below.

## Two ways to work

- **ChatGPT → BLACKICE:** an authenticated connection exposes BLACKICE's local tools to an ordinary ChatGPT conversation. ChatGPT supplies the reasoning; direct tool execution returns durable results without starting another AI model.
- **Inside BLACKICE:** choose native Codex or a configured API model. Agents can use connected tools, maintain plans, delegate work, retain knowledge and run queued or scheduled tasks while BLACKICE is running.

BLACKICE gives authorized tools real authority on your machine. It does not sandbox ordinary Windows commands or add a separate BLACKICE confirmation for every authorized direct action. Host permissions, connection authentication, website sign-in and operating-system restrictions still apply. Review the actual results of consequential work.

## The workspace

The default interface has seven workspaces, with separate loading and update lifecycles:

| Workspace | Main use |
| --- | --- |
| **Chat** | Work with an agent, keep drafts and attachments, inspect saved results, and manage conversations. |
| **Planning** | Explore conversation and project maps, inspect one step at a time, and explicitly save revision-checked plan edits. |
| **Tasks** | See saved work on a status board; inspect and edit schedules with revision checks, or review job receipts and run history separately. |
| **Browser** | Use the actual Chromium page with ordinary tabs, navigation, typing, downloads and site sign-in. |
| **Activity** | Inspect workflow maps and real run status, open task timelines, or manage application windows. |
| **Knowledge** | Search and edit memories and reusable skills, inspect revisions and recover entries from Trash. |
| **Settings** | Configure General preferences, Identity, Models and tool connections. |

The interface uses black-ice photography, graphite surfaces, silver controls and a coordinated prism mark. Native dropdowns have matching dark option lists. Forced colors use the system palette.

The classic interface remains at **`/legacy/`**, linked from Settings, for recovery and less common configuration surfaces. The V2 architecture and current limits are described in [FRONTEND-V2.md](FRONTEND-V2.md).

## Start

Run the current Setup installer to install or update for your Windows account. It creates BLACKICE shortcuts and an Installed apps entry. Back up your profile and quit the app before updating. Saved data normally remains in `%APPDATA%\Relay`; uninstall preserves it.

Open **Settings → Models** to configure a provider and select its models. Open **Settings → General** to choose the default model and working folder. Native Codex discovery and exact custom model IDs are supported. A successful provider credential test verifies the key; it does not establish access to every model. Optional model checks send a real, bounded request when explicitly selected.

**Settings → Tools** manages stdio and HTTP tool servers. Save, Connect and Disconnect are separate actions. Pasted or file-based configuration import has an explicit preview and apply step. Import never automatically connects a server or starts a process. If an import partly succeeds, the saved prefix is reported and the source remains available for a fresh preview.

Identity files and settings forms retain drafts across navigation. Saves and restores are explicit; conflicting revisions keep the edited content available for review.

Use **Run in background** to hide the desktop window while keeping its current profile and runtime alive. Source users can run `npm run headless`. The host must remain awake and BLACKICE must keep running; it is not an operating-system service. Saved schedules and projects preserve their pause/recovery rules after restart.

## Connect ChatGPT

Use the current **BLACKICE connection** for ChatGPT-to-BLACKICE tools. [CHATGPT-CONNECTOR.md](CHATGPT-CONNECTOR.md) covers setup, authentication, saved grants, durable action recovery and Windows startup. [REMOTE-ACCESS.md](REMOTE-ACCESS.md) documents remote access and the agent API.

Reuse an existing healthy connection. An uncertain action should be inspected through its saved receipt before any explicit retry. Connection status and local endpoint readiness do not by themselves prove that a particular ChatGPT conversation has the tools attached.

### Reported desktop approval issue

As reported on October 28, 2026, the ChatGPT desktop app asks for approval on every turn with **Pro Reasoning**, while **Extra High** does not show the same repeated prompts in that comparison. The checked BLACKICE connection already has the app-specific **Allow all actions** setting; BLACKICE reports no local per-action approval gate and no authorization failures. The cause and scope of the mode-dependent behavior remain unconfirmed.

This concerns the current ChatGPT-to-BLACKICE connection. The former reverse ChatGPT Bridge and browser-based ChatGPT model provider are retired. Their historical files and saved data do not make them supported setup paths. BLACKICE workers use native Codex or configured API providers.

## Cronjob reliability and inspection

**Tasks → Schedules** shows the saved triggers, pinned agent/model, limits, job receipts and (when applicable) overdue status, scheduler tick health, and recent occurrence history. A delayed tick admits no more than one currently due occurrence per job and records the skipped backlog as a bounded range, rather than silently dropping scheduled times or burst-replaying jobs. Clean restart and explicit resume account for overdue slots as skipped; neither silently runs them. A paused scheduler is not a running scheduler, even if an enabled schedule is saved.

Every new schedule create, edit and removal records a bounded source-labelled change receipt; removed schedules stay visible in the historical inspection section without exposing webhook secrets or agent instructions. Older removals show `not-recorded` when provenance is unavailable. Scheduled agent workers cannot recursively invoke the native scheduler-control tool. BLACKICE still requires a running/awake host.

**Tasks → Results** is a durable *local* result inbox for newly admitted jobs. Job completion, a result becoming available locally, and explicit human acknowledgement are separate recorded events. Successful, failed, cancelled and interrupted results remain reviewable after restarting BLACKICE. A bounded output preview is copied only when the engine run and saved inbox identity match; use **Open saved run** for the full recorded output. **Mark reviewed** is an explicit revision-checked action, and never changes the job's execution history. Legacy runs without local-result receipts remain available in Job history; BLACKICE does not invent delivery evidence for them. This does **not** push results to ChatGPT, email, or other services, and showing a result does not prove the user read it. No native scheduler permissions or per-action approval prompts were added.

## Planning: practical judgment and recurring work

**Planning is On or Off.** On (the default) requires a real current-turn `relay_task` plan before the agent publishes its final answer or dispatches unrelated operational tools. Planning guidance calls for an expected result, a concrete procedure and an observable completion criterion before execution, followed by the actual observed result. The engine checks the saved plan's run identity and holds premature answers or unrelated tools until the required plan is recorded. One fully specified action can be enough; there is no minimum step count. Off skips the automatic Planning requirement while preserving saved notes and optional tools. Historical Auto and Maximal values map to On. Model reasoning effort remains a separate setting.

Planning supports a revision-checked **decision criterion register** across job research, engineering, procurement and other real-world decisions. Classify verified hard gates separately from material barriers, adaptable gaps, stated requirements, preferences and unknowns. Record the provenance and evidence status of a claim: wording like "required" alone does not make it non-negotiable, and missing data does not establish an adverse outcome. Saved job-specific categories remain readable for compatibility.

A second, **optional judgment frame** records the practical outcome, consequential uncertainty, cheapest useful test, sufficiency condition, reassessment point, observed mismatch and transferable lesson. It is designed to *prevent* excessive verification and perfectionism, not force an introspection checklist on small tasks. Both the frame and criteria are editable in the live Planning workspace; neither can create a job, grant capabilities or certify completion. See [Practical judgment and metacognition](docs/METACOGNITION.md) for the reasoning model and examples.

**Recurring cron or interval schedules with one compatible agent and nonparallel overlap** continue the last settled run in the same conversation and Planning task, including after a clean application restart. Editing that agent's instructions preserves the conversation and task identity. Each occurrence retains its own durable job/run receipt, so the work history stays inspectable across scans. Parallel work, incompatible workflow structures or unavailable historical turns do not blindly reuse a model thread. Previously saved independent conversations are not retroactively merged.

Shared agent guidance keeps the requested outcome central, carries forward authorization for ordinary necessary steps, and distinguishes private assessment from material appropriate for an external audience. It asks for accurate answers and supported claims without volunteering unrelated adverse details. Plan origin and update provenance help keep the user's instructions separate from an agent's earlier methods. These are general workflow improvements; bounded model observations do not establish universal judgment quality.

## Plans, teams and saved work

Planning opens the selected plan's map, with an outline alternative and a focused inspector. Dependencies, branch choices, ownership and recorded evidence remain distinct. Project maps show actual review progress and milestones. Selecting a node inspects saved state; it does not dispatch work or create completion evidence.

Worker assignments describe scope, inputs, expected result and completion criteria. They do not derive capability restrictions or sandbox settings. Existing execution settings, task ownership and prerequisite coordination retain their separate meaning. Old assignment metadata remains readable.

Chat and task history support Archive, recoverable Trash and Restore, including bounded search and multi-selection. Conversation plans share that lifecycle; project plans support Archive and Restore. Knowledge uses Trash and retained revisions rather than an invented archive state. Removing a workflow template or schedule retains its existing permanent-removal semantics; the interface explains what execution history remains.

Memories can be notes, facts, assumptions or decisions, with sources and directed relationships. These are recorded assertions and references, not independent verification. Requirements and uncertainty still use text and existing acceptance checks; this release does not introduce a general probability or requirements ontology.

## Browsing and applications

**New agent web work starts in BLACKICE's contained Chromium browser.** The `relay_browser` tool dispatches only to that browser; an external browser is a separate tool choice. When the contained tool is attached, native Codex sessions exclude the installed `browseros-neo` auto-routing skill through per-session configuration, preserving other skill settings and leaving the global skill file intact. The [browser-routing report](verification/browser-routing-20261028.md) explains the conflict, fix and observed behavior.

Desktop Browser mounts the same Chromium page used by background tools. Tabs have independent saved identities, including blank tabs; unfinished addresses stay with their tabs. Leaving the workspace parks the page without reloading it. Pending site or proxy HTTP sign-in remains available across workspace changes. Genuine site dialogs keep their normal choices; already-closed notices do not require an extra acknowledgment before the next action.

Ordinary local-file and Chromium internal addresses are accepted where the runtime supports them. Human-created pages use the existing total resource budgets rather than the former eight-personal-tab limit. Some folder/branch organization remains available through backend tools or the classic interface. The screenshot/manual-input interface is a compatibility fallback for clients without the desktop bridge.

Configured native browser connections have independent profiles and sessions. [BROWSER-IMPORT.md](BROWSER-IMPORT.md), [BROWSER-PASSWORDS.md](BROWSER-PASSWORDS.md) and [BROWSER-PROTECTION.md](BROWSER-PROTECTION.md) document their specific behavior and limits. Optional filtering begins unfiltered and is enabled explicitly.

Site sign-in, human verification and missing required user information can still interrupt a workflow. A prepared form or successful file upload is not a confirmed external submission.

**Activity → Applications** hosts ordinary existing Win32 windows on the Windows desktop. Its legacy agent application API still uses a separate backend; arbitrary application, dialog, IME and DPI compatibility is not established by the hidden browser tests.

Thunderbird/Himalaya integration is retired. Use **Browser** for webmail. Historical email data is preserved; normal `/api/email` endpoints return `410 EMAIL_RETIRED`.

## Frontend performance and development

Chat uses compact catalogs, bounded rendering and worker-backed decoding for large saved histories. The current implementation avoids cloning the entire conversation history during routine updates and retains existing chat/sidebar rows where possible. Workspaces unsubscribe while hidden and load full selected records on demand. Planning metadata reads project scalar summaries instead of taking full history snapshots.

Earlier bounded installed measurements reduced one Planning metadata request from approximately **400–442 ms to 6–14 ms** on the same saved workload. That measures a specific request cost, not visible frame rate or every profile. The reported intermittent multi-minute startup has not been fully explained; startup now exposes completed stages, the current stage and elapsed time.

The direct `blackice_frontend` development tool inspects the actual desktop window and Electron host: state, DOM snapshots, screenshots, JavaScript evaluation, DevTools Protocol calls and buffered events. Profiling results use the durable job system, including saved files for large results. See [Native frontend development](docs/frontend-development.md) for the inspection and profiling workflow, and [PERFORMANCE.md](PERFORMANCE.md) for performance architecture.

## Verification of the published 2.36.1 release

Verification is pinned to the **v2.36.1 source tag and exact Windows installer**. Source tests, installer checks and model observations establish different things:

| Evidence | Recorded result |
| --- | --- |
| [Complete source suite](https://github.com/MoonlightClarity/BLACKICE/blob/v2.36.1/verification/windows-2.36.1.json) | 417 test files; **5,117 passed, 0 failed, 0 required skips, 8 optional integration skips**. Four supplemental native-receipt checks also passed. |
| [Windows installer validation](https://github.com/MoonlightClarity/BLACKICE/actions/runs/40795583611) | The exact installer passed per-user installation, version/registration/shortcuts, isolated headless startup/restart/shutdown, backup/restore, diagnostics redaction and clean uninstallation. All **511 packaged application files** matched the approved source. |
| [Public-release readiness](https://github.com/MoonlightClarity/BLACKICE/releases/download/v2.36.1/blackice-public-readiness.json) | All required release gates passed. Classification: **ready for public release, unsigned**. No verified publisher signature is claimed. |
| [Bounded browser observation](https://github.com/MoonlightClarity/BLACKICE/blob/v2.36.1/verification/browser-routing-20261028.md) | 98 contained-browser calls and zero connected-browser calls in the observed run. A site verification barrier prevented a confirmed submission; browser routing and task completion were assessed separately. |

Hidden runtime checks do not establish physical pointer/IME compatibility, visible-window responsiveness or universal website support. A passing source suite does not establish model judgment or completion of an external task. Historical verification files belong to their named versions; the matching release assets provide the installer checksums and verification records. Private profiles and task transcripts are excluded from publication.

## Build from source

Use Node.js 22 or newer on Windows. The lockfile pins the desktop runtime and build tools.

```powershell
npm ci
npm test
npm run desktop
```

`npm start` is the plain Node developer server; the desktop and headless commands use Electron. Packaging and release requirements are in [SIGNING-AND-RELEASE.md](SIGNING-AND-RELEASE.md). Do not copy a development checkout over an installed application bundle.

BLACKICE's original source is licensed under [Apache License 2.0](LICENSE). Bundled components retain the licenses in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
