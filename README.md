# BLACKICE

BLACKICE is an open-source Windows application for working with AI agents on real tasks. It brings conversations, files, commands, web browsing, editable plans, reusable knowledge and recurring work into one desktop workspace. You can use an agent inside BLACKICE or connect an ordinary ChatGPT conversation to the tools on your computer.

**2.38.0 for Windows x64. Project overview updated October 31, 2026.**

**[2.38.0 Windows installer](https://github.com/MoonlightClarity/BLACKICE/releases/download/v2.38.0/Blackice-2.38.0-Setup.exe)** · [Release status and verification records](https://github.com/MoonlightClarity/BLACKICE/releases/tag/v2.38.0) · [Release notes](RELEASE-NOTES-2.38.0.md) · [Checksums](https://github.com/MoonlightClarity/BLACKICE/releases/download/v2.38.0/SHA256SUMS.txt)

Installer assets and checksums are published only after fresh verification of the exact Setup executable. Until publication, those asset links may be unavailable. The release page and its attached receipts report the actual publication and verification status.

BLACKICE is usable today and remains under active development. The application includes the desktop workspace, direct ChatGPT connection, built-in browser, shared planning, coordinated agents and recurring tasks. The release manifest records the installer’s signing status. The [project state](#current-project-state) section explains what has been checked, what recently changed and what still needs work.

[Getting started](#getting-started) · [Features](#what-you-can-do) · [Project state](#current-project-state) · [Data and updates](#your-data-background-operation-and-updates) · [Build from source](#build-from-source)

## Two ways to work

| Where you work | How it works |
| --- | --- |
| **In ChatGPT** | ChatGPT does the reasoning and calls BLACKICE's tools for files, commands, browsing and shared plans. BLACKICE performs those actions and returns saved results to the same conversation. This direct connection does not start a second AI model. |
| **Inside BLACKICE** | Choose native Codex or a configured cloud or local model. The agent can use tools, maintain a plan, delegate work and run saved workflows. These agents also power scheduled work. |

BLACKICE supplies the workspace and execution tools. You supply the model connection or use the connected ChatGPT conversation. Provider accounts, model availability and any provider charges are separate from installing BLACKICE.

## Getting started

### Install and choose how to work

1. **Install and open BLACKICE.** Run the Windows Setup installer. It installs for your Windows account and creates shortcuts and an Installed apps entry. Keep the application running while using its tools or schedules.
2. **For an agent inside BLACKICE, configure a model.** Open **Settings → Models**, configure a provider and select a model. Presets include anonymous **Kilo Free** and **Pollinations Classic**, as well as OpenAI, Anthropic, OpenRouter, Ollama, LM Studio and a custom compatible API. Native Codex can also be discovered and selected. Choose your default model and working folder in **Settings → General**. Anonymous presets can be saved with a blank key; providers that require credentials offer a key check. Check the particular model you intend to use as well.
3. **For ChatGPT, connect this computer.** Open **Settings → ChatGPT connector** and follow **Prepare this computer**. The supported setup uses Tailscale and the displayed server address to create the **BLACKICE connection** in ChatGPT. Complete the connection's authorization, attach it to the intended conversation and check that a status request reaches this computer. The [connection guide](CHATGPT-CONNECTOR.md) covers the complete setup and Windows startup options. Reuse a healthy existing connection.
4. **Add other tools when needed.** **Settings → Tools** connects local and remote tool servers using MCP, a standard for giving an AI model access to tools. You can enter settings or import a configuration. Import previews and saves the configuration; **Connect** starts the connection separately.

Choose the model setup, the ChatGPT setup, or both. BLACKICE and any required model server or connection service must remain available while work runs.

Model presets configure a connection; they do not install or download the model. Native Codex needs an available configured Codex installation. Ollama and LM Studio need their local model server running. Hosted providers that require authentication need the appropriate account and credentials. Kilo Free and Pollinations Classic use their anonymous endpoints without a key; availability and provider limits still apply.

### From a request to a result

Open **Chat**, start a conversation, attach relevant files and describe the outcome you want. For example, ask for a comparison of documents, a researched report, an update to local files or a recurring review of new information. With the direct connection, make the request in the ChatGPT conversation where BLACKICE is attached instead.

With Planning on, an agent inside BLACKICE records its intended work before proceeding. You can inspect the steps, edit the saved plan and follow what is happening. The agent can read files, use the browser, run commands and call connected tools. Outputs and execution history remain available for review.

Inspect the resulting files and recorded outcomes, then continue the conversation to refine the work. For repeated work, save a workflow in **Activity**, then use **Tasks → Schedules → Create a schedule** to select it. Review later results in **Tasks → Results**. A prepared form, an uploaded file and a confirmed submission are different outcomes; the saved record should show which actually happened.

## Find your way around

| Workspace | What you use it for |
| --- | --- |
| **Chat** | Talk to agents, attach files, review outputs, continue conversations and export transcripts. |
| **Planning** | See and edit the shared plan, inspect steps and evidence, and organize saved plans. |
| **Tasks** | Manage queued work and schedules, inspect run history and review completed or failed results. |
| **Browser** | Browse real pages, sign in to sites, manage tabs and work alongside browser tools. |
| **Activity** | Follow workflows and workers, inspect task timelines and access the Applications workspace. |
| **Knowledge** | Maintain reusable memories and skills, review changes and restore deleted entries. |
| **Settings** | Configure models, working folders, identity, tool connections and application preferences. |

The current **Settings** workspace includes **General**, **Identity**, **Models**, **Tools**, and **ChatGPT connector**. Older **`/legacy/`** links redirect to the current interface; there is no separate classic interface to open.

## What you can do

### Work with files, documents and commands

Agents can inspect folders, search and read files, write changes and run Windows commands. Text patches retain a record of the change. Attachments let you bring documents and images into a conversation, and saved outputs can be opened for inspection. Conversation transcripts can be exported as Markdown or JSON.

The document tools support reading and inspecting text, PDF and image content. Other document creation or transformation can use installed programs, commands or connected tools. The current interface includes text and image previews. Some advanced document editing and preview controls are not yet exposed in the current workspace. BLACKICE does not provide a complete built-in replacement for every document application.

### Browse websites and use application windows

BLACKICE contains a Chromium browser for both human and agent work. You can use ordinary tabs, addresses, site sign-in, forms, uploads and downloads. The page you see in Browser is the same page used by the background browser tools. Changing workspaces preserves the page and its session.

New agent web work starts in this built-in browser by default, and it keeps its own website sessions. Separately configured browser connections are available when a task calls for them. Optional profile imports create a separate managed copy that runs in the selected external browser. Copying a profile can preserve its data while still requiring a fresh site sign-in. See [browser import](BROWSER-IMPORT.md).

The local password manager can save and generate website credentials and fill supported password fields in the built-in browser. Copying saved passwords to another browser uses that browser's native import process. The [password guide](BROWSER-PASSWORDS.md) explains the handoff. Optional browser filtering starts off and can be enabled explicitly.

**Activity → Applications** can discover and launch installed Windows applications or attach an existing window. Agents can inspect the controls exposed through Windows accessibility and use their supported actions, such as activating buttons, changing text, selecting options and scrolling. Custom controls, elevated windows and display differences can limit what is available. Webmail is accessed through the browser.

### Plan work and make decisions

Planning gives the human and agents a shared, editable record of the goal, steps, dependencies, assignments, evidence and observed results. View it as a map or outline and inspect one step at a time. Saved plans can be named, grouped and revisited. The current **Intelligence Planning** view distinguishes analytical assessments, agent working plans and other project plans; **New assessment** starts a saved analytical project.

**Planning is On or Off.** On is the default for BLACKICE agents and uses Feasibility → Inference → Plan → Think → Respond stages around operational work. Off skips that automatic analytical cycle while keeping saved notes and optional planning tools available. **Guardrails**, under **Settings → General**, is a separate setting and is off by default. With Planning On and Guardrails enabled, execution checks the saved plan, eligible action and recorded outcome before proceeding; with Guardrails off, planning metadata stays advisory. Model reasoning effort is a separate setting.

The plan follows a Python-like algorithm: chronological operations, ordered **IF / ELIF / ELSE**, nested **AND / OR / NOT / Boolean XOR**, and typed comparisons. Unknown information stays unknown rather than selecting ELSE. Thinking and new evidence can send the agent back to planning. **Return to this step** opens another attempt of an earlier leaf or group, preserves its previous results, and flags affected later work for reassessment. [Recursive planning](docs/RECURSIVE-PLANNING.md) documents the exact format, examples, execution checks and limits.

For decisions, the plan can distinguish genuine hard constraints from preferences, adaptable gaps and information that is still unknown. An optional judgment frame records the practical outcome, important uncertainty, a useful next check and what was learned. These tools help an agent decide when it has enough information to act and when it needs to reconsider. [Practical judgment and metacognition](docs/METACOGNITION.md) explains the approach with examples.

Plan edits are explicit saves, and conflicting edits preserve your draft for review. Saving a correction guides subsequent work; use the conversation's execution controls when you need to stop work already underway.

### Coordinate agents and reusable workflows

In **Activity → New workflow**, add and connect agent stages, with optional human-approval and output stages. Configure each agent's model, instructions and assignment, choose which stages depend on others and which can run in parallel, then **Save graph** and **Run workflow**. Agents call their tools as part of those stages. Assignments can describe the scope, inputs, expected result and completion criteria for each worker.

With Planning On, workflow stages and delegated operational work proceed one at a time. Planning Off retains the workflow's configured parallelism. An older native conversation upgrades its planning tool catalog through an internal continuation while retaining the same BLACKICE conversation and task history.

Agents can delegate parts of a task to other workers. Saved projects organize longer work into tasks, dependencies, implementation and review attempts, and milestones. Plans and run histories let you inspect what each worker did and continue from the recorded state. Some project controls are currently available through the backend API and attached tools. Selecting a node in a map inspects it; running work is a separate action.

### Run work repeatedly and collect results

Saved workflows can run on demand, at a fixed interval, on a calendar schedule or in response to an incoming webhook—a request from another system. Choose a model and working folder, edit the task instructions, set retry and stopping limits, and decide whether overlapping runs should be skipped, queued or allowed in parallel. Inspecting or editing a schedule through ChatGPT is a direct tool action; when that schedule runs an agent workflow, it uses the configured model.

The current **Create a schedule** form offers manual and calendar triggers. Select a saved schedule and choose **Edit** for interval or webhook triggers and the additional run controls. Calendar schedules include a timezone and a preview of the next run times.

Recurring workflows that use one agent and run one occurrence at a time can continue the same conversation and plan between runs. The workflow and saved history must support continuation. Editing that agent's instructions preserves this continuity. Each occurrence still has its own recorded result. Parallel and incompatible workflows do not share one continuing conversation automatically.

The default after a clean restart or explicit resume is to skip missed occurrences. You can instead choose to run one missed occurrence within a specified age limit. BLACKICE records skipped time rather than replaying an entire backlog at once. Pause, resume and schedule changes are visible in the saved history.

Results appear in **Tasks → Results**, with the full run available from history. You can mark a result reviewed. By default, results stay in BLACKICE; an optional HTTP(S) webhook can send a saved result excerpt and outcome to a configured destination. Task completion, external delivery and human review have separate recorded states. There is no automatic push of every scheduled result into the original ChatGPT conversation.

Schedules require an awake computer and a running BLACKICE instance. **Run in background** hides the desktop window while keeping the runtime active. Windows sign-in startup can be configured through connection setup. BLACKICE is a desktop application, so it does not run scheduled work while the computer is off.

### Keep useful knowledge and organize history

Knowledge stores reusable notes, facts, assumptions, decisions and skills for general use or a particular working folder. A skill is a set of instructions that can be reused for a kind of task. Entries can include sources and relationships, and you can inspect retained revisions, edit them and restore entries from Trash. **Settings → Identity** holds the editable instructions and identity files used to guide agents.

Chat preserves conversation history, drafts and attachments across navigation. Conversations and their plans support Archive, Trash and Restore; project plans support Archive and Restore. Search and grouping help you return to earlier work without keeping everything in the active view. A transcript export is a readable copy of the conversation; it does not include a live model session.

## Current project state

### What this source checkpoint includes

The **2.37.0 source checkpoint** adds recursive planning:

- **Executable substeps.** Plans use nested parent/child groups and concrete operations. Conditional choices support ordered IF/ELIF/ELSE, nested AND/OR/NOT/XOR, comparisons and membership tests over recorded observations.
- **One operation at a time.** The runtime requires an eligible active leaf and its actual outcome before the next operation. Revisiting earlier work preserves previous attempts and puts dependent work back up for review without automatically repeating its effects.
- **A return to planning before the answer.** After work, the agent records whether to continue, respond or report a genuine blocker. Changed work or user directions invalidate an earlier review. A premature final response resumes the same task for reassessment.
- **Chronology and hierarchy in the interface.** Chat retains successive planning and working phases, and the outline follows the saved tree with numbers such as 1.1 and 1.1.1. Public planning activity survives conversation reopening and execution-history rollover.

The [2.37.0 release notes](RELEASE-NOTES-2.37.0.md), [planning contract](docs/RECURSIVE-PLANNING.md) and [bounded dogfood findings](docs/PLANNING-DOGFOOD-2026-10-29.md) describe the behavior and its limits. Earlier browser, conversation and workflow improvements remain described in the [2.36.1 notes](RELEASE-NOTES-2.36.1.md).

### Verification and publication

The [source verification record](https://github.com/MoonlightClarity/BLACKICE/blob/v2.37.0/verification/windows-2.37.0.json) identifies the tested source checkpoint, its file and runtime fingerprints, complete test inventory, outcome counts and test-log hashes. The Windows run passed 5,265 tests across 430 test files, with eight predefined optional integrations skipped and no failures, cancellations or required skips.

Publishing the Windows installer also requires fresh verification of that exact Setup executable: installation, shortcuts and registration, startup, restart, shutdown, profile backup and restore, clean removal, and comparison of its packaged application files with the release source. The [release page](https://github.com/MoonlightClarity/BLACKICE/releases/tag/v2.37.0) reports the actual installer status and provides its verification records. A development installation, source test pass or model trial does not establish that the Setup installer passed.

Each receipt applies to its named source checkpoint or installer artifact. It does not establish that every website, desktop application or model-driven task has been proven to work.

### Current limitations and open issues

- **Performance work continues.** Large chat histories have received improvements, but intermittent long startup and visible desktop responsiveness are still areas of investigation. A startup progress display does not establish the cause of a delay.
- **Some interfaces are still being consolidated.** The current workspace does not yet expose every advanced configuration, browser organization and document control. The desktop is the primary interface; very narrow mobile layouts and arbitrary Windows application compatibility are incomplete.
- **Web tasks can need human involvement.** Site sign-in, human-verification challenges and missing information can interrupt a workflow. A browser action completing does not by itself establish that an external task succeeded.
- **ChatGPT desktop approval behavior varies in a reported comparison.** On October 28, 2026, Pro Reasoning prompted for approval on every turn while Extra High did not in the same comparison. The checked connection already allowed all app actions, and BLACKICE had no local per-action approval gate. The cause and wider scope remain unconfirmed.
- **The installer is unsigned.** A verified publisher signature is not currently part of the public release. Checksums and release evidence accompany the download.

The former reverse ChatGPT Bridge, browser-driven ChatGPT model provider, Thunderbird/Himalaya email integration and standalone Methods interface are retired. Their historical files may remain for compatibility. The supported ChatGPT direction is **ChatGPT calling BLACKICE**, email uses the browser, and analytical work uses shared Planning.

## Your data, background operation and updates

Saved conversations, plans, knowledge and settings normally live in **`%APPDATA%\Relay`**. The historical folder name is retained for continuity. Files an agent creates in your chosen working folder remain ordinary files on your computer. Cloud models and connected services receive the content sent to them; choosing a local model changes where model processing happens.

BLACKICE's file and command tools use the Windows account's access. Ordinary shell commands are not placed in a separate BLACKICE sandbox, and authorized direct actions do not acquire an extra BLACKICE confirmation each time. Connection authentication, ChatGPT's own app controls, website sign-in and Windows restrictions still apply.

For a manual profile backup, quit BLACKICE and copy **`%APPDATA%\Relay`**, or the custom profile folder you selected, to a separate backup location. Files in other working folders need their own backups. The current interface does not expose the older **Recovery & support** panel; older `/legacy/` links redirect to the current workspace.

Back up the profile and quit BLACKICE before installing an update, then run the new Setup installer. Uninstalling preserves the profile. A move to another Windows account or machine may require signing in to providers and websites again. The [release guide](SIGNING-AND-RELEASE.md) covers packaging and verification.

For access from another device or an external client, BLACKICE supports remote connections using its existing authenticated transport. The [remote access guide](REMOTE-ACCESS.md) explains connection setup and the agent API.

## Build from source

Use Windows and Node.js 22.12 or newer. From a checkout of this repository:

```powershell
npm ci
npm test
npm run desktop
```

`npm run headless` runs the Electron host without the desktop window. `npm start` runs the plain Node developer server. The [packaging guide](SIGNING-AND-RELEASE.md) explains how to build the Windows installer. Use the installer for an installed application; keep development checkouts separate from its application files.

## Further documentation

| Topic | Guide |
| --- | --- |
| Connect ChatGPT, enable connection startup and recover interrupted actions | [ChatGPT connector](CHATGPT-CONNECTOR.md) |
| Remote connections and the agent API | [Remote access](REMOTE-ACCESS.md) |
| Browser profiles, passwords and optional filtering | [Import](BROWSER-IMPORT.md), [passwords](BROWSER-PASSWORDS.md), [filtering](BROWSER-PROTECTION.md) |
| Plans, human edits and agent coordination | [Shared editing](PLANNING-AWARENESS.md), [organization](PLANNING-ORGANIZATION.md), [practical judgment](docs/METACOGNITION.md) |
| Current desktop interface and performance work | [Frontend](FRONTEND-V2.md), [performance](PERFORMANCE.md), [development tools](docs/frontend-development.md) |
| Packaging, installation checks and release evidence | [Windows releases](SIGNING-AND-RELEASE.md) |

BLACKICE's original source is licensed under [Apache License 2.0](LICENSE). Bundled components retain the licenses listed in [Third-party notices](THIRD-PARTY-NOTICES.md).
