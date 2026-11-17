# Existing capability reachability inventory (2026-11-17)

Baseline: installed .105 product source b666b8359627ee737479e8415b3036d8f4f4719c. Source inspection used public/next, the current frontend. public/app.js is legacy and must not be treated as proof a current feature is reachable.

Priority: make existing capabilities seamless before adding features. This is a source inventory paired with ux_flows' fresh disposable .105 captures, not a claim of a complete installed-app accessibility or end-to-end audit.

## Current information map

| User intent | Current visible route | Existing runtime capability | Representation status |
|---|---|---|---|
| Start work, inspect a result | Chat | Conversations, run records, activity inspector, directory evidence, attachments, goals, autonomy, model selection | Primary surface; ontology/activity lane covers detailed relationships |
| Coordinate a team | Swarm | Project board, workers/items, archived/trash lifecycle | Primary surface; .105 lifecycle work exists, do not reimplement |
| Schedule work | Cronjobs | Chat schedules, recurring/event triggers, results, history, workflow deployment | Reachable, but jargon differs from Schedules headings |
| Edit/run reusable workflow now | Cronjobs > Manage saved workflows | Workflow graph author/editor and manual Run workflow | Misrepresented as exclusively for cronjobs; manual work hidden under scheduling |
| View agent websites | Browser | Native Chromium pages, ownership grouping, downloads, cleanup | Primary; native and fallback implementations differ, audit both honestly |
| Manage saved logins | No current next route; Storage & Data offers bulk password deletion | Existing browser-credentials UI plus vault and copy queue HTTP APIs | Confirmed missing frontend wiring; restoration implemented in this lane |
| Curate retained information | Knowledge | Memory/source stores | Other lane owns ontology/curation |
| Reuse procedure | Skills | Skill catalog/editor | Separate current tab; legacy Memory & skills title is not current evidence |
| Set defaults | Settings > General | Working folder, model defaults, response/context settings, concurrency | Reachable; current chats intentionally keep selected settings |
| Configure behavior | Settings > Behavior & profile | Identity/preferences store | Reachable; distinguish instructions versus recalled records |
| Connect a model | Settings > Models | Codex account, Mistral, local engines, API providers | Several onboarding types coexist; hierarchy and return-to-chat need journey check |
| Run local model | Settings > Models > Local models | Bundled llama.cpp server/config, local import/load, Ollama/LM Studio | .105 has model guide/file picker; loaded selection is returned but user manually returns to Chat |
| Add tools agents can use | Settings > Tools | Shared MCP catalog, import, catalog discovery/connect | Shared across supported providers already; not a per-provider rebuild |
| Let another app operate BLACKICE | Settings > App connections | One outgoing MCP endpoint, per-app setup/grants | .105 explicitly says setup tabs are not exclusive connections; label/direction can still improve |
| Manage storage | Settings > Storage & Data | Usage/cleanup grouped by category | Reachable; bulk destructive operations not equivalent to item management |
| Resolve uncertain operation | General's conditionally shown Review paused actions; Troubleshooting | Owner/native recovery receipts | Conditional entry intentional; no blanket gate should be inferred |
| Inspect QA/native application | No QA/application main route in next | applications.mjs remains on disk; historical desktop code exists | Do not restore based merely on file presence; user explicitly retired foreground desktop workflow |
| Backup/remote/email legacy features | Not established in current navigation | Some legacy modules persist | Scope gap: determine intended support before surfacing retired functionality |

## Concrete findings and fixes

### P1: Password manager is orphaned from the current frontend
Evidence: current next route registry and Settings tabs contain no password manager; recursive current-frontend search finds only storage's bulk Saved passwords category. Existing mountBrowserCredentials is fully implemented outside next. Fresh settings-models.png/settings-apps.png captured by ux_flows confirms absent tab.
Fix: reuse the existing manager in Settings > Passwords, plus Browser > Passwords navigation. No backend, permissions, browser behavior, credential masking policy, or vault mutation is added by opening the screen. Use existing revision/receipt semantics. Detach the child panel on leave so existing polling pauses; retain field identity and uncertain receipt until destroyed. Current changes tested with synthetic metadata only.
Limitation: the old component also offers native-browser password copying. This is existing behavior, not a new integration. Browser availability remains server-reported; no imports are executed by navigation.

