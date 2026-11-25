# BLACKICE

BLACKICE is an open-source Windows desktop workspace for AI agents. It combines chat with a contained browser, local file and command tools, saved task state, and scheduled work. You can run supported models in BLACKICE or connect an external assistant to its tools.

BLACKICE is under active development. A tool being available does not guarantee that a model can use it reliably or that a task completed; inspect the actual result.

## Install and use

1. On 64-bit Windows, get the installer from the BLACKICE project's GitHub Releases page. Download model weights or sign in to a model provider separately.
2. Launch BLACKICE. In **Config → Models**, connect a supported model account, API endpoint, or local model. Native Codex support requires the separately installed and signed-in Codex CLI.
3. In **Config → General**, choose a working directory. Open **Chat**, select a model, and give it a task.
4. Check files, browser state, and action results rather than relying solely on the model's completion message.
5. Use **Autonomy (Goal)** when you want a chat to continue toward an objective, or **Cronjobs** for scheduled work. The Windows host must remain running for either to execute.

An external assistant can use BLACKICE's authenticated direct tools after you configure a connection under **Config → App connections**.

## Develop

Requirements: 64-bit Windows, Node.js 22.23.5 or newer, and Git. From the project root:

```powershell
npm ci
npm run desktop
```

Useful commands:

```powershell
npm test
npm run docs:check
npm run package:public
```

`package:public` builds a Windows installer candidate; it does not publish a release. On PowerShell systems that block `npm.ps1`, use `npm.cmd` instead.

The main implementation lives in `lib/`, the desktop host in `desktop/`, the interface in `public/`, tests in `tests/`, and build tooling in `scripts/`. The few retained technical guides are in `docs/`.

## Limits and license

BLACKICE executes on your machine and can affect files, accounts, and external websites. Supported models, credentials, browser compatibility, and long-running reliability vary. Check the specific task's observed effects, especially before repeating a submission or purchase.

BLACKICE-authored code is licensed under Apache-2.0. Third-party components have their own licenses and notices.
