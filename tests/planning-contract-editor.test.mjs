import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskStateStore, TASK_TOOL, TASK_TOOL_V13 } from '../lib/task-state.mjs';
import { ChatGPTPlanningAPI } from '../lib/chatgpt-planning.mjs';
import { RemoteAgentAPI, validRemoteArguments } from '../lib/remote-agent-api.mjs';
import { editPlanningWorkspace, listPlanningWorkspace } from '../lib/planning-workspace.mjs';
import { normalizePlanContract } from '../public/planning-contract-model.mjs';
import { createPlanningWorkspaceController, planningContractIntent, planningDraftValues, planningEditOperations, mergePlanningContractDraft, newPlanningContractWorkItem, removePlanningContractWorkItem } from '../public/planning-workspace-model.mjs';
import { initPlanningWorkspaceUI, renderPlanningContractFields } from '../public/planning-workspace-ui.mjs';
import { createPlanningDraft, planningDraftOperations, acceptPlanningSnapshot, rebasePlanningDraft, commitPlanningDraft, planningDraftDirty } from '../public/next/workspaces/planning-visual.mjs';
import { planningDOM } from './fixture-planning-dom.mjs';

const client = { id: 'editor-fixture', label: 'Shared editor', kind: 'agent', scopes: ['read', 'planning:write'] };
const actor = { type: 'human-client', id: 'editor-fixture', name: 'Human editor' };
function contract() {
  return normalizePlanContract({ contractVersion: 2, goal: 'Inspect the supplied sources and verify the saved outcome.',
    criteria: [{ id: 'checked', kind: 'observation', description: 'The supplied source was inspected.' },
      { id: 'confirmed', kind: 'external-confirmation', description: 'The destination confirms the requested result.', resourceKey: 'browser:https://example.test/receipt',
        receiptBinding: { version: 1, format: 'json', resourceKey: 'browser:https://example.test/receipt', record: 'receipt', status: 'status', confirmedValues: ['confirmed'], outcomeId: 'id', history: false } }],
    workItems: [{ id: 'inspect', title: 'Inspect source', objective: 'Read the supplied source.', owner: 'coordinator', resourceKeys: ['workspace:fixture'], effects: ['observe'], dependsOn: [], criterionIds: ['checked'] },
      { id: 'verify', title: 'Verify result', objective: 'Inspect the destination receipt.', owner: 'coordinator', resourceKeys: ['browser:https://example.test/receipt'], effects: ['observe'], dependsOn: ['inspect'], criterionIds: ['confirmed'] }],
    instructions: [{ id: 'retain', text: 'Preserve the supplied source.', handling: 'preserve' }] });
}
const state = (revision = 2) => ({ taskId: 'canonical', taskSchemaVersion: 14, revision, goal: contract().goal, steps: [], contract: { ...contract(), planEpoch: 1 } });
const draft = (task, stepId = null) => ({ mode: stepId ? 'step' : 'goal', stepId, original: planningDraftValues(task, stepId), values: planningDraftValues(task, stepId) });
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-contract-editor-'));
  const tasks = await new TaskStateStore({ dataDir: directory }).init(), events = [], history = [];
  const engine = { runs: new Map(), defaultCwd: directory, listRuns: () => [],
    startRun: () => { throw Error('An editor must not start a model.'); }, continueRun: () => { throw Error('An editor must not resume a model.'); },
    adoptTaskState: () => { throw Error('This fixture has no running worker.'); } };
  const context = { tasks, engine, conversations: { list: () => structuredClone(history), status: () => ({ healthy: true }) }, defaultCwd: directory, onUpdated: event => events.push(event) };
  const empty = await tasks.ensure({ taskId: 'canonical', runId: 'run-canonical', nodeId: 'agent', cwd: directory, goal: 'Initial objective', schemaVersion: 14 });
  await tasks.setContract(empty.taskId, contract(), { expectedRevision: empty.revision, source: 'human', actor, schemaVersion: 14 });
  history.push({ id: 'run-canonical', taskId: 'canonical', title: 'Canonical plan', state: 'active', status: 'completed' });
  t.after(async () => { await tasks.close(); await rm(directory, { recursive: true, force: true }); });
  return { ...context, events, history, api: new ChatGPTPlanningAPI(context), remote: new RemoteAgentAPI(context) };
}

