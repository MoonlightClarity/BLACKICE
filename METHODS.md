# Projects & methods

> Historical compatibility reference. BLACKICE 2.29 retires the Methods interface in favor of the shared **Planning** application. New agents plan directly in the human-editable saved work graph. Existing method records, licensed reference material and older tool catalogs remain readable; UI instructions below describe earlier releases. See [README.md](README.md) for current navigation.

BLACKICE includes **589 reusable methods** with **2,932 action definitions**. An ordinary task can use this catalog automatically: the agent finds relevant procedures, reads their complete instructions, and adapts or combines them into its visible task outline. You can describe the outcome and let the agent choose the approach.

Projects add saved execution plans, separate acceptance reviews and traceable results for work that benefits from that structure. You can prepare a project yourself or ask your agent to shape it, then start its execution when the scope is ready.

Open **Projects** in the top bar, **Projects & methods** in the workspace menu, or **Plan a project** on the Chat welcome screen.

## What each item means

| Item | What BLACKICE saves | When work starts |
| --- | --- | --- |
| **Method** | A reusable definition: task type, declared inputs, complete step instructions, expected results, acceptance checks, and optional discovery metadata or branching outline. | Saving or selecting a method starts no project work. |
| **Project** | A particular goal, working folder, copied plan, selected models, tracking details, and the actual implementation/review receipts. | **Start project**, **Resume project**, or an explicitly requested agent/API start admits execution. |
| **Capability** | A completed project's reusable plan and its historical passing review evidence. | **Use as starting plan** creates a fresh draft requiring its own execution and review. |

A project based on a method keeps that method's ID, revision, and copied steps. Editing the reusable method later does not rewrite existing project plans or their evidence.

## Prepare your first project

1. Choose **New project**. Enter the outcome under **What should this make possible?**, a **Project name**, and an existing **Working folder**.
2. Choose a **Starting method**, use **Browse methods** to search the whole catalog, or keep **Write my own steps**. For a method, review its procedure and provide the inputs marked **required**.
3. Choose **Use these method steps**. If the draft already contains work, the button reads **Replace steps with this method**. This fills the editable draft; it does not save or execute it.
4. Review each task title, **Expected result**, and **Instructions & acceptance checks**. Write observable checks, such as “The exported report opens and contains all three requested sections.” Add or remove steps as needed.
5. Open **Project details & milestones** for ownership, dates, notes, and checkpoints. Open **Models, context & repair budget** for the implementation model, review model, shared context, and zero to three repairs per task.
6. Choose **Create plan**. The saved project is a draft. Inspect its **Next action**, **Step by step** outline, and task details; choose **Start project** when ready.

In a simple sequence, moving a step updates its prerequisites so it follows the step above. A plan with custom prerequisites keeps those links when its display order changes. **Advanced order settings** can make the whole plan sequential again; **Advanced dependency graph** helps inspect an existing graph. Dependencies must form a graph without loops, and a dependent step waits for every prerequisite to pass review.

Replacing method steps preserves project tracking details. If the replacement would remove a step linked to a milestone, BLACKICE leaves the draft unchanged and asks you to remove those links first. The same protection applies when removing an individual linked step.

Unsaved project, method, type, and details editors keep local drafts. A cached editor draft becomes a shared saved record only after a successful save. If the draft cache is unavailable, the interface reports that the draft is kept in the current window only.

## Find an approach in the catalog

**Browse methods** in the task workspace and the **Methods** tab in Projects both show 20 summaries at a time. Search a name, acronym, intended task, input or output, then narrow the results by **Domain**, **Task stage**, or **Output**. **Previous** and **Next** retain the same search. Opening a result loads its full procedure, inputs, expected results, checks, prerequisites, limitations and source context.

For example, search **ACH** and choose **Intelligence** and **Matrix** to open Analysis of Competing Hypotheses. Search **parallel trends**, choose **Research**, **Causal**, and **Estimate** to find the Difference-in-Differences procedure. Search uses the locally saved names, aliases, metadata and step text; it does not require a network request or a model turn.

The catalog combines BLACKICE's eight original methods with 581 methods imported from the pinned Apache-2.0 Catalyst catalog. The imported material includes 2,906 original steps across 16 domains and 27 clusters: intelligence, forecasting, decision, systems, safety, quality, research, design, security, policy, economics, geospatial, legal, operations research, literary analysis, and religious studies. Original prompts, references and source identities remain available alongside BLACKICE's execution adaptation. See the [catalog attribution and reproducible source pin](lib/vendor/catalyst/NOTICE.md).

