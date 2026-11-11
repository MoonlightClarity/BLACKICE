# BLACKICE

**BLACKICE is an open-source Windows workspace for AI agents.** It brings models, local files and commands, a contained browser, planning, workflows, knowledge, and optional Windows application automation together so an agent can act—not just chat.

**Bottom line:** BLACKICE supplies the environment and tools; connected models supply reasoning. Agents can work inside BLACKICE, external assistants such as ChatGPT and Gemini can use BLACKICE, and one agent can prompt another agent through an available browser session. **Execution is not proof of completion.**

**Download (64-bit Windows):** https://github.com/MoonlightClarity/BLACKICE/releases/latest

**Specification scope:** Published **2.39.27 (November 7, 2026)**. This README describes the shipped behavior and its boundaries. It is self-contained: no other document is needed to learn what a feature is supposed to do or not do. Availability still depends on the model, connected accounts, host, website and observed results.

## Feature summary

| Feature | What it provides | Key boundary |
| --- | --- | --- |
| **Chat and models** | Saved conversations, providers, native accounts, API connections, MCP tools. | Not a bundled AI model or unlimited inference. |
| **Planning** | Inference, feasibility, work items, dependencies, evidence, reconsideration. | Not a guarantee of correct reasoning or completed work. |
| **Intelligence planning** | Requirements, hypotheses, collection, evaluation, assessment. | Not automatic truth verification. |
| **A2A interaction** | An agent can prompt another accessible agent in a browser or delegate work internally. | Not a separate formal A2A protocol. |
| **Browser** | Contained browsing, page observation, interaction, uploads, downloads, sessions. | **Unreliable for visual tasks without a vision-capable model.** |
| **Files and commands** | Local file operations, patches, shell commands, artifacts. | Not an OS sandbox or automatic external publishing. |
| **Tasks and scheduling** | Multi-agent workflows, assignment, cron/interval jobs, results. | Not ongoing execution while the app is closed. |
| **Connectors** | ChatGPT, Gemini, remote agents, and connected MCP servers. | Not automatic access to any assistant or service. |
| **Knowledge** | Memories, skills, source relationships, revision history. | Not a self-validating knowledge base. |
| **Remote access** | Tailscale HTTPS, browser pairing, authenticated remote tools. | Not a cloud-hosted BLACKICE runtime. |
| **Reliability** | Durable jobs, receipts, recovery checks, evidence. | Not proof of external success from a click. |

## Feature specifications

## 1. Chat and model execution

BLACKICE can host its own model-driven conversations. The selected provider supplies inference; BLACKICE supplies the workspace and attached tools.

| Subfeature | Does | Does not |
| --- | --- | --- |
| **Native account models** | Connects supported account-backed model runtimes such as Codex and Mistral Vibe Code; retains model identity with saved conversations. | Supply those accounts, lift subscription limits, or silently replace the selected model. |
| **API model providers** | Configures supported Responses, Anthropic Messages, and Chat Completions-compatible endpoints, including custom/local endpoints. | Guarantee a listed provider's inference access, free pricing, quota, or all model capabilities. |
| **Model setup checks** | Loads advertised model catalogs and checks supported account/credential access before saving compatible connections. | Prove that the selected model will successfully generate an answer or use every tool. |
| **Saved conversations** | Retains messages, selected model/provider, attachments, execution records, and explicit continuation. | Pretend an interrupted provider session resumed cleanly without checking its actual saved state. |
| **Tool connections** | Connects local stdio and remote Streamable HTTP MCP tool servers for in-app agents, with inspectable tool catalogs. | Run catalog items just by connecting or automatically make an incompatible tool callable. |

## 2. Planning

**Planning is a shared, revisable specification of intended work and required evidence, paired with an execution journal.** It is neither a checklist-only feature nor a second model secretly executing actions.

