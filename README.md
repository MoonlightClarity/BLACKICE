# BLACKICE

BLACKICE is an open-source Windows workspace for AI agents that work with files, commands, websites, plans and recurring tasks. Use Codex inside BLACKICE, or let a ChatGPT conversation call BLACKICE's tools on your computer. Conversations, editable plans, execution history and results stay available so you can inspect the work and continue it.

The project is built for personal, user-directed automation. Its focus is practical outcomes, shared human/agent control and continuity across longer tasks.

**Current public release: 2.39.15 for Windows x64. Overview updated November 4, 2026.**

**[Download the Windows installer](https://github.com/MoonlightClarity/BLACKICE/releases/download/v2.39.15/Blackice-2.39.15-Setup.exe)** · [Latest release](https://github.com/MoonlightClarity/BLACKICE/releases/latest) · [2.39.15 release notes](RELEASE-NOTES-2.39.15.md) · [Checksums](https://github.com/MoonlightClarity/BLACKICE/releases/download/v2.39.15/SHA256SUMS.txt)

[Getting started](#getting-started) · [Workspace](#find-your-way-around) · [Planning](#planning-and-practical-judgment) · [Recurring work](#workflows-agents-and-recurring-work) · [Project state](#current-project-state) · [Build from source](#build-from-source)

## Two ways to work

| Where you work | What runs there |
| --- | --- |
| **Inside BLACKICE** | Codex is the supported native agent runtime. Work in saved conversations, attach files, use tools, edit plans and inspect results in the desktop workspace. |
| **In ChatGPT** | ChatGPT owns the conversation and reasoning. BLACKICE executes requested file, command, browser and planning actions on your computer and returns their saved results. Ordinary direct tool calls do not start another model. |

You can use either route or both. The direct connection also has an explicit **start a BLACKICE chat** action for delegating a task to a new saved conversation and its selected agent. That action uses model access; it is separate from ordinary direct execution.

Codex uses the account you configure. Advanced users can explicitly add a compatible API endpoint under **Settings → Models → Connect another endpoint**. Those integrations are optional and unsupported; their availability and compatibility depend on the endpoint. BLACKICE does not silently switch to a paid API fallback. Saved conversations retain their provider and model identity when the default for new conversations changes.

The former browser-driven ChatGPT model provider, Antigravity and Qwen Code native runtimes are retired. Historical conversations remain identifiable. The supported ChatGPT connection is ChatGPT calling BLACKICE's tools.

## Getting started

### Install

Download and run **Blackice-2.39.15-Setup.exe**, then open BLACKICE. The per-user installer creates Desktop and Start menu shortcuts and an Installed apps entry.

The current release is unsigned. Signing is deferred until adoption justifies it. See [Windows releases](SIGNING-AND-RELEASE.md) for packaging and Windows compatibility details, and the [release page](https://github.com/MoonlightClarity/BLACKICE/releases/tag/v2.39.15) for verification of the published installer.

Keep BLACKICE running while using its tools or schedules. Workbench's Hyper-V guest is an optional setup for native application work; it is not required to start a conversation or use ordinary file and browser tools.

### Use an agent inside BLACKICE

1. Configure and sign into Codex with the account you intend to use, then select its model under **Settings → Models**.
2. Choose the working folder for the task.
3. Open **Chat**, start a conversation, attach relevant files and describe the result you want.
4. Choose **Forced**, **Advisory** or **Off** for Planning. Reasoning effort is a separate setting.
5. Follow the saved plan and execution history, inspect the outputs and continue the conversation as needed.

For additional integrations, **Settings → Tools** can connect local and remote MCP tool servers. Importing a configuration saves it for inspection; connecting starts the configured server connection.

### Use BLACKICE from ChatGPT

1. Keep BLACKICE and Tailscale running.
2. Open **Settings → ChatGPT connector** and follow **Prepare this computer**.
3. Use the displayed server URL ending in `/mcp/chatgpt` to add the BLACKICE connection in ChatGPT. Setup uses OAuth with client metadata discovery; it does not require a manually entered client ID, client secret or Owner login key.
4. Match the authorization request in BLACKICE, allow the selected access and attach the connection to the intended ChatGPT conversation.
5. Run the setup guide's status check and confirm the matching result reaches that conversation.

The [ChatGPT connector guide](CHATGPT-CONNECTOR.md) covers setup, Windows startup and recovery. Reuse an existing healthy connection. BLACKICE's direct actions use that connection's granted access without an additional local confirmation for every action; ChatGPT's own app controls and Windows or website requirements still apply.

## Find your way around

| Workspace | Purpose |
| --- | --- |
| **Chat** | Saved agent conversations, attachments, outputs, continuation and transcript export. |
| **Planning** | Shared goals, nested steps, dependencies, assessments, evidence and editable saved plans. |
| **Tasks** | Board, timeline, workflow editor, schedules, results and job history. |
| **Browser** | Shared browsing, site sessions, tabs, forms, uploads and downloads. |
| **Workbench** | Persistent Windows guest setup, application inventory and synchronization, shared files and guest display/control. |
| **Knowledge** | Reusable memories and skills, their sources, revisions and organization. |
| **Settings** | Models, working folders, identity instructions, tool connections and application preferences. |

The current desktop interface replaces the former classic interface; old `/legacy/` links redirect to it. Former Activity routes now open Tasks.

## Planning and practical judgment

Planning is a shared working record for the user and agents. Plans can be viewed as a map or hierarchical outline, named, grouped, edited and revisited. The record connects a goal to steps, dependencies, assignments, evidence and observed outcomes.

**All three planning modes are implemented in the current release:**

| Mode | Behavior |
| --- | --- |
| **Forced** | Requires a saved executable plan before operations, proceeds through eligible atomic steps and records their material outcomes. Supporting read-only observations can belong to the same active step. |
| **Advisory** | Makes planning available and encouraged without blocking execution on a plan checkpoint. |
| **Off** | Removes the automatic planning requirement. Existing saved plans remain accessible. |

Forced planning does not introduce another user-approval step or change the model's reasoning effort. Historical On/Auto/Maximal values remain compatibility inputs; the current user-facing choices are Forced, Advisory and Off.

### From intent to executable work

Task readiness runs **Inference before Feasibility**. Inference uses the request, supplied documents and established facts to identify intended outcomes and supported assumptions. Feasibility then evaluates the workflow that will perform the work, including tools, access, missing data and time. Repairable gaps and unresolved access checks can be investigated by the agent; genuinely missing user facts and confirmed blockers remain visible.

Executable plans support recursively decomposed steps with hierarchical labels such as **1.1** and **1.1.1**, ordered **IF / ELIF / ELSE**, nested **AND / OR / NOT / Boolean XOR**, and typed comparisons. Unknown conditions remain unresolved. New evidence can send the agent back to planning. **Return to this step** opens a new attempt of an earlier step while preserving previous results and marking affected later work for reassessment.

The runtime's user-advocacy guidance asks agents to work backward from the user's intended outcome, distinguish hard constraints from preferences, and weigh likely benefit, effort, downside and the opportunity cost of waiting. Judgment records can capture uncertainty, a useful next check and what was learned. These are instructions and recorded decision structures, not a guarantee that every model will judge a situation well.

Completion is tied to evidence for the requested outcomes. The current release also accepts a final answer that plainly explains unfinished criteria, without requiring the user-facing answer to repeat internal limitation text verbatim.

See [recursive planning](docs/RECURSIVE-PLANNING.md), [practical judgment](docs/METACOGNITION.md) and [shared plan editing](PLANNING-AWARENESS.md). Plan edits are explicit saves with revision checks. Use execution controls to stop an action already underway; editing its plan guides subsequent work.

## Files, browsing and application work

### Files and commands

Agents can list folders, search and read files, write changes and run Windows commands. Text patches retain before/after records. Attachments bring documents and images into a conversation, and transcripts can be exported as Markdown or JSON.

Document tools inspect text, PDFs and images. Creation and transformation can use installed applications, scripts or connected tools. The desktop includes text and image previews; advanced document editing depends on the tools available for the task.

Ordinary file and command actions use the Windows account's access. The working folder supplies a default location; it is not an operating-system sandbox.

### Shared browser

BLACKICE includes a Chromium browser shared by the user and agent. The visible Browser page is the page operated by its contained-browser tools, with its own saved website sessions. Tabs, navigation, forms, uploads, downloads and browser handoffs are part of the workspace.

Configured native browser connections can use their own sessions. Profile import creates a separate managed copy for the selected installed browser; copied profile data does not always preserve a working site login. The local password manager can save, generate and fill credentials in supported browser fields. Optional browser filtering is available and starts off.

Browser recovery includes handling stale field references after a page changes so the agent can inspect fresh controls. Site sign-in and human-verification challenges can still require user involvement.

See [browser profiles](BROWSER-IMPORT.md), [passwords](BROWSER-PASSWORDS.md), [optional filtering](BROWSER-PROTECTION.md) and [tab cleanup](docs/browser-task-cleanup-20261030.md).

### Workbench: persistent Windows applications

Workbench uses a **persistent Windows guest on Hyper-V** for native application work. The guest and its installed applications are reused across tasks. This is the current application workspace; the former host Applications surface is retired. The workspace includes host application inventory, rescan/install batches, saved batch results, retrying missing applications, guest pairing and shared folders.

The installer includes the native FreeRDP viewer, which opens a separate **BLACKICE Agentic Workbench** window using the same guest. User/agent control ownership is shared across the guest tools and native input. The native window provides **Take/Cede** controls, plain-text clipboard sharing and automatic guest sizing when the paired guest supports them. Clipboard sharing and automatic sizing follow user-control ownership.

**The native viewer is a preview.** The 2.39.15 release verifies its installed files and self-test; that check did not connect to a VM. Current acceptance is `local-preview` with `fullAcceptance: false`. Full visible-display and live guest-session acceptance remains incomplete. Installing the app does not by itself configure Hyper-V, install a guest or pair its agent.

Use the [Workbench setup guide](WORKBENCH-SETUP.md) for prerequisites and setup, the [native display document](WORKBENCH-NATIVE-DISPLAY.md) for architecture and recorded preview limits, and the [published native integrity receipt](https://github.com/MoonlightClarity/BLACKICE/releases/download/v2.39.15/blackice-native-workbench-integrity.json) for what the current installer actually verified. Earlier design-document statements that the native runtime is not bundled predate this release.

## Workflows, agents and recurring work

In **Tasks → Workflows**, create or edit a workflow with connected agent stages and optional approval or output stages. Each agent has its own model, instructions and assignment. Dependencies determine ordering, and configured concurrency allows independent stages to run in parallel. Save the graph and run it when ready.

Agents can delegate work to other workers. Swarms/project plans organize tasks, dependencies, implementation and review attempts, and milestones. Saved plans and run histories expose what happened and support continuation. Some advanced project controls are available through tools and backend APIs.

Use **Tasks → Schedules** to inspect and configure recurring work, and **Tasks → Results** to review each occurrence. Scheduling supports:

- Manual, interval, calendar/cron and webhook triggers.
- Timezones, retry/stopping controls and overlap policies: skip, queue or parallel.
- A default policy that skips missed occurrences, or an explicit policy to run one missed occurrence within an age limit.
- Separate records for execution results, optional webhook delivery and human review.

The create form offers manual and calendar schedules; editing a saved schedule exposes interval/webhook triggers and additional controls.

**Compatible recurring single-agent tasks can continue the same conversation and plan.** Continuation applies to interval/cron workflows with one agent, serialized execution and compatible workflow, model and working-folder identities. Each occurrence still has its own run and result. A change to the agent's instructions can preserve that continuity.

Scheduled workflows use their configured model. Results remain available in BLACKICE, with optional HTTP(S) webhook delivery; they are not automatically pushed into the ChatGPT conversation that originally requested the task.

Schedules need an awake computer and a running BLACKICE instance. **Run in background** keeps the runtime active without the main desktop window. Windows sign-in startup can be configured through connector setup. Normal clean restarts can resume enabled schedules; explicitly stopped or uncertain work retains its recorded state for recovery.

## Knowledge, history and local data

Knowledge stores reusable notes, facts, assumptions, decisions and skills, with sources, relationships and retained revisions. Entries can apply generally or to a particular working folder. **Settings → Identity** holds editable instructions used to guide agents.

Saved conversations retain drafts and attachments across navigation. Conversation history and plans can be organized, archived and restored; supported Trash views retain recoverable entries. A transcript export is a readable copy of the conversation.

The installed desktop normally stores its profile in **`%APPDATA%\Relay`**. The historical folder and package names are retained for continuity. Files created in a chosen working folder remain ordinary files there. Cloud models and connected services receive the content sent to them.

For a manual backup, quit BLACKICE and copy the profile folder, or your selected custom profile, to a separate location. Back up working files stored elsewhere separately. Back up and quit before running an update installer. Uninstalling preserves the profile; moving to another account or computer can require signing into services again.

Direct actions have saved job IDs and results. After a disconnect, inspect the existing result before retrying an uncertain action. Saved plan revisions likewise allow human and agent edits to be checked against the current state. The [connector guide](CHATGPT-CONNECTOR.md) explains action recovery and native restart.

## Current project state

BLACKICE is under active development. This overview describes the public **2.39.15** checkpoint and its published evidence; later development checkouts can contain additional work.

Recent releases improved scheduled readiness checks, recovery from stale browser references, disclosure of partial results and the handling of explicitly retried operations. See [2.39.13](RELEASE-NOTES-2.39.13.md), [2.39.14](RELEASE-NOTES-2.39.14.md) and [2.39.15](RELEASE-NOTES-2.39.15.md).

| Verification for 2.39.15 | Recorded scope |
| --- | --- |
| [Windows source suite](https://github.com/MoonlightClarity/BLACKICE/blob/v2.39.15/verification/windows-2.39.15.json) | 6,957 passed, zero failed and nine optional skips across 606 test files. This is the recorded synthetic source suite for that release. |
| [Published installer](https://github.com/MoonlightClarity/BLACKICE/releases/download/v2.39.15/blackice-windows-install-validation.json) and [release receipts](https://github.com/MoonlightClarity/BLACKICE/releases/download/v2.39.15/blackice-release-receipts.json) | Exact Setup installation, installed integrity, Windows registration/shortcuts, clean uninstall with profile preservation, and profile backup/restore checks passed. |
| [Native Workbench](https://github.com/MoonlightClarity/BLACKICE/releases/download/v2.39.15/blackice-native-workbench-integrity.json) | Bundled native files and self-test verified; limited preview acceptance, without a live VM connection during that check. |

These records establish their stated checks. Live provider availability, arbitrary websites, visible desktop behavior and application compatibility require their own observations. Performance on large histories, advanced UI coverage and agent handoffs continue to be refined. Windows is the supported desktop target.

Some older design documents and evaluation reports describe previous checkpoints. Use versioned release notes, current source and matching release receipts when checking what a particular installer includes.

## Build from source

Use **Windows x64 and Node.js 22.12 or newer**:

```powershell
git clone https://github.com/MoonlightClarity/BLACKICE.git
cd BLACKICE
npm ci
npm run desktop
```

Useful commands:

| Command | Purpose |
| --- | --- |
| `npm test` | Run the source test suite. |
| `npm run desktop` | Run the Electron desktop application. |
| `npm run headless` | Run the Electron host without the main desktop window. |
| `npm start` | Run the plain Node developer server. Native desktop capabilities require the appropriate host and platform. |
| `npm run package:public` | Build a Windows Setup candidate. Follow the release guide for native build inputs and verification. |

Keep source checkouts separate from installed application files. Packaging creates a candidate; the repository's release workflow handles verification and publication. See [Windows releases](SIGNING-AND-RELEASE.md).

The main implementation lives in `desktop/` (Electron and native integration), `lib/` (runtime, tools, persistence and scheduling), `public/next/` (current interface), `skills/planning/` (planning instructions) and `tests/`.

## Further documentation

| Topic | Guide |
| --- | --- |
| ChatGPT connection, startup, action recovery and restart | [ChatGPT connector](CHATGPT-CONNECTOR.md) |
| Remote connections and the agent API | [Remote access](REMOTE-ACCESS.md) |
| Planning, shared edits and organization | [Recursive planning](docs/RECURSIVE-PLANNING.md), [shared editing](PLANNING-AWARENESS.md), [organization](PLANNING-ORGANIZATION.md), [practical judgment](docs/METACOGNITION.md) |
| Browser sessions and credentials | [Import](BROWSER-IMPORT.md), [passwords](BROWSER-PASSWORDS.md), [filtering](BROWSER-PROTECTION.md) |
| Native application workspace | [Workbench setup](WORKBENCH-SETUP.md), [native display](WORKBENCH-NATIVE-DISPLAY.md) |
| Frontend and development | [Frontend](FRONTEND-V2.md), [UI controls](docs/FRONTEND-UI-CONTROLS.md), [development tools](docs/frontend-development.md) |
| Packaging and release evidence | [Windows releases](SIGNING-AND-RELEASE.md), [published releases](https://github.com/MoonlightClarity/BLACKICE/releases) |

BLACKICE's original source is licensed under [Apache License 2.0](LICENSE). Bundled components retain their own licenses; see [Third-party notices](THIRD-PARTY-NOTICES.md). Corresponding native sources are included as a separate archive on the [release page](https://github.com/MoonlightClarity/BLACKICE/releases/tag/v2.39.15).
