# BLACKICE Skills tab — isolated review handoff (2026-11-15)

## Ownership and boundaries
- This is **Skills-tab lane only**, from fetched `origin/main` at `2371578ed97960a235abbdd3dbdec14da91a4703`, branch `feat/skills-tab-20261115`, isolated worktree `C:\Users\user\Documents\Codex\BLACKICE-skills-tab-20261115`.
- Root dot remains sole integration, release, installer, restart and publication gate. **Do not release this branch directly.**
- The reviewed deadline+startup combination `154e1e7` is separate and untouched. Swarm's Planning-TAB removal is separate; this branch only **adds** Skills navigation and retains the original Planning tab in its base. Merge Skills navigation into Swarm's current layout, never restore Planning as a side effect.
- No BLACKICE agent/model workers started. No job applications, full suite, installer, release, shared dirty checkout, or persistent skills/settings mutations.

## Existing semantics respected
- **Saved**: actual `KnowledgeStore` entries with `kind=skill`, active revision and optional folder scope; searchable and readable via existing `relay_skills` and editable through the existing revision-guarded Knowledge editor. The catalog does not claim they were loaded for a particular model turn or that a global per-skill enable toggle exists.
- **Bundled**: packaged Planning v4, Planning v5 (schema >=14) and Conversation Autonomy instructions. Loaded by host as source, but their *use* is conditional. Catalog presence is not turn evidence.
- **Native Codex**: read-only `skills/list` on an already-connected Codex process; no `start()` or model turn. Existing BLACKICE `blackiceSessionConfig` disables ambient native skill paths for isolated sessions. Catalog and detail show those as excluded, not automatically enabled. Native discovery failure/unavailability is visible; no silent promotion.
- The new Skills UI has source/query/folder filters, source/applicability/loading/enable-state details, full source content, explicit content reload, forced native refresh only on manual Refresh, empty and error states, stale-revision warning and revision-safe navigation to existing Knowledge editor for saved skills. No Skills mutation endpoint or decorative enable control.

## Code scope (integration overlap)
- New: `lib/skills-catalog.mjs`; `public/next/workspaces/skills.mjs`; `public/next/skills.css`.
- Narrow changes: `lib/codex.mjs` (read-only native discovery), `lib/conversation-autonomy.mjs` (export existing packaged content), `server.mjs` (two GET routes, asset allowlist), `public/next/app.mjs` and `public/next/index.html` (tab/navigation), `public/next/workspaces/knowledge.mjs` (open existing saved skill).
- Focused tests: `tests/skills-catalog.test.mjs`, `tests/codex-skill-inspection.test.mjs`, `tests/next-skills-workspace.test.mjs`, `tests/skills-knowledge-navigation.test.mjs`. Disposable HTTP/visual-acceptance fixture: `tests/fixtures/skills-rendered-harness.mjs`.
- Main Swarm merge overlap: `server.mjs` next asset allowlist and API routes, `public/next/app.mjs` module/navigation map, `public/next/index.html` nav button. Preserve Swarm's removal of Planning tab.

## Verifiable receipts
- **Focused tests + neighbors: TAP 32 / 0 / 0**, Windows Node 22, syntax of all edited runtime modules checked, no full suite: direct job `direct_9675460c26282d43c7ee845a82c86f0e6ca0f13b4e428aac254fff71ef114028`.
  Command: `node --test tests/skills-catalog.test.mjs tests/codex-skill-inspection.test.mjs tests/next-skills-workspace.test.mjs tests/skills-knowledge-navigation.test.mjs tests/next-knowledge-management.test.mjs tests/planning-required-skill.test.mjs`.
- **Disposable HTTP acceptance host** `http://127.0.0.1:64951/` verified HTML 200, workspace JavaScript 200 with `text/javascript`, CSS 200 with `text/css`, catalog 4 entries / Codex explicitly unavailable, `saved%3Arendered-skill` returned full content and updated revision 1→2 after a concurrent fixture-only write. Receipt `direct_fab3ea2522935789e3bf4ff3c2afc4f74fa986e88e23576fee952de73359231d`. This host was a **disposable fixture**, not the running BLACKICE server. Exact process PID 724 was stopped and verified absent; its initial long-lived shell launch job `direct_3d4c92aa66d5c4bab9929ee6cd6a33ee049f607b6fdf50a256473497d402272c` cancelled after dispatch but was reconciled; no orphan.
- **Live Electron rendered-interaction gap:** contained-browser `open` returned `BROWSER_TASK_TAB_LIMIT`, `actionDispatched:false`, with 8/8 existing shared task pages. Receipt `direct_ac712d5201a4176cb2133f5131ee398f6ef57ed6d9544d8b70f356d20a9de3f2`. None of the other owners' pages were suspended/navigated/closed. DOM-level interaction tests cover selection, sources, empty/error, reload, races and navigation, but **do not prove physical Electron rendering**.
- No native Codex discovery against a *live authenticated process*, no exact production-host end-to-end API/navigation acceptance, no production install, and no full-suite CI claims.

## Independent acceptance checklist
1. Merge/cherry-pick onto **current** remote main plus Swarm's independently accepted tab removal. Resolve overlapping nav/asset allowlist without changing unrelated work. Root owns release.
2. Validate actual running BLACKICE GET `/api/skills` + `/api/skills/saved%3A...` + JS MIME and negative unlisted sibling; verify error state when Codex offline.
3. Free a truly owned contained-browser slot **without disturbing other tasks**; render actual Skills tab and inspect sample built-in, saved and native entries, source content, user edit navigation, source filter, reload and empty/error. The disposable rendered harness is reproducible when a slot becomes available.
4. Verify live Codex discovery only if already connected; do not start a model worker. Run an integration CI/suite at root's single gate.
5. Skills-to-module promotion, module validity tests, SVG module, adversarial RSI and generalized planning UI changes remain separate future lanes.
