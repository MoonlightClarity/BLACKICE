# BLACKICE documentation map

**Current published application: 2.39.27 (November 7, 2026).** Start with the [project README](../README.md) and the [latest release](https://github.com/MoonlightClarity/BLACKICE/releases/latest). This page distinguishes active user guidance from historical design and test reports. A date or old schema in a preserved report describes **that report's version**, not necessarily today's runtime.

## Current user guides

| Topic | Read |
| --- | --- |
| Installation, models and everyday use | [README](../README.md) |
| Direct ChatGPT MCP connection | [ChatGPT connector](../CHATGPT-CONNECTOR.md) |
| Independent Google Gemini MCP connection | [Gemini connector](GEMINI-CONNECTOR.md) |
| Public/private reachability and outside agents | [Remote access](../REMOTE-ACCESS.md) |
| Planning v2 work items, admission and evidence | [Current planning](RECURSIVE-PLANNING.md) |
| Collaborative editing | [Planning awareness](../PLANNING-AWARENESS.md) |
| Native and optional API model setup | [API providers](API-PROVIDERS.md) |
| Browser sessions and profile imports | [Browser import](../BROWSER-IMPORT.md) |
| Persistent Windows application guest | [Workbench setup](../WORKBENCH-SETUP.md) |
| Installer creation, source gates and release checks | [Release workflow](../SIGNING-AND-RELEASE.md) |
| Workbench native viewer test boundaries | [Native display status](../WORKBENCH-NATIVE-DISPLAY.md) |

## Implementation and verification references

- [Planning contract v2 (November 5 design and test scope)](planning-contract-v2-20261105.md): current contract mechanics, with its **original experimental acceptance statements preserved**.
- [Agent advocacy](agent-advocacy.md): inference, evidence and decision principles.
- [Practical judgment](METACOGNITION.md) and [planning depth](PLANNING-DEPTH.md): quality principles and limits of host enforcement.
- [Provider setup details](provider-setup-20261030.md), [model context reporting](model-limits-20261030.md) and [frontend development](frontend-development.md): dated implementation notes.
- [Release notes](https://github.com/MoonlightClarity/BLACKICE/releases) and the versioned `RELEASE-NOTES-*.md` files: specific historical claims and verification evidence.

## Historical and retired material

- [Schema-10 recursive planning guide](history/RECURSIVE-PLANNING-SCHEMA10.md) applies to preserved legacy plans, **not new canonical v2 work items**.
- [2.22 Windows application compatibility](../APPLICATION-COMPATIBILITY.md) records private-desktop experiments and does not describe the full current Hyper-V Workbench.
- [ChatGPT browser model retirement](../CHAT-MODE.md), [reverse Bridge retirement](../CHATGPT-BRIDGE.md), [retired email integration](../EMAIL.md) and [retired Methods interface](../METHODS.md) are retained for migration context.
- Dated experiments (for example [Planning browser architecture candidate](planning-browser-architecture-20261030.md), [response cycles](response-cycles-20261030.md) and [Planning dogfood](PLANNING-DOGFOOD-2026-10-29.md)) are historical evidence. Follow current source and release notes where behavior has changed.

To check a capability, distinguish **documented design**, **shipped code**, **source/regression verification** and **actual external end-to-end acceptance**. Do not promote an earlier candidate, an isolated fixture or a successful UI click into a current production guarantee.
