# BLACKICE

**An open-source Windows workspace that gives AI assistants the tools, context, and continuity to carry out useful work.**

BLACKICE connects an assistant to a browser it can operate, files it can read and change, commands it can run, saved task history, and scheduled workflows. You can use an assistant inside BLACKICE or connect an external assistant to its tools.

The goal is to reduce the work of managing the agent: copying instructions between apps, repeating background information, keeping track of unfinished steps, and checking whether a claimed result actually happened. You define the outcome and relevant constraints; BLACKICE gives the assistant a place to execute, keeps the work inspectable, and lets you intervene when needed.

**[Download for Windows](https://github.com/MoonlightClarity/BLACKICE/releases)** · **[Source](https://github.com/MoonlightClarity/BLACKICE)** · **[Issues](https://github.com/MoonlightClarity/BLACKICE/issues)** · **[Apache-2.0 license](LICENSE)**

> **Development version:** This README describes the development branch. Check the release notes for the capabilities included in your installed version.

## Why BLACKICE exists

Useful work often crosses several tools and sessions. Research requires opening sources, comparing evidence, and producing something usable. A software change requires inspecting files, making an edit, running checks, and reviewing the result. An application requires finding the right form, supplying information, submitting it, and recording the outcome.

Coordinating all of that can become a second job for the person delegating it. BLACKICE brings the working environment, reasoning controls, execution tools, and records of what happened into one place.

| What the user needs | What BLACKICE supplies | Practical benefit |
| --- | --- | --- |
| **Get work carried out** | Browser actions, file operations, commands, and connected tools available to the assistant. | Delegate the steps involved in producing a result, including applying edits and checking the destination. |
| **Explain the task less often** | Saved conversations, task records, reusable workflows, memories, and skills. | Carry relevant information and prior progress into continuing work. |
| **Stay in control of the approach** | Model selection, per-conversation reasoning controls, visible browser pages, and inspectable plans and action history. | Adjust how the agent works and inspect the material behind its decisions. |
| **Understand what actually finished** | Command outputs, file patch receipts, browser observations, and recorded action states. | Review a result, investigate a failure, or resume an interrupted action using concrete records. |
| **Repeat useful work** | Cronjobs with saved workflow settings, schedules, overlap handling, and run history. | Configure recurring work once and review its subsequent runs. |
| **Use an existing assistant** | Native model runtimes, compatible API providers, and direct MCP connections. | Keep a preferred supported assistant while giving it access to the same Windows workspace. |

These are the benefits the product is designed to deliver. Actual completion and time saved depend on the task, chosen model, available tools, and external systems.

## What you can delegate

BLACKICE is a general workspace. These examples show how its capabilities combine into recognizable tasks.

| Example request | How the assistant can carry it out | What you should get back |
| --- | --- | --- |
| **“Research these options and recommend one.”** | Read local material, browse sources, split independent questions among workers when useful, and compare findings. | A recommendation or document with supporting sources, tradeoffs, and unresolved questions. |
| **“Fix this bug and check the result.”** | Inspect the repository, edit the relevant files, run commands or tests, and inspect their output. | The actual changes, the checks performed, and the observed result. |
| **“Complete this website workflow using these files.”** | Navigate pages, inspect controls, fill forms, upload documents, and observe the resulting page. | The destination's confirmation or a precise account of the remaining step. |
| **“Find suitable roles and apply using my resumes.”** | Evaluate roles against your constraints, prepare forms, upload materials, and consult application history before submission. | Distinct application records with confirmed, pending, or unresolved outcomes. |
| **“Run this check every morning.”** | Save the prompt, model, working folder, and relevant context in a scheduled workflow. | A history of runs and their results that you can inspect, edit, pause, or resume. |

The selected model performs the reasoning. BLACKICE supplies the workspace, tools, orchestration, and records around that reasoning. Native Codex and configured API models can supply inference while your Windows computer hosts the working environment.

## Work in BLACKICE or from an external assistant

### Inside BLACKICE

Choose a supported native runtime, such as **Codex** or **Mistral Vibe Code**, or configure an API model. API connections support **OpenAI Responses**, **Anthropic Messages**, and **OpenAI Chat Completions-compatible** endpoints, including compatible local endpoints.

Conversations retain their recorded model and provider. Changing the default affects the appropriate future selections while preserving the identity of earlier work. BLACKICE keeps its own conversation history so a continuing task can retain useful context.

**[Goal mode](docs/GOAL-MODE.md)** gives a conversation a persistent objective and automatically continues work in that same task. Use the Goal control or `/goal` commands to set, pause, resume, edit, or clear it. Continuation is unlimited by default, with an optional turn allowance. Completion records the model's evidence and recent tool receipts after its run succeeds.

**Why this helps:** you can choose a model appropriate to the task and keep its execution environment, files, and work history together.

See [API provider setup](docs/API-PROVIDERS.md).

### From ChatGPT, Gemini, or Claude

A configured direct MCP connection lets an external assistant call BLACKICE's file, command, browser, and planning tools. The assistant reasons in your existing conversation; BLACKICE executes the requested tool action and returns its result. A direct action does not require another model call inside BLACKICE.

**Why this helps:** you can continue working in a supported assistant you already use and give it practical access to your Windows workspace. Files, browser tasks, and command results can become part of that conversation without manually carrying every instruction between applications.

Setup: [ChatGPT](CHATGPT-CONNECTOR.md) · [Gemini](docs/GEMINI-CONNECTOR.md) · [Claude](docs/CLAUDE-CONNECTOR.md).

## A browser the user and agent can work in

The contained browser supports navigation, readable page and control snapshots, screenshots, clicks, typing, selection, keyboard actions, scrolling, uploads, downloads, and supported dialogs. The user can view and interact with the same pages inside BLACKICE.

Agents can inspect the current page before acting and inspect the result afterward. Task ownership and page identity help associate actions with the intended tab and document. Browser diagnostics provide additional information when an interaction fails.

**Why this helps:** multi-page tasks can stay with the agent while you retain visibility into the actual website. You can supply a missing login or intervene on a page, then continue the task with the surrounding work still available.

Website authentication, challenges, and unsupported controls can still require intervention. Completion of a web task is established by the destination's observed result.

## Files and commands that produce inspectable changes

BLACKICE can read and search local files, create text files, apply focused patches, and run commands in a chosen working folder. It captures command output and exit codes. Patch receipts record the before and after content and support guarded undo.

Direct actions have durable identifiers and saved results. If the connection drops, an assistant can retrieve the existing action's status before deciding what to do next. For supported consequential actions, recorded identities and uncertainty handling help prevent accidental repeats.

**Why this helps:** the assistant can move from an explanation to a real change, then check that change. When something goes wrong, you have a concrete file diff, command result, or action record to inspect and continue from.

The installed Windows account and available applications determine which files and commands the host can use.

## Planning you can configure for the task

Planning methods have explicit **On/Off** controls, and their choices belong to the current conversation. All nine methods default to **On**. You can change individual methods, save defaults for new conversations, or turn Planning off.

The methods address different sources of wasted work:

| Method | Question it helps the agent answer | Benefit to the user |
| --- | --- | --- |
| **Intent inference** | What outcome does the user actually want, and which constraints matter? | Reduces work aimed at the wrong interpretation of the request. |
| **Feasibility** | What information, tools, access, or prerequisites does this task really need? | Identifies concrete dependencies early and separates them from assumptions. |
| **Task decomposition** | Which parts can be acted on, and what depends on what? | Makes complex work easier to continue, delegate, and review. |
| **Conditional logic** | What should happen if an observation changes the next step? | Gives branching workflows a clear response to different results. |
| **Recursive reassessment** | What should change after new evidence arrives? | Lets the approach adapt while retaining useful progress. |
| **Metacognition** | Which assumptions or judgments deserve another check? | Helps catch consequential reasoning errors before they spread. |
| **Anti-overalignment calibration** | Is an apparent restriction actually binding, and how does it affect the user's objective? | Helps prevent invented requirements, unnecessary questions, and excessive deference from blocking useful work. |
| **Outcome verification** | What evidence establishes that the requested result happened? | Makes completion claims easier to trust and inspect. |
| **Subagent orchestration** | Would separate workers improve this task enough to justify their overhead? | Supports parallel work where it offers a practical payoff. |

**Why this helps:** you can shape the reasoning around the task. A straightforward file edit and an uncertain research problem can use different methods. These controls do not silently change the selected model or start a second reasoning model.

User advocacy is part of this design. BLACKICE's reasoning guidance asks the agent to distinguish hard constraints from preferences, use available context, and make supported routine decisions. A blocked step should be handled at the smallest practical scope so other actionable work can continue.

## Long tasks with fresh context and saved work

Longer tasks accumulate sources, intermediate findings, decisions, and unfinished steps. **Directory mode** gives that work a persistent structure. It has its own **On/Off** control, separate from the choice of Planning methods.

Directory runs focused stages with a **fresh model context for each stage**. It loads the stage's saved inputs and relevant material, supplies the user's authoritative instructions, and records the outputs and source references under the conversation. Later stages can reopen that work as they need it. Saved conversation history remains available.

**Why this helps:** each step can focus on the material it needs while earlier work stays available for reuse. A long task can span multiple model calls, and you can inspect what each stage received and produced. This supports continuity and reduces the need to reconstruct the task from memory. Each call still uses the selected model's actual context capacity.

Context audits expose the conversation's model turns, saved inputs, and recorded results. The current audit viewer is for inspection. Supported context tools can correct designated retained information, record the revision, and identify derived results that need rebuilding.

### Reusable knowledge and skills

The **Knowledge** workspace stores reusable memories and skills. Users can create and edit entries, scope them to folders, review revisions, and use Trash and restore controls. Saved analytical plans can also represent nested questions, dependencies, observations, and uncertainty.

**Why this helps:** preferences, project decisions, and repeatable procedures have a place to live beyond a single request. You can correct what agents retain and reuse stable instructions across appropriate work.

## Parallel work with a coordinator

Supported workflows can assign independent research questions, files, or work items to separate agents. Dependencies determine which work can proceed in parallel and which must wait. A coordinator collects the results and integrates them into the task.

BLACKICE's orchestration guidance considers the expected time saved, the value of independent analysis, model cost, and the effort required to combine the outputs.

**Why this helps:** separable work can progress together while you keep a single overall objective. The useful result is the combined deliverable and its quality; the benefit varies with how well the task can be divided.

## Recurring work with Cronjobs

The **Cronjobs** workspace lets you create, inspect, edit, pause, and resume schedules. Saved workflows can retain prompts, models, working folders, attachments, and worker settings. Schedules expose overlap handling, retries, run limits, previews, and result history.

Recurring single-agent cron or interval jobs configured to **queue or skip overlapping runs** can continue the same task and conversation when their prior run and saved configuration are compatible. This gives eligible ongoing work a way to retain progress between runs.

**Why this helps:** recurring research, checks, and other supported work can use a repeatable setup. You can review the history, adjust the instructions, and pause the schedule from one place.

The Windows host must be awake and BLACKICE must be running. Scheduled results are saved in BLACKICE; delivery to another service depends on a configured delivery path.

## How to judge whether a task worked

Look for evidence appropriate to the requested outcome:

- **A website submission:** the destination's confirmation or an accurately recorded unresolved state.
- **A software change:** the changed files, relevant checks, and observed behavior.
- **A research request:** supported findings and the requested usable answer or artifact.
- **A scheduled task:** the run's actual result and progress carried into subsequent work.

BLACKICE keeps action and task records to make these checks possible. Supported application workflows use submission history and action claims to help avoid duplicates. Failed, pending, and uncertain work should remain distinguishable from confirmed outcomes.

The aim is to reduce supervision while making results easier to verify. Reliability still depends on the selected model, the workflow, and the external system; this README does not promise a fixed completion rate or productivity improvement.

## Getting started

1. **Install BLACKICE** from the [Windows releases](https://github.com/MoonlightClarity/BLACKICE/releases).
2. **Choose where to work.** Start a chat inside BLACKICE and select a supported runtime or API model, or configure a direct connection from your external assistant.
3. **Give the task its context.** Choose the working folder and provide the relevant files, instructions, and constraints.
4. **Set the reasoning controls.** Choose the Planning methods you want On for this conversation, or turn Planning off.
5. **Describe the result you need.** For example: “Update these files, run the relevant checks, and show me the result.”
6. **Review the work.** Inspect the files, browser outcome, and action history. Save a workflow and add a schedule when the task should recur.

Model accounts, API keys, quotas, and service capabilities come from the selected provider. BLACKICE runs the workspace and tools on your host.

### Build from source

Requirements: supported **64-bit Windows** and **Node.js 22 or newer**.

```powershell
git clone https://github.com/MoonlightClarity/BLACKICE.git
cd BLACKICE
npm ci
npm run desktop
```

| Command | Purpose |
| --- | --- |
| `npm run desktop` | Start the Electron app. |
| `npm run headless` | Start the runtime without the normal main window. |
| `npm test` | Run the source test suite. |
| `npm run release:check` | Run release validation. |
| `npm run package:public` | Build an unsigned Windows installer candidate. |

### Data and remote access

**Settings → Storage & Data** shows disk usage and selective cleanup controls. User-selected cleanup is scheduled for the next application startup and can be cancelled before it runs. Custom external working folders remain outside app-managed cleanup.

A running Windows host can expose its authenticated tools over configured HTTPS connectivity, including supported Tailscale configurations. Remote access lets an external assistant use that host's workspace while it is running and reachable.

BLACKICE-authored code is licensed under [Apache-2.0](LICENSE). Third-party dependencies retain their own licenses.
