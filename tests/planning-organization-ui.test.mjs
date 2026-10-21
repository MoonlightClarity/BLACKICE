import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskStateStore } from '../lib/task-state.mjs';
import { PlanningOrganizationStore } from '../lib/planning-organization.mjs';
import { planningQuery, listPlanningWorkspace, editPlanningOrganization } from '../lib/planning-workspace.mjs';
import { initPlanningWorkspaceUI } from '../public/planning-workspace-ui.mjs';
import { planningCatalogOutline } from '../public/planning-workspace-model.mjs';
import { planningDOM } from './fixture-planning-dom.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function fixture(t, { width = 1440 } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-plan-organization-ui-')), cwd = path.join(directory, 'workspace'); await mkdir(cwd);
  const tasks = await new TaskStateStore({ dataDir: directory }).init(), planningOrganization = await new PlanningOrganizationStore({ dataDir: directory }).init();
  const metadata = new Map(), calls = [], timers = new Map(); let timerId = 0, hook;
  for (const [taskId, state] of [['task-a', 'active'], ['task-b', 'active'], ['task-archived', 'archived'], ['task-deleted', 'deleted']]) {
    const task = await tasks.ensure({ taskId, runId: `run-${taskId}`, cwd, goal: `Objective for ${taskId}`, defaultPlan: true });
    await tasks.setPlan(taskId, { plan: { layout: 'sequence' }, steps: [{ id: 'inspect', title: 'Inspect input', kind: 'action', status: 'pending', parentId: null, dependsOn: [], doneWhen: 'The input is read and its constraints recorded.' }] }, { expectedRevision: task.revision, runId: `run-${taskId}`, nodeId: 'agent', schemaVersion: 4 });
    metadata.set(taskId, { id: `run-${taskId}`, taskId, title: `Chat title for ${taskId}`, latestRunId: `run-${taskId}`, state, status: 'completed', updatedAt: new Date().toISOString() });
  }
  await planningOrganization.edit({ expectedRevision: 0, operations: [{ type: 'create_group', id: 'launch', name: 'Launch' }, { type: 'create_group', id: 'research', name: 'Research' }, { type: 'update_plan', taskId: 'task-a', name: 'Release checklist', groupId: 'launch' }, { type: 'update_plan', taskId: 'task-archived', name: 'Earlier release', groupId: 'launch' }] });
  const context = { tasks, planningOrganization, conversations: { list: () => [...metadata.values()], status: () => ({ healthy: true }) }, engine: { listRuns: () => [], runs: new Map() } };
  const request = async (url, method = 'GET', body) => {
    if (url.startsWith('/api/planning?')) return listPlanningWorkspace(context, planningQuery(new URL(url, 'http://fixture').searchParams));
    if (url === '/api/planning/organization' && method === 'POST') return editPlanningOrganization(context, body);
    const match = url.match(/^\/api\/tasks\/([^/]+)$/); assert.ok(match, url); assert.equal(method, 'GET'); return tasks.get(match[1]);
  };
  const api = async (url, options = 'GET', body) => {
    const method = typeof options === 'object' ? options.method || 'GET' : options; calls.push({ url, method, body: body ? structuredClone(body) : undefined });
    if (hook) { const value = await hook(url, method, body, options); if (value !== undefined) return value; }
    return request(url, method, body);
  };
  let workspace;
  t.after(async () => { workspace?.destroy(); await tasks.close(); await planningOrganization.close(); await rm(directory, { recursive: true, force: true }); });
  const dom = planningDOM(t, { width, normalizeMarkup: true });
  workspace = initPlanningWorkspaceUI({ mount: dom.mount, api, controllerOptions: { pollMs: 0, awarenessEnabled: false, createGroupId: () => 'new-group', setTimer: fn => { const id = ++timerId; timers.set(id, fn); return id; }, clearTimer: id => timers.delete(id) } });
  await workspace.enter({ taskId: 'task-a' });
  return { workspace, controller: workspace.controller, dom, calls, metadata, tasks, planningOrganization, context, request, hook(value) { hook = value; }, writes: () => calls.filter(call => call.method === 'POST'), async mutate(operations) { return planningOrganization.edit({ expectedRevision: (await planningOrganization.get()).revision, operations }); } };
}

