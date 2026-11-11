> **Next-version README:** This document describes the next version of BLACKICE.

# BLACKICE

**BLACKICE is an open-source Windows workspace for autonomous AI agents and a bidirectional companion to Codex.** It brings model reasoning, recursive planning, local execution, a contained browser, agent collaboration, scheduled work, knowledge, and observable results into one workflow.

Agents can work in BLACKICE or Codex. Codex can call BLACKICE for its planning and execution environment, and BLACKICE can use Codex as a native reasoning and development runtime. Other connected assistants, including ChatGPT and Gemini, use BLACKICE's direct tools. **The model supplies reasoning; BLACKICE supplies a coordinated environment for doing and verifying work.**

**Repository:** https://github.com/MoonlightClarity/BLACKICE  
**Windows releases:** https://github.com/MoonlightClarity/BLACKICE/releases

## What BLACKICE does

| Capability | Integrated behavior |
| --- | --- |
| **Chat and Codex** | Native model-backed conversations, bidirectional Codex integration, API providers, and persistent model identity per conversation. |
| **Planning** | A single recursive Planning system with inference, feasibility, decomposition, conditional logic, execution feedback, and revision. |
| **Browser** | A contained browser operated and inspected by both the user and agents, with observable pages, uploads, downloads, and tab lifecycle management. |
| **Local execution** | Files, exact patches, shell commands, application diagnostics, and durable tool results on the user's Windows machine. |
| **Tasks and agents** | Reusable workflows, delegated subagents, dependencies, work tracking, and scheduled or event-triggered execution. |
| **External connections** | Direct ChatGPT and Gemini access to BLACKICE tools, plus interoperable MCP connections and remote agent interfaces. |
| **Knowledge** | Memories, skills, references, source relationships, and shared task context available to eligible agents. |
| **Reliability** | Durable operation IDs, resumable inspection, explicit uncertainty, evidence-aware completion checks, and revisioned planning state. |

The workspace is **agent-oriented rather than prompt-oriented**: a request becomes work with a goal, constraints, decisions, actions, and observable results. The user can inspect or intervene in that work without becoming responsible for every routine substep.

## One integrated workflow

BLACKICE uses a recursive work cycle:

1. **Infer** the actual objective, hard constraints, preferences, unwanted outcomes, and missing information.
2. **Check feasibility** against available tools, access, time, data, and concrete blockers.
3. **Plan** the smallest useful executable substeps, their dependencies, conditions, ownership, and success criteria.
4. **Think and act** using the selected model and available tools. Observe each meaningful result.
5. **Re-enter Planning** whenever evidence changes a premise, a condition fails, a dependency becomes ready, or a better approach emerges.
6. **Respond** with completed, partial, blocked, and uncertain outcomes grounded in receipts and observations.

This is not a fixed Plan → Think → Respond chain. The model can move **Plan → Think → Plan → Think → Respond**, reopen earlier decisions, recurse into a subproblem, or revise the work graph without discarding the task's identity.

The same canonical task record powers the outline, visual Planning graph, task progress, notes, dependencies, execution evidence, and final review. Views do not invent their own competing versions of the plan.

## Planning

Planning is one editable, shared system rather than separate legacy planners. It is available to agents and the user, and its selected behavior persists through drafts, admitted runs, continuations, retries, and saved workflows.

### Modes

| Mode | Behavior |
| --- | --- |
| **Off** | Does not impose automatic Planning. Direct task execution and normal tool handling remain available. |
| **Advisory** | Makes Planning available without requiring every request to pass a formal plan gate. |
| **Forced** | Requires applicable work to be planned before execution and reviewed when material conditions change. |
| **Maximal** | Uses the full recursive inference, feasibility, decomposition, and reconsideration workflow for complex or long-running work. |

### Structured, recursive work

- **Hierarchical decomposition.** The outline follows the actual plan: `1`, `1.1`, `1.1.1`, and so on. Substeps are broken down until each actionable leaf has a clear purpose, prerequisites, and observable completion condition.
- **Chronological execution with recursion.** Work advances in dependency order but can revisit prior steps, insert a newly discovered branch, or deepen an existing step.
- **Conditional logic.** Branches express `IF`, `ELIF`, `ELSE`, `AND`, `OR`, `NOT`, and nested conditions, with explicit fallbacks, retries, and stop conditions. This is an executable decision structure, not an invitation to run arbitrary Python in the planner.
- **Inference and feasibility.** The agent separates genuine hard gates from ideals and preferences, checks cheap uncertainties early, and considers alternatives rather than stopping at the first repairable obstacle.
- **Grounded accuracy fields.** Task accuracy criteria specify what constitutes an acceptable outcome, how it is measured, and what evidence supports it. Missing or bounded evidence remains visibly uncertain instead of being converted to a success claim.
- **Revision-aware collaboration.** The user, a native worker, Codex, or an authorized external assistant can inspect and revise the same plan using revision checks. A plan edit does not pretend to undo an already dispatched external action.
- **Outline and relationship views.** Hierarchy and SVG relationship views represent the same saved nodes and relationships. They are not a separate source of truth.

