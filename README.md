# BLACKICE

**An open-source, autonomy-first Windows workspace for AI agents that do real work—and can show what actually happened.**

BLACKICE connects AI models to a contained browser, local files and commands, persistent task records, and scheduled workflows. Run a supported model inside BLACKICE, or let an external assistant use the same tools through an authenticated MCP connection. Direct tool calls execute on the Windows host without silently launching a second model.

BLACKICE is being developed as an **agent execution and continuity system**, not merely a chat interface. The user owns the objective and constraints; the agent should be able to plan, act, make proportionate decisions under uncertainty, recover from interruptions, and continue without repeatedly transferring routine work back to the user. The system should preserve enough evidence to distinguish a proposed action from one actually completed.

**[Download for Windows](https://github.com/MoonlightClarity/BLACKICE/releases)** · **[Source](https://github.com/MoonlightClarity/BLACKICE)** · **[Issues](https://github.com/MoonlightClarity/BLACKICE/issues)** · **[Apache-2.0 license](LICENSE)**

## Source version and Windows releases

**BLACKICE 2.40.75 is published**, completing the browser, continuity, Directory and MiniCPM integration with connector-discovery and provider-persistence corrections. The [published release](https://github.com/MoonlightClarity/BLACKICE/releases/tag/v2.40.75) targets commit [`3fc873c8`](https://github.com/MoonlightClarity/BLACKICE/commit/3fc873c8394fb8381456c305cd91068ce9b98eac); documentation corrections made afterward do not change its installer. See the [2.40.75 release notes](RELEASE-NOTES-2.40.75.md), [instruction clarity guide](docs/instruction-clarity.md), and [instruction audit guide](docs/instruction-audit.md) for the changes and their qualification limits.

Published Windows installers, build manifests, and tagged source archives are listed on the [Releases page](https://github.com/MoonlightClarity/BLACKICE/releases). The [2.40.75 release](https://github.com/MoonlightClarity/BLACKICE/releases/tag/v2.40.75) includes its installer, `SHA256SUMS.txt`, and separate Windows validation evidence; the [fresh Windows release workflow](https://github.com/MoonlightClarity/BLACKICE/actions/runs/45091943186) passed. A release tag identifies its source snapshot; the current branch and an installed version can differ. Match the installer checksum and application fingerprint to that release's evidence instead of selecting a build by filename or timestamp alone.

> **Evidence boundary:** This README describes the current source. Version-specific release notes and verification records establish what was packaged, installed, and tested. Source tests, renderer checks, and synthetic trials do not establish that every external integration works or that complex tasks reliably complete unattended. Check the exact installer’s manifest and verification records for its build identity, hashes, and signing status.

**Guide:** [Direction](#where-blackice-is-going) · [Getting started](#getting-started) · [Capabilities](#what-you-can-delegate) · [Models](#models-and-providers) · [Planning and Activity](#planning-and-activity) · [Goals and continuing work](#goal-mode-and-continuing-work) · [Troubleshooting](#configuration-and-troubleshooting) · [Contributors](#contributors)

## Where BLACKICE is going

The central challenge is **reliable long-horizon delegation**: not just producing plausible plans, but acting on them, recovering from interruptions, and checking outcomes without making the human manage every step. BLACKICE is intended to provide the environment and durable execution state around whichever supported model is doing the reasoning.

**User-directed agency.** The agent should follow the user's objective and binding constraints, infer reasonable next steps, and treat ordinary uncertainty as a problem to work through—not an automatic request for approval or a reason to abandon the task. Website text, model suggestions, and third-party preferences are evidence to evaluate, not instructions that override the user. Actual tool, access, and other applicable limits still matter. This is a design goal, not a guarantee of autonomous success.

**Planning + Action Directory.** Planning represents what needs doing and how work depends on other work. Action Directory focuses on what was attempted, what inputs and observations support it, which effects are confirmed or unresolved, and what can happen next. The current system has separate Planning and Action Directory controls; the ongoing architectural work is to make their records support recovery across model-context boundaries, failed calls, interrupted tasks, and changing plans. User instructions and observed facts must remain distinguishable from agent assumptions. The goal is useful task-state continuity, not arbitrary step counts or token caps masquerading as progress; real model context and resource constraints still apply.

**Coordination as project management.** Independent agents can be useful, but multiplying workers is not itself the objective. A proposed **Swarm project-management** layer would give users and workers a shared view of scopes, owners, dependencies, blockers, integration status, and evidence. This is distinct from the **retired automatic Swarm execution system** and is **not a shipped workspace** in 2.40.75.

**Interoperability without lock-in.** Codex is the primary native integration, with a two-way relationship: BLACKICE can use Codex for inference, while supported external assistants can use BLACKICE's tools directly. Optional API and local models widen the choice, but model support, tool use, context capacity, and cost are specific to each route. A saved conversation should retain the model identity and work record it actually used.

**Measure real recovery, not just prompt quality.** Current evaluation work emphasizes difficult, reproducible tasks that compare a plain baseline with Planning-only, Directory-only, and combined Planning + Directory execution. Interruption, stale browser state, failed tool effects, context loss, prompt-injection attempts, and destination verification matter more than a model merely saying it completed the task. This benchmark direction is under development; it is not a published reliability score.

## Current capability and evidence boundaries

The distinction between an implemented tool, a verified integration, and a reliably completed real-world task matters. These boundaries describe the **2.40.75 source**; installed versions and provider capabilities can differ.

| Area | What the current source provides | What is **not** established |
| --- | --- | --- |
| **Direct external-assistant tools** | An authenticated MCP connection can let a configured ChatGPT conversation call BLACKICE file, command, browser, and planning tools. Ordinary direct tools return to the originating assistant without starting a second BLACKICE model; explicit start tools can launch the selected BLACKICE model. | Every external client, installation, grant, or remote connection working automatically. Gemini and Claude have separate documented setup and compatibility requirements. |
| **Browser, file, and command actions** | A contained browser with observed controls; bounded file operations and patches; command execution; durable action IDs and readable receipts. | Universal website compatibility, uninterrupted multi-page forms, failure-free filename discovery, or exactly-once effects on external sites. |
| **Conversation and work records** | Saved conversations, explicit task/graph records, retained-event Activity views, and captured instruction-source audits; configured model/provider identity persists with a conversation. | Reconstruction of instructions never captured in older runs, an always-running Swarm coordinator, or proof that long-running tasks cannot encounter context or state contamination. |
| **Continuing work** | Goal controls and editable Cronjobs with run records; compatible single-agent queue/skip schedules can continue an existing task and conversation. | Fully unattended, end-to-end job-search reliability or execution while the Windows host is off. |
| **Skills and model choices** | Owner-editable Skills with revision tracking and read-only model retrieval; native Codex, an optional Mistral Vibe Code account connection, and advanced API or local-model configurations. SOUL.md supplies owner behavior and selected Skills supply task procedures. | Automatic learning, guaranteed local-model tool use, or free access to a particular hosted provider. Existing captured turns retain the instruction text they actually used. |

**Historical capability boundaries:** The [2.40.6 notes](RELEASE-NOTES-2.40.6.md) document retired Planning, Directory, memory/automatic-learning, and Autonomy/Swarm execution paths, along with unresolved legacy dependencies. Historical files can remain on disk; their presence does not establish that an old execution path is active. Use the current tool catalogs and version-specific release notes when assessing an installed version.

## Still in active development

- **Planning + Action Directory recovery.** Preserve action-linked inputs, decisions, observed results, failed attempts, user authority, and next steps across context changes and interrupted runs. The 2.40.75 continuity improvements have focused regression coverage, but long-run recovery across real providers and workflows is not yet qualified.
- **Autonomy that keeps making progress.** Improve browser control recovery, tool-effect reconciliation, task deadlines, efficient search, and proportionate decisions under uncertainty. A failed page interaction or imperfect intermediate result should not needlessly stop unrelated work. Real multi-site workflows, including job-search diagnostics, expose gaps; they are not evidence of reliable unattended submission.
- **Shared project coordination.** Explore Swarm as user-and-agent project management with inspectable ownership, dependencies, blockers, evidence, and integration—not as a return of the removed automatic Swarm orchestration engine. No new Swarm management UI is claimed as released.
- **Evaluations and local models.** Build harder Planning/Directory comparison and cascade-recovery tests with independent controls, realistic interruptions, and inspectable scoring. MiniCPM runtime/tool-contract fixes are present; a reproducible completed MiniCPM score and validated sampler/thinking comparison are still pending.
- **ChatGPT connection and hosted schedules ([#25](https://github.com/MoonlightClarity/BLACKICE/issues/25)).** The direct MCP route is implemented, and custom MCP connection creation is available across personal tiers. Each account/endpoint route still needs matching OAuth, owner authorization, attached-tool and actual status/command receipts; endpoint discovery alone does not establish those results. Hosted ChatGPT scheduled runs remain unverified. A public plugin listing is a separate, unshipped route.

The closed-source context-management proposal and weight-modification experiments remain deferred research. None of these priorities implies a shipped capability, a completed benchmark, or a verified end-to-end success rate.

## Why BLACKICE exists

Useful work often crosses several tools and sessions. Research requires opening sources, comparing evidence, and producing something usable. A software change requires inspecting files, making an edit, running checks, and reviewing the result. An application requires finding the right form, supplying information, submitting it, and recording the outcome.

Coordinating all of that can become a second job for the person delegating it. BLACKICE brings the working environment, reasoning controls, execution tools, and records of what happened into one place.

| What the user needs | What BLACKICE supplies | Practical benefit |
| --- | --- | --- |
| **Get work carried out** | Browser actions, file operations, commands, and connected tools available to the assistant. | Delegate the steps involved in producing a result, including applying edits and checking the destination. |
| **Explain the task less often** | Saved conversations, task records, saved workflow graphs, and owner-controlled skills. | Carry relevant information and prior progress into continuing work. |
| **Stay in control of the approach** | Model selection, per-conversation reasoning controls, visible browser pages, and inspectable plans and action history. | Adjust how the agent works and inspect the material behind its decisions. |
| **Understand what actually finished** | Command outputs, file patch receipts, browser observations, and recorded action states. | Review a result, investigate a failure, or resume an interrupted action using concrete records. |
| **Repeat useful work** | Cronjobs with saved workflow settings, schedules, overlap handling, and run history. | Configure recurring work once and review its subsequent runs. |
| **Use an existing assistant** | Native model runtimes, compatible API providers, and direct MCP connections. | Keep a preferred supported assistant while giving it access to the same Windows workspace. |

These are the benefits the product is designed to deliver. Actual completion and time saved depend on the task, chosen model, available tools, and external systems.

## What you can delegate

BLACKICE is a general workspace. These examples show how its capabilities combine into recognizable tasks.

| Example request | How the assistant can carry it out | What you should get back |
| --- | --- | --- |
| **“Research these options and recommend one.”** | Read local material, browse sources, split independent questions among workers when useful, and compare findings. | A recommendation or document with supporting sources, tradeoffs, and unresolved questions. |
| **“Fix this bug and check the result.”** | Inspect the repository, edit the relevant files, run commands or tests, and inspect their output. | The actual changes, the checks performed, and the observed result. |
| **“Complete this website workflow using these files.”** | Navigate pages, inspect controls, fill forms, upload documents, and observe the resulting page. | The destination's confirmation or a precise account of the remaining step. |
| **“Find suitable roles and apply using my resumes.”** | With a compatible model and supported websites, evaluate roles against stated constraints, prepare forms, upload materials, and consult application history before submission. | Records that distinguish destination-confirmed, pending, and unresolved application outcomes; not an assurance that every application completed. |
| **“Run this check every morning.”** | Save the prompt, model, working folder, and relevant context in a scheduled workflow. | A history of runs and their results that you can inspect, edit, pause, or resume. |

The selected model performs the reasoning. BLACKICE supplies the workspace, tools, orchestration, and records around that reasoning. Native Codex and configured API models can supply inference while your Windows computer hosts the working environment.

## Work in BLACKICE or from an external assistant

### Inside BLACKICE

**Codex is the primary native subscription runtime.** Install and authenticate the [Codex CLI](https://github.com/openai/codex) separately, then choose an available Codex model in BLACKICE. **Optional Mistral account** under **Config → Models → Accounts** connects through the separately installed official Mistral Vibe Code CLI. It requires sign-in and a compatible model advertised by that CLI. Its [ACP compatibility guide](docs/mistral-acp-compatibility.md) records catalog and native-version limits; controlled adapter tests do not qualify every live account or CLI version.

Other compatible API endpoints (including OpenAI Responses, Anthropic Messages, and OpenAI Chat Completions-style services) are **optional advanced integrations**; the current Models UI labels these unsupported, and their compatibility, tool support, quotas, and pricing depend on the provider. Retired native CLI integrations are not new-model options. Saved history can remain inspectable, but incompatible legacy native-session formats are rejected rather than silently migrated or resumed.

Conversations retain their recorded model and provider. Changing the default affects the appropriate future selections while preserving the identity of earlier work. BLACKICE keeps its own conversation history so a continuing task can retain useful context.

**Why this helps:** you can choose a model appropriate to the task and keep its execution environment, files, and work history together.

Configure native or optional model connections under **Config → Models** and the new-chat default under **Config → General**. For the separate direct ChatGPT connection, see the [connector guide](CHATGPT-CONNECTOR.md).

### From an external assistant

A configured direct MCP connection lets an external assistant call BLACKICE's file, command, browser, and planning tools. The assistant reasons in your existing conversation; BLACKICE executes the requested tool action and returns its result. A direct action does not require another model call inside BLACKICE.

**Why this helps:** you can continue working in a supported assistant you already use and give it practical access to your Windows workspace. Files, browser tasks, and command results can become part of that conversation without manually carrying every instruction between applications.

For the verified local setup path, see the [ChatGPT connector guide](CHATGPT-CONNECTOR.md). Other external-assistant connectors depend on the particular host and integration; they are not automatically available simply because BLACKICE is installed.

## Models and providers

**Codex, optional Mistral and hosted models.** For primary native inference, install and sign in with the [Codex CLI](https://github.com/openai/codex) separately from BLACKICE. The optional Mistral account connection uses Mistral Vibe Code rather than an API key; it does not promise complete account-catalog parity. Check **Config → Models → Accounts** and choose the exact model for a chat or set a default in **Config → General**. Saved conversations retain their original model/provider identity. Native Codex uses your account's access and quotas; optional hosted API connections use the provider's API address, model ID and required credentials. A model listed as free or accessible today may still have limits, and **some providers charge for API calls**. BLACKICE does not supply paid credits or guarantee third-party endpoint compatibility.

**Local models.** Config → Models → Local models supports the included Windows x64 llama.cpp runtime and separately installed Ollama or LM Studio services. For llama.cpp, choose **Load GGUF file…** and confirm an existing model file. To switch to a saved model, choose it and click **Load**. GGUF weights are not bundled or automatically downloaded. The pinned runtime probes Vulkan and falls back to an independent CPU build; actual status, model support and performance depend on the hardware and model.

**Advanced llama.cpp setups.** Existing custom executables and external servers remain supported. Saving launch settings does not restart a server. A later discovery or load can apply those settings by restarting an idle BLACKICE-owned router; active work reports a retryable deferral rather than being interrupted. See [local models](docs/local-models.md) and [prior runtime validation plan](docs/RELEASE-2.39.102-VERIFICATION.md). The published 2.40.75 installer contains the pinned runtime and passed native installation checks; actual model performance and compatibility on another host remain separate questions.


## A browser the user and agent can work in

The contained browser supports navigation, readable page and control snapshots, screenshots, clicks, typing, selection, keyboard actions, scrolling, uploads, downloads, and supported dialogs. The user can view and interact with the same pages inside BLACKICE. Browser screenshots and Planning/other recorded visual views help inspect what the agent saw or mapped; a visual display is evidence to review, not proof of an external outcome.

Agents can inspect the current page before acting and inspect the result afterward. Task ownership and page identity help associate actions with the intended tab and document. Browser diagnostics provide additional information when an interaction fails.

**Why this helps:** multi-page tasks can stay with the agent while you retain visibility into the actual website. You can supply a missing login or intervene on a page, then continue the task with the surrounding work still available.

Website authentication, challenges, and unsupported controls can still require intervention. Completion of a web task is established by the destination's observed result.

## Files and commands that produce inspectable changes

BLACKICE can read and search local files, create text files, apply focused patches, and run commands in a chosen working folder. It captures command output and exit codes. Patch receipts record the before and after content and support guarded undo.

Direct actions have durable identifiers and saved results. If the connection drops, an assistant can retrieve the existing action's status before deciding what to do next. For supported consequential actions, recorded identities and uncertainty handling help prevent accidental repeats.

**Why this helps:** the assistant can move from an explanation to a real change, then check that change. When something goes wrong, you have a concrete file diff, command result, or action record to inspect and continue from.

The installed Windows account and available applications determine which files and commands the host can use.

## Planning and Activity

Ordinary Chat can run with **Planning** and **Directory** off. Their current per-chat controls are separate: Planning creates task work records, while Action Directory organizes execution around the current task's actions and observations. **Config → General → New Chat defaults** changes the defaults for future chats; existing chats retain their settings. The old module-selection switches and former Directory context editor remain retired.

**Goal controls** let you state and inspect an objective for a conversation. The retained Planning view also provides access to saved graph requests: explicit objectives, steps, dependencies, and recorded responses. These are inspectable work records, not a claim that an automatic coordinator is always running.

**Activity** reads retained updates, tool calls, and available structured outputs for the selected run. Internal outputs are opt-in. Activity does not create work, edit context, or expose private reasoning. Ordinary artifacts and conversation history remain available.

### Skills and organization

The **Skills** workspace presents bundled methods with explicit human editing. Select a skill, edit its single document directly, then choose **Save**. The document is authoritative; no separate title, summary, usage or scope fields are maintained. Folder names support inline rename, dragging and Ctrl+Enter indentation (Ctrl+Shift+Enter moves a folder out). Edits survive restart and are used on the next explicit model skill read; they do not rewrite bundled originals or inject themselves into existing conversations. Conflicting saves retain your draft instead of overwriting another edit. Use **Delete skill** to remove a skill from the catalog and future skill lookups. An inline confirmation explains any unsaved changes that will be discarded. **Deleted skills** offers Restore: it recovers your saved edit, or the current bundled default if you never edited it. Deleted skills retain folder placement. Model skill tools remain search/read-only. Nested folders organize the view without changing contents or creating learned memory. Browser tab folders are also nested and preserve the tabs' ownership boundaries.

The **Knowledge/memory**, **My workflows**, and **To-do** workspaces are removed. This does not remove the separate saved workflow graph manager under **Cronjobs**, or the core task and delegation tools. Previously saved files are not automatically deleted merely because their UI or service was retired.

### Current navigation and compatibility limits

The top-level workspaces are **Chat, Cronjobs, Browser, Skills, and Config**. Saved workflow graphs are available through **Cronjobs → Manage saved workflows**. Planning is a retained task-inspection route, not a top-level tab.

Automatic learning, the former Autonomy/Swarm execution system, and the old module-selection UI remain retired. Current Action Directory and conversation-scoped Goal autonomy are supported independently of those retired systems. The repository-wide zero-legacy inventory is not complete; this release must not be read as a guarantee that every historical reference or compatibility path has been eliminated. Incompatible legacy native sessions are rejected rather than migrated. Preserve any history you need and start a current session instead of assuming an old native session can continue.

## Parallel work and saved workflow graphs

Core delegation remains available for independent research questions or implementation steps. Saved workflow graphs can retain explicit agent nodes, dependencies, and model settings. These capabilities are separate from the removed Swarm UI and automatic orchestration machinery.

**Why this helps:** separable work can progress together, and its outputs can be inspected before they are combined. Coordination still costs time and model usage; the selected model and task determine whether delegation is useful.

## Goal Mode and continuing work

An ordinary chat can use available tools for the current request and then stop. **Goal Mode** tracks an explicitly stated objective, progress, and completion or unresolved effects, with pause and resume controls. A goal does not authorize unrelated work or establish that an external action succeeded.

The composer shows **Autonomy: Off** until enabled. Its calibration editor saves the objective and optional limits; **Turn on autonomy** continues the same conversation through the Goal engine. Turning it off pauses further continuation and requests cancellation of the active turn. See the [Goal mode guide](docs/GOAL-MODE.md) for completion, deadline, wait and recovery semantics. This does not restore the former Swarm coordinator or automatic model-selection system.

The design intent is **best-effort execution under the user's authority**: make routine, reasonable choices without repeated approval loops; isolate a real blocker to the affected action; and continue other useful work when possible. Respect explicit Goal boundaries, deadlines, tool capabilities, and the user's corrections. These principles describe the behavior being pursued, not proof that every current model follows them.

A saved uncertain action receipt is not proof of success or failure. Inspect the destination and the likely consequences before repeating a consequential action; preventing some duplicate in-flight work does not guarantee exactly-once delivery to an external website. Uncertainty about one action does not automatically invalidate the entire goal.

## Recurring work with Cronjobs

The **Cronjobs** workspace lets you create, inspect, edit, pause, and resume schedules. Saved workflows can retain prompts, models, working folders, attachments, and worker settings. Schedules expose overlap handling, retries, run limits, previews, and result history.

Recurring single-agent cron or interval jobs configured to **queue or skip overlapping runs** can continue the same task and conversation when their prior run and saved configuration are compatible. This gives eligible ongoing work a way to retain progress between runs.

**Why this helps:** recurring research, checks, and other supported work can use a repeatable setup. You can review the history, adjust the instructions, and pause the schedule from one place.

The Windows host must be awake and BLACKICE must be running. Scheduled results are saved in BLACKICE; delivery to another service depends on a configured delivery path.

## How to judge whether a task worked

**Example: repair a small bug in a local project.** Set that repository as the working folder and ask: *“Identify why this settings value resets, change only the necessary files, run the relevant tests, and show me the diff and results.”* First the model **inspects** code and may **plan** an edit; neither step has changed the application. Next it may **execute** a patch and tests through the attached tools. Inspect the actual changed files, test command/exit code, and observed behavior. Only describe the requested fix as **confirmed** when evidence relevant to the bug supports it. If tests fail or the behavior was not checked, keep the result partial or unresolved.

**External actions require extra care.** Preparing a form, clicking Submit, and obtaining an acceptance receipt are different events. If a connection ends after a possible submission, the outcome is **uncertain**: that is not proof of success *or* failure. Inspect the recorded action and any actual destination confirmation or history before deciding whether a retry is safe. Keep the affected action unresolved if it cannot be reconciled; do not blindly replay it.

Look for evidence appropriate to the requested outcome:

- **A website submission:** the destination's confirmation or an accurately recorded unresolved state.
- **A software change:** the changed files, relevant checks, and observed behavior.
- **A research request:** supported findings and the requested usable answer or artifact.
- **A scheduled task:** the run's actual result and progress carried into subsequent work.

BLACKICE keeps action and task records to make these checks possible. Supported application workflows use submission history and action claims to help avoid duplicates. Failed, pending, and uncertain work should remain distinguishable from confirmed outcomes.

The aim is to reduce supervision while making results easier to verify. Reliability still depends on the selected model, the workflow, and the external system; this README does not promise a fixed completion rate or productivity improvement.

## Getting started

1. **Install on 64-bit Windows.** Open the [published Windows releases](https://github.com/MoonlightClarity/BLACKICE/releases), read the release notes and installer/checksum information, run the appropriate `Blackice-<version>-Setup.exe`, and launch BLACKICE from its shortcut. The Windows x64 installer bundles the desktop application and a pinned llama.cpp runtime. It does **not** bundle your model account, cloud API quota, model weights, or separate Ollama/LM Studio services.
2. **Connect a model.** For the supported native route, install and sign in to the [Codex CLI](https://github.com/openai/codex) separately. Check **Config → Models → Accounts** and choose an available model in **Config → General** or Chat. If you prefer an optional API or local endpoint, configure and verify it deliberately in **Config → Models**.
3. **Choose the workspace.** In **Config → General**, select a working folder and start **Chat**. Supply any relevant files and constraints. For ChatGPT using BLACKICE directly, follow the separate [connector setup](CHATGPT-CONNECTOR.md), which may require Tailscale and an authorized MCP connection.
4. **Choose the model and reasoning controls.** Select the model, available reasoning effort, and context options for your chat. Use the current chat's **Planning** and **Action → Directory** controls as needed, and **Autonomy (Goal)** for an explicit continuing objective. The older Planning-module selection interface is retired.
5. **Try a first task.** Ask: *“Create `blackice-check.txt` in the working folder containing `BLACKICE file check`, read it back, and tell me the file path and exact content.”* Verify that the actual file and content exist; a model assertion alone is not enough.
6. **Inspect and continue.** Review the browser state, file changes, command outputs and action receipts. Correct or resume the same conversation as needed; use **Cronjobs** if the work should repeat on a schedule.

Model accounts, API keys, quotas, and service capabilities come from the selected provider. BLACKICE runs the workspace and tools on your host.

## Configuration and troubleshooting

**Instructions you control:** In Config → Behavior & profile, open **Instructions** beside SOUL.md and USER.md to edit the common instruction text, review its saved revisions, and inspect the exact sources captured for an execution. Saved text is pinned across upgrades; model tools have no save/restore operation and structured file mutations are denied. The [instruction guide](docs/instruction-audit.md) explains the application-level boundary and the remaining authority of unrestricted shell/development access. See the [2.40.68 release notes](RELEASE-NOTES-2.40.68.md).

**Find the controls.** **Config → General** holds the working folder, default model, runtime preferences and new-chat defaults. **Config → Models** contains **Accounts**, **Local models**, and **Add API**. **Config → App connections** contains the **ChatGPT**, **Gemini**, **Claude**, and **Other MCP apps** guides for external clients calling BLACKICE. The **Chat** composer retains model, reasoning, context, Planning, Directory and Goal autonomy controls. There is no separate **Tools** tab in the current Config workspace; an imported external-tool configuration still needs a successful live connection before its tools are usable.

- **Slow startup or an unresponsive model:** check **Config → Troubleshooting** and the model connection status. Distinguish app startup from a Codex sign-in, unavailable server, or model request. The UI exposes **Refresh** and **Reconnect model runtime**; inspect the returned state before considering a restart, and preserve unfinished work.
- **Missing provider or model:** verify the Codex CLI is installed and authenticated, or that the explicitly configured API/local server is reachable. Refresh its model list, check the exact model and provider quota, and inspect any reported error. A downloaded llama.cpp archive alone is not a running server.
- **Missing tool:** inspect the current tool catalog and whether the relevant external-tool connection is enabled and actually connected; also check that the selected model supports tool use. Available tools depend on both the host and the active model.
- **After an update:** refresh runtime status and reconnect the model runtime only if needed. For direct ChatGPT use, reuse a healthy existing connection and verify a fresh status request. If its address or authorization changed, follow the [connector recovery instructions](CHATGPT-CONNECTOR.md) instead of blindly registering duplicates.

**Known limits:** the host must be running for tools and schedules; website authentication, changing pages, unsupported controls, and model/tool incompatibility can interrupt work; external action receipts can remain uncertain. **File discovery, long-run context isolation, startup variability, and multi-site job-search throughput remain validation priorities.** One successful focused or synthetic check must not be generalized into a reliability guarantee. Source-level fixes are **not installed-release guarantees**. Incompatible legacy native sessions are rejected, old v1/v2 effects may remain unreconciled, and the repository-wide zero-legacy inventory remains incomplete.

### Data and remote access

**Config → Storage & Data** shows disk usage and selective cleanup controls. User-selected cleanup is scheduled for the next application startup and can be cancelled before it runs. Custom external working folders remain outside app-managed cleanup.

A running Windows host can expose its authenticated tools over configured HTTPS connectivity, including supported Tailscale configurations. Remote access lets an external assistant use that host's workspace while it is running and reachable. See [remote access](REMOTE-ACCESS.md) and [ChatGPT connection setup](CHATGPT-CONNECTOR.md).

## Contributors

Thanks to [@jweter (PR #24)](https://github.com/MoonlightClarity/BLACKICE/pull/24) for optional Tailscale Funnel HTTPS port **10000**, with explicit CLI opt-in and preservation of existing routes.

### Build from source

Requirements: supported **64-bit Windows** and **Node.js 22.23.5 or newer**, matching the minimum in `package.json`.

```powershell
git clone https://github.com/MoonlightClarity/BLACKICE.git
cd BLACKICE
npm ci
npm run desktop
```

**Windows PowerShell:** If `npm` reports that `npm.ps1` cannot run because script execution is disabled, use `npm.cmd`; for example, `npm.cmd ci` and `npm.cmd run desktop`. The same substitution applies to the other npm commands below and in the release guide. This invokes npm's Windows command launcher without changing your PowerShell execution policy.

| Command | Purpose |
| --- | --- |
| `npm run desktop` | Start the Electron app. |
| `npm run headless` | Start the runtime without the normal main window. |
| `npm test` | Run the source test suite. |
| `npm run docs:check` | Check documentation classification, current-version links and local targets. |
| `npm run release:check` | Run release validation. |
| `npm run package:public` | Build an unsigned Windows installer candidate. |

### Repository map and contributions

`desktop/` contains Electron startup and desktop integration; `lib/` contains the agent runtime and tool services; `public/` contains the interface; `server.mjs` starts the local server; `tests/` holds regression tests; `scripts/` has build and verification tooling; `docs/` contains more detailed guides. Use the exact checkout's scripts and acceptance criteria for the feature under change.

The tracked [release availability-retirement helper](scripts/release-availability-retirement.mjs) and its [composed regression tests](tests/release-availability-retirement.test.mjs) support qualification controllers that must retire a matching, already-offline availability responder before installing a candidate. The controller still proves native process identity and installation readiness. This is release tooling; ordinary app shutdown, the updater and NSIS behavior are unchanged by that helper. See the [release qualification procedure](SIGNING-AND-RELEASE.md#release-qualification-and-the-availability-responder).

See [frontend development](docs/frontend-development.md) and [release/build verification](SIGNING-AND-RELEASE.md) for current procedures. The preserved [UI validation record](UI-VALIDATION.md) describes an earlier interface; use current native fixtures and their observed results for the release being checked. Source tests are not a substitute for verification of a packaged installer. Report bugs and propose changes through [Issues](https://github.com/MoonlightClarity/BLACKICE/issues) and [Pull requests](https://github.com/MoonlightClarity/BLACKICE/pulls).

BLACKICE-authored code is licensed under [Apache-2.0](LICENSE). Third-party dependencies retain their own licenses.
