# BLACKICE Frontend V2

V2 is the default interface in BLACKICE 2.35.2. It replaces the accumulated renderer with a small shell and independently mounted workspaces while retaining the existing local profile and execution/storage APIs. It does not migrate saved data.

## Routes and lifecycle

- `/` and `/index.html` open V2; `/next/` is a direct alias.
- `/legacy/` retains the classic recovery interface, linked from Settings and the startup warning.
- `public/next/app.mjs` loads workspace modules when selected. Each module owns enter, leave and destroy behavior; hidden workspaces unsubscribe and invalidate stale reads.
- `server.mjs` serves an explicit static allowlist. Execution and storage remain authoritative on the backend.
- `public/next/guard.js` provides a small startup-failure warning without depending on the main renderer.

Separate UI lifecycles do not imply separate data stores. The human interface, background agents and connected clients can inspect the same saved records. Editors preserve local drafts and use the backend's available revision or snapshot checks before explicit writes.

## Workspaces

| Surface | Current behavior |
| --- | --- |
| Chat | Bounded catalogs and turns, worker-backed history decoding, streaming updates, preserved drafts/attachments, model and reasoning controls, on-demand artifacts, conversation lifecycle actions. |
| Planning | Saved conversation/project maps, branch focus, outline alternative, one step inspector, revision-checked notes and plan edits, conversation lifecycle and project Archive/Restore. |
| Tasks | Status board by default; separate Schedules and Job history views; searchable, bounded task management and explicit execution actions. |
| Browser | Actual desktop Chromium surface, persistent independent tabs, per-tab address drafts, navigation/downloads/shortcuts, pending HTTP authentication and fallback screenshot controls. |
| Activity | Selected workflow/run map, actual stage status and focused inspection; secondary editors and run actions; separate task timeline and native applications. |
| Knowledge | Metadata search, on-demand memory/skill content, explicit guarded writes, lazy retained revisions, Trash and direct restore. |
| Settings | Lazy General, Identity, Models and Tools sections, with preserved drafts, separate save/connect actions and explicit configuration import. |

The workflow authoring tools retain node and edge identities and unknown metadata. Graph edits, stage settings and descriptive assignments remain local until explicit Save. Known stale snapshots are rejected; this does not create an atomic compare-and-swap guarantee for APIs that only support a preflight read.

Worker assignments contain scope, inputs, expected result and completion criteria. Legacy permission metadata is inert. Actual execution configuration, saved-plan ownership and dependency coordination remain separate.

## Rendering and data bounds

Chat loads lightweight catalogs and selected records instead of rendering the complete saved archive. Message and catalog expansion is explicit. Heavy saved transcript decoding runs in a module worker; active streamed text uses bounded updates and completed output can render Markdown.

Planning catalog requests project scalar run metadata directly when the engine's retained Map is available. They preserve prior ordering, lifecycle precedence and active-run edit guards without snapshotting every retained transcript. The compatibility path for older engines remains.

Maps bound their initial visible work and provide explicit expansion. The Activity inspection map keeps a readable scale and scrolls inside its viewport; keyboard navigation uses one tab entry with arrow/Home/End movement. The workflow editor has its own bounded interactive canvas. Selecting a map node does not change execution or invent timestamps, progress or evidence.

Settings catalogs page explicitly. Provider key checks describe credential verification separately from model access. Tool-configuration previews omit secret values and command arguments; applying an import saves configuration without connecting or starting a server. Partial failure retains the source and reports saved items before another preview.

## Browser integration

`desktop/browser-surface.mjs` moves the selected `WebContentsView` between the desktop host and a hidden parking host. The page session and background-tool identity are preserved. Frontend attach/hide requests guard against stale workspace and tab selection.

Each blank tab is an actual saved `about:blank` tab. Native attachment persists selection; fallback selection uses a metadata-only action. Navigation acts on the existing tab. Unsaved addresses remain separate in memory, and delayed status or navigation replies cannot replace newer selection or text.

Site/proxy HTTP authentication uses a stable chrome form and a one-time native callback outside the ordinary navigation queue. Credentials are not placed in normal HTTP action payloads, status or persisted receipts. Pending sign-in can survive a workspace switch. Closed dialog metadata is informative; genuine pending dialogs retain their choices.

Direct human browsing accepts ordinary local-file/internal addresses subject to Chromium support. Human tab organization and background task routing retain distinct provenance and resource budgets. The release does not claim every historical browser policy or all folder-management UI has been replaced.

Thunderbird/Himalaya is retired; email belongs in Browser. The former reverse ChatGPT Bridge/browser provider is also retired. The supported ChatGPT-to-BLACKICE direct connection is separate.

## Visual system and accessibility

V2 uses `blackice-dark-ice.png` with graphite panels, silver accents and a coordinated SVG mark. The persistent masthead exposes the image across workspaces. Text surfaces retain dark overlays. Native options and option groups have explicit paired foreground/background colors, with distinguishable disabled choices and visible focus.

Reduced transparency and increased contrast keep an opaque masthead image; forced colors defer content and controls to system colors. Planning/workflow maps preserve distinguishable selection and transparent interaction targets.

The desktop minimum width is 780 pixels. A known mobile-web limitation remains below 650 pixels: the Chats sidebar lacks a visible opener. Programmatic geometry checks at that width are not evidence of usable physical interaction.

## Verification and limits

Tests use synthetic credentials and temporary stores for Knowledge, Identity, providers and tool connections. Configuration import fixtures do not start configured processes or invoke external tools. Other tests use actual local HTTP APIs and disposable profiles. Native Electron fixtures must remain hidden and nonfocusable.

Historical heavy fixtures include thousands of conversations/workflows and large graphs; their results belong to the exact source named in each receipt. Pure-model, headless Chrome, real-backend and hidden Electron checks establish different properties. A hidden render does not establish visible frame rate, physical pointer/IME behavior, drag-and-drop or arbitrary Windows dialog/DPI compatibility.

The 2.35.2 installed Planning comparison used the same saved workload before and after the scalar metadata change. Its measured response cost improved substantially. The probe used a fresh hidden renderer against an already running server with uncontrolled caches; it is not a cold-start benchmark or a full interaction journey.

The original intermittent multi-minute startup remains under investigation. Remote-route setup no longer blocks local desktop startup, complete direct-action indexing has bounded concurrency, and startup diagnostics accept only fixed phase names, bounded durations and ready/failed outcomes. These changes do not establish the original root cause.

The historical native `EXCEPTION_BREAKPOINT` likewise lacks a causal reproduction with a genuine minidump. Deferred renderer-death cleanup and local-only Crashpad provide mitigation and evidence. Crash dumps can contain private process memory and are not uploaded automatically.

Classic fallback still covers less common account/configuration and advanced document surfaces. Rich V2 artifact previews cover text and raster images; native document editing, advanced document/SVG previews and broad application compatibility remain separate work.