test('shared editors save canonical intent with revision protection and preserve bound receipt semantics', async t => {
  const f = await fixture(t), before = await f.tasks.get('canonical'), next = planningContractIntent(before); next.workItems[0].objective = 'Read the supplied source and record relevant observations.';
  const saved = await f.api.call('blackice_edit_plan', { taskId: before.taskId, expectedRevision: before.revision, operations: [{ type: 'replace_contract', contract: next }] }, client);
  assert.equal(saved.revision, before.revision + 1); assert.equal(saved.contract.planEpoch, before.contract.planEpoch + 1);
  assert.deepEqual(saved.contract.criteria, before.contract.criteria); assert.deepEqual(saved.contract.instructions, before.contract.instructions);
  assert.deepEqual(saved.contract.workItems[1], before.contract.workItems[1]); assert.equal(saved.steps.length, 0);
  assert.equal(saved.provenance.actor.id, client.id); assert.equal(f.engine.runs.size, 0); assert.equal(f.events.length, 1);
  const read = await f.remote.call('blackice_get_task', { taskId: before.taskId }, client);
  assert.equal(read.planningContract.taskSchemaVersion, 14); assert.equal(read.planningContract.edit.operation, 'replace_contract');
  await assert.rejects(f.api.call('blackice_edit_plan', { taskId: before.taskId, expectedRevision: before.revision, operations: [{ type: 'replace_contract', contract: next }] }, client), error => error.code === 'TASK_STATE_CONFLICT' && error.currentRevision === saved.revision);
  assert.equal((await f.tasks.get(before.taskId)).revision, saved.revision);
});

test('remote schemas preserve version 13 graph edits and add strict canonical replacement without mutating native catalogs', async t => {
  const f = await fixture(t), native = JSON.stringify(TASK_TOOL), legacy = JSON.stringify(TASK_TOOL_V13), args = { taskId: 'canonical', expectedRevision: 2, operations: [{ type: 'replace_contract', contract: contract() }] };
  for (const api of [f.api, f.remote]) {
    const schema = api.tools(client).find(tool => tool.name === 'blackice_edit_plan').inputSchema;
    assert.equal(validRemoteArguments(args, schema), true);
    assert.equal(validRemoteArguments({ ...args, operations: [{ type: 'metadata', patch: { goal: 'An older graph objective' } }] }, schema), true);
    assert.equal(validRemoteArguments({ ...args, operations: [{ type: 'replace_contract', contract: { ...contract(), planEpoch: 12 } }] }, schema), false);
    assert.equal(validRemoteArguments({ ...args, operations: [{ type: 'replace_contract', contract: { ...contract(), outcomes: [{ satisfied: true }] } }] }, schema), false);
  }
  assert.equal(JSON.stringify(TASK_TOOL), native); assert.equal(JSON.stringify(TASK_TOOL_V13), legacy);
  const legacyState = await f.tasks.ensure({ taskId: 'legacy', runId: 'run-legacy', cwd: f.defaultCwd, goal: 'Older saved objective', schemaVersion: 13 });
  await f.tasks.setPlan('legacy', { steps: [{ id: 'legacy-step', title: 'Read source', kind: 'action', parentId: null, doneWhen: 'Source has been read.', dependsOn: [] }] }, { expectedRevision: legacyState.revision, runId: 'run-legacy', nodeId: 'agent', schemaVersion: 4 });
  f.history.push({ id: 'run-legacy', taskId: 'legacy', state: 'active', status: 'completed' });
  const current = await f.tasks.get('legacy');
  const edited = await f.remote.call('blackice_edit_plan', { taskId: 'legacy', expectedRevision: current.revision, operations: [{ type: 'metadata', patch: { goal: 'Revised older saved objective' } }] }, client);
  assert.equal(edited.goal, 'Revised older saved objective'); assert.equal(edited.steps[0].id, 'legacy-step'); assert.equal(edited.contract, undefined);
  await assert.rejects(editPlanningWorkspace(f, 'legacy', { expectedRevision: edited.revision, operations: [{ type: 'replace_contract', contract: contract() }] }), { code: 'TASK_CONTRACT_MIGRATION_REQUIRED' });
});

