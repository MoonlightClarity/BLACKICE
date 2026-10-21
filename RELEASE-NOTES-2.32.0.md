# BLACKICE 2.32.0

## Organize Planning and Swarms

Planning now opens on active plans. Its saved-plan catalog is a navigable outline of named groups and plans, with separate Archive and Trash views. Create and rename groups, rename plans, move plans between groups, filter by group, and remove a group without deleting its plans. Arrow keys navigate the outline, and F2 opens the focused item's name editor.

Plan display names and group membership have their own durable revision. Organizing a plan does not rewrite its objective or steps, advance the work document's revision, change worker ownership, or replace an open step draft. Competing organization edits require reviewing the current saved values before retrying. Existing plans appear as Ungrouped until organized.

Shared editing presence and agent read status now appear below the editor actions. Their background updates keep the fields and Save button in place, including while a pointer click is underway.

Planning text fields retain their ordinary cursor keys. Arrow, Home, and End navigation switches mobile panes only when a pane tab itself has focus.

Swarms uses the same named groups and defaults to active plans. A saved project can be renamed, moved, archived, or restored. Its main task outline follows dependency order and shows explicit prerequisite links. Expanding a task exposes its actual implementation and review attempts and links to their saved runs and plans. Tasks appear once; execution status remains a secondary filter.

Archiving a Swarms plan requires its work to settle. Archived projects cannot start, retry, or begin a review until restored. Creating or reorganizing a saved plan does not launch workers. Group removal moves both chat plans and Swarms projects to Ungrouped while keeping their names, work, and history.

## Direct sign-in entry

Opening Chat Mode sign-in now puts the page first, keeps browser-management controls collapsed, and shows the current keyboard state next to the page. Long OAuth addresses no longer expand the page heading or push the form below the window. Click a field and type normally; no separate text-entry panel is required. A field click made while the preview refreshes is retained, and subsequent text waits for that click to finish.

Includes the 2.31.1 input bridge for typed text, Unicode paste, editing and navigation keys, Tab/Shift+Tab, and Control/Command+A. Escape releases keyboard capture. Ordered input remains tied to the exact selected tab and document, and unsent input is cancelled when the page or tab changes.

## Verification

The completion handoff records the accepted automated and native UI results for this exact build. The organization UI journey uses disposable local data and checks group creation, plan naming and movement, draft preservation, active-only defaults, Archive/Restore, shared group renaming, dependency order, narrow layouts, and non-destructive group removal. The native keyboard fixture exercises the real contained browser without signing in to an external account.
