# Editable visual reasoning — first release

Figures stay in the chat transcript. There is no dedicated tab, empty gallery or permission toggle. A quiet Inspect figure control opens the existing editor with revision history, SVG/source/text export and zoom. The capability is available by default; the agent should use it selectively. Existing saved SVGs and their versioned renderers are unchanged.

Presentation references inspected for this refinement were Heuer and Pherson's concept/argument maps and comparison figures, and the US Government's March 2009 *A Tradecraft Primer*, especially the assumptions comparison (printed page 8), evidence matrix (15), alternative futures figure (35), and timeline (38). The implementation borrows readable hierarchy, light fields and restrained color, not source illustrations or a mandatory technique taxonomy. The visual tool's `describe` action supplies a problem-specific design guide, including custom SVG, uncertainty, bounds, legibility and negative examples. Three authored examples illustrate different visual arguments, not a required template.

Visuals are optional conversation artifacts. They do not run Planning modules, launch workers, validate evidence or change Goals. The same service backs `relay_visual`, `blackice_visual` and Chat's Visuals panel. Native provider conversations retain their original tool catalog; start a new provider conversation to obtain a newly introduced tool. Existing conversations can still inspect and edit visuals through Chat.

## Choosing a representation

Start with the analytical question and the relationship that is hard to see. Arrange claims, observations, dependencies or alternatives so the relationship becomes inspectable. Mix primitives as needed. No technique names or mandatory analysis sequence are exposed.

- “These three reports might all come from one witness.” Draw source dependencies; three reports need not be three independent observations.
- “Both explanations fit the outage; what should we check?” Show shared evidence, uncertainty and the missing observation that separates the explanations.
- “What has to happen before this action is possible?” Show dependencies only if branching matters. A short ordered list usually wins for a simple sequence.
- “Compare exact prices and dates.” Use a table. A diagram would make exact lookup harder.
- “What is the answer?” Give a sentence when one sentence settles it. Do not manufacture a canvas to justify using the tool.

There is no opt-in gate. Availability does not mandate a visual in every answer; prose and ordinary tables remain the better choice when spatial structure adds nothing. A visual never makes an unsupported claim more certain. Label hypotheses, uncertain relationships and missing evidence in words; color alone is insufficient.

## Shared contract

Call `describe` for a complete editable example. Actions are `describe`, `list`, `read`, `changes`, `create`, `revise`, `patch`, and `export`. Direct calls require a stable `requestId`; writes also require one in native calls. Direct calls name an existing conversation; create/revise/patch additionally reauthorize the existing files:write grant. Native identity comes from the host and cannot be supplied by the model. `revise` and `patch` require the exact `expectedRevision` read. A conflict returns 409 and never merges unseen user changes. Read, reconsider the correction, then submit an intentional revision with a new request ID.

Version 2 documents have `title`, `summary` (the analytical takeaway/text alternative), and `kind`:

| Kind | Editable content |
| --- | --- |
| `composed` | `width`, `height`; `items` with unique IDs, labels, optional positions/dimensions and status; labeled directed `links` with optional uncertainty; `groups` with member IDs or explicit bounds; `grid` columns/rows; `notes`; bounded custom SVG `regions` |
| `custom` | A static `svg` string, title and a sufficient text alternative |

The compiler assigns missing stable IDs and returns the semantic document, deterministic SVG, and a text equivalent. Omit coordinates for local automatic arrangement; optional layout.columns and explicit coordinates control geometry. Small relationship graphs use a neutral ring to avoid routing through a middle object; other content uses bounded packing. Layout does not infer causal or temporal meaning. Group enclosures that include unrelated items are rejected rather than silently implying membership. Version 1 rendering remains unchanged so earlier exports can still be validated. Limits: 40 items, 60 connections, 12 groups, 20 notes, 8 custom regions, 6 grid columns and 12 rows; 32 KiB SVG; 100 artifacts and 200 revisions per artifact within a 20 MiB conversation journal. Split large analyses rather than shrinking labels to fit. Each custom region carries a label and text alternative and is edited as SVG source. It can coexist with semantic objects, but its paths do not claim semantic meaning. Custom content does not claim a semantic round trip. Chat's explicit custom fork creates a separate artifact and retains the original composition.