Planning supports research and intelligence-style analysis as well as operational execution: requirements, competing hypotheses, evidence and contradictions, collection gaps, confidence, and decision implications can be recorded inside the same system.

### User advocacy and autonomy

A request is interpreted in terms of the user's intended result, not merely literal keywords or an outside party's asserted requirements. BLACKICE evaluates the cost of compliance, real authority, feasibility, and the user's time. Routine agent actions proceed without repeatedly delegating ordinary decisions back to the user. Material choices remain inspectable and revisable.

## Codex and models

**Codex and BLACKICE are integrated in both directions.** A conversation may live in Codex or BLACKICE; an agent can use the other environment when that helps the task. Codex is useful on its own and is not required to route every request through BLACKICE.

- **Native Codex identity.** The integration identifies itself as BLACKICE, uses the packaged application identity, and carries the current BLACKICE instructions into coordinator and delegated-worker turns.
- **Model continuity.** Each saved conversation retains the model and provider actually used. Changing the default does not relabel or silently switch older conversations.
- **Provider choice.** BLACKICE connects account-backed runtimes and compatible API endpoints, including Responses, Anthropic Messages, Chat Completions-compatible services, and local models. Provider quotas, prices, and capabilities remain those of the selected provider.
- **Tool-aware conversations.** Native chat can access the applicable Planning, browser, files, execution, knowledge, and MCP tools. Direct tool actions do not need to start an additional model.
- **Current-turn instructions.** Compatible provider continuations receive the applicable current developer policy rather than relying on stale cached instructions.
- **Independent external assistants.** ChatGPT and Gemini can access BLACKICE through their own authenticated connections, without becoming the provider selected for native BLACKICE chats.

BLACKICE is **not** a bundled frontier model, a source of unlimited inference, or a guarantee that an arbitrary external provider supports every requested feature.

## Browser

The contained BLACKICE Browser is a first-class workspace shared between the human user and authorized agent work.

| Area | Behavior |
| --- | --- |
| **Navigation** | Open and inspect pages, follow history, and work across task-associated tabs. |
| **Observation** | Read page content and controls, capture screenshots, inspect browser diagnostics, and track the current document identity. |
| **Interaction** | Click, type, fill, select, scroll, upload files, and interact with supported dialogs using current observations. |
| **Sessions** | Retain contained sessions and manage supported imported or connected Chromium profiles separately. |
| **Ownership** | Track and transfer tab control between the user and agent tasks using explicit observed identities. |
| **Tab hygiene** | Associate tabs with work, reuse suitable sessions, and close completed task tabs so they do not accumulate or trigger duplicate attempts. |
| **Verification** | Inspect the destination after an interaction; a successful click is not a confirmed submission. |

For visual websites, a **vision-capable model** materially improves reliability. Text extraction alone does not reliably describe icons, spatial controls, image-only content, or dynamic visual states. Sites can still block access or require human account steps.

The browser is an agent-operable tool, not a promise of universal access to every website or browser profile.

## Files, commands, and local execution

Agents operate on the host with the attached tool's authority and the Windows account's existing rights.

- List, inspect, and search files and workspaces.
- Create text files, make exact patches, and inspect revision or undo receipts.
- Run bounded shell commands and collect exit codes, logs, and failures.
- Diagnose the BLACKICE frontend and host process through supported app inspection and debugging tools.
- Create and inspect artifacts as part of the task.
- Recover the status of an earlier operation by its durable job ID instead of blindly running it again.

A working directory provides context; **it is not an operating-system sandbox**. A successful command or tool call shows that the tool action ran, not necessarily that the outside-world objective was achieved.

## Tasks, swarms, and scheduling

BLACKICE represents long work as persistent tasks and workflows rather than one disposable chat per trigger.

- **Task continuity.** A scheduled continuation refers to the existing task, saved plan, progress, and relevant conversation context.
- **Delegated agents.** Independent or dependent stages can be assigned to configured workers with input, scope, resource boundaries, and observable completion criteria.
- **Conditional execution.** Tasks use prerequisite gates, branching, retries, fallback paths, and return to Planning when the evidence changes.
- **Schedules.** Manual, cron, interval, and configured webhook triggers launch eligible work while the BLACKICE host is operating.
- **Throughput and reuse.** Existing work and recorded outcomes are checked before repeating an application, submission, edit, or other externally consequential action.
- **Tracking.** The task board distinguishes *running* from queued, waiting, completed, failed, and uncertain work; only work actually running is marked active.
- **History.** Actual run IDs, receipts, and outcomes remain available for review. A disconnected caller can query a saved operation rather than assume it finished.

Scheduling does not make a powered-off or unavailable Windows host execute work. Uncertain external effects are investigated before a retry.

## Agents working with other agents

BLACKICE supports several practical paths for coordination:

