# BLACKICE

**Open-source Windows software for agent-driven work, with native chat and direct tools for outside AI assistants.**

BLACKICE can let an agent inspect and edit local files, use its contained browser, run commands, work through saved plans, and preserve action results. You can operate it from the Windows application or connect an outside assistant such as ChatGPT or Gemini to the same running BLACKICE host. A successful tool call is not, by itself, evidence that an external task was completed.

**[Download the current Windows installer](https://github.com/MoonlightClarity/BLACKICE/releases/latest)**

**Current published release: 2.39.27 (November 7, 2026).** The release includes the independent Gemini MCP connector, following 2.39.26's browser-upload and Workbench pairing fixes and 2.39.23's canonical planning redesign. Use [2.39.27 release notes](RELEASE-NOTES-2.39.27.md), the [release page](https://github.com/MoonlightClarity/BLACKICE/releases/tag/v2.39.27), and its published SHA-256 sums for the exact installer. BLACKICE currently targets 64-bit Windows; Windows installers are unsigned unless a publisher signing configuration is supplied.

## Choose how to work

| Route | What runs the model? | What BLACKICE does |
| --- | --- | --- |
| **Chat in BLACKICE** | Your selected native account or configured API provider | Owns the chat, attached tools, saved task and run history |
| **ChatGPT → BLACKICE** | ChatGPT | Calls BLACKICE's authenticated direct MCP tools; ordinary direct calls do not start a BLACKICE model worker |
| **Gemini → BLACKICE** | Gemini | Uses the same running MCP server with an **independent Google OAuth grant**; it does not replace ChatGPT's grant |
| **Tasks and workflows** | The model selected for the task/worker | Runs saved workflows and scheduled jobs locally; saves independent run results |

The old BLACKICE-to-ChatGPT browser model/Bridge is **retired**. ChatGPT calling BLACKICE through MCP is a different, supported direction. See [Chat-mode retirement](CHAT-MODE.md) and [Bridge retirement](CHATGPT-BRIDGE.md).

## Install and start

1. From [Releases](https://github.com/MoonlightClarity/BLACKICE/releases/latest), get `Blackice-2.39.27-Setup.exe` (or the installer for the currently published version).
2. Optionally compare its hash with `SHA256SUMS.txt` on that release.
3. Run the Windows installer, open BLACKICE, then choose the path below. The installer is per-user; application/profile identity is kept across updates.

For **native chat**, open **Settings → Models**, connect Codex or the separately installed Mistral Vibe Code CLI, or configure an optional API connection. Choose a model in Chat, assign a working folder and start a conversation. These are separate transports: **Mistral Vibe Code** is not the **Mistral API**, and **Google Gemini as an API model** is not the **Gemini → BLACKICE MCP connector**. Account access, quotas and model support are determined by the connected provider. [API provider setup](docs/API-PROVIDERS.md).

For **ChatGPT**, keep BLACKICE and Tailscale running, use **Settings → ChatGPT connector → Prepare this computer**, authorize the requested capabilities and verify an actual `blackice_direct_status` round trip from the intended ChatGPT conversation. Follow the [ChatGPT connector walkthrough](CHATGPT-CONNECTOR.md).

For **Gemini**, use **Settings → Gemini connector → Open Gemini connector setup in BLACKICE Browser**. Approve the matching Google request in BLACKICE and test the direct status tool in Gemini. ChatGPT and Google have separate OAuth grants even though they use the same MCP server. Follow the [Gemini connector walkthrough](docs/GEMINI-CONNECTOR.md).

## Main areas

| Area | Use |
| --- | --- |
| **Chat** | Model-backed conversations, attachments, saved history, and tool results |
| **Planning** | Shared work plans, dependencies, decisions, revisions and progress |
| **Tasks** | Workflows, schedules, saved runs and results |
| **Browser** | BLACKICE-owned contained tabs and their real page state |
| **Workbench** | Optional persistent Windows guest for desktop applications |
| **Knowledge** | Reusable knowledge and skills |
| **Settings** | Providers, connectors, remote access and application configuration |

### Planning: one intent plan, real operation evidence

The current **canonical planning contract (v2, introduced in 2.39.23)** separates three things:

- **Intent:** a single saved plan of meaningful **work items**, resource scopes, dependencies, instructions and outcome criteria.
- **Execution:** host-owned operations and durable jobs, with journaled dispatch, effects and recovery. Filling one form may require many browser operations without creating a model-authored plan leaf for every click.
- **Evidence:** observed source coverage, new destination-confirmed effects and supported judgments. A click, tool delivery, model claim or existing record is not automatically a new completed outcome.

Planning modes are **Forced**, **Advisory** and **Off**. Forced requires a current applicable work item and admission conditions; Advisory permits ordinary operations without that mandatory gate; Off does not require an automatic plan. Other runtime limits, cancellation, and uncertainty do not disappear merely because planning is Off.

New canonical plans and historical step-by-step plans have different contracts. Preserved older sessions may use their original frozen tool/schema catalog. Do **not** follow older schema-10 instructions for a canonical v2 task. See [Current planning guide](docs/RECURSIVE-PLANNING.md), [contract v2 design and evidence](docs/planning-contract-v2-20261105.md), and [editing awareness](PLANNING-AWARENESS.md).

### Browser, files and Windows applications

BLACKICE has a contained browser that the user and agent can inspect. Its native browser/profile integrations are separate from the contained Electron session; copying or connecting another browser's profile does not automatically sign in every BLACKICE tab. Agents can inspect pages, enter values, upload files, handle supported dialogs and check post-submit results. A site can still reject an operation, require authentication or challenge automation. [Browser import and sessions](BROWSER-IMPORT.md).

File and command tools run under the Windows account hosting BLACKICE; choosing a working folder is not an operating-system sandbox. Direct actions return **durable job IDs** where needed. Inspect the saved result after interruption instead of blindly repeating a potentially consequential operation. [ChatGPT direct-tool behavior](CHATGPT-CONNECTOR.md#action-identity-recovery-and-cancellation).

**Workbench** is an optional Hyper-V Windows guest with persistent applications and files. The **Pair & auto-repair** flow (2.39.26) can provision its dedicated share login, bootstrap through Hyper-V even when `W:` is missing, and install a guest reconnect watcher. The development VM passed heartbeat, bidirectional file and reconnect checks; this does **not** prove that every user's guest, application or native viewer will work. Workbench needs supported Windows editions and virtualization. [Workbench setup](WORKBENCH-SETUP.md) · [native viewer evidence and limits](WORKBENCH-NATIVE-DISPLAY.md).

### Workflows and recurring tasks

In **Tasks**, compose workflows with multiple agents and dependency order; inspect results separately. Schedule recurring jobs by interval/calendar or invoke them manually. Compatible recurring work can continue a saved conversation instead of always creating a new one. The host must be running and sufficiently awake for work to execute. Connector requests do not automatically push their results into an idle ChatGPT or Gemini conversation. [Direct connector schedules](CHATGPT-CONNECTOR.md#schedules-and-cronjobs).

## Storage, availability and boundaries

The installed app retains its profile under `%APPDATA%\Relay` for compatibility; working-folder artifacts stay in their selected folders. Back up profile and working folders separately. The remote availability responder can report that BLACKICE is closed, but **cannot start the app or perform actions while it is closed**. Remote connections use the running host's displayed HTTPS address and the configured Tailscale route. [Remote access](REMOTE-ACCESS.md).

BLACKICE is actively developed. Real-world completion depends on the provider, saved permissions, host state, site/application behavior and observed receipts. A source test or installer smoke test does not prove arbitrary end-to-end task success.

## Build from source

On Windows with Node.js 22.12 or newer:

~~~powershell
git clone https://github.com/MoonlightClarity/BLACKICE.git
cd BLACKICE
npm ci
npm run desktop
~~~

Useful commands: `npm test` (source tests), `npm run headless` (desktop runtime without the main window), `npm start` (Node server) and `npm run package:public` (build an installer candidate). Packaging a candidate does **not** publish a release. See [release and signing workflow](SIGNING-AND-RELEASE.md).

## Documentation

Start with the [documentation map](docs/README.md), which separates **current instructions** from **historical release and experiment records**.

- [ChatGPT connector](CHATGPT-CONNECTOR.md), [Gemini connector](docs/GEMINI-CONNECTOR.md) and [remote access](REMOTE-ACCESS.md)
- [Current planning](docs/RECURSIVE-PLANNING.md), [API providers](docs/API-PROVIDERS.md) and [browser import](BROWSER-IMPORT.md)
- [Workbench setup](WORKBENCH-SETUP.md) and [Windows release process](SIGNING-AND-RELEASE.md)
- [Release notes](https://github.com/MoonlightClarity/BLACKICE/releases)

BLACKICE-authored source code uses [Apache License 2.0](LICENSE); bundled components retain their own licenses. See [third-party notices](THIRD-PARTY-NOTICES.md).
