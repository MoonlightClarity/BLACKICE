# Editable visual reasoning — first release

Visuals are optional conversation artifacts. They do not run Planning modules, launch workers, validate evidence or change Goals. The same service backs `relay_visual`, `blackice_visual` and Chat's Visuals panel. Native provider conversations retain their original tool catalog; start a new provider conversation to obtain a newly introduced tool. Existing conversations can still inspect and edit visuals through Chat.

## Choosing a representation

Start with the analytical question and the relationship that is hard to see. Arrange claims, observations, dependencies or alternatives so the relationship becomes inspectable. Mix primitives as needed. No technique names or mandatory analysis sequence are exposed.

- “These three reports might all come from one witness.” Draw source dependencies; three reports need not be three independent observations.
- “Both explanations fit the outage; what should we check?” Show shared evidence, uncertainty and the missing observation that separates the explanations.
- “What has to happen before this action is possible?” Show dependencies only if branching matters. A short ordered list usually wins for a simple sequence.
- “Compare exact prices and dates.” Use a table. A diagram would make exact lookup harder.
- “What is the answer?” Give a sentence when one sentence settles it. Do not manufacture a canvas to justify using the tool.

Automatic use is off by default and can be enabled per conversation. Explicit user requests remain supported. The tool description instructs the agent to inspect `list` before discretionary use. This is model guidance, not a classifier that claims to prove the user's intent. A visual never makes an unsupported claim more certain. Label hypotheses, uncertain relationships and missing evidence in words; color alone is insufficient.

## Shared contract

Call `describe` for a complete editable example. Actions are `describe`, `list`, `read`, `create`, `revise`, and `export`. Direct calls require a stable `requestId`; writes also require one in native calls. Direct calls name an existing conversation; create/revise additionally reauthorize the existing files:write grant. Native identity comes from the host and cannot be supplied by the model. `revise` requires the exact `expectedRevision` read. A conflict returns 409 and never merges unseen user changes. Read, reconsider the correction, then submit an intentional revision with a new request ID.

Version 1 documents have `title`, `summary` (the analytical takeaway/text alternative), and `kind`:

| Kind | Editable content |
| --- | --- |
| `composed` | `width`, `height`; `items` with unique IDs, labels, positions, dimensions and optional status; labeled directed `links` with optional uncertainty; bounded `groups`; `grid` columns/rows; positioned `notes` |
| `custom` | A static `svg` string, title and a sufficient text alternative |

The compiler returns the original semantic document, deterministic SVG, and text containing all semantic labels and connections. Limits: 40 items, 60 connections, 12 groups, 20 notes, 6 grid columns and 12 rows; 32 KiB SVG; 100 artifacts and 200 revisions per artifact within a 20 MiB conversation journal. Split large analyses rather than shrinking labels to fit. Custom content does not claim a semantic round trip. Chat's explicit custom fork creates a separate artifact and retains the original composition.

No additional model calls are used for rendering, reading, editing, history or export. The model pays for its document/tool output and any revisions it chooses. `list` returns metadata and history, not every SVG. Keep artifacts small and purposeful.

## Editing and persistence

Chat displays validated SVG images directly inside the scrolling conversation. Inspect opens a keyboard-operable dialog with content fields, an advanced JSON structure editor, a draft preview, text equivalent, revision selector and SVG/JSON/text exports. Simple fields edit item labels, statuses, connection labels, groups, notes and grid cells. The source editor can add/remove primitives and change positions; drag-and-drop layout is deferred. Custom SVG source is editable as text. Failed validation and revision conflicts leave the draft in place. An unchanged retry reuses the same request ID.

The panel explicitly shows current revision numbers; historical tool receipts retain their original revision identifiers. Historical inspection and export select an exact immutable revision and disable overwriting it. Revisit via the saved conversation. The conversation journal commits revisions and retry receipts atomically using a synced temporary file and rename. Reads validate saved content before allowing export. Data is separate from Planning and Goal stores. Conversation trash retains its visuals with the conversation; permanent data lifecycle integration is deferred and must not be claimed as implemented.

## Renderer boundary

SVG is an encoded image URL, never injected into the chat DOM. Both host and renderer validate the same bounded profile, layered over the existing static SVG validator. Scripts, events, foreign HTML, navigation, external resources, CSS, filters, masks, patterns and reusable references are rejected. Numeric geometry, element count, nesting and byte size are bounded. The host CSP continues to prohibit objects and external image resources. There is no approval dialog for normal safe use. Invalid submissions preserve the previous valid revision. No renderer claims that structural validity proves analytical correctness or legibility.

## Worked decision

An outage follows a deployment. Three support reports initially appear to corroborate a code regression. Put both “code regression” and “load increase” beside the observed failure and draw explicitly uncertain explanatory links. Add a source group showing that the three reports repeat the same monitoring alert. They no longer look like independent corroboration. A note identifies the missing discriminating observation: old and new versions under equal load.

The next action becomes a controlled comparison, rather than an immediate rollback justified by three supposedly independent reports. If equal-load testing finds both versions fail at the same threshold, revise the observations and explanation links. Preserve the earlier revision to show why the decision changed. The diagram's benefit is exposing dependency and a useful test; it does not establish causation.

## Verification and evaluation

Automated checks cover native execution with Planning off, saved catalog restoration, authenticated HTTP/static assets, shared adapter persistence, conflicts, retry identity, cancellation, exact history/export and malicious SVG. `node tests/visual-headless.mjs` exercises the active chat in a disposable Edge/Chromium profile: inline rendering, user edit, preview, agent revision, conflict draft, history and exact SVG export. It never opens the user's browser profile.

Before enabling automatic use by default, run paired tasks with identical evidence and model settings in three arms: prose, ordinary structured text/table, and visual-tool access. Randomize order and blind scoring. Include source dependence, competing hypotheses, causal confounding, branching dependencies, uncertain timelines, and negative controls (a one-sentence answer, exact lookup, a simple sequence). Score correct distinctions, unsupported claims, missing-evidence detection, decision quality and calibration. Measure end-to-end time, tool latency, model input/output tokens, correction turns and SVG retries. Test whether a user can change a label, relationship and grid cell, reopen it after restart and export the same revision without model assistance.

An occasional tool succeeds when users complete requested visual tasks reliably and selected spatial tasks improve beyond the structured-text arm at acceptable cost. Default enablement needs a broader benefit: neutral or better negative controls, no material increase in unsupported certainty, and consistent net quality/time gains after selection and revision costs. Attractive diagrams alone are not evidence. If structured text matches the quality faster, retain opt-in use. No comparative reasoning improvement has been measured by the implementation tests.

Follow-up increments: better layout/label-overlap diagnostics; keyboard geometry and connection editing; stable Planning artifact references; per-conversation archive/export lifecycle; optional pinned transcript cards; then a controlled evaluation of automatic selection. Do not gate ordinary reasoning on any of them.