test('Planning starts with active plans and nests actual plan rows under named groups', async t => {
  const f = await fixture(t);
  assert.equal(f.controller.state.bucket, 'active'); assert.equal(new URL(f.calls[0].url, 'http://fixture').searchParams.get('state'), 'active');
  assert.equal(f.dom.$('#planning-state').value, 'active');
  assert.equal(f.dom.$('[data-planning-task="task-archived"]'), null);
  const row = f.dom.$('[data-planning-task="task-a"]'), group = f.dom.$('[data-planning-group="launch"]');
  assert.equal(row.closest('[data-planning-group]'), group); assert.equal(row.getAttribute('aria-level'), '2'); assert.equal(group.getAttribute('aria-level'), '1'); assert.equal(group.getAttribute('aria-expanded'), 'true');
  assert.equal(row.querySelector('strong').textContent, 'Release checklist'); assert.equal(f.dom.$('#planning-outline').getAttribute('role'), 'tree');
  await f.dom.input('#planning-state', 'archived'); await f.controller.loadCatalog();
  assert.equal(f.dom.$('[data-planning-task="task-a"]'), null); assert.ok(f.dom.$('[data-planning-task="task-archived"]')); assert.match(f.dom.$('#planning-catalog-status').textContent, /1 archived plan/);
});

test('the outline has roving keyboard focus, collapsible groups and F2 naming', async t => {
  const f = await fixture(t), launch = f.dom.$('[data-planning-group="launch"]'), leaf = f.dom.$('[data-planning-task="task-a"]');
  launch.focus(); await f.dom.key(launch, 'ArrowLeft');
  assert.equal(launch.getAttribute('aria-expanded'), 'false'); assert.equal(launch.querySelector('[role="group"]').hidden, true);
  await f.dom.key(launch, 'ArrowDown'); assert.equal(document.activeElement.dataset.planningGroup, 'research');
  await f.dom.key(document.activeElement, 'Home'); assert.equal(document.activeElement, launch);
  await f.dom.key(launch, 'ArrowRight'); await f.dom.key(launch, 'ArrowRight'); assert.equal(document.activeElement, leaf);
  await f.dom.key(leaf, 'ArrowLeft'); assert.equal(document.activeElement, launch);
  await f.dom.key(launch, 'F2'); assert.equal(f.controller.state.organizationDraft.mode, 'rename-group'); assert.equal(document.activeElement.dataset.planningOrganizationField, 'name');
  await f.dom.key(document.activeElement, 'Escape'); assert.equal(f.controller.state.organizationDraft, null); assert.equal(document.activeElement, launch);
  await f.dom.key(leaf, 'F2'); assert.equal(f.controller.state.organizationDraft.taskId, 'task-a');
  const focusable = [...f.dom.$('#planning-outline').querySelectorAll('[data-planning-outline]')].filter(node => node.tabIndex === 0); assert.equal(focusable.length, 1);
});

for (const width of [1440, 320]) test(`cursor navigation stays in Planning text fields at ${width}px while pane tabs retain navigation`, async t => {
  const f = await fixture(t, { width });
  const editWithoutPaneNavigation = async (selector, value) => {
    const field = await f.dom.input(selector, value), pane = f.controller.state.pane;
    field.focus(); field.setSelectionRange(2, 6, 'backward');
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
      const event = await f.dom.key(field, key);
      assert.equal(event.defaultPrevented, false, `${selector}: ${key} must remain available to the native text control.`);
      assert.equal(document.activeElement, field); assert.equal(f.controller.state.pane, pane);
      assert.equal(f.dom.$(selector), field); assert.equal(field.value, value);
    }
  };
  f.controller.setPane('edit');
  await editWithoutPaneNavigation('[data-planning-field="goal"]', 'Keep the objective draft while moving the caret');
  f.controller.selectEditor('inspect');
  await editWithoutPaneNavigation('[data-planning-field="title"]', 'Keep this unfinished step');
  await f.dom.click('[data-planning-action="organize-plan"]');
  await editWithoutPaneNavigation('[data-planning-organization-field="name"]', 'Keep this custom plan name');
  await editWithoutPaneNavigation('#planning-search', 'Release');
  assert.equal(f.writes().length, 0);
  if (width > 1050) return;
  f.controller.setPane('plan');
  f.dom.$('.planning-mobile-tabs button[data-planning-pane="plan"]').focus();
  for (const [key, pane] of [['ArrowRight', 'edit'], ['End', 'saved'], ['Home', 'plan'], ['ArrowLeft', 'saved']]) {
    const event = await f.dom.key(document.activeElement, key);
    assert.equal(event.defaultPrevented, true); assert.equal(f.controller.state.pane, pane);
    assert.equal(document.activeElement, f.dom.$(`.planning-mobile-tabs button[data-planning-pane="${pane}"]`));
    assert.equal(document.activeElement.getAttribute('aria-selected'), 'true');
  }
});

