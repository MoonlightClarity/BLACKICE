# Skills search / collapsed-folder regression

Baseline: 73f0ca1f675f99c4eb6f4377e179ad78bb9e4c39.

Independent review correctly identified that a matching saved skill could remain hidden beneath collapsed ancestors. Reproduced with both Research and its child Review collapsed: search returned the entry, but the root remained closed. The added test failed with "search must reveal the collapsed root".

Fix: a search render temporarily opens matching groups and their ancestors. Its native toggle events do not update the browsing collapse preferences. The mode is captured per render, so delayed events after a later render cannot overwrite saved state. Clearing the query restores the previous root and child collapse states. User interactions in search do not change the browsing preference.

Verification:
- 108 targeted Knowledge/Skills/static/navigation tests passed, no failures or skips.
- Real createHarnessServer static/API + offscreen Electron regression passed: collapse root and child; search; verify both open and results visible; clear search; verify both closed again. Whole scoped renderer run passed nine checks with zero console errors.
- Inspected 08-search-reveals-folders.png and 09-search-cleared-restores-collapse.png. Matching nested rows are visible during search; collapsed Research returns after clearing.
- Evidence includes before-fix failing test, after-fix test log and search-render-result.json.

No live user data, profile, installation, browser permissions or model execution changed.
