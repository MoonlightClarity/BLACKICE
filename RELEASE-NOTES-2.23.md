# BLACKICE 2.23.0 — The task outline becomes the workspace

## Automatic planning for ordinary tasks

Send one outcome and the agent builds its working outline in BLACKICE. New tasks with current planning tools start with the real goal and **Preparing the plan**. The agent then saves concrete actions, completion checks, and useful branches. A simple request can use one action; substantial work can grow into nested sequences, independent parallel groups, and explicit choice paths. A Project or prompt template is no longer needed to make planning visible.

The runtime instructs the agent to read the saved task and write its approach for each turn. Before that write, the BLACKICE gateway permits planning reads and up to four known inspection/discovery calls. Other gateway operations return `TASK_PLAN_REQUIRED` without running. This makes room for grounded planning and then continued execution within the already authorized task. It is a sequencing rule, not a host-permission override. A final response without a saved plan is retained with **Plan not recorded**; completion is never inferred from the end of a response.

## A persistent, inspectable outline

Task plan sits beside Conversation on wide screens. Narrow windows have accessible **Plan / Conversation** tabs, with Plan selected for each new structured task. The outline uses connected branches, restrained ice textures, clear step states, and a detail pane for the selected action.

- Inspect completion checks, results, evidence, dependencies, blockers, skipped-path reasons, and registered files.
- Expand branches or use the keyboard without changing the agent's plan or starting work.
- Keep the inspected step, collapsed branches, focus, text selection, and reading position through streaming updates and task switches.
- Leave hidden Conversation responses unread until they are shown.
- Use **Guide this step** to append context to an editable draft, **Draft next action** to prepare unfinished work, or **Make repeatable** to open scheduling for a completed plan.

Action leaves determine progress; structural groups do not inflate it. Choice paths are explicitly selected, and unused alternatives require recorded skip reasons. Skipped actions are counted separately. A finished chosen route is still incomplete while alternatives remain unresolved. Evidence is agent-reported; registered-file checks establish file identity, not correctness. Parallel labels describe independent work and do not themselves launch agents.

The welcome surface now centers on the desired outcome, a black-ice formation, a short explanation of the working process, compact draft shortcuts, and direct access to methods. Existing drafts, model selections, and attachment behavior are preserved.

## Useful detail without tying it to answer length

**Reasoning → Plan detail** offers **Compact**, **Balanced** (default), and **Detailed**. This controls the granularity of the operational outline independently of reasoning effort and the response-length preference. The choice persists with a chat draft and is carried into new tasks, Inbox capture, and continuations. Changing it affects the next submission and creates a new request identity when an earlier uncertain send had different settings.

## Shared methods and vocabulary

The default task tool exposes the existing built-in/custom task and step vocabulary and reusable methods. Agents can read a relevant definition and adapt it to the actual request, or write a new approach. These definitions describe work; they do not grant tools or permissions.

**Browse methods** and the outline's method badge open readable definitions. **Use in my message** adds a method reference to the current draft for review before Send. **Create reusable method** prepares the current outline; review its branches and checks, name it, and **Save method**. Saved methods retain structure, conditions, dependencies, and completion criteria while leaving prior statuses, evidence, file links, and selected alternatives with the source task. Reuse begins unverified. Agents can prepare and save the same definitions through `relay_task draft_method` and `save_method`.

The existing Projects workflow remains available for explicit implementation/reviewer runs, acceptance review, bounded repairs, and reusable capabilities. The new task outline describes work performed through existing tools; it is not a separate execution engine.

## Compatibility and verification scope

New native Codex tasks and tool-capable API-provider turns receive `relay_task` schema version 4. A model explicitly reporting no tool support keeps its Conversation response and shows the planning limitation. Persistent native Codex threads keep the schemas they were created with; start a new chat to use branching task plans and method actions in a thread predating this version. Existing history is preserved rather than silently copied into a replacement native thread. API turns and temporary native sessions use the current attached tools when created.

The configurable ChatGPT Chat Mode bridge, existing approval-scope behavior, timeout recovery, model discovery and exact-ID checks, unrestricted attachment types, Projects, and contained browser/Windows functionality remain documented in [README.md](README.md). This release does not claim to fix Avalon host permission prompts, establish access to every endpoint model, or validate all large Windows applications. See [UI-VALIDATION.md](UI-VALIDATION.md) for the recorded checks and remaining limits of the actual release candidate.
