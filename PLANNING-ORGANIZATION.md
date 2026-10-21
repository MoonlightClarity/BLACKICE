# Plan names, groups, and history

Planning and Swarms share named groups. Planning shows a group → plan outline beside the existing work plan and step editor. Swarms shows groups containing saved projects; the selected project contains a dependency-ordered task outline, and each task contains its actual implementation and review attempts. Prerequisite links describe dependencies without pretending they are parent–child ownership.

## Everyday use

Both workspaces initially show active plans. Choose Archive explicitly to inspect historical plans. Planning also has a read-only Trash view tied to the saved conversation's state. A completed plan remains active until it is deliberately archived.

In Planning, choose **New group**, or select a plan and choose **Rename / move**. Navigate group branches with the arrow keys; F2 edits the focused item's name. The plan name can be cleared to use its chat title or objective again. Search includes saved names and group names, and the group filter applies before pagination.

In Swarms, use **Rename**, **Move to group**, or **Archive** on the saved project. Group names are shared with Planning. **Restore plan** returns an archived project to the active list. A project with running or unsettled work must finish stopping before it can be archived.

Removing a group keeps every plan, objective, step, project task, and execution receipt. Its members become Ungrouped. Group membership does not change how a task executes.

## Saved data and conflicts

Organization metadata lives in `planning-organization.json` within the existing application data directory. It contains named groups, optional chat-plan name overrides and assignments, and project group/archive assignments. No existing task or project file is rewritten just to open these views; legacy plans remain readable as Ungrouped.

The organization revision is independent of executable task revisions. A rename or group move does not make a worker's saved-plan revision stale. Swarms project names continue to use the existing project's authoritative name and revision.

Writes validate the whole requested transaction, hold an interprocess lock, preserve a backup, and publish atomically. A stale `expectedRevision` produces a conflict. The UI retains the user's proposed values and asks them to inspect the current organization before retrying. Corrupt or unreadable organization data is reported rather than silently replaced with empty data.

## HTTP interface

`GET /api/planning` defaults to `state=active`. Explicit `state=archived`, `state=deleted`, and `state=all` remain available. Optional `groupId` and `taskId` filters narrow the catalog before pagination. The response includes effective plan titles, group metadata, and an `organization` summary with its own revision.

`POST /api/planning/organization` accepts an `expectedRevision` and an `operations` array. Supported operations are `create_group`, `rename_group`, `remove_group`, `update_plan`, and `update_project`.

```json
{
  "expectedRevision": 4,
  "operations": [
    {"type": "create_group", "id": "launch", "name": "Website launch"},
    {"type": "update_plan", "taskId": "saved-task-id", "name": "Review the launch copy", "groupId": "launch"},
    {"type": "update_project", "projectId": "saved-project-id", "groupId": "launch"}
  ]
}
```

Only existing editable saved plans or projects can be assigned. Use `groupId: null` to ungroup, and `name: null` to clear a plan's display-name override. Project archive membership uses `update_project` with `archived: true` or `false`; project renaming uses the existing revision-checked project update endpoint. Archive admission and project execution admission share the organization lock, preventing work from starting between the archive check and its commit.

All routes retain the application's session and remote-device authorization. Names and group operations do not imply permission to launch a project, send a message, or perform an external action.
