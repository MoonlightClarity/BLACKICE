# BLACKICE documentation

> **Status: 2.40.79 local installation candidate (not published).** Package version is **2.40.79**. See the [current notes](../RELEASE-NOTES-2.40.79.md). The latest confirmed published version remains [2.40.75](https://github.com/MoonlightClarity/BLACKICE/releases/tag/v2.40.75).

Start with the [project README](../README.md). A named document's date, original deployment note, test result, or branch name does not override this index or the code in the version you actually run.

## Current user guides

| Need | Maintained guidance |
| --- | --- |
| Inspect active instruction sources and saved execution snapshots | [Instruction audit](instruction-audit.md), [instruction clarity](instruction-clarity.md), and [tool responsibilities](tool-responsibilities.md) |
| Product overview, setup, navigation, recurring work | [Project README](../README.md) |
| Choose models and API connections | [API providers](API-PROVIDERS.md), [local models](local-models.md), and [optional Mistral account compatibility](mistral-acp-compatibility.md) |
| Connect an external assistant to BLACKICE's direct tools | [ChatGPT](../CHATGPT-CONNECTOR.md), [Gemini](GEMINI-CONNECTOR.md), [Claude](CLAUDE-CONNECTOR.md) |
| Remote access and connection scope | [Remote access](../REMOTE-ACCESS.md) |
| Use the browser and imported profiles | [Browser import](../BROWSER-IMPORT.md), [password handling](../BROWSER-PASSWORDS.md), [request filtering](../BROWSER-PROTECTION.md), [stopped-task tab adoption](stopped-task-tab-adoption.md) |
| Keep work moving within a conversation | [Goal mode](GOAL-MODE.md) |
| Current architecture and verification limits | [2.40.75 release scope](../RELEASE-NOTES-2.40.75.md) |
| Organize work | Conversation folders, nested Skills and Browser folders, Cronjobs and [Goal mode](GOAL-MODE.md). No automatic Swarm dispatch. |
| Build or publish a Windows release | [Signing and release](../SIGNING-AND-RELEASE.md), [release qualification tooling](../SIGNING-AND-RELEASE.md#release-qualification-and-the-availability-responder), and [third-party notices](../THIRD-PARTY-NOTICES.md) |

**Published 2.40.75 implementation:** Chat has optional Action Directory for the current task. The old module controls, automatic learning and old Autonomy/Swarm execution are retired. Skills have bundled originals plus human-edited persistent overrides, with user-organized folders. Model skill tools are read-only; unrestricted shell access is not an OS-level immutability guarantee. The separate To-do and My workflows spaces have been removed; Cronjobs retain their current saved-workflow editor. Historical documents below do not reactivate those features.

**Workspace navigation:** Chat, Cronjobs, Browser, Skills and Config. Within Config, use Models for Accounts / Local models / Add API, Behavior & profile for Instructions, and App connections for the incoming ChatGPT / Gemini / Claude / Other MCP apps guides. The retained Planning deep link exposes Goal and Activity plus explicit saved graph plans.

**Workbench retirement:** earlier BLACKICE releases documented an optional Windows VM Workbench and native-display paths. Those are **not current setup features** in the current source: the VM UI, APIs and installer inputs were retired. The [retirement regression](../tests/workbench-retired.test.mjs) checks this boundary. Historical [2.39.26 pairing notes](../RELEASE-NOTES-2.39.26.md) are retained for provenance, not as instructions to install a missing Workbench component.

## Engineering references: verify against the exact revision

These explain implementation boundaries or invariants. They are valuable to maintainers, but do **not** certify that an isolated branch, candidate, external workflow, or installed host has that behavior.

- [Planning contract v2 implementation reference](planning-contract-v2-20261105.md), [operation protection](OPERATIONAL-EFFECT-PROTECTIONS.md), [application-history gate](application-history-gate.md), [planning tool exposure](planning-tool-exposure.md), and [Planning activity UI](PLANNING-ACTIVITY-UI.md).
- [Agent advocacy](agent-advocacy.md), [metacognition](METACOGNITION.md), [direct caller guidance](direct-caller-guidance.md), and [Directory execution](directory-chat-mode.md).
- [Credential authentication](credential-authentication.md), [frontend development](frontend-development.md), [frontend UI control semantics](FRONTEND-UI-CONTROLS.md), [storage management](STORAGE-MANAGEMENT.md), and [Codex history isolation](CODEX-HISTORY-ISOLATION.md).
- [Retained plan organization and earlier UI](../PLANNING-ORGANIZATION.md), [shared editing awareness](../PLANNING-AWARENESS.md) and the other files classified as engineering references in the [document status register](document-status.json).

## Historical / retired / version-bound records

Documents marked **Status: Historical documentation** preserve the original experiments, migration information, tests, and branch-specific design. They are **not operational guidance** for the current release, even where their original heading says "current" or "not deployed."

- [Old canonical recursive-planning controls](RECURSIVE-PLANNING.md), [old planning depth/modes](PLANNING-DEPTH.md), and [schema-10 planning](history/RECURSIVE-PLANNING-SCHEMA10.md). Current Goal controls are documented in the [Goal mode guide](GOAL-MODE.md).
- [November 12 Planning/Directory audit](../PLANNING-DIRECTORY-AUDIT-20261112.md) and dated [planning browser](planning-browser-architecture-20261030.md) / [response-cycle](response-cycles-20261030.md) candidates: evidence about their original revisions, not present defaults.
- [Old VM application tests](../APPLICATION-COMPATIBILITY.md), [frontend V2 rollout](../FRONTEND-V2.md), [retired ChatGPT browser model](../CHAT-MODE.md), [retired reverse bridge](../CHATGPT-BRIDGE.md), [retired email integration](../EMAIL.md), and [retired Methods](../METHODS.md).
- [Earlier module/Directory benchmark trade-offs](PLANNING-TRADEOFFS.md) and [2.39.104 onboarding work](connections-model-onboarding.md) preserve their original scope and measured results; they do not describe current controls or benchmark qualification.
- All [versioned release notes](../RELEASE-NOTES.md), dated evaluation reports, experimental design snapshots, and preserved [legacy planning schema](history/RECURSIVE-PLANNING-SCHEMA10.md) describe their own version and evidence boundaries.

The [document status register](document-status.json) classifies **every first-party root/docs Markdown entrypoint** as current guide, engineering reference, or historical material. Versioned release notes remain explicitly historical by filename; vendor licenses, fixtures, and verification artifacts retain their own independent provenance.

## Documentation maintenance

Run **npm run docs:check** to validate classification coverage, visible historical labels, the source-version release-note links, and local Markdown targets. New docs must be classified; retired/dated docs must be labeled before publication. When a capability changes, update the primary user guide and documentation index **in the same change**, then record the new release's scope separately. Never claim public installer installation from a passing source test, and never silently rewrite historical measured outcomes.
