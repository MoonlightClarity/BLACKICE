# BLACKICE

**An open-source Windows workspace that gives AI assistants the tools, context, and continuity to carry out useful work.**

BLACKICE connects an assistant to a browser it can operate, files it can read and change, commands it can run, saved task history, and scheduled workflows. You can use an assistant inside BLACKICE or connect an external assistant to its tools.

The goal is to reduce the work of managing the agent: copying instructions between apps, repeating background information, keeping track of unfinished steps, and checking whether a claimed result actually happened. You define the outcome and relevant constraints; BLACKICE gives the assistant a place to execute, keeps the work inspectable, and lets you intervene when needed.

**[Download for Windows](https://github.com/MoonlightClarity/BLACKICE/releases)** · **[Source](https://github.com/MoonlightClarity/BLACKICE)** · **[Issues](https://github.com/MoonlightClarity/BLACKICE/issues)** · **[Apache-2.0 license](LICENSE)**

> **Source guide:** This README describes the current source, not proof of an installed or published build. Check the [published release notes](https://github.com/MoonlightClarity/BLACKICE/releases) for the exact installer you use. Source tests and renderer checks do not establish packaged-installation success.

**Guide:** [Getting started](#getting-started) · [Capabilities](#what-you-can-delegate) · [Models](#models-and-providers) · [Planning and Activity](#planning-and-activity) · [Goals and continuing work](#goal-mode-and-continuing-work) · [Troubleshooting](#configuration-and-troubleshooting) · [Contributors](#contributors)

## Why BLACKICE exists

Useful work often crosses several tools and sessions. Research requires opening sources, comparing evidence, and producing something usable. A software change requires inspecting files, making an edit, running checks, and reviewing the result. An application requires finding the right form, supplying information, submitting it, and recording the outcome.

Coordinating all of that can become a second job for the person delegating it. BLACKICE brings the working environment, reasoning controls, execution tools, and records of what happened into one place.

| What the user needs | What BLACKICE supplies | Practical benefit |
| --- | --- | --- |
| **Get work carried out** | Browser actions, file operations, commands, and connected tools available to the assistant. | Delegate the steps involved in producing a result, including applying edits and checking the destination. |
| **Explain the task less often** | Saved conversations, task records, saved workflow graphs, and release-owned skills. | Carry relevant information and prior progress into continuing work. |
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
| **“Find suitable roles and apply using my resumes.”** | Evaluate roles against your constraints, prepare forms, upload materials, and consult application history before submission. | Distinct application records with confirmed, pending, or unresolved outcomes. |
| **“Run this check every morning.”** | Save the prompt, model, working folder, and relevant context in a scheduled workflow. | A history of runs and their results that you can inspect, edit, pause, or resume. |

The selected model performs the reasoning. BLACKICE supplies the workspace, tools, orchestration, and records around that reasoning. Native Codex and configured API models can supply inference while your Windows computer hosts the working environment.

## Work in BLACKICE or from an external assistant

### Inside BLACKICE

**Codex is the supported native subscription runtime.** Install and authenticate the [Codex CLI](https://github.com/openai/codex) separately, then choose an available Codex model in BLACKICE. Other compatible API endpoints (including OpenAI Responses, Anthropic Messages, and OpenAI Chat Completions-style services) are **optional advanced integrations**; the current Models UI labels these unsupported, and their compatibility, tool support, quotas, and pricing depend on the provider. Retired native CLI integrations are not new-model options. Saved history can remain inspectable, but incompatible legacy native-session formats are rejected rather than silently migrated or resumed.

Conversations retain their recorded model and provider. Changing the default affects the appropriate future selections while preserving the identity of earlier work. BLACKICE keeps its own conversation history so a continuing task can retain useful context.

**Why this helps:** you can choose a model appropriate to the task and keep its execution environment, files, and work history together.

Configure native or optional model connections under **Settings → Models** and the new-chat default under **Settings → General**. For the separate direct ChatGPT connection, see the [connector guide](CHATGPT-CONNECTOR.md).

### From an external assistant

A configured direct MCP connection lets an external assistant call BLACKICE's file, command, browser, and planning tools. The assistant reasons in your existing conversation; BLACKICE executes the requested tool action and returns its result. A direct action does not require another model call inside BLACKICE.

**Why this helps:** you can continue working in a supported assistant you already use and give it practical access to your Windows workspace. Files, browser tasks, and command results can become part of that conversation without manually carrying every instruction between applications.

For the verified local setup path, see the [ChatGPT connector guide](CHATGPT-CONNECTOR.md). Other external-assistant connectors depend on the particular host and integration; they are not automatically available simply because BLACKICE is installed.

## Models and providers

**Codex and hosted models.** For native inference, install and sign in with the [Codex CLI](https://github.com/openai/codex) separately from BLACKICE. Check **Settings → Models → Codex subscription** and choose the exact model for a chat or set a default in **Settings → General**. Saved conversations retain their original model/provider identity. Native Codex uses your account's access and quotas; optional hosted API connections use the provider's API address, model ID and required credentials. A model listed as free or accessible today may still have limits, and **some providers charge for API calls**. BLACKICE does not supply paid credits or guarantee third-party endpoint compatibility.

**Local models.** Settings → Models → Local models supports the included Windows x64 llama.cpp runtime and separately installed Ollama or LM Studio services. For llama.cpp, choose an existing GGUF file, name it, and select **Save & load model**. GGUF weights are not bundled or automatically downloaded. The pinned runtime probes Vulkan and falls back to an independent CPU build; actual status, model support and performance depend on the hardware and model.

**Advanced llama.cpp setups.** Existing custom executables and external servers remain supported. Saving a new model catalog restarts only an idle BLACKICE-owned router; active work reports a retryable deferral rather than being interrupted. See [local models](docs/local-models.md) and [prior runtime validation plan](docs/RELEASE-2.39.102-VERIFICATION.md). This source preparation does not establish that an installed version contains the bundle.


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

Ordinary Chat does not require a Planning module selection or Directory mode. The old module switches, automatic planning loops, and Directory context editor are removed.

**Goal controls** let you state and inspect an objective for a conversation. The retained Planning view also provides access to saved graph requests: explicit objectives, steps, dependencies, and recorded responses. These are inspectable work records, not a claim that an automatic coordinator is always running.

**Activity** reads retained updates, tool calls, and available structured outputs for the selected run. Internal outputs are opt-in. Activity does not create work, edit context, or expose private reasoning. Ordinary artifacts and conversation history remain available.

### Skills and organization

The **Skills** workspace presents bundled methods with explicit human editing. Select a skill, edit its single document directly, then choose **Save**. The document is authoritative; no separate title, summary, usage or scope fields are maintained. Folder names support inline rename, dragging and Ctrl+Enter indentation (Ctrl+Shift+Enter moves a folder out). Edits survive restart and are used on the next explicit model skill read; they do not rewrite bundled originals or inject themselves into existing conversations. Conflicting saves retain your draft instead of overwriting another edit. Model skill tools remain search/read-only. Nested folders organize the view without changing contents or creating learned memory. Browser tab folders are also nested and preserve the tabs' ownership boundaries.

The **Knowledge/memory**, **My workflows**, and **To-do** workspaces are removed. This does not remove the separate saved workflow graph manager under **Cronjobs**, or the core task and delegation tools. Previously saved files are not automatically deleted merely because their UI or service was retired.

### Current navigation and compatibility limits

The top-level workspaces are **Chat, Cronjobs, Browser, Skills, and Settings**. Saved workflow graphs are available through **Cronjobs → Manage saved workflows**. Planning is a retained task-inspection route, not a top-level tab.

Automatic learning, old Autonomy/Swarm execution, Directory processing, and the module-selection UI are retired. The repository-wide zero-legacy inventory is not complete; this release must not be read as a guarantee that every historical reference or compatibility path has been eliminated. Incompatible legacy native sessions are rejected rather than migrated. Preserve any history you need and start a current session instead of assuming an old native session can continue.

## Parallel work and saved workflow graphs

Core delegation remains available for independent research questions or implementation steps. Saved workflow graphs can retain explicit agent nodes, dependencies, and model settings. These capabilities are separate from the removed Swarm UI and automatic orchestration machinery.

**Why this helps:** separable work can progress together, and its outputs can be inspected before they are combined. Coordination still costs time and model usage; the selected model and task determine whether delegation is useful.

## Goal Mode and continuing work

An ordinary chat can use available tools for the current request and then stop. **Goal Mode** tracks an explicitly stated objective, progress, and completion or unresolved effects, with pause and resume controls. A goal does not authorize unrelated work or establish that an external action succeeded.

The old **Autonomous operation** controls and their automatic execution are removed. Do not assume an unattended self-drive replacement, automatic model selection, calibration, or an autonomous-model allowlist has shipped. Core delegation and scheduled work remain separate capabilities.

A saved uncertain action receipt is not proof of success or failure. Check the destination before retrying a consequential action; preventing some duplicate in-flight work does not guarantee exactly-once delivery to an external website.

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
2. **Connect a model.** For the supported native route, install and sign in to the [Codex CLI](https://github.com/openai/codex) separately. Check **Settings → Models → Codex subscription** and choose an available model in **Settings → General** or Chat. If you prefer an optional API or local endpoint, configure and verify it deliberately in **Settings → Models**.
3. **Choose the workspace.** In **Settings → General**, select a working folder and start **Chat**. Supply any relevant files and constraints. For ChatGPT using BLACKICE directly, follow the separate [connector setup](CHATGPT-CONNECTOR.md), which may require Tailscale and an authorized MCP connection.
4. **Choose the model and reasoning controls.** Select the model, available reasoning effort, and context options for your chat. Use Goal controls for an explicit continuing objective. There are no Planning-module or Directory switches in the current interface.
5. **Try a first task.** Ask: *“Create `blackice-check.txt` in the working folder containing `BLACKICE file check`, read it back, and tell me the file path and exact content.”* Verify that the actual file and content exist; a model assertion alone is not enough.
6. **Inspect and continue.** Review the browser state, file changes, command outputs and action receipts. Correct or resume the same conversation as needed; use **Cronjobs** if the work should repeat on a schedule.

Model accounts, API keys, quotas, and service capabilities come from the selected provider. BLACKICE runs the workspace and tools on your host.

## Configuration and troubleshooting

**Find the controls.** **Settings → General** holds the working folder, default model, runtime preferences and runtime health. **Settings → Models** shows Codex, optional advanced endpoints and local-model management (where included in the tested build). **Settings → Tools** manages MCP tool connections; importing a configuration is not the same as confirming a live connection. The **Chat** composer retains model, reasoning, context, and Goal controls; retired module, Directory, and old Autonomy controls are not part of current setup. **Settings → ChatGPT connector** configures the direct remote link.

- **Slow startup or an unresponsive model:** check **Settings → General → Runtime health** and the model connection status. Distinguish app startup from a Codex sign-in, unavailable server, or model request. The UI exposes **Refresh** and **Reconnect model runtime**; inspect the returned state before considering a restart, and preserve unfinished work.
- **Missing provider or model:** verify the Codex CLI is installed and authenticated, or that the explicitly configured API/local server is reachable. Refresh its model list, check the exact model and provider quota, and inspect any reported error. A downloaded llama.cpp archive alone is not a running server.
- **Missing tool:** review **Settings → Tools** and whether its connection is enabled and actually connected; also check that the selected model supports tool use. Available tools depend on both the host and the active model.
- **After an update:** refresh runtime status and reconnect the model runtime only if needed. For direct ChatGPT use, reuse a healthy existing connection and verify a fresh status request. If its address or authorization changed, follow the [connector recovery instructions](CHATGPT-CONNECTOR.md) instead of blindly registering duplicates.

**Known limits:** the host must be running for tools and schedules; website authentication and unsupported controls can interrupt work; external action receipts can remain uncertain. Source-level fixes are **not installed-release guarantees**. Incompatible legacy native sessions are rejected, and the repository-wide zero-legacy inventory remains incomplete.

### Data and remote access

**Settings → Storage & Data** shows disk usage and selective cleanup controls. User-selected cleanup is scheduled for the next application startup and can be cancelled before it runs. Custom external working folders remain outside app-managed cleanup.

A running Windows host can expose its authenticated tools over configured HTTPS connectivity, including supported Tailscale configurations. Remote access lets an external assistant use that host's workspace while it is running and reachable. See [remote access](REMOTE-ACCESS.md) and [ChatGPT connection setup](CHATGPT-CONNECTOR.md).

## Contributors

### Build from source

Requirements: supported **64-bit Windows** and **Node.js 22 or newer**.

```powershell
git clone https://github.com/MoonlightClarity/BLACKICE.git
cd BLACKICE
npm ci
npm run desktop
```

| Command | Purpose |
| --- | --- |
| `npm run desktop` | Start the Electron app. |
| `npm run headless` | Start the runtime without the normal main window. |
| `npm test` | Run the source test suite. |
| `npm run release:check` | Run release validation. |
| `npm run package:public` | Build an unsigned Windows installer candidate. |

### Repository map and contributions

`desktop/` contains Electron startup and desktop integration; `lib/` contains the agent runtime and tool services; `public/` contains the interface; `server.mjs` starts the local server; `tests/` holds regression tests; `scripts/` has build and verification tooling; `docs/` contains more detailed guides. Use the exact checkout's scripts and acceptance criteria for the feature under change.

See [frontend development](docs/frontend-development.md), [UI validation](UI-VALIDATION.md), and [release/build verification](SIGNING-AND-RELEASE.md) rather than relying on this overview for detailed instructions. Source tests are not a substitute for verification of a packaged installer. Report bugs and propose changes through [Issues](https://github.com/MoonlightClarity/BLACKICE/issues) and [Pull requests](https://github.com/MoonlightClarity/BLACKICE/pulls).

BLACKICE-authored code is licensed under [Apache-2.0](LICENSE). Third-party dependencies retain their own licenses.