Search ranking identifies lexical matches. The agent still needs to check the chosen method's prerequisites against the actual task and evidence. A method can be adapted, combined with complementary phases from other methods, or replaced by a new approach when the catalog does not fit.

### The original BLACKICE methods

These eight general starting points remain available under their existing IDs. The project goal and working folder are needed when preparing a project; the optional method inputs supply additional context.

| Method | ID | Intended result | Required method input |
| --- | --- | --- | --- |
| **Research a question** | `research-brief` | Define the question, assess sources, write a sourced brief, and prepare a usable handoff. | None; starting material and reader constraints are optional. |
| **Compare options and recommend** | `compare-options` | Define decision criteria, compare evidence consistently, and explain a recommendation and its tradeoffs. | **Options** (`options`) |
| **Build a software change** | `software-feature` | Inspect the current code, implement a bounded change, check the integrated result, and explain it. | None; requirements and relevant code/files are optional. |
| **Find and fix a defect** | `debug-repair` | Establish the failure, identify its supported cause, and repair and recheck it. | **Observed problem** (`symptom`) |
| **Test an explanation** | `evidence-analysis` | Compare an explanation with alternatives, assess contradictory evidence, and state a bounded conclusion. | **Explanation to examine** (`claim`) |
| **Analyze a dataset** | `data-analysis` | Inspect data quality, preserve reproducible calculations, and report findings with their limits. | **Dataset location** (`dataset`) |
| **Write and refine a document** | `document-draft` | Plan for the reader, write a supported draft, then refine and hand it off. | **Reader and purpose** (`reader`) |
| **Plan a substantial goal** | `delivery-plan` | Define an outcome, decompose its work, and review the plan and next action. Executing this method produces a plan; it does not execute the downstream work described in that plan. | None; resources and constraints are optional. |

Use **Adapt a copy** to change a built-in method. The built-in remains available, and **Save a copy** creates your own reusable definition.

## Automatic methods in an ordinary task

New tasks use the current `relay_task` schema. For substantive work, the agent is instructed to search for a relevant method, inspect one or a few complete definitions, check the prerequisites, and preserve the useful method-specific operations and checks in the task outline. It can combine complementary phases from two or three methods and record the contributing method IDs and revisions in concise checkpoint decisions. One primary method reference appears on the plan. A small atomic request can use a single action without a catalog search.

With planning enabled, the outline and mind map are two views of the same saved task record. The composer offers Maximal, On, Auto, and Off. Maximal requires concrete action methods, expected results, and checks; Off removes automatic method-search and plan-before-answer instructions while leaving methods available on request. The outline remains the normal working surface. It shows manageable actions, sequence and parallel groups, conditional alternatives, dependencies, expected results and actual progress. Method selection does not force the user through a form or start a separate project workflow.

To guide a particular request yourself, open a method and choose **Use in my message**. This appends its exact ID and revision to the current message draft while preserving the existing text and attachments. It sends nothing until you send the message.

**Create reusable method** in the task plan prepares its current outline for saving. The agent can do the same through `draft_method` and `save_method`. If the task still references the exact source method revision and its action rows are unchanged, the draft preserves the original detailed instructions, inputs for each action and checks. Changed actions are not assigned stale source instructions. For a new or composed method, the agent can supply `methodSteps` containing a complete authored definition for every saved action in its outline order. Each definition must agree with the action's ID, title, type, expected result and completion criterion.

Only reusable authoring material is saved. Task inputs, execution statuses, evidence, artifact links and selected alternatives stay with the original task. Repeating the same task-method save request returns the original receipt, even if the task continued or either reusable method was subsequently edited. An altered definition is a different authoring request; a changed source with the same task revision is rejected.

## Create methods and extend the vocabulary

On the **Methods** tab, choose **Create method**. Give it a name, describe when it should be used, and select a **Task type**. Add any declared inputs and mark the ones required for every project.

Each ordered method step needs a title, instructions, an expected result, and at least one acceptance check. Its **Inputs for this step** describe the material it needs, such as a source file or a reviewed earlier result. Use **Move up**, **Move down**, **Add step**, and **Remove** to shape the sequence, then **Save method**. Your saved methods offer **Edit method** and **Save method changes**.

The **Task & step types** section is the shared ontology: the vocabulary used to describe work.

| Vocabulary | Built-in IDs |
| --- | --- |
| Task types describe the whole method. | `general`, `research`, `analysis`, `decision`, `software`, `writing`, `planning` |
| Step types describe an individual action. | `scope`, `collect`, `analyze`, `decide`, `create`, `check`, `handoff` |

Choose **Create task type** or **Create step type** to add a name and description. Custom types can be edited and then selected by other methods. Their IDs remain stable across renames. A custom type is descriptive metadata: adding one does not install a tool, grant permissions, change model access, or introduce an execution handler.

