# BLACKICE

**BLACKICE is an open-source Windows app that lets AI assistants do work on your computer.** It provides local file and command tools, a browser, planning, workflows, and an optional Windows VM for application tasks. Use an AI model inside BLACKICE, or connect ChatGPT or Gemini to its tools.

**Bottom line:** BLACKICE is an *execution workspace*, not an AI model or a guarantee of task completion. It runs requested actions on your computer, records what happened, and lets you inspect the results. It cannot make an unavailable model, inaccessible website, or unsupported application work.

**[Download BLACKICE for Windows](https://github.com/MoonlightClarity/BLACKICE/releases/latest)** · [Setup and guides](docs/README.md) · [Latest changes](https://github.com/MoonlightClarity/BLACKICE/releases)

## What it does — and does not do

| Feature | Does | Does **not** |
| --- | --- | --- |
| **Chat and models** | Runs saved conversations using connected native accounts (such as Codex or Mistral Vibe Code) or configured model APIs. | Supply a guaranteed free/unlimited AI model, or silently turn a saved chat into another provider. |
| **Files and commands** | Reads, creates, edits, and searches local files; runs Windows commands and returns results. | Confine those commands to a secure sandbox just because a working folder is selected. They use the host Windows account's access. |
| **[Browser](BROWSER-IMPORT.md)** | Opens and inspects pages in BLACKICE's contained browser; supports forms, supported dialogs, uploads, and browser-session reuse. | Bypass website restrictions or promise that signing in, clicking Submit, or uploading means a site accepted the action. |
| **Browser profiles** | Imports or connects supported browser profiles/sessions for agent use. | Automatically transfer a login from Chrome, Neo, or another browser into every contained BLACKICE tab. |
| **[Planning](docs/RECURSIVE-PLANNING.md)** | Saves one shared plan of meaningful work items, dependencies, allowed effects, and evidence criteria; supports revisions. | Require a new plan leaf for every click, or prove the agent reasoned correctly just because a plan exists. |
| **[Tasks and agents](CHATGPT-CONNECTOR.md#schedules-and-cronjobs)** | Coordinates multi-agent workflows, recurring schedules, saved runs, and follow-up work. | Keep executing scheduled work when the computer is asleep or the BLACKICE runtime is closed. |
| **[ChatGPT connector](CHATGPT-CONNECTOR.md)** | Lets ChatGPT call BLACKICE's direct local tools through an authorized MCP connection. | Start another BLACKICE AI model for ordinary direct tool calls, or attach tools to every ChatGPT conversation automatically. |
| **[Gemini connector](docs/GEMINI-CONNECTOR.md)** | Lets Gemini call the same direct tools using its own Google authorization. | Share, replace, or revoke ChatGPT's independent authorization, or act as the Gemini model API inside BLACKICE. |
| **[Workbench](WORKBENCH-SETUP.md)** | Uses an optional persistent Hyper-V Windows guest for application tasks, with guest input, file sharing, and auto-repair pairing. | Support every Windows application, work on hosts without the required Hyper-V support, or claim that every native viewer/guest scenario is fully verified. |
| **Knowledge** | Stores reusable knowledge and skills for later work. | Independently verify that saved information is correct or current, or execute a saved skill without an agent using it. |
| **[Remote access](REMOTE-ACCESS.md)** | Exposes the running host to authorized browsers and outside agents over configured HTTPS/Tailscale access. | Start BLACKICE or execute local work while its main runtime is closed; an availability responder can only report status. |
| **Action history and recovery** | Saves durable jobs, observed results, and evidence to inspect or reconcile interrupted work. | Treat a tool call, model claim, or lost response as proof of a completed external effect; uncertain actions require verification before replay. |

**Retired features:** The old BLACKICE-to-ChatGPT browser provider and reverse Bridge are not offered; the supported direction is **ChatGPT → BLACKICE**. The old native email integration and Methods interface are also retired. Their historical documentation is retained for reference.

## Get started

**1. Install.** Download the current `Blackice-<version>-Setup.exe` from [Releases](https://github.com/MoonlightClarity/BLACKICE/releases/latest). BLACKICE targets **64-bit Windows**; its current public installer is **unsigned**. Check the release's `SHA256SUMS.txt` if you want to verify the download. The optional Workbench VM is **not required** for Chat, files, or browsing.

**2. Choose a model or connector.**

- **Chat inside BLACKICE:** Open **Settings → Models**, connect a native account or API provider, then select a model in **Chat**. [Model setup](docs/API-PROVIDERS.md).
- **ChatGPT using BLACKICE:** Keep BLACKICE and Tailscale running; open **Settings → ChatGPT connector**, prepare the connection, approve the requested access, and test `blackice_direct_status` in ChatGPT. [Instructions](CHATGPT-CONNECTOR.md).
- **Gemini using BLACKICE:** Open **Settings → Gemini connector**, follow the setup link in BLACKICE Browser, approve the matching Google request, and test `blackice_direct_status` in Gemini. [Instructions](docs/GEMINI-CONNECTOR.md).

**3. Work and verify.** Set a working folder for local tasks, watch actual tool results, and check the destination before counting a submission, installation, or other consequential action as complete. Longer actions may return a job ID to inspect.

## Requirements and boundaries

BLACKICE is a **Windows application**, not a hosted cloud computer. Local actions use the permissions of the Windows account running it. Connected model providers have their own access limits, costs, and policies. Remote agent access needs a reachable, running BLACKICE host; Workbench additionally needs a supported Windows edition and Hyper-V. Existing profile data is stored under `%APPDATA%\Relay` for compatibility, with working-folder files kept separately.

The project is actively developed. A passing source test or installer check is **not** a guarantee that every external website, model, or Windows app will work end to end.

## Build from source

On 64-bit Windows with Node.js 22.12 or newer:

```powershell
git clone https://github.com/MoonlightClarity/BLACKICE.git
cd BLACKICE
npm ci
npm run desktop
```

`npm test` runs the source tests; `npm run headless` starts the desktop runtime without its main window; `npm run package:public` builds an **installer candidate**, not a published release. See [release workflow](SIGNING-AND-RELEASE.md).

**More detail:** [Documentation index](docs/README.md) · [Release history](https://github.com/MoonlightClarity/BLACKICE/releases) · [Apache 2.0 license](LICENSE) · [Third-party notices](THIRD-PARTY-NOTICES.md).