test('canonical editing rejects mixed or legacy operations and runtime fields without partial changes', async t => {
  const f = await fixture(t), before = await f.tasks.get('canonical');
  for (const operations of [[{ type: 'metadata', patch: { goal: 'Wrong format' } }], [{ type: 'replace_contract', contract: contract() }, { type: 'remove', stepId: 'inspect' }]]) {
    await assert.rejects(editPlanningWorkspace(f, before.taskId, { expectedRevision: before.revision, operations }), { code: 'PLANNING_CONTRACT_EDIT_REQUIRED' });
  }
  await assert.rejects(editPlanningWorkspace(f, before.taskId, { expectedRevision: before.revision, operations: [{ type: 'replace_contract', contract: { ...contract(), runtime: { complete: true } } }] }));
  assert.equal((await f.tasks.get(before.taskId)).revision, before.revision); assert.equal(f.events.length, 0);
});

test('classic editor sends only authored fields from the current saved intent and keeps receipt bindings', () => {
  const original = state(), local = draft(original, 'inspect'); local.values.title = 'Read the updated source';
  const latest = structuredClone(original); latest.contract.criteria[1].receiptBinding.record = 'confirmedReceipt'; latest.contract.workItems[1].objective = 'An independently refined objective.';
  const [edit] = planningEditOperations(local, latest);
  assert.equal(edit.type, 'replace_contract'); assert.equal(edit.contract.planEpoch, undefined); assert.equal(edit.contract.workItems[0].title, local.values.title);
  assert.equal(edit.contract.criteria[1].receiptBinding.record, 'confirmedReceipt'); assert.equal(edit.contract.workItems[1].objective, 'An independently refined objective.');
  const root = draft(original); root.values['criterionDescription:confirmed'] = 'The saved receipt verifies the outcome.';
  assert.deepEqual(planningEditOperations(root, latest)[0].contract.criteria[1].receiptBinding, latest.contract.criteria[1].receiptBinding);
  assert.throws(() => planningEditOperations({ ...local, mode: 'remove' }, latest), /criterion|cover/i);
});

test('both canonical forms expose work intent and never offer editable runtime status or evidence', () => {
  const task = state(), work = renderPlanningContractFields(task, draft(task, 'verify')), root = renderPlanningContractFields(task, draft(task));
  assert.match(work, /data-planning-field="objective"/); assert.match(work, /data-planning-choice="effects"/); assert.match(work, /Work item title/);
  assert.match(root, /criterionDescription:confirmed/); assert.match(root, /instruction:retain/);
  assert.doesNotMatch(work + root, /data-planning-field="(?:status|evidence|planEpoch|runtime)"/);
});

test('canonical three-way review merges unrelated remote edits and retains text for remotely removed work', () => {
  const previous = contract(), edited = structuredClone(previous), latest = structuredClone(previous); edited.workItems[0].title = 'My revised source title'; latest.workItems[1].objective = 'Shared updated verification'; latest.criteria[1].receiptBinding.record = 'newReceipt';
  const merged = mergePlanningContractDraft(previous, edited, latest);
  assert.equal(merged.contract.workItems[0].title, 'My revised source title'); assert.equal(merged.contract.workItems[1].objective, 'Shared updated verification'); assert.equal(merged.contract.criteria[1].receiptBinding.record, 'newReceipt');
  latest.workItems = latest.workItems.filter(item => item.id !== 'inspect'); latest.workItems[0].dependsOn = []; latest.workItems[0].criterionIds.push('checked');
  const removed = mergePlanningContractDraft(previous, edited, latest);
  assert.equal(removed.contract.workItems.some(item => item.id === 'inspect'), false); assert.equal(removed.detached[0].id, 'inspect'); assert.match(removed.detached[0].note, /My revised source title/);
  const collisionOld = contract(), collisionMine = structuredClone(collisionOld), collisionLatest = structuredClone(collisionOld);
  collisionMine.workItems.push({ ...collisionMine.workItems[0], id: 'same-new-id', title: 'My new work' }); collisionLatest.workItems.push({ ...collisionLatest.workItems[0], id: 'same-new-id', title: 'Their new work' });
  const collision = mergePlanningContractDraft(collisionOld, collisionMine, collisionLatest); assert.equal(collision.detached[0].id, 'same-new-id'); assert.equal(collision.contract.workItems.at(-1).title, 'Their new work');
});