test('renaming and moving a plan changes only organization while retaining its step draft and row identity', async t => {
  const f = await fixture(t); f.controller.selectEditor('inspect');
  const input = await f.dom.input('[data-planning-field="title"]', 'My unfinished step'); input.focus(); input.setSelectionRange(3, 9, 'backward');
  const draft = f.controller.draft(), saved = await f.tasks.get('task-a'), row = f.dom.$('[data-planning-task="task-a"]');
  await f.dom.click('[data-planning-action="organize-plan"]');
  await f.dom.input('[data-planning-organization-field="name"]', 'Release readiness'); await f.dom.input('[data-planning-organization-field="groupId"]', 'research');
  assert.equal(await f.controller.saveOrganization(), true);
  assert.deepEqual(f.writes()[0].body.operations, [{ type: 'update_plan', taskId: 'task-a', name: 'Release readiness', groupId: 'research' }]);
  assert.deepEqual(await f.tasks.get('task-a'), saved); assert.equal(f.controller.draft(), draft); assert.equal(draft.values.title, 'My unfinished step');
  assert.equal(f.dom.$('[data-planning-field="title"]'), input); assert.equal(input.selectionStart, 3); assert.equal(input.selectionEnd, 9);
  assert.equal(f.dom.$('[data-planning-task="task-a"]'), row); assert.equal(row.closest('[data-planning-group]').dataset.planningGroup, 'research');
  assert.equal(row.closest('[data-planning-group]').getAttribute('aria-expanded'), 'true'); assert.equal(row.querySelector('strong').textContent, 'Release readiness');
  assert.match(f.dom.$('.planning-document-identity').textContent, /ResearchRelease readiness/);
  assert.equal(f.calls.some(call => call.url.endsWith('/plan/edit')), false);
});

test('group creation, rename and removal persist while assigned plans remain saved', async t => {
  const f = await fixture(t), before = await f.tasks.get('task-a');
  await f.dom.click('[data-planning-action="create-group"]'); await f.dom.input('[data-planning-organization-field="name"]', '  Customer work  '); assert.equal(await f.controller.saveOrganization(), true);
  assert.ok((await f.planningOrganization.get()).groups.some(group => group.id === 'new-group' && group.name === 'Customer work'));
  assert.ok(f.dom.$('[data-planning-group="new-group"]'));
  f.controller.startOrganization('rename-group', { groupId: 'new-group' }); f.controller.editOrganization('name', 'Delivery'); assert.equal(await f.controller.saveOrganization(), true);
  f.controller.startOrganization('plan'); f.controller.editOrganization('groupId', 'new-group'); assert.equal(await f.controller.saveOrganization(), true);
  f.controller.startOrganization('remove-group', { groupId: 'new-group' }); assert.match(f.dom.$('#planning-organization-fields').textContent, /plans and Swarms.*Ungrouped/); assert.equal(await f.controller.saveOrganization(), true);
  const saved = await f.planningOrganization.get(); assert.equal(saved.groups.some(group => group.id === 'new-group'), false); assert.equal(saved.plans.find(plan => plan.taskId === 'task-a').groupId, null);
  assert.equal(f.dom.$('[data-planning-task="task-a"]').closest('[data-planning-group]').dataset.planningGroup, 'ungrouped'); assert.deepEqual(await f.tasks.get('task-a'), before);
});

test('clearing a custom plan name restores the chat title without rewriting its objective', async t => {
  const f = await fixture(t), task = await f.tasks.get('task-a');
  f.controller.startOrganization('plan'); f.controller.editOrganization('name', ''); assert.equal(await f.controller.saveOrganization(), true);
  assert.deepEqual(f.writes()[0].body.operations, [{ type: 'update_plan', taskId: 'task-a', name: null }]);
  assert.equal(f.dom.$('[data-planning-task="task-a"] strong').textContent, 'Chat title for task-a'); assert.deepEqual(await f.tasks.get('task-a'), task);
});

