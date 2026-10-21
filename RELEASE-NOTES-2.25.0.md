# BLACKICE 2.25.0 — Visual planning

## Planning is a visible, adjustable part of agent work

The composer has one Planning control: **Maximal**, **On**, **Auto**, and **Off**. Its choice follows the task through saved drafts, new turns, continuation, and retry. Saved workflows can retain the policy for later dispatch. Auto is the default and scales the outline to the work. On explicitly requires a current-turn plan. Off disables the automatic planning instructions and answer gate while preserving previous task notes and results.

Maximal asks for expanded, method-based work: manageable actions, useful branches, expected outcomes, and checks. An unfinished action must record its concrete method or check procedure, expected result, and completion criterion before its plan is accepted. A truly atomic task can remain one detailed action. Completion still needs observed evidence. The mode selects the highest reasoning effort actually advertised by the chosen model when no explicit effort was supplied; unknown capability metadata keeps the existing/default behavior. It does not fabricate provider support or promise that more text produces better reasoning.

Planning uses the existing revision-checked task tool and durable notes. The agent saves its outline before ordinary tool actions and before a final answer is released. A small bounded inspection allowance lets the agent read real inputs first. The model sees the actual available tools, saved state, and method catalog. Plans describe actions, checks, decisions, and evidence, not private internal reasoning.

## Outline and mind map share one task record

The task pane offers **Outline** and **Mind map** views of the same hierarchy. Goal, sequence, parallel, and choice branches retain their saved step identities. Selecting a map node opens the same notes, expected result, completion check, and evidence as selecting an outline row. Branch focus, breadcrumb navigation, zoom, and fit controls keep larger plans readable. A guidance action drafts a request for the agent to revise the selected step.

The map exports as editable SVG and conservative Freeplane-compatible `.mm` XML. Export does not start an external application, create a second live plan, or introduce a Java runtime dependency. Freeplane import compatibility is limited to the exported common map format unless a separate Freeplane import check is recorded in the release evidence.

## Editable ice and application identity

The active black-ice scene is authored SVG geometry with editable sheets, edge light, and fissures. The wordmark, app mark, and controls follow the same vector visual language. UI surfaces use gradients and transparency; the old raster image is no longer the active scene. Text contrast, keyboard focus, responsive layouts, and reduced-motion behavior remain part of acceptance.

Native model initialization identifies BLACKICE and reads its version from the packaged application. Coordinator and worker instructions explicitly describe BLACKICE as their agent harness. Responses, Messages, and compatible Chat Completions receive the same application identity through their respective instruction fields. OpenRouter attribution uses the real BLACKICE title and personal-agent category, while preserving explicit custom headers. Provider registration or restricted-model eligibility remains the provider's decision.

## Verification and local update

The local updater starts from the verified 497-file 2.24.1 baseline and checks the 447 inspected additional source files without modifying them. Its acceptance requires full Windows regression, real headless web-interface checks, hidden contained-browser checks, the installed email CLI against disposable Maildir data, and a real native task-plan turn. New acceptance covers planning modes, map behavior, and SVG surfaces, with no claim that a fixture measures general model reasoning quality.

The exact results, source hashes, cleanup records, and limitations are saved in the release receipts described in UI-VALIDATION.md. The update preserves profiles and connections, verifies rollback copies, and checks the installed application after writing. It is a local installed-runtime update; public installer packaging is a separate artifact.
