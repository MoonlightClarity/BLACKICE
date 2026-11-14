# BLACKICE documentation

> **Status: Current source index.** This index is checked against the repository's main-branch package version, **2.39.92**. It describes source documentation, **not proof that a particular installer was published or installed**. Check the [release downloads](https://github.com/MoonlightClarity/BLACKICE/releases) and your installed application's version before assuming a feature is available. The [2.39.92 source release notes](../RELEASE-NOTES-2.39.92.md) and [release-note index](../RELEASE-NOTES.md) describe version-specific changes and verification limits.

Start with the [project README](../README.md). A named document's date, original deployment note, test result, or branch name does not override this index or the code in the version you actually run.

## Current user guides

| Need | Maintained guidance |
| --- | --- |
| Product overview, setup, navigation, recurring work | [Project README](../README.md) |
| Choose models and API connections | [API providers](API-PROVIDERS.md) and [local models](local-models.md) |
| Connect an external assistant to BLACKICE's direct tools | [ChatGPT](../CHATGPT-CONNECTOR.md), [Gemini](GEMINI-CONNECTOR.md), [Claude](CLAUDE-CONNECTOR.md) |
| Remote access and connection scope | [Remote access](../REMOTE-ACCESS.md) |
| Use the browser and imported profiles | [Browser import](../BROWSER-IMPORT.md), [password handling](../BROWSER-PASSWORDS.md), [request filtering](../BROWSER-PROTECTION.md) |
| Keep work moving within a conversation | [Goal mode](GOAL-MODE.md) |
| Choose *optional* reasoning | [Current On/Off Planning modules](MODULAR-PLANNING-ONTOLOGY.md) and [benchmark trade-offs](PLANNING-TRADEOFFS.md) |
| Inspect conversation Goals and Directory work | Planning: **Current work**; see [Goal mode](GOAL-MODE.md) and the [current Planning screen source](../public/next/workspaces/planning-current.mjs) |
| Build or publish a Windows release | [Signing and release](../SIGNING-AND-RELEASE.md) and [third-party notices](../THIRD-PARTY-NOTICES.md) |

**Planning controls today:** eight selectable Planning modules use **On/Off**; Directory uses **On/Off** separately. Unspecified selections default Off. Delegation is an available tool capability, not a ninth toggle. Older Forced/Advisory, Mandatory/Optional/Forbidden/Auto, and forced per-operation plan instructions are **not current controls**. Saved choices remain subject to their actual migration/compatibility semantics. See the current [Planning module guide](MODULAR-PLANNING-ONTOLOGY.md).

**Planning workspace navigation:** Planning opens **Current work**, showing each conversation's Goal and Directory records. The filter distinguishes **Saved conversations**, **Running now**, **Archived**, and **All conversations**; a saved conversation is not necessarily running. **Saved graph plans** is a separate view for explicit graph requests and earlier planning records, not the current Directory work. Opening these views reads saved records rather than creating a plan or starting a model. The earlier group-outline UI is documented only as an [organization reference](../PLANNING-ORGANIZATION.md), not current navigation.

**Workbench retirement:** earlier BLACKICE releases documented an optional Windows VM Workbench and native-display paths. Those are **not current setup features** in 2.39.82 source: the VM UI, APIs and installer inputs were retired. The [retirement regression](../tests/workbench-retired.test.mjs) checks this boundary. Historical [2.39.26 pairing notes](../RELEASE-NOTES-2.39.26.md) are retained for provenance, not as instructions to install a missing Workbench component.

## Engineering references: verify against the exact revision

These explain implementation boundaries or invariants. They are valuable to maintainers, but do **not** certify that an isolated branch, candidate, external workflow, or installed host has that behavior.

- [Planning contract v2 implementation reference](planning-contract-v2-20261105.md), [operation protection](OPERATIONAL-EFFECT-PROTECTIONS.md), [application-history gate](application-history-gate.md), [planning tool exposure](planning-tool-exposure.md), and [Planning activity UI](PLANNING-ACTIVITY-UI.md).
- [Agent advocacy](agent-advocacy.md), [metacognition](METACOGNITION.md), [direct caller guidance](direct-caller-guidance.md), and [Directory execution](directory-chat-mode.md).
- [Credential authentication](credential-authentication.md), [frontend development](frontend-development.md), [frontend UI control semantics](FRONTEND-UI-CONTROLS.md), [storage management](STORAGE-MANAGEMENT.md), and [Codex history isolation](CODEX-HISTORY-ISOLATION.md).
- [Retained plan organization and earlier UI](../PLANNING-ORGANIZATION.md), [shared editing awareness](../PLANNING-AWARENESS.md) and the other files classified as engineering references in the [document status register](document-status.json).

## Historical / retired / version-bound records

Documents marked **Status: Historical documentation** preserve the original experiments, migration information, tests, and branch-specific design. They are **not operational guidance** for 2.39.82, even where their original heading says "current" or "not deployed."

- [Old canonical recursive-planning controls](RECURSIVE-PLANNING.md), [old planning depth/modes](PLANNING-DEPTH.md), and [schema-10 planning](history/RECURSIVE-PLANNING-SCHEMA10.md). Current user controls are documented in the [Planning module guide](MODULAR-PLANNING-ONTOLOGY.md).
- [November 12 Planning/Directory audit](../PLANNING-DIRECTORY-AUDIT-20261112.md) and dated [planning browser](planning-browser-architecture-20261030.md) / [response-cycle](response-cycles-20261030.md) candidates: evidence about their original revisions, not present defaults.
- [Old VM application tests](../APPLICATION-COMPATIBILITY.md), [frontend V2 rollout](../FRONTEND-V2.md), [retired ChatGPT browser model](../CHAT-MODE.md), [retired reverse bridge](../CHATGPT-BRIDGE.md), [retired email integration](../EMAIL.md), and [retired Methods](../METHODS.md).
- All [versioned release notes](../RELEASE-NOTES.md), dated evaluation reports, experimental design snapshots, and preserved [legacy planning schema](history/RECURSIVE-PLANNING-SCHEMA10.md) describe their own version and evidence boundaries.

The [document status register](document-status.json) classifies **every first-party root/docs Markdown entrypoint** as current guide, engineering reference, or historical material. Versioned release notes remain explicitly historical by filename; vendor licenses, fixtures, and verification artifacts retain their own independent provenance.

## Documentation maintenance

Run **npm run docs:check** to validate classification coverage, visible historical labels, the source-version release-note links, and local Markdown targets. New docs must be classified; retired/dated docs must be labeled before publication. When a capability changes, update the primary user guide and documentation index **in the same change**, then record the new release's scope separately. Never claim public installer installation from a passing source test, and never silently rewrite historical measured outcomes.
