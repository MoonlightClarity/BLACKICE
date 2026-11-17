# Nested saved-knowledge folders and compact previews

Baseline: integrated existing-capabilities product b1c1e127a3c933cc908442b85a8f8cc20e97118c (2.39.106).
Scope: Knowledge/memories and saved Skills. No live profile, installer, release, permissions, credentials, task execution or agent instructions changed.

## What changed
- Existing flat knowledge folders remain roots. Optional parentId adds real nested folders, persisted atomically in the existing organization document.
- Create a folder inside another; move an existing folder under another or back to top level. Self/descendant moves reject atomically. Removing a folder keeps directly filed entries in Unfiled and promotes its children one level.
- Knowledge uses a collapsible indented folder tree with recognizable decorative folder icons. Folder names remain accessible text; disclosure buttons have expanded state and retain keyboard focus after redraw.
- Skills exposes saved procedures inside their actual nested folders, with descendant counts and Unfiled. Built-ins remain a separate read-only group. Empty unrelated folders disappear from catalog searches; management still exposes the complete shared saved-knowledge folder tree.
- Organize saved skills opens folder management within Skills without leaving the workspace. New/edit flows retain their focused form and existing drafts.
- Skills and memories show a bounded single-line summary and compact metadata; selecting an entry still loads full unmodified content. Skills no longer repeats applicability/scope metadata in every list row. Its solid workspace background matches Knowledge readability.
- Folder-read errors keep the Skills catalog usable and explicitly report ungrouped fallback.

## Verification
- 107 targeted tests passed across knowledge, Skills, static asset and navigation tests; zero failed/skipped. Includes nested persistence/reopen, valid reparent, cyclic/unknown parent rejection, promotion on removal, unchanged entry bytes/history/applicability, stale revisions, full content, compact previews, source filtering, draft preservation and external removal.
- Fresh offscreen Electron renders used the actual createHarnessServer static and API routes with a temporary synthetic data/profile directory and a stub runtime that rejects model runs. No permissive static fixture or live data was used.
- Desktop and 640px viewport tested. Folder icon, descendant structure/counts, actual UI folder moves, full content, accessible management, and no horizontal overflow passed with zero renderer console errors.
- Actual rendered QA found and corrected a CSS specificity issue hiding the new organizer despite passing DOM tests. Also corrected leaf indentation after inspecting pixels.
- Seven final PNG screenshots and render-result.json were inspected. This is scoped visual/interaction QA, not full accessibility certification or whole-application acceptance.

## Screenshots / flow health
1. 01-memory-tree-desktop: healthy tree, visible folder icons and compact memory list.
2. 02-memory-open-desktop: healthy selected memory and full-path filing control; full body is retained in editor (asserted separately).
3. 07-folder-management: healthy create/rename/move/remove controls; real move-to-root and move-back verified.
4. 03-skills-tree-desktop: healthy nested saved Skills catalog with counts and on-demand full content.
5. 04-skills-organize-desktop: healthy in-Skills folder management, with Back to skills preserved.
6. 05-skills-compact: healthy responsive catalog, single-line previews, no horizontal overflow.
7. 06-memory-compact: healthy compact tree and all folder management controls reachable.

## Deliberate limits / adjacent owners
- Browser folders, Cronjobs folders and Chat integration are owned by separate workers. This change does not claim those complete.
- Knowledge and saved Skills continue sharing the existing organization catalog. Folder organization does not change applicability, provenance, source content, relationship data or execution behavior.
- No drag-and-drop, bulk filing, saved collapse-state across application restart, custom ordering, or knowledge-store capacity changes are introduced.
- Existing global unique folder-name constraint remains; sibling-scoped duplicate names are not introduced.
- Parent selection lists the full folder paths. Invalid self/descendant destination is rejected clearly rather than silently changing the destination.
- End-to-end installed-profile validation and release integration remain for the parent coordinator.