| Subfeature | Does | Does not |
| --- | --- | --- |
| **Inference** | Interprets the full request, intended benefit, end-to-end outcome, delegated work, constraints, and material uncertainties. | Make speculation authoritative or replace explicit instructions with a simpler inferred goal. |
| **Feasibility** | Assesses concrete tools, access, input data, environment, time, confirmed blockers, repairable gaps, and cheap checks. | Treat a named tool or provider connection as proof that it works for the task. |
| **Plan** | Saves the canonical intent: goal, outcome criteria, meaningful work items, owners, resource scopes, permitted effects, dependencies, and instructions. | Require a separate model-authored step for each click, read, keystroke, or validation correction. |
| **Work-item decomposition** | Divides independent or dependent work at meaningful objective, ownership, resource, and verification boundaries. | Guarantee that an AI-written decomposition is complete or optimal. |
| **Conditions and dependencies** | Tracks prerequisites and action readiness; preserved legacy graph plans can use nested Boolean IF/ELIF/ELSE and revisit operations. | Execute arbitrary Python code or imply that legacy graph operations are the new canonical contract. |
| **Think / reassessment** | Evaluates observed results against criteria and contrary evidence, then revises affected work or returns to an earlier decision when necessary. | Expose private reasoning transcripts or guarantee the model reaches a sound conclusion. |
| **Respond / completion review** | Reports achieved, partial, blocked, and uncertain outcomes based on the plan and real execution records. | Claim a requested external result merely because a click succeeded or an agent said 'done'. |
| **Recursive response cycles** | For supported tasks, uses **Inference → Feasibility → Plan → Think → Respond**, with revisions and bounded subproblems as needed. | Automatically run all five model stages for each ordinary file or browser tool call. |
| **Evidence types** | Distinguishes observed resources, complete coverage of a concrete source, destination-confirmed external effects, and grounded judgments. | Count existing records, partial reads, and repeated receipts as new confirmed results. |
| **Editing and collaboration** | Lets people and agents inspect or edit the same saved plan, track revisions, and preserve updates after an execution starts. | Retroactively cancel an already-dispatched operation by changing its plan. |
| **Planning modes** | **Forced** requires applicable planned work; **Advisory** allows optional planning; **Off** disables the automatic planning requirement. | Disable ordinary execution authority, cancellation, or uncertain-effect handling when Planning is Off. |

## 3. Intelligence planning

An additional **intelligence-analysis workflow** within Planning, for decisions that require structured research and competing explanations. It is distinct from the generic work-item execution contract.

| Subfeature | Does | Does not |
| --- | --- | --- |
| **Requirements** | Captures the decision, priority intelligence requirement, key intelligence questions, scope, and information needs. | Decide an answer before investigating the evidence. |
| **Hypotheses** | Frames competing explanations and the indicators or observations that could falsify them. | Treat the first plausible explanation as established. |
| **Collection and evaluation** | Organizes sources, provenance, collection gaps, credibility, contradictions, and corroboration. | Automatically authenticate every source or turn absent information into negative evidence. |
| **Analysis and assessment** | Supports evidence-based judgments, confidence, alternatives, implications, and a bottom-line-up-front assessment. | Make confidence labels objective measurements or prove a hypothesis without adequate data. |
| **Visual relationship map** | Shows explicitly recorded intelligence entities and relationships from the saved analytical text. | Infer missing relationships or independently verify that an edge is true. |
| **Execution boundary** | Saves the draft assessment and its workflow separately; a user or agent can start work explicitly. | Start agents merely because an intelligence plan was saved. |

## 4. Agent-to-agent (A2A) interaction

**A2A is an implicit capability, not a separate formal protocol implementation.** An agent can prompt or delegate to another accessible agent and use its reply as input. ChatGPT and Gemini (formerly Bard) are examples, not the full definition.

| Subfeature | Does | Does not |
| --- | --- | --- |
| **Agent prompting an agent** | An agent can open an ordinary accessible chat page in BLACKICE Browser, type a task to another agent, read the response, and continue. | Obtain access to every agent service, bypass logins, or control the specially reserved human ChatGPT calling tab. |
| **Browser-based A2A** | Uses the same browser navigation, input, observation, screenshots, and session rules as any website. | Provide a privileged API into the other agent or guarantee its answer is machine-readable or correct. |
| **Delegated subagents** | Native BLACKICE workflows can assign scoped prompts to other workers with dependencies and returned results. | Make child workers independent of configured models, resource constraints, or observed completion checks. |
| **External assistants using BLACKICE** | A ChatGPT or Gemini agent can call authorized BLACKICE tools, including reading saved plans; where supported, an assistant can explicitly start a BLACKICE chat. | Mean that every external assistant automatically has access, or that every direct tool call starts a second agent. |
| **Protocol distinction** | Uses existing browser prompting, internal delegation, or connected MCP/REST interfaces as the practical path between agents. | Claim a standalone standards-based A2A agent-card/discovery endpoint or a special A2A wire protocol that BLACKICE has not implemented. |
| **Cross-agent verification** | Carries actual task IDs, run outcomes, and observations back to a coordinator where the interface provides them. | Treat the other model's assertion as independently verified external-world success. |