test('next editor rebases canonical drafts explicitly and delayed save receipts preserve later typing', () => {
  let local = createPlanningDraft(state()); local.goal = 'My revised objective'; local.contract.workItems[0].objective = 'My revised source procedure';
  const newer = state(3); newer.contract.criteria[1].receiptBinding.record = 'freshReceipt'; newer.contract.workItems[1].title = 'New shared verification title';
  local = acceptPlanningSnapshot(local, newer); assert.equal(local.base.revision, 2);
  local = rebasePlanningDraft(local); const [operation] = planningDraftOperations(local); assert.equal(operation.contract.criteria[1].receiptBinding.record, 'freshReceipt'); assert.equal(operation.contract.workItems[1].title, 'New shared verification title');
  const submitted = { goal: local.goal, contract: structuredClone(local.contract) }, saved = { ...newer, revision: 4, goal: operation.contract.goal, contract: { ...operation.contract, planEpoch: 2 } };
  local.goal = 'Text typed while the save is in flight'; local.contract.workItems[0].title = 'Later local title';
  const newest = structuredClone(saved); newest.revision = 5; local.latest = newest;
  local = commitPlanningDraft(local, saved, submitted);
  assert.equal(local.goal, 'Text typed while the save is in flight'); assert.equal(local.contract.workItems[0].title, 'Later local title'); assert.equal(local.base.revision, 4); assert.equal(local.latest.revision, 5); assert.equal(planningDraftDirty(local), true);
});

test('work-item removal removes dependency edges and adding after removal does not invent resources', () => {
  const value = contract(); removePlanningContractWorkItem(value, 'inspect'); assert.deepEqual(value.workItems[0].dependsOn, []);
  removePlanningContractWorkItem(value, 'verify'); const added = newPlanningContractWorkItem(value, 'new'); assert.deepEqual(added.resourceKeys, []); assert.deepEqual(added.effects, ['observe']);
});

test('the classic canonical UI saves through the actual shared service and retains a conflicting draft', async t => {
  let workspace; t.after(() => workspace?.destroy());
  const f = await fixture(t), dom = planningDOM(t, { normalizeMarkup: true }), calls = [];
  const api = async (url, options = 'GET', body) => {
    const method = typeof options === 'object' ? options.method || 'GET' : options;
    if (url.startsWith('/api/planning?')) return listPlanningWorkspace(f, { state: 'active' });
    const match = url.match(/^\/api\/tasks\/([^/]+)(\/plan\/edit)?$/); assert.ok(match, url);
    if (method === 'GET') return f.tasks.get(match[1]); calls.push(body); return editPlanningWorkspace(f, match[1], body);
  };
  workspace = initPlanningWorkspaceUI({ mount: dom.mount, api, controllerOptions: { pollMs: 0, awarenessEnabled: false }, onSaved() {} });
  const controller = workspace.controller; await controller.enter({ taskId: 'canonical' }); controller.selectEditor('inspect');
  assert.ok(dom.$('[data-planning-field="objective"]')); assert.equal(dom.$('[data-planning-field="doneWhen"]'), null);
  await dom.input('[data-planning-field="title"]', 'Source checked by the human editor');
  assert.equal(await controller.save(), true); assert.equal(calls[0].operations[0].type, 'replace_contract'); assert.equal((await f.tasks.get('canonical')).contract.workItems[0].title, 'Source checked by the human editor');
  controller.edit('objective', 'Retained local procedure'); const before = await f.tasks.get('canonical'), remote = planningContractIntent(before); remote.workItems[1].title = 'Shared updated work title';
  await f.tasks.setContract('canonical', remote, { expectedRevision: before.revision, source: 'human', actor, schemaVersion: 14 });
  await controller.reviewLatest(); assert.equal(controller.draft().values.objective, 'Retained local procedure'); assert.equal(controller.applyReviewedDraft(), true);
  assert.equal(await controller.save(), true); const saved = await f.tasks.get('canonical'); assert.equal(saved.contract.workItems[0].objective, 'Retained local procedure'); assert.equal(saved.contract.workItems[1].title, 'Shared updated work title'); assert.deepEqual(saved.contract.criteria[1].receiptBinding, contract().criteria[1].receiptBinding);
});