Edits use the saved record's revision. A conflicting save keeps the newer shared record intact and returns a conflict; inspect the current record before reconciling your draft. There are no method/type deletion controls or deletion API routes in this version.

## Ask your agent to plan in Chat

Use **Ask agent to plan** in the project editor or **Ask agent to shape this** in the method editor. Provide a concrete goal first. BLACKICE opens Chat with a planning request containing the current draft and relevant method/type information. If Chat already contains a draft, the planning request is appended while keeping the existing text, attachments, and model preferences. The button does not send the message.

Review the composed request and choose **Send**. The request asks the agent to inspect existing methods, use the shared `relay_project` tool, ask for concrete missing inputs, and save drafts only. It asks the agent to identify the saved method/project and the decisions still needed. Return to **Projects** to inspect the saved result.

Planning and execution are separate actions. A planning request prepares the method and project; an execution request can authorize the agent to start the saved work within that scope. Saving a definition alone is not an execution request.

## Read progress and recover blocked work

Each project task has an implementation turn followed by a separate review turn. The reviewer receives the saved acceptance criteria and is instructed to inspect actual evidence. A task counts as reviewed only when the returned review covers every saved criterion and passes all of them. A finished implementation response alone does not advance dependent steps.

The review model can be the same model as the implementation model; the review still runs as a separate turn. Selecting a catalog entry or a custom model ID does not establish account access. The configured endpoint decides whether the requested model can run, and failures remain visible in the task's receipts.

The project shows **Working**, **Blocked**, **Ready**, **Waiting**, and **Reviewed** counts, plus a concrete **Next action**. Selecting an outline step or the next-action button opens that task's instructions, checks, and saved attempts. **Open run** links to the actual implementation or review conversation.

When a valid review reports unmet checks, ordinary execution can attempt repairs within the saved budget. Runtime failures, malformed review output, exhausted repairs, or an external-action hold can block a task. Inspect its evidence before selecting a recovery action:

- **Prepare another attempt** prepares a new implementation cycle and pauses the project. **Resume project** admits it. Existing external-action receipts can prevent a repeat when an action may already have succeeded.
- **Review original result**, when available, prepares a separate review of a completed implementation. **Resume to review** starts that review. This recovery does not repeat implementation or delivery, and a failed review remains blocked.
- **Pause after current phase** prevents new project phases from starting. Already active work may finish. Use the run's own stop controls when you need to stop that active turn.

BLACKICE must stay open for execution. After reopening, projects that were running are paused for inspection and explicit resume. Once a task has an attempt, its execution plan and acceptance criteria are retained; use a fresh project for a changed plan. **Edit details** still permits tracking changes with the current revision. **Use latest saved details** deliberately replaces the open details draft with the current saved values.

Review evidence is agent-reported and linked to the actual runs. It supports inspection; it is not a universal correctness guarantee or independent human certification. A step named “Check the result” is itself ordinary method work and also receives the separate acceptance review.

## Milestones and tracking

**Edit details** manages priority, owner, due date, tags, notes, and milestones. Owner is a label, not a sent assignment. Priority and due dates support tracking and overdue displays; they do not create a schedule or promise a dispatch order.

| Checkpoint | How completion is determined | Effect on reviewed task progress |
| --- | --- | --- |
| Milestone with **Linked steps** | Every linked step must pass review. The display shows the reviewed count and active/blocked state. | It reflects the linked tasks' actual states. |
| Unlinked milestone | Set **Manual checkpoint is complete**. | It does not complete a task, satisfy a prerequisite, or add reviewed progress. |

Project percentage is derived from completed, reviewed tasks divided by all tasks. Manual checkpoints do not inflate it. To remove a step, first remove its milestone links. Dates use `YYYY-MM-DD` and do not themselves trigger work.

When every task has passing review evidence, **Save as capability** stores the plan and historical receipts under **Plans with working evidence** on the Methods tab. **View evidence** opens the source project. Reusing it creates a new draft; the earlier reviews remain historical, and the new work requires new checks.

## Method inputs and shared context

Method inputs are plain saved text. BLACKICE serializes declared input IDs, labels, and values into an applied context block; it does not evaluate them as JavaScript, shell commands, or an interpolated template. Required inputs must be supplied, and undeclared input keys are rejected.

In **Models, context & repair budget**, **Shared project context** holds your own text. **Applied method input context** shows the generated values. To update generated inputs, change the method's input fields and apply the method again. This also replaces the method steps, so review your task edits before applying it.