## 5. Browser

BLACKICE has a contained, agent-operable browser that the person can also inspect. Its actions are based on observed pages, tabs, and document identities.

| Subfeature | Does | Does not |
| --- | --- | --- |
| **Navigation and tabs** | Opens sites, moves through history, manages tabs/folders, selects tabs, suspends idle pages, and closes completed work. | Guarantee a stable page layout or unrestricted access to third-party websites. |
| **Page inspection** | Reads supported page text and controls, snapshots page state, and captures screenshots. | See all visual content reliably through text/DOM extraction alone. |
| **Vision requirement** | A **vision-capable model is strongly needed for reliable visual browser work**: screenshots, spatial layouts, icon-only controls, image content, and dynamically rendered UIs. | Make browser automation reliable with a text-only model. **Without vision, visual browser tasks are unreliable**, even where DOM/text controls sometimes work. |
| **Interactions** | Clicks, hovers, fills fields, types, selects, presses keys, scrolls, and waits using the observed current page. | Assume an earlier selector, coordinate, URL, or document remains valid after a page changes. |
| **Dialogs and uploads** | Handles supported site dialogs and file upload controls; verifies the chosen page and file context before dispatch. | Solve every CAPTCHA, native authentication step, unsupported dialog, or hidden file chooser. |
| **Downloads and sessions** | Supports page downloads and persistent contained browsing sessions. | Transfer another browser's authenticated cookies automatically or guarantee that a session persists on a changed site. |
| **Browser profiles** | Can import or connect supported Chromium profiles/sessions through separate integration paths. | Equate the imported/connected browser session with the contained Electron session. |
| **Interaction evidence** | Allows a model to inspect a page after submitting a form and check for an actual result. | Treat typing or a successful click as proof the remote submission was accepted. |
| **Ownership** | Supports observed tab ownership and guarded changes to who controls a tab; reserves the user's calling chat tab. | Give an external agent unlimited control over every human browsing session. |

## 6. Files and local execution

Attached tools act on the host's configured working folders and Windows account.

| Subfeature | Does | Does not |
| --- | --- | --- |
| **Browse and search** | Lists folders, reads text, searches files, and inspects available attachments and artifacts. | Assume a partial excerpt is the entire source or read unavailable paths without host access. |
| **Editing** | Creates or overwrites UTF-8 text and can make exact patches with saved before/after records. | Turn an unconfirmed edit into a verified repair or silently resolve conflicts. |
| **Commands** | Runs bounded shell commands and captures exit status, output, and failures. | Provide a virtual OS sandbox: the working directory is a starting point, not a security boundary. |
| **File artifacts** | Preserves generated files and registered task artifacts for later inspection. | Automatically publish local artifacts to an outside service. |
| **Permissions and effects** | Uses existing Windows-account rights and the attached tool's real dispatch constraints. | Make a command safe, reversible, or authorized solely because the model wrote it. |

## 7. Tasks, workflows, and scheduling

Tasks are saved work; workflows assign stages to agents; schedules trigger work on the running host. The **Cronjobs** tab opens schedules, results, and job history directly. **Manage saved workflows** opens the reusable workflow editor; **Back to Cronjobs** returns without discarding unsaved drafts. Task and run records remain available through Chat and Planning. Older `#tasks` and `#activity` links open Cronjobs; saved schedules and connector/API names do not change.