1. **Codex ↔ BLACKICE:** integrated native reasoning, development, Planning, and execution across either conversation host.
2. **ChatGPT/Gemini → BLACKICE:** independently authorized direct tool calls for Planning, local files, commands, the contained browser, and other exposed capabilities.
3. **BLACKICE → MCP servers:** tools from supported local or remote MCP services available to native BLACKICE agents.
4. **Agent → agent in the browser:** one agent can prompt another accessible agent through a normal authenticated browser session and inspect the reply.
5. **Native subagents:** a coordinator can delegate scoped stages and collect their real run results.

A browser chat with another assistant is not itself a separate formal A2A wire protocol. Another model's statement that a task is finished is not independent proof of the result.

The former reverse ChatGPT Bridge is retired from the application interface. The direct connector and native Codex integration are the supported paths.

## Knowledge and unified state

The separate legacy Storage surface is removed. BLACKICE uses the workspace and task's canonical resources directly instead of exposing a competing Storage feature.

- **Conversations** preserve their own model identity, relevant context, and work history.
- **Plans** preserve nodes, relationships, notes, revisions, dependencies, and observed evidence.
- **Knowledge** preserves typed memories, skills, sources, and explicit supports/contradicts/informs/supersedes relationships.
- **Artifacts and files** remain accessible through the relevant workspace and file tools.
- **Task records** preserve work ownership, current status, schedules, operation receipts, and inspected outcomes.

Removing the legacy Storage interface does **not** mean deleting persistent user data. Compatible application-profile data and user working files are separate resources, and historical records remain available through their owning features.

## Remote access and connectors

BLACKICE runs on the user's Windows machine and provides authenticated access to that running instance.

| Connection | Role |
| --- | --- |
| **ChatGPT direct connector** | Authenticated MCP access to advertised BLACKICE tools and durable actions. |
| **Gemini connector** | Separate authenticated access to the running BLACKICE tool service. |
| **Remote human browser** | Pair with an existing BLACKICE workspace through the configured HTTPS connection. |
| **Outside agents** | Work through supported MCP/REST tools, task records, and bounded results. |
| **Native MCP clients/servers** | Use configured local stdio or remote Streamable HTTP tool connections. |

Private Tailscale Serve and public Tailscale Funnel are supported network exposure options where configured. Each external connection uses its own grant and the actual host's availability. A disconnected host does not continue local browser or command execution merely because a remote client asks.

## Outcome verification

**Execution is not proof of completion.** BLACKICE distinguishes:

| State | Meaning |
| --- | --- |
| **Attempted** | An operation was submitted or dispatched. |
| **Executed** | The relevant tool returned an observed execution result. |
| **Confirmed** | Evidence at the actual destination supports the claimed external outcome. |
| **Partial** | Some requested outcomes are confirmed and others remain open. |
| **Blocked** | A concrete obstacle prevents the next meaningful action. |
| **Uncertain** | The effect cannot yet be established; the operation must not be repeated blindly. |

Examples: entering a job application is not the same as submitting it; clicking Submit is not proof the employer received it; a patch receipt is not proof that the full software defect is fixed. Planning and final responses use the appropriate distinction.

BLACKICE's own plan and task identity survives refinement. A new model turn, reconnect, browser page, or schedule tick does not automatically create an unrelated duplicate task.

## Get started

1. **Install BLACKICE** from the [Windows releases](https://github.com/MoonlightClarity/BLACKICE/releases). Match the installer to the selected release's checksum when provided. Public Windows installers are unsigned.
2. **Choose a reasoning environment.** Open a BLACKICE chat with a supported native account or API model, or use Codex with the BLACKICE integration.
3. **Connect tools.** Select the working folder, contained browser, and any compatible MCP services or external assistant connectors you use.
4. **State the objective.** BLACKICE infers requirements, checks feasibility, creates or revises the canonical plan according to its Planning mode, and executes meaningful steps.
5. **Inspect results.** Review actual task status, browser observations, file changes, receipts, and destination confirmation.

For a recurring task, reuse its saved workflow and schedule rather than creating a new conversation for each run.

## Build from source

Use **Node.js 22 or newer** on supported 64-bit Windows:

~~~powershell
git clone https://github.com/MoonlightClarity/BLACKICE.git
cd BLACKICE
npm ci
npm run desktop
~~~

| Command | Purpose |
| --- | --- |
| `npm test` | Run the repository's source tests. |
| `npm run desktop` | Start BLACKICE's Electron desktop app. |
| `npm run headless` | Start the runtime without the normal visible main window. |
| `npm run release:check` | Run the repository's release checks. |
| `npm run package:public` | Produce an unsigned Windows installer candidate. |

Passing source tests is not a substitute for confirming a live website, model provider, or external destination action.

## Scope

BLACKICE is a **local-first agent workspace**. It needs a running Windows host for local operations and a compatible model or connected assistant for reasoning. It does not supply unlimited provider quotas, guaranteed access to third-party sites, or universal native-Windows-app automation. The old Hyper-V **Workbench** product surface and the legacy Planning and Storage interfaces are not part of the integrated workspace.

**License:** BLACKICE-authored source code is licensed under [Apache License 2.0](LICENSE). Third-party dependencies retain their respective licenses.
