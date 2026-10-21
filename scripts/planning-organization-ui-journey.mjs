import assert from 'node:assert/strict';

/** Organization acceptance in the caller's disposable server/browser. No worker is launched. */
export async function planningOrganizationUIJourney({ api, app, runtime, report, taskId, cwd, cdp, session, origin, evaluate, until, waitVisible, click, fill, select, key, menu, closeModal, resize, screenshot, geometry, check }) {
  const suffix = Date.now().toString(36), groupName = `QA launch ${suffix}`, renamedGroup = `QA delivery ${suffix}`, planName = `QA named plan ${suffix}`;
  const evidence = report.recovery.planningOrganization = { fixtureOnly: true, taskId, turnsBefore: runtime.calls.length, projectIds: [] };
  const planning = async () => { await closeModal(); await resize(1440, 900); await click('#workspace-modes [data-mode="planning"]'); await waitVisible('#planning-outline'); };
  const catalogPlan = async (state = 'active') => (await api(`/api/planning?state=${state}&taskId=${encodeURIComponent(taskId)}`)).plans.find(plan => plan.taskId === taskId);
  const organization = async () => (await api('/api/planning')).organization;
  const saveOrganization = async () => { await click('#planning-organization-save'); await until('the organization editor to settle', () => evaluate(() => document.querySelector('#planning-organization').hidden)); };
  const projectSaved = async id => api(`/api/projects/${id}`);
  const saveProjectOrganization = async () => { await click('#project-organization-editor [type="submit"]'); await until('the Swarms organization editor to settle', () => evaluate(() => !document.querySelector('#project-organization-editor'))); };

  await planning();
  assert.equal(await evaluate(() => document.querySelector('#planning-state').value), 'active');
  assert.equal((await api('/api/planning')).state, 'active');
  await waitVisible(`[data-planning-task="${taskId}"]`); await click(`[data-planning-task="${taskId}"]`);
  await until('the exact plan to open for organization', () => evaluate(id => document.querySelector('#planning-plan-mount').dataset.planTask === id, taskId));
  await click('[data-planning-action="create-group"]'); await waitVisible('#planning-organization-form');
  await fill('[data-planning-organization-field="name"]', groupName); await saveOrganization();
  const group = await until('a durable named plan group', async () => (await organization()).groups.find(group => group.name === groupName)); evidence.groupId = group.id;
  check('Planning opens on active plans and creates a persistent named group through the real UI', Boolean(group.id));

  await click('#planning-task-bar [data-planning-action="objective"]'); await waitVisible('[data-planning-field="goal"]');
  const before = await api(`/api/tasks/${taskId}`), draftText = 'QA unsaved objective must survive renaming and moving the plan.';
  await fill('[data-planning-field="goal"]', draftText);
  await evaluate(() => { globalThis.__qaOrganizationDraft = document.querySelector('[data-planning-field="goal"]'); });
  await click('[data-planning-action="organize-plan"]'); await waitVisible('#planning-organization-form');
  await fill('[data-planning-organization-field="name"]', planName); await select('[data-planning-organization-field="groupId"]', group.id); await saveOrganization();
  const named = await until('the saved independent plan name and group', async () => { const plan = await catalogPlan(); return plan?.name === planName && plan.groupId === group.id && plan; });
  const after = await api(`/api/tasks/${taskId}`);
  assert.equal(after.revision, before.revision); assert.equal(after.goal, before.goal); assert.deepEqual(after.steps, before.steps);
  const preserved = await evaluate(({ id, groupId, title, draft }) => ({ sameField: document.querySelector('[data-planning-field="goal"]') === globalThis.__qaOrganizationDraft, draft: document.querySelector('[data-planning-field="goal"]').value === draft, nested: document.querySelector(`[data-planning-group="${groupId}"] [data-planning-task="${id}"]`)?.querySelector('strong')?.textContent === title }), { id: taskId, groupId: group.id, title: planName, draft: draftText });
  assert.ok(preserved.sameField && preserved.draft && preserved.nested); evidence.plan = { name: named.name, groupId: named.groupId, taskRevisionBefore: before.revision, taskRevisionAfter: after.revision, ...preserved };
  check('Renaming and moving a plan changes its group outline while preserving the exact unsaved step editor and executable revision');
  await click('[data-planning-action="discard"]');

  // The group row owns real keyboard tree navigation, independently of the
  // current editor's focus and selections.
  await evaluate(id => document.querySelector(`[data-planning-group="${id}"]`).focus(), group.id);
  await key('ArrowLeft', 'ArrowLeft', 37);
  assert.equal(await evaluate(id => document.querySelector(`[data-planning-group="${id}"]`).getAttribute('aria-expanded'), group.id), 'false');
  await key('ArrowRight', 'ArrowRight', 39); await key('ArrowDown', 'ArrowDown', 40);
  assert.equal(await evaluate(() => document.activeElement.dataset.planningTask), taskId);
  check('The grouped plan outline collapses, expands and enters its child plan with the arrow keys');
  await screenshot('51-planning-groups-desktop.jpg');

  // Archive is deliberately selected; reloading returns to active plans.
  await api(`/api/conversations/${taskId}/archive`, 'POST', {}); await click('[data-planning-action="refresh"]');
  await until('the archived plan to leave the active outline', () => evaluate(id => !document.querySelector(`#planning-outline [data-planning-task="${id}"]`), taskId));
  assert.equal(await catalogPlan(), undefined);
  await select('#planning-state', 'archived'); await waitVisible(`[data-planning-task="${taskId}"]`);
  assert.equal((await catalogPlan('archived')).name, planName);
  await cdp.call('Page.navigate', { url: origin }, session); await waitVisible('#workspace-modes'); await planning();
  await until('active-only Planning after reload', () => evaluate(id => document.querySelector('#planning-state').value === 'active' && !document.querySelector(`#planning-outline [data-planning-task="${id}"]`) && !/Updating/.test(document.querySelector('#planning-catalog-status').textContent), taskId));
  check('Archived plans appear only in the explicit Archive view and a fresh Planning load defaults to active plans');
  await api(`/api/conversations/${taskId}/restore`, 'POST', {}); await click('[data-planning-action="refresh"]');
  const restored = await until('the restored plan in the active catalog with its saved name and group', async () => { const value = await catalogPlan(); return value?.name === planName && value.groupId === group.id && value; });
  await until('the restored plan attached to its named outline group', () => evaluate(({ id, groupId }) => Boolean(document.querySelector(`[data-planning-group="${groupId}"] [data-planning-task="${id}"]`)), { id: taskId, groupId: group.id }));
  // The group was empty when the fresh active view opened and can remain
  // collapsed when its plan returns. Open that real tree disclosure first.
  if (await evaluate(id => document.querySelector(`[data-planning-group="${id}"]`).getAttribute('aria-expanded') === 'false', group.id)) await click(`[data-planning-group="${group.id}"] > .planning-outline-group-label`);
  await waitVisible(`[data-planning-task="${taskId}"]`);
  assert.equal(restored.name, planName); assert.equal(restored.groupId, group.id);
  check('Plan names and group membership survive a real page reload and an archive/restore cycle');

  await resize(320, 844); await click('.planning-mobile-tabs button[data-planning-pane="saved"]'); await waitVisible('#planning-search');
  assert.ok(await geometry('320px named Planning outline')); await click('[data-planning-action="create-group"]'); await waitVisible('#planning-organization-form');
  const narrow = await evaluate(() => { const node = document.querySelector('[data-planning-organization-field="name"]'), box = node.getBoundingClientRect(); return { width: innerWidth, left: box.left, right: box.right, fieldWidth: box.width }; });
  assert.ok(narrow.left >= -1 && narrow.right <= narrow.width + 1 && narrow.fieldWidth > 100);
  await screenshot('52-planning-groups-320.jpg'); await click('[data-planning-action="cancel-organization"]'); await resize(1440, 900);
  check('The plan outline and group editor remain usable at 320px without horizontal overflow');

  const project = await api('/api/projects', 'POST', { name: `QA swarm outline ${suffix}`, objective: 'Inspect an owned saved project structure without running agents.', cwd, tasks: [
    { id: 'publish', title: 'Publish the checked draft', instructions: 'Keep this as an unexecuted local fixture.', dependsOn: ['review'], acceptanceCriteria: ['The checked draft is available.'] },
    { id: 'draft', title: 'Prepare the draft', instructions: 'Keep this as an unexecuted local fixture.', acceptanceCriteria: ['The intended draft is prepared.'] },
    { id: 'review', title: 'Review the draft', instructions: 'Keep this as an unexecuted local fixture.', dependsOn: ['draft'], acceptanceCriteria: ['The actual draft has been reviewed.'] }
  ] });
  evidence.projectIds.push(project.id);
  await menu('projects'); await waitVisible('#projects-workspace'); await waitVisible(`[data-project="select"][data-id="${project.id}"]`); await click(`[data-project="select"][data-id="${project.id}"]`);
  assert.equal(await evaluate(() => document.querySelector('[data-project="history"][data-id="active"]').getAttribute('aria-pressed')), 'true');
  const taskOrder = await evaluate(() => [...document.querySelectorAll('.project-task-outline > li > [data-project-task]')].map(node => node.dataset.projectTask));
  assert.deepEqual(taskOrder, ['draft', 'review', 'publish']);
  assert.equal(await evaluate(() => document.querySelectorAll('[data-project-task]').length), 3);
  await click('[data-project="expand-tasks"]');
  const prerequisites = await evaluate(() => [...document.querySelectorAll('.project-outline-dependencies')].map(node => node.textContent));
  assert.ok(prerequisites.some(text => text.includes('Prepare the draft')) && prerequisites.some(text => text.includes('Review the draft')));
  check('Swarms defaults to active plans and renders each task once in dependency order with explicit prerequisite links');

  const newProjectName = `QA renamed swarm ${suffix}`;
  await click(`[data-project="rename-plan"][data-id="${project.id}"]`); await waitVisible('#project-organization-editor'); await fill('#project-organization-editor [name="name"]', newProjectName); await saveProjectOrganization();
  const renamed = await until('the saved Swarms name', async () => { const value = await projectSaved(project.id); return value.name === newProjectName && value; });
  assert.deepEqual(renamed.tasks, project.tasks);
  await click(`[data-project="move-plan"][data-id="${project.id}"]`); await waitVisible('#project-organization-editor'); await select('#project-organization-editor [name="groupId"]', group.id); await saveProjectOrganization();
  await until('the Swarms plan in the shared group', () => evaluate(({ id, groupId }) => Boolean(document.querySelector(`[data-project-group="${groupId}"] [data-project="select"][data-id="${id}"]`)), { id: project.id, groupId: group.id }));
  assert.equal((await projectSaved(project.id)).groupId, group.id);
  check('A saved Swarms plan can be renamed and moved into the same named groups without changing its tasks or starting workers');
  await click(`[data-project="rename-group"][data-id="${group.id}"]`); await waitVisible('#project-organization-editor'); await fill('#project-organization-editor [name="name"]', renamedGroup); await saveProjectOrganization();
  assert.equal((await catalogPlan()).groupName, renamedGroup);
  check('Renaming a group in Swarms updates that same group in Planning');
  await screenshot('53-swarms-group-outline-desktop.jpg');

  await click(`[data-project="archive-plan"][data-id="${project.id}"]`);
  await until('the archived Swarms plan to leave active plans', () => evaluate(id => !document.querySelector(`[data-project="select"][data-id="${id}"]`), project.id));
  assert.equal((await projectSaved(project.id)).archived, true);
  await click('[data-project="history"][data-id="archived"]'); await waitVisible(`[data-project="select"][data-id="${project.id}"]`); await click(`[data-project="select"][data-id="${project.id}"]`);
  await click(`[data-project="restore-plan"][data-id="${project.id}"]`);
  await until('the restored Swarms plan to be active', async () => (await projectSaved(project.id)).archived === false);
  await until('the restored Swarms plan in the active outline', () => evaluate(id => document.querySelector('[data-project="history"][data-id="active"]')?.getAttribute('aria-pressed') === 'true' && Boolean(document.querySelector(`[data-project="select"][data-id="${id}"]`)) && document.querySelector(`[data-project="archive-plan"][data-id="${id}"]`)?.disabled === false, project.id));
  check('Swarms Archive is explicit, preserves the saved plan, and Restore returns it to active plans');

  await resize(320, 844); assert.ok(await geometry('320px grouped Swarms outline')); await screenshot('54-swarms-group-outline-320.jpg');
  const widths = await evaluate(() => [...document.querySelectorAll('.project-list,.project-main,.project-task-outline')].map(node => ({ client: node.clientWidth, scroll: node.scrollWidth })));
  assert.ok(widths.length === 3 && widths.every(item => item.scroll <= item.client + 2));
  check('The grouped Swarms plan and task outline fit the 320px viewport');
  await planning();
  await waitVisible(`[data-planning-group="${group.id}"]`); await click(`[data-planning-group="${group.id}"] > .planning-outline-group-label`);
  await click('[data-planning-action="remove-group"]'); await waitVisible('#planning-organization-form'); await saveOrganization();
  await until('the named plan rendered under Ungrouped after group removal', () => evaluate(id => Boolean(document.querySelector(`[data-planning-group="ungrouped"] [data-planning-task="${id}"]`)), taskId));
  assert.equal((await catalogPlan()).groupId, null); assert.equal((await catalogPlan()).name, planName);
  const ungrouped = await projectSaved(project.id); assert.equal(ungrouped.groupId, null); assert.equal(ungrouped.name, newProjectName); assert.deepEqual(ungrouped.tasks, project.tasks);
  assert.equal((await api(`/api/tasks/${taskId}`)).revision, before.revision);
  check('Removing a group keeps both chat and Swarms plans, names and work intact and moves them to Ungrouped');
  evidence.turnsAfter = runtime.calls.length; evidence.projectStatus = ungrouped.status; evidence.taskOrder = taskOrder; evidence.mobile = { planning: narrow, swarms: widths };
  assert.equal(evidence.turnsAfter, evidence.turnsBefore); assert.equal(ungrouped.status, 'draft'); assert.ok(ungrouped.tasks.every(task => task.attempts.length === 0));
  check('Organization acceptance dispatches no model or worker turn');
  report.features.planningOrganization = true; report.features.swarmOutline = true;
  await click('#workspace-modes [data-mode="view"]');
}
