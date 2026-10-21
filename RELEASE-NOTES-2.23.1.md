# BLACKICE 2.23.1 — More room for the outline

The default branching task workspace introduced in 2.23 now gives compact windows more room for the actual steps. Long task descriptions and pinned evidence can be opened when needed while the working outline remains easy to browse.

## Compact plan browsing

At 600 px and below, a selected-step tray shows the step's number, state and title. It starts collapsed. Choosing a row updates the tray; **Details** opens the checks, evidence, results and files in the plan's reading area. **Back to outline** or Escape inside the inspector returns to the selected row and restores the tree's reading position. Enter on an action row also opens its details. These controls inspect saved work without changing a task or sending a message.

Wider screens keep the adjacent inspector open by default and offer **Hide details**. Resizing preserves access to the surface holding keyboard focus. Inspection choices, disclosure state and reading positions remain scoped to each task and survive streaming updates and task switches.

Compact branch rows keep their step numbers inline and use a one-line condition preview. **Details** retains the complete condition and evidence. A newly selected step opens at the beginning of its details; reopening the same step preserves its reading position.

## Complete task descriptions without crowding

Long goals use a compact heading and a **Full task** disclosure. The complete original task remains available in a keyboard-scrollable region, including text beyond the title preview. Opening or closing the description preserves the saved plan and any unsent message.

Live progress respects a disclosure that was just opened or closed, including updates arriving before the browser delivers its native toggle event.

The outline keeps its connected branches, clear progress, real completion evidence and explicit unused paths. Automatic agent planning, planning-detail preferences, reusable methods, Projects, model selection, attachments and the configurable ChatGPT bridge remain part of the release's regression scope.

## Release metadata and evidence

Package, lockfile and native client version metadata now agree on 2.23.1. [UI-VALIDATION.md](UI-VALIDATION.md) describes the required checks for this exact candidate. The delivered validation report records actual test, browser, native-model and installation results. Existing native conversations retain the tool schema they were created with; a new chat is needed to use the branching task tools in a thread predating 2.23.