### P2: Workflow placement hides immediate execution
Source: tasks.mjs removes workflow tab in cronjobsOnly mode and adds Manage saved workflows. workflow-execution.mjs subtitle says for cronjobs but exposes Run this workflow with immediate POST execution.
Recommendation: accurately describe reusable workflows for immediate OR scheduled use, and offer contextual navigation where users already choose multi-agent work. Do not invent a second workflow store or conflate Swarm projects with workflow templates. Fresh flow capture required before changing information architecture.

### P2: Local model setup ends without a use-this-model handoff
Source: llama-launch-settings.mjs tells users to return to chat selector; settings-local-models.mjs gets result.selection after load but uses it only in status text.
Recommendation: connect the existing successful load receipt to an explicit Use in new chat action. Do not silently change current conversations, global default, or start a model turn. Verify provider/model readiness and preserve existing chat drafts. Not implemented yet.

### P2: Two directions of app/tool connectivity remain cognitively costly
Source: Tools owns incoming external tool servers; App connections lets external apps call BLACKICE. .105 prose is correct and shared server already exists.
Recommendation: retain architecture, improve headings to Tools for BLACKICE / Use BLACKICE from other apps and provide contextual cross-links. Avoid adding exclusive provider copies.

### P2: Model setup status is not the whole job
Codex subscription tells an unauthenticated person to use official CLI and reconnect; global header Connected also reports event-stream health. A user can mistake transport availability for model readiness. Need actual disconnected-state journey capture before choosing the repair.

## Scope and evidence limits

No live profile, real vault, active job task, employer website, or account was used. No application was submitted or replayed. No source-only claim of visual/accessibility compliance. Fixture screenshots should identify synthetic API data; actual rendering supports CSS/navigation findings, not real provider/authentication efficacy.
Outstanding audit coverage includes keyboard traversal in the full shell, narrow widths, real local-model hardware/load success, MCP authentication/import end-to-end, storage recovery/backups, native-browser page containment, and large real data volumes. These must not be labeled complete because unit tests pass.

## Implemented and verified in this lane

- Restored existing Passwords manager in Settings and Browser with the existing vault UI/API. No new permissions or automated credential actions.
- Led with BLACKICE agent logins; existing optional external-browser copy/queue is now collapsed in this Settings adapter.
- Preserved draft nodes and uncertain receipts across leaving/re-entering the panel; detached polling stops; destruction clears local draft.
- Added Swarm > Reusable workflows navigation to the existing workflow manager and corrected that manager's subtitle to cover immediate and scheduled execution.
- With no explicit saved runtime, running local model, or configured local provider, fallback setup shows llama.cpp rather than unavailable Ollama. Existing configured selections remain unchanged. .105 already selected bundled llama when config successfully reported it; the earlier unsupported fixture response was not evidence of a real installed default bug.
- Model-load-to-chat selection handoff remains unimplemented. It must not silently overwrite an existing conversation/draft or execute a model turn.

103/103 focused tests pass; no skips or cancellations. Includes password adapter lifecycle/navigation, existing credential UI semantics, Settings, native/fallback Browser, Swarm link, local runtime selection, and a shared synthetic DOM type setter correction. No full-suite/build/install claim.

### Captured flow evidence

Fresh capture owned by ux_flows, after screenshots inspected by ux_inventory as well:
1. Settings > Passwords: healthy, existing synthetic saved login visible and external-copy extras collapsed. evidence/ux-existing-capabilities-20261117/01-passwords.png.
2. Browser Passwords button > Settings Passwords at 640px: healthy, actual navigation captured, no horizontal overflow. evidence/ux-existing-capabilities-20261117/02-browser-to-passwords-640.png.
3. Swarm > reusable workflow manager: source and synthetic navigation checks pass; full-render capture pending.

These fixture screenshots contain only synthetic example.test metadata. They do not show or test any real credential, submission, import, or user account. Keyboard focus through every restored credential operation and assistive-technology announcement quality remain outside this capture's evidence.