No additional model calls are used for rendering, reading, editing, history or export. The model pays for its document/tool output and any revisions it chooses. `list` returns metadata and history, not every SVG. Agent `read` omits the redundant rendered SVG; `export` supplies it. Write receipts return assigned object IDs. `changes` provides actor-tagged field deltas after an observed revision (default five revisions, maximum twenty), with explicit truncation of long values and a pagination cursor. Native turns receive bounded ID/revision/actor metadata for saved visuals, so user changes are discoverable without inserting entire drawings into context. Keep artifacts small and purposeful.

## Editing and persistence

Tool availability itself has a prompt cost even when no visual is produced. A full-catalog history fixture crossed its automatic compaction threshold after the schema grew (93,198 estimated tokens against 93,061); compaction added a model call. Its persistence test now uses a larger fixture window, while context/compaction tests retain their own limits. This is not a measured visual reasoning benefit: evaluation must include catalog overhead and any earlier compaction, not just visual tool calls. Rendering and editing themselves remain model-free.

Chat displays validated SVG images directly inside the scrolling conversation. Inspect opens a keyboard-operable dialog with content fields, an advanced JSON structure editor, a draft preview, text equivalent, revision selector and SVG/JSON/text exports. Simple fields edit item labels, statuses, connection labels, groups, notes and grid cells. Simple controls add items and labeled connections. Field edits generate targeted patches where possible; the source editor can add/remove primitives and change positions. Drag-and-drop layout is deferred. Custom SVG source is editable as text. Failed validation and revision conflicts leave the draft in place. An unchanged retry reuses the same request ID. Patches can add/update/remove objects by collection and ID, set document presentation fields, or set an existing grid cell. All operations commit together at an exact expected revision; dangling links and prototype fields are rejected. Removing an item requires removing its links and group memberships in that same patch.

The panel explicitly shows current revision numbers; historical tool receipts retain their original revision identifiers. Historical inspection and export select an exact immutable revision and disable overwriting it. Revisit via the saved conversation. The conversation journal commits revisions and retry receipts atomically using a synced temporary file and rename. Reads validate saved content before allowing export. Data is separate from Planning and Goal stores. Conversation trash retains its visuals with the conversation; permanent data lifecycle integration is deferred and must not be claimed as implemented.

## Renderer boundary

SVG is an encoded image URL, never injected into the chat DOM. Both host and renderer validate the same bounded profile, layered over the existing static SVG validator. Scripts, events, foreign HTML, navigation, external resources, CSS, filters, masks, patterns and reusable references are rejected. Numeric geometry, element count, nesting and byte size are bounded. The host CSP continues to prohibit objects and external image resources. There is no approval dialog for normal safe use. Invalid submissions preserve the previous valid revision. No renderer claims that structural validity proves analytical correctness or legibility.

## Worked decision

An outage follows a deployment. Three support reports initially appear to corroborate a code regression. Put both “code regression” and “load increase” beside the observed failure and draw explicitly uncertain explanatory links. Add a source group showing that the three reports repeat the same monitoring alert. They no longer look like independent corroboration. A note identifies the missing discriminating observation: old and new versions under equal load.

The next action becomes a controlled comparison, rather than an immediate rollback justified by three supposedly independent reports. If equal-load testing finds both versions fail at the same threshold, revise the observations and explanation links. Preserve the earlier revision to show why the decision changed. The diagram's benefit is exposing dependency and a useful test; it does not establish causation.

## Verification and evaluation

Automated checks cover native execution with Planning off, saved catalog restoration, authenticated HTTP/static assets, shared adapter persistence, conflicts, retry identity, cancellation, exact history/export and malicious SVG. `node tests/visual-headless.mjs` exercises the active chat in a disposable BLACKICE Electron/Chromium profile: inline rendering, user edit/addition, preview, agent patch, conflict draft, history and exact SVG export. It never opens the user's browser profile.

To evaluate default availability, run paired tasks with identical evidence and model settings in three arms: prose, ordinary structured text/table, and visual-tool access. Randomize order and blind scoring. Include source dependence, competing hypotheses, causal confounding, branching dependencies, uncertain timelines, and negative controls (a one-sentence answer, exact lookup, a simple sequence). Score correct distinctions, unsupported claims, missing-evidence detection, decision quality and calibration. Measure end-to-end time, tool latency, model input/output tokens, correction turns and SVG retries. Test whether a user can change a label, relationship and grid cell, reopen it after restart and export the same revision without model assistance.

