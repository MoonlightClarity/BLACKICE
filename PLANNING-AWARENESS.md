# Shared editing awareness

BLACKICE uses one semi-structured process graph for the human, native agent and assigned swarm workers. Durable plan content and transient collaboration signals have separate lifecycles.

## Editing presence

Actual human input publishes the selected saved step ID and a generated editor ID. It does not publish draft text, claimed identity, completion status or an acknowledgement. The server derives identity from the local session or verified paired browser.

Presence is advisory. Editing a step does not lock every worker. The UI renews a lease during recent input, releases it after inactivity and on successful Save, Discard, selection changes, navigation, hidden documents and leaving the compact Edit pane. Leases expire after 20 seconds if release cannot be delivered. A unique editor ID prevents a delayed old release from clearing a newer editor session. A paired browser cannot release another client's lease.

Presence is held in memory. It does not increment the saved plan revision, persist unsaved text or survive a runtime restart. Registry reads prune expired leases; the interface refreshes status while active.

## Worker plan reads

The runtime registers a worker using its actual run, node and assigned step. An actual successful `relay_task read` records the revision delivered. The interface displays that revision or that a newer relevant correction requires review. There is no user-writable acknowledgement endpoint.

A receipt establishes that saved plan data was delivered to the worker's tool context. It does not establish comprehension, agreement or successful execution. A newly admitted worker has a baseline for detecting later changes, but the interface shows no recorded plan read until one occurs.

The live registry resets when BLACKICE restarts. Finished run snapshots may retain their historical read receipts; they are not live presence for a restarted worker.

## Before an affected action

The guard compares the relevant saved work with the worker's observed context. Relevant work includes its owned subtree, prerequisite work, and enclosing branch or sequence controls. A saved correction outside an independent parallel scope does not impose a global wait.

If relevant work changed, an attached operational tool returns `TASK_PLAN_REVIEW_REQUIRED` before execution. The worker must call `relay_task read`, review the delivered correction and then retry the intended action. Task reads remain available. After a new read, a newly unmet prerequisite can still prevent operational work; reading does not bypass dependency readiness or pretend an upstream worker finished.

An action already underway keeps its real result. If someone saved a relevant correction during it, an appended notice requests a fresh read before subsequent affected work. New unsaved editing notices may also appear in tool results, with duplicate notices suppressed. Advisory presence does not turn a successful action into a failure.

## Boundary of enforcement

The guard covers BLACKICE's attached `relay_*` tool dispatch. Native Codex built-in shell/file tools do not pass through this dispatcher. Guidance tells the agent to use the shared plan and not bypass review, but those built-ins are not covered by a universal runtime interception guarantee.

Outside agents can read `planningAwareness` through `blackice_get_task` and follow `planning.awareness` invalidations. Their reads do not impersonate registered native workers. Tools or commands they run outside BLACKICE remain outside its enforcement boundary.

Use explicit conversation direction or Stop for immediate control of active execution. Saving a plan is a durable correction; it is not cancellation of an in-flight operation.

## Interfaces

| Interface | Result |
| --- | --- |
| `GET /api/tasks/:id/plan/awareness` | Current revision, relevant editor leases and real worker read receipts |
| `POST /api/tasks/:id/plan/presence` | Renew `{editorId, stepId}` for the authenticated human |
| `DELETE /api/tasks/:id/plan/presence` | Release that human's `{editorId}` lease |
| `planning.awareness` event | Compact task invalidation; fetch current state |

Presence mutations require the authenticated human application route. Outside bearer credentials retain the scoped MCP/agent API surface. Trash stays read-only. Saved plan edits still require `expectedRevision` and full graph validation.
