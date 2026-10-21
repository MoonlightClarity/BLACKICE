# BLACKICE 2.29.0

## Shared visual Planning

Planning is a main workspace beside Chat, Activity and Settings. It replaces Methods and displays the agent's actual saved objective, steps, dependencies, branches, expected results, completion checks and evidence. Humans edit the same plan in a persistent editor. Outline and Mind map share the data; narrow screens offer Plan, Edit and Saved plans panes.

Saves check the displayed revision. Concurrent changes preserve the draft and open a review flow. Remote edits carry verified client provenance. Plans can be found by current chat titles, edited after archiving, and inspected read only from Trash.

Unsaved drafts have no editing-presence signal. Saved changes notify the application and pending scheduler; an already running model sees them through a later plan read, revision conflict or continuation. Saving does not interrupt active tools or require acknowledgement before the next ordinary action. Conversation directions and Stop remain the controls for redirecting active work.

## Independent swarm work

Swarms use the same visual structure. Workers have explicit roles, scope, required inputs, expected results and finish conditions. Eligible work starts when its actual prerequisites allow it, while unrelated work or a coordinator remains busy. Dependencies still require upstream runtime settlement and completed prerequisite work.

The delivery team includes an implementation owner and parallel specialists. Additional writers require disjoint scopes. Delegated agents stay within assigned work; the coordinator integrates results and owns final external-action receipts.

## Remote access for people and agents

Settings provides private Tailscale access and an explicitly selected authenticated public option. Browsers pair with short-lived one-use codes. Outside agents receive named revocable credentials with separate read, task execution and planning permissions.

MCP and REST expose shared tasks, plans, outputs, artifacts, continuation and cancellation. Stable request IDs recover admitted tasks on retry. Revocation ends access and active event streams. Setup preserves unrelated Tailscale routes. See [REMOTE-ACCESS.md](REMOTE-ACCESS.md).

## Headless operation

`Agent Desk.exe --headless` starts the same Electron runtime without opening the main window. Run in background hides an existing window; normal reopening reveals the same profile instance. An explicit `--profile-dir` supports isolated workspaces, and `--quit` requests graceful shutdown. Encrypted connections and contained tools remain available while the process runs.

## Browser tabs and protection

Activity has a visible tab strip, individual close controls, New tab and explicit Follow active page mode. Selecting a tab pins the view; closing it selects a neighbor. Keyboard navigation and per-tab address drafts work across status updates.

Ad and tracker blocking starts enabled with bundled Ghostery filtering and EasyList/EasyPrivacy snapshots. The browser shows protection and actual blocked counts. People can add an exact-site exception, change global protection or refresh the known lists. Failed updates retain usable filters, and site changes recheck the current origin. See [BROWSER-PROTECTION.md](BROWSER-PROTECTION.md).

## Retained interface improvements

The update keeps the calmer chat layout, compact model lists, dark dropdowns, chat renaming, message and filename search, draft recovery and cancellation behavior. Existing conversations retain their original native tool catalogs and saved history.

## Verification and delivery

The guarded local update requires the Windows regression, rendered UI acceptance, actual remote gateway/runtime checks, real Electron lifecycle and native browser protection checks, all tied to the exact candidate. [UI-VALIDATION.md](UI-VALIDATION.md) defines the scope; acceptance reports contain measured results.

The update preserves the profile and connections and records verified rollback copies. Remote access is configured separately in Settings. This local update does not publish a public route or rebuild a public Setup installer.