test('group and title search filters compose with active history and preserve the open step draft', async t => {
  const f = await fixture(t); f.controller.edit('goal', 'Keep my objective draft');
  await f.dom.input('#planning-group-filter', 'launch'); await f.dom.input('#planning-search', 'Release checklist'); await f.controller.loadCatalog();
  const request = new URL(f.calls.filter(call => call.url.startsWith('/api/planning?')).at(-1).url, 'http://fixture').searchParams;
  assert.equal(request.get('state'), 'active'); assert.equal(request.get('groupId'), 'launch'); assert.equal(request.get('query'), 'Release checklist');
  assert.deepEqual(f.controller.state.plans.map(plan => plan.taskId), ['task-a']); assert.equal(f.controller.draft().values.goal, 'Keep my objective draft');
  assert.deepEqual(planningCatalogOutline(f.controller.state.plans, f.controller.state.organization, f.controller.state).map(group => group.id), ['launch']);
});

test('organization conflicts keep edits and review the exact plan outside the filtered catalog before retry', async t => {
  const f = await fixture(t); f.controller.setFilter({ groupId: 'launch' }); await f.controller.loadCatalog();
  f.controller.startOrganization('plan'); f.controller.editOrganization('name', 'My intended name');
  await f.mutate([{ type: 'update_plan', taskId: 'task-a', name: 'Another name', groupId: 'research' }]);
  assert.equal(await f.controller.saveOrganization(), false); assert.equal(f.controller.state.organizationDraft.conflict, true); assert.equal(f.controller.state.organizationDraft.values.name, 'My intended name');
  assert.equal(f.controller.state.plans.length, 0); assert.equal(await f.controller.saveOrganization(), false); assert.equal(f.writes().length, 1);
  assert.equal(await f.controller.reviewOrganization(), true); assert.deepEqual(f.controller.state.organizationDraft.review.values, { name: 'Another name', groupId: 'research' });
  const read = f.calls.find(call => call.url.includes('taskId=task-a')); assert.ok(read); assert.equal(new URL(read.url, 'http://fixture').searchParams.get('groupId'), null);
  assert.equal(f.controller.applyReviewedOrganization(), true); assert.equal(await f.controller.saveOrganization(), true);
  const saved = (await f.planningOrganization.get()).plans.find(plan => plan.taskId === 'task-a');
  assert.equal(saved.name, 'My intended name'); assert.equal(saved.groupId, 'research'); assert.equal(f.writes().length, 2);
  assert.deepEqual(f.writes()[1].body.operations, [{ type: 'update_plan', taskId: 'task-a', name: 'My intended name' }]);
});

test('an uncertain group creation is reviewed by its stable ID and never creates a duplicate', async t => {
  const f = await fixture(t); f.controller.startOrganization('create-group'); f.controller.editOrganization('name', 'One group');
  f.hook(async (url, method, body) => { if (method !== 'POST') return; await f.request(url, method, body); throw Object.assign(new Error('The reply was lost.'), { uncertain: true }); });
  assert.equal(await f.controller.saveOrganization(), false); assert.equal(f.controller.state.organizationDraft.uncertain, true); assert.equal(f.writes().length, 1);
  assert.equal(await f.controller.saveOrganization(), false); f.hook(null);
  assert.equal(await f.controller.reviewOrganization(), true); assert.equal(f.controller.applyReviewedOrganization(), true); assert.equal(await f.controller.saveOrganization(), true);
  assert.equal(f.writes().length, 1); assert.equal((await f.planningOrganization.get()).groups.filter(group => group.name === 'One group').length, 1);
});

test('opening cached metadata outside the catalog requires a current read before it can overwrite organization', async t => {
  const f = await fixture(t); f.controller.setFilter({ groupId: 'ungrouped' }); await f.controller.loadCatalog();
  await f.mutate([{ type: 'update_plan', taskId: 'task-a', name: 'A newer saved name' }]); await f.controller.loadCatalog();
  assert.equal(f.controller.state.plans.some(plan => plan.taskId === 'task-a'), false);
  assert.equal(f.controller.startOrganization('plan'), true); f.controller.editOrganization('groupId', 'research');
  assert.equal(await f.controller.saveOrganization(), false); assert.equal(f.writes().length, 0);
  assert.equal(await f.controller.reviewOrganization(), true); assert.equal(f.controller.applyReviewedOrganization(), true); assert.equal(await f.controller.saveOrganization(), true);
  assert.deepEqual(f.writes()[0].body.operations, [{ type: 'update_plan', taskId: 'task-a', groupId: 'research' }]);
  assert.equal((await f.planningOrganization.get()).plans.find(plan => plan.taskId === 'task-a').name, 'A newer saved name');
});

