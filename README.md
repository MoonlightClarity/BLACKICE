# BLACKICE

**An open-source agent harness designed to turn user intent into verifiable work.**

**Status: STAGING — active development and real-world dogfooding, not a production-ready reliability claim.**

BLACKICE is a Windows desktop execution environment for AI agents. Rather than treating an agent as a chat persona, BLACKICE equips supported local and hosted models with tools, persistent task state, execution controls, and evidence of what actually happened. It can also expose its tools to an authenticated external assistant.

The core design principle is **user sovereignty**: the agent works for the person giving it instructions. It should exercise delegated judgment, proceed when information is incomplete, recover from errors, and finish the requested work instead of repeatedly asking for permission already given or substituting a polished explanation for an available action.

## Core competencies

- **Agency and delegated judgment.** Behavioral guidance and execution controls target premature stopping, unnecessary permission loops, self-disqualification, and other failures that prevent agents from carrying out authorized instructions.
- **Long-horizon execution.** Persistent goals, deadlines, scheduled jobs, task records, and context/continuation mechanisms support work spanning many model turns and interruptions.
- **Observable execution and recovery.** Tool receipts, effect tracking, outcome checks, and recovery paths distinguish an attempted action from a confirmed result, including when browser state changes or the effect of a tool call is uncertain.
- **Computer and browser operations.** A contained browser and Windows tools let agents work with files, commands, documents, applications, and external sites rather than only produce text.
- **Model independence and interoperability.** Supported local and hosted models, native Codex integration, and authenticated direct-tool connections let the harness be used across different model configurations.
- **Coordination and specialization.** Subagents, task delegation, projects, editable instructions, and discoverable skills support complex work and task-specific behavior.

These are competencies being developed and tested, **not guarantees that every model or unattended workflow will succeed**. A tool being available does not prove that the model used it correctly, and an agent's completion message is not proof that the result occurred.

## How BLACKICE is being tested

Development is driven by repeated end-to-end use, particularly the maintainer's own job search: research, evaluating opportunities, handling documents, navigating application systems, and checking whether submissions actually completed.

Two complementary test configurations isolate different failure classes:

- **Luna** is used for long-horizon agency failures, such as over-restrictive interpretation, unnecessary stopping, weak delegated judgment, and incomplete follow-through.
- **MiniCPM-1B**, a small local model, is used to expose tool-contract, execution, context, and recovery errors quickly.

Failures are investigated as evidence for improvements to the *harness*, rather than assuming that a larger model alone will solve them. BLACKICE remains in staging while this testing and reliability work continues.

## Still in active development

- **Self-driving and Goal continuity:** Self-driving uses the existing Goal Mode, not a separate agent engine. Goal scheduling, interruption recovery, and outcome verification are being exercised with end-to-end fixtures; unattended success across all models and sites is not established.
- **Browser and tool reliability:** Browser recovery, stale-reference handling, uncertain external effects, and provider-independent tool contracts remain active test areas. A passing simulated test is not evidence of a real-world submission or action.
- **Local models and context:** MiniCPM and other local models are being evaluated for inference, tool use, and compaction. No universal improvement is claimed from benchmarks or architecture alone.
- **Distribution and upgrades:** Every candidate requires its own source-bound Windows installer and runtime checks. Installing locally and verifying the saved profile precede cleanup; preserve a verified rollback installer and all durable user data.

## Install and use

1. On 64-bit Windows, get the installer from the BLACKICE project's [GitHub Releases](https://github.com/MoonlightClarity/BLACKICE/releases) page. Download model weights or sign in to a model provider separately.
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