For integrations, `methodContext` records the exact generated final block within `context`. A nonempty value requires a method reference and must either equal the whole context or match its final block after two newlines. Preserve this field when round-tripping a preview into a project. It lets the editor replace its own earlier generated values while preserving authored context.

BLACKICE does not guess ownership from a heading that happens to resemble generated text. Imported or edited text without an exact recorded boundary stays authored text. An API client can explicitly clear `methodContext` to `""` on an editable, unattempted plan to treat all context as authored; a metadata-only update cannot change it. This boundary prevents accidental context replacement. It does not make supplied text trusted or confer tool authority.

## Local HTTP API

These routes are on BLACKICE's existing local server. Use its same-origin authenticated session and `Content-Type: application/json` for JSON requests. Opening the application supplies the local session cookie. Anonymous API requests are rejected; foreign origins and cross-site browser requests are rejected as well. These are not public unauthenticated endpoints.

### Methods and types

| Request | Result |
| --- | --- |
| `GET /api/methods` | `{status, ontology: {taskTypes, stepTypes}, methods}`. |
| `GET /api/methods?compact=true&query=...` | A bounded summary page with `status`, `ontology`, `totalMethods`, `total`, `offset`, `limit`, `nextOffset`, `catalogRevision`, and domain/phase/output/effort/evidence facets. |
| `GET /api/methods/:id` | A saved definition and its revision. |
| `POST /api/methods` | Create a custom definition; returns `201`. |
| `PUT /api/methods/:id` | Edit a custom definition with `expectedRevision`; returns the saved record. |
| `POST /api/methods/:id/preview` | Return an editable project definition without saving a project or starting a run. |
| `POST /api/methods/:id/use` | Save that method as a fresh draft project; returns `201`, with no execution. |
| `POST /api/method-types` | Create a task or step type from `{kind, name, description?, id?}`; `kind` is `"task"` or `"step"`; returns `201`. |
| `PUT /api/method-types/:id` | Edit `{expectedRevision, name?, description?}`. |
| `POST /api/tasks/:id/method-draft` | Preview a reusable outline at `expectedRevision`; accepts optional `name`, `description`, `catalog` and complete aligned `methodSteps`. |
| `POST /api/tasks/:id/method` | Save that task's reusable method with the same options; an identical retry recovers its durable original receipt. |

Compact search accepts `query`, `domain`, `phase`, `output`, `effort`, `evidence`, `limit` and `offset`. `limit` defaults to 20 and is capped at 40. Continue with the returned `nextOffset` and `catalogRevision`, keeping the same query and filters. A changed catalog returns `409` instead of combining pages from different versions. Full definitions are fetched by ID after discovery.

Optional method `catalog` metadata supports `domain`, `cluster`, `phases`, `outputs`, `aliases`, `tags`, `whenToUse`, `prerequisites`, `avoidWhen`, `effort`, `evidence`, `recommendedNext`, `useBefore`, `useAfter`, `alternatives`, and HTTP(S) `references`. These fields describe discovery and applicability. They do not record an execution result.

For example, a custom method creation body is:

```json
{
  "name": "Inspect a supplied report",
  "description": "Check a report against a concrete request.",
  "taskType": "analysis",
  "inputs": [
    {"id": "report", "label": "Report path", "required": true}
  ],
  "steps": [
    {
      "id": "inspect",
      "title": "Inspect the report",
      "type": "analyze",
      "instructions": "Inspect the supplied report and save a note of supported findings and missing evidence.",
      "inputs": ["Report path", "Project goal"],
      "result": "A saved inspection note.",
      "checks": [
        "The note identifies the actual report inspected.",
        "Findings identify their evidence and unresolved gaps."
      ]
    }
  ]
}
```

Create accepts only `name`, `description`, `taskType`, `inputs`, and `steps`; the server supplies the method ID, revision, origin, and verification state. An edit accepts those fields plus `expectedRevision`. To adapt a built-in, create a custom definition rather than sending an update to the built-in ID.

Preview/use accepts `objective`, `cwd`, and optional `name`, `model`, `verifierModel`, `maxRepairs`, declared `inputs`, and tracking fields (`priority`, `owner`, `dueDate`, `notes`, `tags`, `milestones`). Use an existing absolute folder for `cwd`. Input values are keyed by the method's input IDs:

```json
{
  "name": "Inspect the quarterly report",
  "objective": "Identify supported findings and evidence gaps in the report.",
  "cwd": "C:/work/report-review",
  "inputs": {"report": "quarterly-report.pdf"},
  "model": "default",
  "verifierModel": "default",
  "maxRepairs": 1
}
```

