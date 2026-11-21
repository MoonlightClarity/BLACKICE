# Tool and host responsibilities

The model chooses actions that advance the user’s task and interprets their results. BLACKICE and the operating system execute those actions, maintain sessions and record what happened. Tools provide the interface between those responsibilities.

This note describes the current implementation. The final section contains recommendations; administration tools have not been hidden or removed by this change.

## Current capability roles

Native `relay_*` tools run inside a BLACKICE agent execution. Direct `blackice_*` tools serve connected clients. Related operations can have different wrappers, required fields and result lifecycles. The attached schema describes the actual call. The [engine](../lib/engine.mjs), [direct API](../lib/direct-execution-api.mjs) and [connector catalog](../lib/chatgpt-tool-catalog.mjs) construct these surfaces.

| Capability | Current role |
| --- | --- |
| Local files and commands | Native `relay_workspace` reads, searches, edits and runs commands. `relay_find_files` discovers filenames and paths. Direct workspace read/write and command tools expose corresponding host operations through durable jobs. |
| Websites | `relay_browser` and direct browser read/action tools inspect pages and operate observed targets. Connected-browser and profile tools manage additional browser connections and profiles. |
| Native applications | `relay_windows` launches or attaches Windows applications and operates accessibility controls. `relay_apps` provides private application sessions and saved text snapshots. These have different session and document lifecycles. |
| Attachments | `relay_files` reads task attachments by a listed attachment ID and can export a working copy. A local filesystem path is a different input. |
| Email and credentials | `relay_email` reads mail, prepares messages and tracks sending. Native credentials and direct credential tools manage saved accounts and support filling or authenticating compatible forms. |
| Reusable information | `relay_skills` reads methods. `relay_history` searches saved run records. `relay_identity` reads the identity/profile snapshot. These are separate sources, not general filesystem searches. |
| Visual artifacts | Native and direct visual tools create, inspect, revise and export saved visual documents. Preview results let the model inspect the rendered result. |
| Work coordination | Delegation, saved conversations, Goals, task contracts, action outlines and analytical Planning each expose a specific work lifecycle, described below. |
| Administration | `relay_project`, `relay_prompts` and `relay_control` manage saved projects, templates, workflows, runtime settings and scheduled work. Provider setup, restart and frontend debugging are direct administrative capabilities. |

Implementations: [workspace](../lib/workspace-tools.mjs), [filename discovery](../lib/file-search-contract.mjs), [browser](../lib/browser.mjs), [connected browsers](../lib/connected-browser-tools.mjs), [Windows applications](../lib/native-window-tools.mjs), [private applications](../lib/application-tools.mjs), [email](../lib/email-tools.mjs), [retrieval](../lib/retrieval-tools.mjs) and [visuals](../lib/visual-artifacts.mjs).

## Distinctions that affect the next action

**Attachments and paths.** Use a returned attachment ID with `relay_files`. Use a known absolute local path directly with the workspace reader, including outside the starting working folder. An empty attachment list does not establish that a local file is missing. Exporting an attachment creates a working copy; it does not edit the original. See [attachments](../lib/attachments.mjs).

**Working folder, output destination and search roots.** `cwd` resolves relative paths and starts commands. A requested output folder does not limit input discovery. Filename-search `path` or `roots` selects coverage. A miss in one folder describes that search, not every location. Native discovery without explicit roots currently includes common personal folders, the working folder and detected filesystem roots. Explicit relevant roots keep a known-location search focused. OS permissions still determine accessible locations. See [location discovery](../lib/workspace-file-search-locations.mjs).

**Delegates and saved agents.** `relay_delegate` runs workers scoped to the current execution and returns their statuses and outputs. It does not create an independently managed saved conversation. `relay_agents` and direct `blackice_start_chat` manage saved conversations that can be continued or given persistent Goal state. Host scheduling and worker admission remain separate from the model’s choice of coherent work units. See [delegation](../lib/subagents.mjs), [saved agents](../lib/native-agent-control.mjs) and [direct chat creation](../lib/chatgpt-start-chat.mjs).

**Planning stores.** `relay_task` operates the task execution contract and its receipts. `relay_directory_action` operates a per-task action outline. Native `relay_planning_*` tools adapt the saved analytical Planning graph used by the direct Planning tools. These stores have different records, revisions and operations. A graph’s `graphRequestId` and module `nodeId` are not substitutes for a task-contract or action-outline field. See [task state](../lib/task-state.mjs), [action outlines](../lib/task-action-directory-store.mjs) and [Planning adapters](../lib/native-planning-tools.mjs).

**Vault records and website forms.** Saving or updating a credential changes the local vault, not the website password. Filling writes supported fields without submitting; authentication is a separate supported form operation. An associated `loginOrigin` becomes the `origin` argument when filling that SSO page. Ordinary browser forms remain available. See [credential tools](../lib/browser-credential-tools.mjs).

## Responsibilities already implemented in the host

- **Catalog refresh:** native provider threads retain their original tool definitions. BLACKICE fingerprints current descriptor variants, including descriptions and schemas. A supported saved catalog with a missing or different fingerprint uses the existing history handoff on Continue/Retry. The task and saved messages remain in the conversation. A genuine resume preserves the original fingerprint. This does not refresh an external client’s cached connector catalog. See [fingerprinting](../lib/native-catalog-fingerprint.mjs) and [native provider calls](../lib/codex.mjs).
- **Goal defaults:** omitted `maxTurns` and `maxMinutes` become `null`. An explicit numeric limit is enforced; `null` imposes no budget stop from that field. The model need not invent a turn allowance. See [Goals](../lib/conversation-goals.mjs).
- **Traversal and coverage:** the host discovers default roots, follows links, deduplicates targets and manages traversal cursors. Follow a returned cursor while present. `scanComplete` means traversal ended; `searchComplete` additionally requires no errors or skips. Finished traversal can therefore have incomplete coverage. See [file search](../lib/workspace-file-search.mjs).
- **Durable execution:** the direct API stores request identity, jobs and results. Reusing an identical request recovers its existing result; `blackice_get_job` reads queued work. Clients still supply the fields required by their attached schema. A queue admission is not completion evidence. See [direct execution](../lib/direct-execution-api.mjs).
- **Receipts and conflicts:** host adapters record operations and check revisions or target identity. Effect tools expose unresolved outcomes for investigation. The model interprets current evidence and decides how to resolve a real conflicting edit; transport success alone does not prove the external result. See [effect handling](../lib/operational-effect-guard.mjs) and [receipt inspection](../lib/operational-receipts.mjs).

## Recommendations, not shipped exposure changes

1. **Make administration optional.** Offer project, prompt-template, workflow, provider and debugger capabilities when the task calls for them. Current native control exposure is broader than that. Preserve requested management capabilities through explicit scope selection and the existing native handoff mechanism.
2. **Keep coordination proportional to the task.** Preserve current explicit Planning gating. Avoid requiring ordinary work to maintain a task contract, action outline and analytical graph simultaneously. Each should have a concrete requested purpose.
3. **Separate browser work from browser administration.** Page inspection and interaction serve website tasks. Collections, folder organization, protection settings and debugging serve management or troubleshooting. Task ownership and normal release cleanup already belong to the host.
4. **Reduce mechanical copying.** Where the host can bind an observed target, generate a request identity or recover a known job, implement that behavior in the adapter first. Then simplify the model-facing recipe. Do not remove required-field guidance while the actual schema still requires those fields.

A shell’s theoretical ability to reproduce another operation is not sufficient reason to delete its tool. Filename coverage, email delivery state, accessibility targets, attachment IDs and application snapshots provide concrete results that generic commands do not provide automatically.