| Subfeature | Does | Does not |
| --- | --- | --- |
| **Workflow graph** | Creates and edits multi-stage workflows with prerequisites, stage settings, and assigned workers. | Guarantee unrelated agents can safely modify the same file simultaneously. |
| **Worker assignment** | Records a worker's scope, inputs, expected result, and observable done condition. | Grant a worker capabilities beyond its tools and assigned scope. |
| **Subagent delegation** | Can dispatch bounded workers for independent or dependent tasks and return their actual runtime outcomes. | Allow unlimited parallel or recursively self-spawning workers. |
| **Task and run history** | Chat and Planning retain saved work, stage progress, and execution records; Cronjobs shows scheduled results and job history. | Equate a visually complete stage with a confirmed external result. |
| **Schedules** | Supports manual, cron, interval, and webhook-triggered work with timezones and run previews where configured. | Execute a schedule while the host is asleep, offline, or the BLACKICE runtime is not running. |
| **Run policy** | Supports pause/resume, overlap handling, bounded retries, missed-run behavior, and limits configured per schedule. | Guarantee every missed occurrence will be replayed or every third-party action can be safely retried. |
| **Results** | Stores scheduled outcomes and history locally; can opt into a configured webhook result destination. | Send results back into an idle ChatGPT/Gemini chat automatically or report a queued job as complete. |

## 8. External connectors and tool interoperability

There are two directions: **an external assistant calls BLACKICE**, or **a BLACKICE agent calls a configured external MCP tool server**.

| Subfeature | Does | Does not |
| --- | --- | --- |
| **ChatGPT → BLACKICE** | Supports an authenticated direct MCP connection for file, command, browser, planning, and other advertised tools. | Require BLACKICE to run a second model for ordinary direct actions, or attach itself automatically to every chat. |
| **Gemini → BLACKICE** | Allows Google Gemini's connected app to use the same running server with its own OAuth grant and consent. | Merge its authorization with ChatGPT's, or replace the outgoing Gemini API provider. |
| **Other external agents** | Provides a paired outside-agent MCP/REST task interface with saved plans, starts/continues/cancellations, outputs, and events. | Guarantee that every outside product supports the required authentication or transport. |
| **BLACKICE → MCP servers** | Lets in-app agents use configured local stdio or remote Streamable HTTP MCP tool connections. | Execute a tool simply because its catalog was discovered, or guarantee protocol compatibility for arbitrary endpoints. |
| **Independent grants** | Tracks and revokes separate assistant grants without unintentionally revoking the other connector. | Use one agent's login to authorize another agent silently. |
| **Durable calls** | Returns stable job/run identifiers for long work so a caller can inspect actual results. | Push background completions into an unrelated conversation or replay uncertain external actions automatically. |

## 9. Knowledge and saved context

Knowledge is locally stored, human-editable reference material accessible to eligible BLACKICE agents.

| Subfeature | Does | Does not |
| --- | --- | --- |
| **Memories** | Saves notes, facts, assumptions, and decisions as distinct entry types. | Automatically prove an entry is correct or current. |
| **Skills** | Stores reusable instructions and practices as separately typed entries. | Execute a skill or an arbitrary program merely because it was saved. |
| **Sources and relationships** | Allows saved references and explicit supports/contradicts/informs/supersedes relationships on memory entries. | Infer that a cited source is trustworthy without checking it. |
| **Finding and scoping** | Searches entries and optionally scopes them to a working folder; unscoped entries can be available broadly. | Search the entire internet or automatically synchronize all provider memories. |
| **History and recovery** | Tracks revisions, supports edits, Trash, and restoration of retained versions. | Promise unlimited historical versions or infer a deleted entry's missing content. |

## 10. Remote access and pairing

## 11. Remote access and pairing

BLACKICE can expose its running workspace to a human browser or another agent using configured HTTPS connectivity.