test('organization form focus and its pressed Save survive input blur, polling and an agent step revision', async t => {
  const f = await fixture(t); await f.dom.click('[data-planning-action="organize-plan"]');
  const input = await f.dom.input('[data-planning-organization-field="name"]', 'A name in progress'); input.focus(); input.setSelectionRange(2, 7, 'backward');
  const save = f.dom.$('#planning-organization-save'); await input.dispatch('change', {}, true); await f.controller.refresh();
  assert.equal(f.dom.$('#planning-organization-save'), save); assert.equal(f.dom.$('[data-planning-organization-field="name"]'), input); assert.equal(document.activeElement, input);
  const task = await f.tasks.get('task-a'), updated = await f.tasks.setStep('task-a', 'inspect', { note: 'Agent observation' }, { expectedRevision: task.revision, runId: 'run-task-a', nodeId: 'agent', schemaVersion: 4 });
  f.workspace.handleEvent({ type: 'task.state', data: updated });
  assert.equal(f.dom.$('[data-planning-organization-field="name"]'), input); assert.equal(input.value, 'A name in progress'); assert.equal(input.selectionStart, 2); assert.equal(input.selectionEnd, 7);
  assert.equal(f.controller.state.organizationDraft.revision, 1); assert.equal(f.controller.state.organizationDraft.conflict, false);
});

test('unavailable organization disables naming while the readable saved plans and drafts remain available', async t => {
  const f = await fixture(t); f.controller.edit('goal', 'Keep this draft');
  f.hook(async (url, method, body) => { if (!url.startsWith('/api/planning?')) return; const result = await f.request(url, method, body); return { ...result, healthy: false, organization: { revision: null, groups: [], healthy: false } }; });
  await f.controller.loadCatalog();
  assert.equal(f.controller.state.plans.length, 2); assert.equal(f.controller.state.organization.revision, null); assert.equal(f.dom.$('[data-planning-action="create-group"]').disabled, true);
  assert.equal(f.controller.startOrganization('plan'), false); assert.equal(f.controller.draft().values.goal, 'Keep this draft'); assert.ok(f.dom.$('[data-planning-task="task-a"]'));
});

test('a delayed organization review cannot replace a newer form after navigation', async t => {
  const f = await fixture(t), pending = deferred(); f.controller.startOrganization('plan'); f.controller.editOrganization('name', 'Prior plan draft');
  const snapshot = await f.request('/api/planning?state=all&taskId=task-a&limit=1');
  f.hook(url => url.includes('taskId=task-a') ? pending.promise : undefined);
  const reading = f.controller.reviewOrganization(); await turn(); f.controller.cancelOrganization(); f.controller.startOrganization('rename-group', { groupId: 'research' }); f.controller.editOrganization('name', 'Current group draft');
  pending.resolve(snapshot); assert.equal(await reading, false); assert.equal(f.controller.state.organizationDraft.mode, 'rename-group'); assert.equal(f.controller.state.organizationDraft.values.name, 'Current group draft'); assert.equal(f.controller.state.organizationDraft.review, null);
});

test('mobile naming opens the visible outline pane and Escape returns to an accessible plan row', async t => {
  const f = await fixture(t, { width: 390 }); await f.dom.click('[data-planning-action="organize-plan"]');
  assert.equal(f.dom.$('#planning-saved-panel').hidden, false); assert.equal(f.dom.$('#planning-board-panel').hidden, true); assert.equal(document.activeElement.dataset.planningOrganizationField, 'name');
  await f.dom.key(document.activeElement, 'Escape');
  assert.equal(f.dom.$('#planning-organization').hidden, true); assert.equal(document.activeElement.dataset.planningTask, 'task-a'); assert.equal(f.dom.$('#planning-saved-panel').hidden, false);
});