Replace the example folder with an existing folder on your machine. Preview returns a definition with `method`, `context`, `methodContext`, and sequential `tasks`; it has no saved project ID or execution status. Either edit that definition and send it to `POST /api/projects`, or call the method's `/use` route with the input options. Use copies the current method revision atomically with its steps. It does not accept a forged execution `status`.

### Projects, capabilities, and agent tools

| Request | Result |
| --- | --- |
| `GET /api/projects` / `GET /api/projects/:id` | Read project summaries or a complete saved project. |
| `POST /api/projects` | Save a draft definition containing `name`, `objective`, `cwd`, and `tasks`, plus optional model, context, method, and tracking fields. |
| `PUT /api/projects/:id` | Update with `expectedRevision`; attempted plans permit tracking-only changes. |
| `POST /api/projects/:id/start` | Start or resume remaining authorized work; send `{}`. |
| `POST /api/projects/:id/pause` | Pause admissions; optional `{reason}`. |
| `POST /api/projects/:id/retry-task` | Prepare a blocked task's new implementation cycle with `{taskId}`. |
| `POST /api/projects/:id/review-task` | Prepare review-only recovery with `{taskId}`; the project remains paused. |
| `GET /api/capabilities` | Read saved plans with historical evidence. |
| `POST /api/capabilities` | Save a completed reviewed project with `{projectId, name?, description?}`. |
| `POST /api/capabilities/:id/use` | Create a fresh draft; accepts optional `name`, `cwd`, and `objective`. |

The `relay_project` agent tool operates on these same stores. Its `describe` action provides the current schema. Authoring actions include `ontology`, `methods`, `get_method`, `create_type`, `update_type`, `create_method`, `update_method`, `preview_method`, and `use_method`; project, recovery, and capability actions expose the same saved plans and execution boundaries. For the large catalog, `methods` returns a complete ID/name/revision index and `get_method` loads a selected procedure. Tool calls must inspect their returned receipt before reporting that work was saved, started, or reviewed.

Current `relay_task` **v5** adds `methodQuery`, `methodDomain`, `methodPhase`, `methodOutput`, `methodEffort`, `methodEvidence`, `methodLimit`, `methodOffset`, `catalogRevision`, `methodCatalog` and `methodSteps`. Exact method details use the existing `methodId`, `methodRevision` and `methodStepOffset` fields. Saved native **v4** threads retain their original tool descriptor, instructions and planning requirement; their `describe` action includes a compact complete method index and their declared fields still work. Start a new task to acquire v5's search and authoring fields. Older thread schemas never silently acquire new input fields.

A stale revision returns HTTP `409`; malformed definitions are rejected, and unavailable storage returns an error. A failed save does not acknowledge a new definition or draft. After an interrupted request, read the saved state before retrying: creation routes are not idempotency-key APIs, so blindly repeating a create/use request can create another record if the first save completed.

## Limits and source references

The bundled 589 methods are separate from the editable library's capacity of 100 custom methods, 100 custom types, 50 steps per ordered method, and 20 declared inputs per method, within an 8 MiB methods file. Branching task methods can preserve up to 200 outline nodes and their aligned action definitions. Projects support 40 saved projects and up to 100 tasks each. A task has one to 20 unique acceptance checks and zero to three repairs per implementation cycle. Tracking supports 30 milestones and 12 tags per project.

Each bound method input is limited to 6,000 characters. Generated input context and the combined shared context must fit within 8,000 characters; refer to larger materials by path. Type, method-input, and step IDs use one to 100 letters, numbers, underscores, or hyphens. Definition edits and record creation have different field contracts; do not round-trip server-owned revision/status fields into a create request.

The outline-and-method workflow draws inspiration from [Catalyst](https://github.com/MoonlightClarity/Catalyst). BLACKICE retains its eight original definitions and now includes the licensed 581-method source snapshot from Catalyst commit `1c50eea56ea4c05de8055084583145882dc8d302`. The source, license, retrieval manifest and reproducible materialized definitions ship under `lib/vendor/catalyst`. BLACKICE's adapter preserves the original prompts while adding its existing task/step types, expected results, checks, discovery metadata and source attribution.

Implementation references: [built-in definitions and validation](lib/process-ontology.mjs), [Catalyst adapter](lib/catalyst-methods.mjs), [bounded catalog search](lib/method-catalog.mjs), [method storage and preview/use](lib/methods.mjs), [task tool versions and authoring](lib/task-state.mjs), [project execution and review](lib/projects.mjs), [tracking and context boundaries](lib/project-management.mjs), [Projects controller](public/projects-ui.mjs), [method/type interface](public/process-ui.mjs), and [HTTP routes](server.mjs).