| Subfeature | Does | Does not |
| --- | --- | --- |
| **Network modes** | Provides private Tailscale Serve or public Tailscale Funnel exposure on the host's actual configured HTTPS address. | Make an unreachable or sleeping computer available from the internet. |
| **Human pairing** | Uses a short-lived pairing code to connect a remote browser to the existing workspace. | Make a remote browser a second independent BLACKICE host. |
| **Outside-agent access** | Issues per-client credentials for its remote agent interfaces and associates actions with the authenticated client. | Provide unrestricted direct desktop/browser APIs through the limited outside-agent task surface. |
| **MCP and REST** | Serves documented agent tools over MCP Streamable HTTP and corresponding REST operations. | Claim that this is the formal agent-to-agent (A2A) protocol. |
| **Background/headless** | Can run without a visible main window while the actual BLACKICE process is operating. | Start itself merely because an external agent makes a call. |
| **Availability responder** | Can report closed/unreachable application state while the main runtime is absent. | Execute commands, drive a browser, start models, or queue new actions while BLACKICE is closed. |

## 11. Reliability, state, and limitations

BLACKICE records operations so users and agents can distinguish an attempted action from an observed outcome.

| Subfeature | Does | Does not |
| --- | --- | --- |
| **Action receipts** | Saves durable identities, status, output, and failures for bounded operations. | Guarantee that a successful tool return equals third-party acceptance. |
| **Interrupted work** | Retains records for inspecting effects after disconnects, cancellations, and uncertain outcomes. | Automatically replay an operation whose external effects are unknown. |
| **Plan provenance** | Separates model-authored intent, actual host operations, and evidence used in final review. | Treat a polished explanation as independent verification. |
| **Model and site limits** | Reports provider, browser, operating-system, and evidence blockers where observed. | Guarantee arbitrary models, websites, applications, or automated end-to-end tasks. |
| **Local data** | Keeps saved profile data under the compatible `%APPDATA%\Relay` folder and files in their working folders. | Back up an unrelated working folder merely by copying the application profile. |

## Get started

1. **Install:** Download `Blackice-<version>-Setup.exe` from the release URL above. Current public Windows installers are unsigned. Optionally compare the installer with that release's `SHA256SUMS.txt`.
2. **Choose how to reason:** In **Settings → Models**, connect a supported native account or configure an API provider, then select the model in **Chat**. Model availability and costs come from that provider.
3. **Or connect an outside assistant:** In **Settings → ChatGPT connector** or **Settings → Gemini connector**, prepare the host connection, approve the matching request, and test an actual `blackice_direct_status` tool round trip in the assistant. The two assistants have separate authorizations.
4. **Give the agent tools and context:** Select the appropriate working folder and use the contained **Browser** or attach a compatible tool server. For visual browser work, prefer a **vision-capable model**. Without one, visual tasks are unreliable.
5. **Inspect the outcome:** Verify real destination effects before counting submissions, installations, or changes as complete. Read saved job/run results if a request was interrupted.

## Operational requirements

| Requirement | Specification |
| --- | --- |
| Host | 64-bit Windows, running BLACKICE desktop or background/headless instance for actual tool execution. |
| Models | Connected native account or compatible API endpoint as chosen; provider limits and charges are independent of BLACKICE. |
| Browser | BLACKICE contained browser; visual workflows are unreliable with a text-only model. |
| Remote assistants | Host reachability over configured Tailscale/HTTPS plus the actual connector or outside-agent authorization. |
| Local authority | File and command tools act with the Windows account's rights; choosing a folder is not OS sandboxing. |
| Scheduled work | The host must be running and sufficiently awake; schedules do not make a closed app execute. |
| State | App profile uses `%APPDATA%\Relay` for compatibility; working-folder files are separate. |

## Build from source

With Node.js 22.12 or newer on supported Windows:

```powershell
git clone https://github.com/MoonlightClarity/BLACKICE.git
cd BLACKICE
npm ci
npm run desktop
```

| Command | Behavior |
| --- | --- |
| `npm test` | Runs the source tests; passing is not live website or VM acceptance. |
| `npm run headless` | Starts the desktop runtime without the normal main window. |
| `npm run package:public` | Produces an unsigned Windows installer **candidate**, not a published release. |

**Retired interfaces:** The former BLACKICE-to-ChatGPT browser-provider mode and reverse Bridge, old email integration, and Methods interface are not current capabilities. Browser-based A2A prompting and ChatGPT/Gemini calling BLACKICE are different from the retired reverse Bridge.

**License:** BLACKICE-authored code is Apache License 2.0; bundled third-party components retain their own licenses.