An occasional tool succeeds when users complete requested visual tasks reliably and selected spatial tasks improve beyond the structured-text arm at acceptable cost. Default enablement needs a broader benefit: neutral or better negative controls, no material increase in unsupported certainty, and consistent net quality/time gains after selection and revision costs. Attractive diagrams alone are not evidence. If structured text matches the quality faster, reduce unsolicited visual use. No comparative reasoning improvement has been measured by the implementation tests.

Follow-up increments: richer graphical overlap diagnostics; richer keyboard geometry and connection editing; stable Planning artifact references; per-conversation archive/export lifecycle; optional pinned transcript cards; then a controlled evaluation of automatic selection. Do not gate ordinary reasoning on any of them.

## Integration choices from the design handoff

Included: renderer-managed geometry, stable object edits, actor-tagged user changes, mixed custom regions and concise positive/negative examples in the attached tool description. These reduce authoring and correction effort without requiring the user to learn an analytical taxonomy.

Deferred: a permanent global component marketplace, interactive executable SVG, drag-canvas editing, automatic promotion of generated diagrams into reusable templates, and mandatory Planning integration. None is needed to demonstrate the user-edit/agent-revision loop. Custom regions are static graphics, not mini-applications. Visual tools remain available by default without requiring their use; paired outcome and cost evaluation remains outstanding.

Chat previews remain visible inline. Generated compositions without custom regions receive a subdued grayscale/charcoal display treatment; original SVG export bytes and custom-authored colors are preserved. Workspace controls use BLACKICE's shared theme variables. The model guide asks custom SVG authors to match the surrounding theme and avoid bright decorative fields.

## Rendered authoring feedback

`preview` accepts an unsaved document, or an artifact ID and optional revision. On desktop it returns a PNG and advisory text-bounds/overlap diagnostics without saving a revision or launching another model. The isolated, hidden, sandboxed Chromium surface denies permissions, external navigation and resources; it is disposed after each preview. SVG validation is identical to saved-artifact validation. A server without the native preview callback reports unavailability explicitly. Preview latency and image tokens are paid only when requested. Automated diagnostics do not assess evidence quality, graphical meaning or every possible overlap.

`tests/visual-authoring-render.cjs` checks all three authored examples in real Chromium, clipping and overlapping transformed text on a small canvas, absent viewBox normalization, cancellation recovery and disposal. This verifies rendering mechanics; it does not prove future model outputs or better decisions. Guidance emphasizes a visual argument, deliberate custom composition, clear hierarchy, restraint, and rendered inspection before saving.

## Concrete SVG construction guidance

The on-demand guide now supplies a drawing vocabulary: an 8-unit spacing rhythm, measured text plus padding, explicit line spacing, connector clearance and routing, paint order, narrow-display calculations and valid SVG construction fragments. Fragments show shared dependence, an unknown interval and a displaced long annotation. They are local techniques to combine, not a chart taxonomy or whole-figure templates. The guide rejects decorative text slides, removes automatic all-caps labels and oversized headings, and keeps BLACKICE colors. Full examples use quieter, smaller headings. Saved user artifacts are not restyled.

Research references: [Hermes concept-diagrams](https://github.com/NousResearch/hermes-agent/blob/main/optional-skills/creative/concept-diagrams/SKILL.md) and [Hermes architecture-diagram](https://github.com/NousResearch/hermes-agent/blob/main/skills/creative/architecture-diagram/SKILL.md), inspected November 14, 2026. The useful ideas are explicit construction rules, semantic color, spacing and text fitting. This implementation uses original wording and geometry. It deliberately does not import Hermes HTML/CSS templates, marker references, bright architecture colors, tiny labels, fixed diagram menus or universal box layouts. Its SVG fragments compile and render under BLACKICE's existing static profile.

The tab remains removed. Construction guidance is retrieved only when authoring, not injected wholesale into ordinary answers. Rendered tests verify geometry and compatibility, not aesthetic preference or consistent future model behavior. The latest real custom-SVG test exposed a text-slide failure; checking actual model-generated responses remains the criterion for the next qualitative assessment.
