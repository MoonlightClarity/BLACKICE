# BLACKICE

**BLACKICE is an open-source Windows app that gives AI agents tools to do real work on your computer.**

Instead of only chatting about a task, an agent can work with files, use a browser, run commands, follow a plan, and save its results. You can work with an agent inside BLACKICE or connect BLACKICE to ChatGPT.

You stay able to see what the agent is doing, review the results, and pick up where you left off.

**[Download BLACKICE for Windows](https://github.com/MoonlightClarity/BLACKICE/releases/latest)**

The latest published release is **2.39.25 (November 7, 2026)**. BLACKICE currently supports **64-bit Windows**. See the [release notes](RELEASE-NOTES-2.39.25.md) and [download checksums](https://github.com/MoonlightClarity/BLACKICE/releases/latest/download/SHA256SUMS.txt).

## What can BLACKICE do?

- **Work with files:** Find, read, create, and edit files in your working folders.
- **Use websites:** Open pages, fill out forms, upload and download files, and keep browser sessions available.
- **Run commands:** Use Windows commands and other installed tools to complete tasks.
- **Make and follow plans:** Break large tasks into smaller steps, track progress, and change course when new information appears.
- **Save your work:** Keep conversations, plans, results, and task history so you can return to them.
- **Repeat tasks:** Run jobs on a schedule, such as at set times or intervals.
- **Use more than one agent:** Build workflows in which agents handle different parts of a task.
- **Connect to ChatGPT:** Let a ChatGPT conversation use BLACKICE's tools on your computer.
- **Work with Windows apps:** An optional Workbench uses a separate Windows virtual machine. This feature is still being developed and has not passed full live acceptance testing.

For example, you might ask an agent to organize project files, research information in a browser, or complete a task that needs several steps. The outcome depends on the tools, model, accounts, and websites involved. BLACKICE records results, but it does not guarantee that every task will succeed.

## Two ways to work

**1. Chat inside BLACKICE.** Pick a model, start a conversation, give it a working folder, and describe what you want done. BLACKICE saves the conversation and the work it performs.

**2. Use BLACKICE from ChatGPT.** Connect BLACKICE to ChatGPT, then ask ChatGPT to use its file, command, browser, and planning tools. ChatGPT does the reasoning; BLACKICE runs the requested actions on your computer and returns the results. Normal tool calls do **not** start a second AI conversation.

You can use either way, or both.

## Getting started

### Install

1. Open the [latest release page](https://github.com/MoonlightClarity/BLACKICE/releases/latest).
2. Download the Windows installer named `Blackice-<version>-Setup.exe`.
3. Run the installer, then open BLACKICE from the Start menu or desktop shortcut.

The Windows installer is currently **not code-signed**. You can use the checksums on the release page to check the file you downloaded. See [Windows installation and releases](SIGNING-AND-RELEASE.md) for details.

You do **not** need to set up the optional Workbench virtual machine just to use Chat, files, or the browser.

### Use an agent inside BLACKICE

1. Open **Settings → Models**. Connect a supported account, such as Codex or Mistral Vibe Code, or add an API provider.
2. Open **Chat** and choose a model. Select the folder you want the agent to work in.
3. Start a conversation. Describe the result you want, and attach files when they would help.
4. Choose a planning mode: **Forced**, **Advisory**, or **Off**.
5. Watch the steps and results. You can review the work, adjust the plan, or continue the conversation.

Model availability depends on your account or API provider. Some providers require an API key or paid access. BLACKICE can check a provider's connection and model list, but a successful check does not promise that every model will accept a request.

### Choose the Mistral connection for your task

There are two different Mistral options:

- **Mistral Vibe Code** uses the official Vibe command-line app and a Mistral account. Install that app, then sign in and refresh the models from **Settings → Models → Mistral Vibe Code**.
- **Mistral API** is a separate API connection. Set it up under **Settings → Models → Optional API connections** with the credentials your account requires.

They are not the same connection and may offer different models. See the [ChatGPT connector guide](CHATGPT-CONNECTOR.md) for more about model connections.

### Use BLACKICE from ChatGPT

1. Keep **BLACKICE** and **Tailscale** running on your Windows computer.
2. In BLACKICE, open **Settings → ChatGPT connector** and choose **Prepare this computer**.
3. Follow the guide to add the displayed BLACKICE server address as a custom tool connection in ChatGPT.
4. Complete the connection setup and confirm that the test result from your computer appears in ChatGPT.
5. Add that connection to the conversation where you want to use BLACKICE.

The setup uses a secure sign-in and authorization flow. You do not need to copy a private login key into ChatGPT. Available connection controls can depend on your ChatGPT account.

For the full instructions, including setup after a Windows restart and recovery from interrupted actions, see [Connect BLACKICE to ChatGPT](CHATGPT-CONNECTOR.md).

## Find your way around

| Area | What it is for |
| --- | --- |
| **Chat** | Talk with agents, attach files, and revisit saved conversations. |
| **Planning** | See and edit a task's steps, dependencies, decisions, and progress. |
| **Tasks** | Create workflows, set schedules, and inspect past runs and results. |
| **Browser** | Use the browser shared by you and the agent. |
| **Workbench** | Set up and control a separate Windows workspace for application tasks. |
| **Knowledge** | Save useful information and reusable skills for future tasks. |
| **Settings** | Manage models, tool connections, working folders, and preferences. |

## Planning and practical judgment

BLACKICE can make a plan before taking action and save what happens as it works through the task. Plans can have smaller steps within larger steps (for example, **1**, **1.1**, and **1.1.1**). They can also include conditions, such as what to do if a form fails or a needed file is missing.

You can choose how planning works:

| Mode | What it means |
| --- | --- |
| **Forced** | The agent must have a saved plan before it begins actions. It tracks work against that plan and can revisit it as needed. |
| **Advisory** | The agent can use planning, but it does not have to finish a plan first. |
| **Off** | The agent can work without an automatic planning requirement. Saved plans remain available. |

Planning tries to use the information already available before asking you for missing details. The system also tracks evidence for completed work rather than treating a click or an attempted submission as proof of success.

You can edit plans and return to earlier steps. Planning helps organize work; it does not make an AI model infallible.

Read more: [Recursive planning](docs/RECURSIVE-PLANNING.md) · [Editing shared plans](PLANNING-AWARENESS.md) · [How decisions are assessed](docs/METACOGNITION.md)

## Files, browsing and application work

### Files and commands

Agents can inspect and change files, run Windows commands, and save records of their actions. You can attach documents and images to a conversation and export a conversation transcript.

Files and commands run with the access of the Windows account running BLACKICE. Choosing a working folder gives the agent a starting location; it does **not** create a separate Windows sandbox.

### Shared browser

BLACKICE has its own browser that both you and the agent can use. You can see pages, tabs, forms, and downloads in the Browser area. Browser sessions can be kept for later work.

A website may still require a login, verification step, or manual action. A completed form entry is not the same as a confirmed submission. Read more about [browser sessions](BROWSER-IMPORT.md), [passwords](BROWSER-PASSWORDS.md), and [tab cleanup](docs/browser-task-cleanup-20261030.md).

### Workbench: Windows applications

Workbench is an **optional** workspace for tasks involving installed Windows applications. It uses a persistent Windows virtual machine through Hyper-V, so its apps and files can remain available between tasks.

It needs extra Windows setup, enough computer resources, and an appropriate Windows guest installation. The native viewing window is a **preview**, and full testing with a live guest remains incomplete. Do not assume Workbench will control every application successfully.

See [Workbench setup](WORKBENCH-SETUP.md) and [current display limitations](WORKBENCH-NATIVE-DISPLAY.md).

## Workflows, agents and recurring work

In **Tasks → Workflows**, you can connect several agent steps into a larger job. Each agent can have its own model and instructions. Tasks can depend on earlier steps; independent steps can run at the same time when the workflow allows it.

In **Tasks → Schedules**, you can set work to run manually, at an interval, on a calendar schedule, or from a webhook. **Tasks → Results** shows what happened on each run. Compatible repeating single-agent jobs can continue an existing conversation instead of starting a new one every time.

**Scheduled tasks need the computer awake and BLACKICE running.** You can use its background mode without leaving the main window open. Scheduled results are saved in BLACKICE; they are not automatically sent to the ChatGPT conversation that originally requested the work.

## Knowledge, history and local data

BLACKICE saves conversations, plans, task results, and reusable knowledge so you can inspect or continue work later.

On a normal Windows installation, BLACKICE stores its profile under `%APPDATA%\Relay`. The older folder name is kept for compatibility. Files created in a working folder stay in that folder.

To make a manual backup, close BLACKICE and copy its profile folder to another location. Back up working folders separately. If you use a cloud model or connected service, that provider receives the information sent to it.

## Current project state

**Version 2.39.25** is the latest published Windows release as of November 7, 2026.

Recent changes include clearer error messages in Chat, better recovery after failed runs, safer switching between API models, and a way to check an API connection before saving it. See the [2.39.25 notes](RELEASE-NOTES-2.39.25.md) and [2.39.24 notes](RELEASE-NOTES-2.39.24.md).

BLACKICE is under active development. Important limits include:

- The Workbench native viewer has not passed full live guest testing.
- An account, model, or website may be unavailable even when the app itself is working.
- Some interrupted actions cannot safely be retried until their results can be checked.
- Automated tests do not prove every real website, Windows application, or end-to-end task will work.

For exactly what was included and tested in a given version, use its [release notes and published files](https://github.com/MoonlightClarity/BLACKICE/releases).

## Build from source

If you want to run or change the source code, use **64-bit Windows** and **Node.js 22.12 or newer**:

~~~powershell
git clone https://github.com/MoonlightClarity/BLACKICE.git
cd BLACKICE
npm ci
npm run desktop
~~~

Other useful commands:

| Command | Purpose |
| --- | --- |
| `npm test` | Run the tests. |
| `npm run headless` | Run BLACKICE without the main desktop window. |
| `npm start` | Start the Node development server. |
| `npm run package:public` | Build a Windows installer candidate. |

Building an installer candidate is **not** the same as publishing a tested release. See [Windows releases](SIGNING-AND-RELEASE.md).

## Further documentation

- [Connect to ChatGPT](CHATGPT-CONNECTOR.md) and [remote access](REMOTE-ACCESS.md)
- [Planning](docs/RECURSIVE-PLANNING.md) and [shared plan editing](PLANNING-AWARENESS.md)
- [Workbench setup](WORKBENCH-SETUP.md) and [application compatibility](APPLICATION-COMPATIBILITY.md)
- [Browser profiles](BROWSER-IMPORT.md) and [browser passwords](BROWSER-PASSWORDS.md)
- [Frontend and UI](FRONTEND-V2.md) and [development tools](docs/frontend-development.md)
- [Release process](SIGNING-AND-RELEASE.md) and [release history](https://github.com/MoonlightClarity/BLACKICE/releases)

BLACKICE's original source code uses the [Apache License 2.0](LICENSE). Bundled components may use different licenses; see [third-party notices](THIRD-PARTY-NOTICES.md).
