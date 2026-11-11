> **Next-version README:** This document describes the next version of BLACKICE.

# BLACKICE

**BLACKICE is an open-source, local-first agent workspace for Windows. Its job is to turn a user's objective into verified work—not simply produce plans, chats, or successful-looking tool calls.**

BLACKICE connects reasoning models and agents, including Codex, to the user's computer, contained browser, files, external tools, scheduled work, and persistent task history. The user can start a task in BLACKICE or Codex, let agents do the routine work, inspect what actually happened, intervene when useful, and continue without throwing away earlier progress.

**The measure of success is the user's achieved outcome.** A model response, completed planning graph, number of browser clicks, number of jobs launched, or passing source test suite is not a substitute for that outcome.

**[Windows releases](https://github.com/MoonlightClarity/BLACKICE/releases)** · **[Source code](https://github.com/MoonlightClarity/BLACKICE)** · **License: Apache-2.0**

## What BLACKICE actually does

A person gives BLACKICE a meaningful goal. BLACKICE coordinates the selected model, available tools, and reusable task state to pursue that goal with as little unnecessary user effort as possible.

| Real task | What BLACKICE does | What counts as success |
| --- | --- | --- |
| **Apply for jobs** | Finds positions, evaluates genuine constraints without inventing disqualifiers, prepares forms, uploads materials, submits distinct applications, and continues viable opportunities when one application is blocked. | **Distinct, destination-confirmed applications**, plus accurate records of pending or uncertain submissions—not pages visited or buttons clicked. |
| **Build and repair software** | Inspects source, diagnoses failures, edits files, runs tests, delegates independent work when valuable, and prepares releases through available tools. | **Changed and validated behavior** with real test/build results and, where requested, evidence of the produced or published artifact—not a proposed patch. |
| **Perform research** | Collects relevant sources, compares claims and competing explanations, records uncertainty, and produces a decision-ready answer or artifact. | **Supported findings and a usable deliverable**, with the missing evidence distinguished from established facts. |
| **Operate websites** | Uses the contained browser to navigate, inspect, fill forms, upload files, and follow through after submission. | **An observed result at the destination**, not a successful input event alone. |
| **Run ongoing work** | Reuses task state, executes eligible scheduled or event-triggered steps, handles dependencies and interruptions, and retains outcomes for review. | **Verified incremental progress across runs** without repeating uncertain external effects or creating unrelated replacement tasks. |
| **Coordinate agents** | Assigns truly separable work to supported models or subagents, monitors receipts, and integrates results. | **Better verified output, elapsed time, or resource efficiency** than doing the same work without delegation. |

The system is built to **act, measure, learn from what actually happened, and continue**, while preserving the user's control over their goals and material decisions.

## Product metrics and acceptance criteria

BLACKICE measures the work that matters at the task level. Metrics are computed from actual timestamps, model and tool usage, canonical task IDs, operation receipts, and destination evidence. A metric without an observed denominator or baseline is reported as unknown—not filled with an invented number.

| Metric | Measurement | Success criterion |
| --- | --- | --- |
| **Verified completion rate** | Distinct requested outcomes with adequate confirmation ÷ distinct eligible outcomes pursued. | Every *confirmed* outcome has supporting evidence; attempted, partial, blocked, and unknown work is not counted as confirmed. |
| **Outcome throughput** | Destination-confirmed outcomes per elapsed hour or per scheduled run, with task type and difficulty retained. | Measure productive work, not the volume of tool calls, chat turns, scheduled triggers, or self-reported completions. |
| **Time to useful action** | Elapsed time from task admission to the first relevant real action or substantive answer. | Avoid mandatory planning-only passes and needless preflight rituals; minimize latency without sacrificing correctness. |
| **Time to verified result** | End-to-end elapsed time from request to first and final confirmed outcomes; report p50/p95 across comparable tasks. | Reduce real task latency, including rework and waiting, rather than optimizing isolated tool latency. |
| **User intervention cost** | User questions, approvals, corrections, and manual steps per verified outcome. | Resolve ordinary decisions autonomously; ask only when a genuinely material missing fact or choice requires the person. |
| **Reasoning and tool efficiency** | Provider turns, input/output tokens, tool calls, retries, and monetary or quota cost per verified outcome. | Spend resources where they improve the result; a more elaborate plan is not automatically better. |
| **Duplicate-effect prevention** | Duplicate consequential dispatches or confirmed repeated effects for the same action identity. | **Zero unjustified replays** of a confirmed or unresolved consequential action; isolate the affected action while unrelated work proceeds. |
| **Recovery fidelity** | Tasks resumed with the correct conversation, model, plan/context, receipts, and outstanding work after interruption. | No fabricated completion, lost task identity, or automatic replay of an uncertain external effect. |
| **Evidence quality** | Unsupported completion claims, mismatched citations, stale observations, and assertions contradicted by receipts. | **Zero knowingly unsupported confirmed-outcome claims**; unknown remains unknown until resolved. |
| **Delegation value** | Actual critical-path time saved and independent quality gained versus worker setup, coordination, and integration cost. | Delegate only when the forecasted opportunity justifies overhead; check the forecast against measured results. |
| **Local inference performance** | Prefill and decode tokens/minute, time to first token, end-to-end latency, memory/VRAM peak, and output/parity accuracy for a stated model and precision. | Compare configurations on the same input and hardware; report accuracy alongside speed rather than treating throughput alone as success. |

**These are product acceptance measures, not fabricated benchmark results.** BLACKICE records real values and distinguishes a user-defined numerical target from a measured result. No fixed tokens-per-minute, completion-per-hour, or speedup guarantee is implied by this README.

### Measurement rules

- Report **attempts, executions, confirmed outcomes, pending work, and unknown effects separately**. A completed agent run is not necessarily a completed user task.
- Use **distinct target identities** (for example, an employer requisition ID) so reopens, page changes, retries, and repeated receipts do not inflate outcome counts.
- Preserve the **real denominator and time window**. Report task difficulty, provider/model, applicable accuracy criteria, and observation coverage alongside comparisons.
- For speed claims, measure **end-to-end wall time and resource use**, not just synthetic prompts or isolated kernel calls.
- For quality claims, check **the destination state, accepted artifact, benchmark reference, or human-defined acceptance condition**. A model agreeing with another model is not independent verification.
- When a workflow remains feasible, a blocked leaf reduces the current completion count; it does **not** imply the user's whole goal has failed.

## Architecture at a glance

| Layer | What it supplies |
| --- | --- |
| **Chat and model runtimes** | Persistent conversations, native Codex integration, API and local models, model-specific settings, and actual tool results. |
| **Modular Planning** | Nine independent reasoning methods, each controlled per conversation rather than one compulsory orchestration loop. |
| **Execution** | Contained browser, files and exact patches, shell, application diagnostics, and connected MCP tools. |
| **Tasks and subagents** | Durable work identity, dependency-aware assignment, bounded parallelism, continuation, and scheduled work. |
| **Operational protections** | Independent effect reservations, application-history deduplication, hashes, receipts, and unresolved-effect handling. |
| **Knowledge** | Typed memories, skills, sources, relationships, and relevant task context. |
| **Settings → Storage & Data** | Storage usage, selective cleanup, and retention controls without a separate legacy Storage workspace. |

The layers cooperate, but **Planning does not own execution authority or operational effect protection**. Turning a reasoning method off does not disable ordinary tools, action receipts, or duplicate-effect checks.

## Modular Planning: choose the reasoning, not a rigid process

BLACKICE Chat provides **Planning → Modules** and **Planning → Off**. With Modules selected, the compact **Modules** disclosure opens a three-column configuration grid. Each method has four independent states:

| State | Meaning |
| --- | --- |
| **Mandatory (M)** | Apply the method when its subject actually occurs; do not invent work solely to demonstrate it. |
| **Optional (O)** | The method is available but not required. |
| **Forbidden (F)** | Do not invoke that method, including indirectly through another method. |
| **Auto (A)** | The selected model chooses the task-local value of the method based on its usefulness, cost, and context. |

There is **no legacy compulsory planning contract, fixed five-stage model cycle, mandatory extra provider round trip, or graph-admission ritual**. Reasoning methods operate inline with useful work. The model can still explicitly construct, inspect, and revise saved plans or recursive analytical requests where they help, but an ordinary tool call is not blocked merely because the model did not author a formal plan first.

### The nine modules

| Module | What it does | Default |
| --- | --- | --- |
| **Intent inference** | Interprets the real desired outcome, known facts, hard constraints, preferences, and relevant missing context. | Auto |
| **Feasibility** | Checks concrete capabilities and dependencies in proportion to the decision, instead of turning hypothetical obstacles into blockers. | Auto |
| **Task decomposition** | Breaks genuinely complex work into useful, actionable components and identifies dependencies. | Auto |
| **Conditional logic** | Applies nested IF / ELIF / ELSE and AND / OR / NOT when different observations require different actions. | Auto |
| **Recursive reassessment** | Revisits earlier assumptions or actions after meaningful new evidence; preserves existing task identity and progress. | Auto |
| **Metacognition** | Tests consequential assumptions against alternatives and recognizes where the model's judgment may be wrong. | Auto |
| **Anti-overalignment calibration** | Rejects invented hard gates, unsupported certainty thresholds, overstrict interpretations, and unnecessary deference to third-party preferences. | **Mandatory** |
| **Outcome verification** | Checks results and effect claims against actual evidence instead of model assertion. | Auto |
| **Subagent orchestration** | Evaluates and delegates separable work when supported and worthwhile. | Auto |

Anti-overalignment is mandatory **by default**, not unchangeable: the user can explicitly choose any of the four states for it, as for every other module.

### How module choices persist

Choices belong to the current conversation. A pending conversation-specific selection wins over that conversation's saved run; the saved run wins over application defaults. **Save default** updates the fallback for newly created conversations without silently rewriting another chat's settings. Expanding or collapsing the grid does not change its values.

The module grid is a reasoning preference system, not a global switch that secretly raises model effort, starts a second model, or forces a rigid response template.

### Satisficing and user advocacy

BLACKICE aims for **good-enough verified progress under real constraints**, rather than refusing useful work because one detail falls short of a hypothetical ideal.

For example, a job description's wish list is not automatically a user-imposed hard gate; an omitted résumé statement is not proof the skill is absent; and one unresolved sponsorship declaration does not stop unrelated applications. BLACKICE checks available context, distinguishes known/inferable/unknown facts, makes supported decisions, and defers only the smallest dependent action if a consequential personal declaration cannot be answered truthfully.

**A binding obstacle has the smallest justified scope.** A blocked field parks that field or form; a potentially duplicated submission parks that exact submission; an unavailable provider or page triggers evaluation of alternatives. Other independently actionable work continues.

User advocacy means evaluating authority, costs, alternatives, uncertainty, and the user's objective—not reflexive obedience to an outside party's text and not reflexive disobedience either. The agent does not create new approval checkpoints for routine steps.

## Task planning and analytical graphs

The modular ontology is the normal Chat reasoning policy. When structured work is useful, BLACKICE also exposes saved task and analytical graph resources that users and authorized agents can inspect and edit.

- Nested tasks and dependencies preserve the structure of actual work rather than flattening everything into numbered top-level checklist items.
- Analytical modules can record hypotheses, observations, source coverage, contradictory evidence, accuracy criteria, confidence, and narrower child questions.
- A recursive analysis child has a bounded, source-grounded question; it does not silently become the operational owner of the user's entire task.
- Observed results can trigger reassessment and a revision; earlier evidence is not erased merely because the approach changes.
- Historical planner records remain readable for provenance without reactivating their retired admission behavior.

A saved graph and a completed analytical response are **not** proof that an employer received an application, a website accepted a form, or software passed a test.

## Agent orchestration and expected payoff

BLACKICE delegates when **the work is separable and delegation is worth its cost**, not merely because subagents exist.

The coordinator considers a bounded **WEP opportunity forecast** for:

1. **Saved critical-path time** from parallel execution.
2. **Independent quality gain** from genuinely distinct work.
3. **Worker setup and model cost**.
4. **Integration and rework cost** after workers finish.

Forecasts include qualitative likelihood and confidence, with explicit reasoning and resource limits; they are **estimates, not achieved speedups**. BLACKICE compares the forecast with actual wall time, worker usage, output quality, integration effort, and verified deliverables.

Independent workers can share the task goal while owning disjoint files, analyses, pages, or work items. Dependent tasks run in prerequisite order; parallel work respects host capacity. A worker's assertion of completion is checked against actual artifacts and receipts.

**Successful delegation improves the end-to-end outcome or efficiency**. Spawning many workers, consuming more tokens, or generating more messages is not itself success.

## Codex, external assistants, and model continuity

**Codex ↔ BLACKICE is bidirectional.** Conversations can run in BLACKICE or Codex, and Codex can use BLACKICE's tools, planning resources, task context, and execution environment when useful. BLACKICE can use Codex as a native model/development runtime; Codex can also be used without BLACKICE.

- Native chats preserve the **actual selected model and provider for that conversation**. A default-model change does not relabel or silently migrate earlier chats.
- Supported account-backed runtimes and compatible Responses, Anthropic Messages, and Chat Completions endpoints supply inference according to their own quotas and capabilities.
- ChatGPT and Gemini can call BLACKICE directly through separately authorized MCP connections. They do not automatically inherit each other's accounts or grants.
- BLACKICE agents can use configured local or remote MCP tool servers and can interact with another accessible assistant in a normal contained-browser session.
- Direct file, command, browser, and Planning tools execute without requiring a second model call from BLACKICE.

BLACKICE does not bundle an unlimited cloud model, manufacture provider quotas, or guarantee that every external assistant exposes the same tool capabilities.

## Local models and inference metrics

BLACKICE includes native-model execution and an explicit model/backend interface alongside compatible external local providers.

The **BLACKICE-owned reference engine** implements Qwen3-family model loading and inference independently of llama.cpp, Ollama, or LM Studio. The separate **llama.cpp backend** is an explicit alternative; optional third-party local providers are not prerequisites for the reference engine. Local model choice and precision are explicit rather than silently substituted.

The runtime covers FP16 model handling, tokenizer and transformer execution, KV-cache continuation, CPU/SIMD paths, GPU execution where supported, and batched prompt prefill. Work on a given model is evaluated under the same checkpoint, prompts, context, and machine configuration.

### Model performance scorecard

| Measurement | Meaning |
| --- | --- |
| **Prefill throughput (tokens/minute)** | Input tokens processed per minute, including real prompt processing. |
| **Decode throughput (tokens/minute)** | Generated continuation tokens per minute at the stated batch/context size. |
| **Time to first token** | Real prompt-to-first-output latency, including relevant setup. |
| **End-to-end latency** | Complete load/prefill/generation/continuation time for a fixed workload. |
| **Memory and VRAM** | Peak RAM, GPU memory, model residency, and KV-cache use for the workload. |
| **Accuracy and parity** | Token-level agreement, logit/cache numerical differences, and task-quality checks against a fixed reference. |
| **Precision comparison** | Side-by-side FP16 and supported quantized variants under identical workload conditions, reporting memory and accuracy alongside speed. |
| **Session correctness** | Continued generation preserves the right prompt history and cache, does not replay the entire prior conversation without cause, and isolates concurrent sessions. |

A fast decoder that corrupts outputs, repeats context incorrectly, or silently changes precision is **not** a better model. **Model inference tokens/minute and model-training tokens/second are different measurements**; BLACKICE does not conflate them.

## The contained browser

BLACKICE's browser belongs to the actual workspace. Users and authorized agents can inspect the same relevant pages, with task ownership and current-page identities.

It supports navigation, readable page/control snapshots, screenshots, clicking, filling, keyboard actions, scrolling, downloads, uploads, and session management. Browser diagnostics help investigate failed actions. Task-associated tabs are reused appropriately, and completed task tabs are closed instead of accumulating indefinitely.

Actions use the current observed page; stale coordinates, document identities, and form states are not treated as authoritative. Visual browser tasks work best with vision-capable models. Website restrictions, logins, CAPTCHA challenges, and unsupported controls remain genuine external limitations.

**Browser success is destination success.** The system inspects the result after an external action; one click or open tab is not an application receipt.

## Independent operational protections

The execution layer protects consequential operations **whether Planning is set to Modules or Off**. These checks do not create another mandatory model cycle.

- Recognized job applications are checked against submission history and task-independent claim records before final dispatch. A reservation for the same requisition prevents an unverified repeat; a distinct requisition remains actionable.
- Consequential browser inputs receive durable operation identities and uncertainty-aware receipts where supported.
- File writes and patches are checked against expected bytes and hashes; an uncertain file effect blocks only that file until reconciled.
- Confirmed, absent, and unknown effects are recorded separately. A callback that returned normally is not sufficient evidence of third-party acceptance.
- Unknown effects are investigated before a potentially duplicated dispatch. Other independent tasks continue.

These checks apply to the supported operational adapters; they are not a claim that an arbitrary opaque shell command can be semantically classified as every possible external effect.

## Cronjobs, saved work, and continuation

**Cronjobs** is a dedicated workspace for scheduled automation rather than a general-purpose old Tasks dashboard. It provides schedule creation, editing, pausing, resuming, run previews, local results, and job history.

Supported triggers include daily, weekday, weekly, interval, cron, manual, and configured webhook schedules. Saved work can pin models, Planning module selections, working folders, relevant attachments, and worker configurations. Overlap, retry, catch-up, run-limit, and delivery preferences remain explicit.

The scheduler measures **verified progress across run boundaries** rather than counting fresh conversations. A repeat trigger can continue the existing relevant work context; it checks actual previous outcomes and reservations before attempting consequential work again.

A schedule requires the host runtime to be awake and operating. A queued or interrupted run is not reported as successful, and results are not silently delivered to a different assistant conversation.

## Files, workspace, and source changes

BLACKICE reads local files, searches folders, creates and patches text, runs bounded shell commands, and records outputs with durable IDs. Development tools can inspect the app's own frontend and runtime for diagnosis. Actual file changes are verified and can be audited through their receipts.

Local tools act with the authority of their Windows host account; a chosen working folder is not a virtual-machine or OS security boundary. A patch return confirms an operation, not that the entire bug or requested release is fixed.

## Knowledge and Storage & Data

Knowledge keeps typed memories, reusable skills, sources, references, relationships, and revision histories available to eligible agents. These resources can inform a task but do not turn an unverified saved assertion into a fact.

**Settings → Storage & Data** replaces the separate legacy Storage surface. It shows measured on-disk usage by category, including conversations, context, workspace metadata, managed workspace files, action history, media, browser state, and temporary files.

Selective deletion is explicit and staged for the **next application startup**, before saved state is loaded. It requires a deliberate category selection and confirmation; nothing is deleted just by inspecting the page. A queued deletion can be cancelled before it runs. Interrupted cleanup is not blindly replayed. Optional automatic cleanup applies to **rebuildable temporary/diagnostic data**, not conversations, source folders, action receipts, credentials, or media by default.

Removing the old Storage UI does not mean discarding user data. Historic records and files are managed through their actual owner features and Settings. Custom external working folders are outside app-managed destructive cleanup.

## Remote access

The running Windows host can expose authenticated tools and a paired human workspace over configured HTTPS connectivity, including supported Tailscale Serve or Funnel modes. Each external assistant or client uses its own applicable grant. A remote connection does not become a second independent BLACKICE host, and an offline machine does not execute local tasks merely because a caller requests one.

## Getting started

1. Install BLACKICE from the [Windows releases](https://github.com/MoonlightClarity/BLACKICE/releases). Public installers are unsigned; compare a release's published checksum where available.
2. Open a BLACKICE chat or use Codex with the BLACKICE integration. Choose an available model and working context.
3. Under **Planning → Modules**, configure any methods you want to make Mandatory, Optional, Forbidden, or Auto; or choose **Off**.
4. Give the agent a meaningful outcome—not a script for every click. The agent evaluates real constraints, uses available tools, and records actual results.
5. Review confirmed outcomes and unresolved work. For continuing tasks, attach or resume the saved work and use Cronjobs where scheduling helps.

## Build from source

Requirements: supported 64-bit Windows and **Node.js 22 or newer**.

~~~powershell
git clone https://github.com/MoonlightClarity/BLACKICE.git
cd BLACKICE
npm ci
npm run desktop
~~~

| Command | Purpose |
| --- | --- |
| `npm test` | Run source tests (not proof of live external outcomes). |
| `npm run desktop` | Start the Electron app. |
| `npm run headless` | Start the runtime without the normal main window. |
| `npm run release:check` | Run release validation. |
| `npm run package:public` | Build an unsigned Windows installer candidate. |

## Scope and principles

BLACKICE is **an agent workspace, not a checklist generator**. Its priorities are useful outcomes, sound judgment, genuine user autonomy, measurable performance, appropriate tool use, persistence, and recovery. The Hyper-V Workbench product and the old compulsory planning system are not part of the integrated application. The browser, local execution, modules, workflows, and Settings cover their respective roles.

**Do not confuse feature availability, a passing test, or a model's confidence with verified real-world accomplishment.** BLACKICE's answer to “Did it work?” is grounded in the actual outcome and evidence.

**License:** BLACKICE-authored code is licensed under the [Apache License 2.0](LICENSE). Third-party dependencies retain their own licenses.
