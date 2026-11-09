import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { TaskStateStore, createTaskToolHandler } from '../lib/task-state.mjs';
import { createPlanningWorkerGuard, wrapPlanningToolHandler } from '../lib/planning-awareness.mjs';
import { readContractJournal, contractCompletionStatus, contractRuntimeView, createContractCompletionController } from '../lib/planning-contract-runtime.mjs';
import { normalizeContractEvidence } from '../lib/planning-contract-evidence.mjs';
import { createPlanningCompletionController } from '../lib/planning-completion.mjs';
import { createWorkspaceToolHandler } from '../lib/workspace-tools.mjs';
import { describeHostOperation } from '../lib/operation-descriptors.mjs';
import { fixtureDeferredUserAgency, fixtureUserAgency } from './fixture-user-agency.mjs';

const body = result => JSON.parse(result.contentItems.find(item => item.type === 'inputText').text);
const call = (name, args) => ({ name, arguments: args, callId: randomUUID() });
const draft = keys => ({ contractVersion: 2, goal: 'Inspect and prepare the supplied fixture files.',
  criteria: [{ id: 'checked', kind: 'judgment', description: 'Actual file evidence supports the requested preparation.' }],
  workItems: [{ id: 'files', title: 'Prepare files', objective: 'Inspect the inputs and make the authorized local change.', owner: 'coordinator', resourceKeys: keys, effects: ['observe', 'interact', 'commit', 'opaque'], dependsOn: [], criterionIds: ['checked'] }], instructions: [] });

const accuracyTarget = overrides => ({ mode: 'qualitative', tolerance: 'Cover every relevant supplied fact.',
  decisionThreshold: 'The retained source supports the requested review.', evidenceNeeded: 'Actual host-observed source evidence.',
  consequence: 'An unsupported conclusion would misstate the supplied facts.', unknownPolicy: 'block',
  stopWhen: 'The stated review is supported and remaining uncertainty is reported.', ...overrides });

async function fixture(t, { scope = 'workspace', deliverPlan = true, contract: authored, operationAdapter } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-contract-runtime-')), cwd = path.join(root, 'work'); await fs.mkdir(cwd);
  await fs.writeFile(path.join(cwd, 'input.txt'), 'actual fixture input\n');
  const tasks = new TaskStateStore({ dataDir: path.join(root, 'data') }), taskId = 'task-fixture', runId = 'run-fixture', nodeId = 'coordinator-node', controller = new AbortController();
  const workspace = createWorkspaceToolHandler({ cwd, signal: controller.signal, runId, nodeId });
  const descriptor = await describeHostOperation({ name: 'relay_workspace', arguments: { action: scope === 'file' ? 'write' : 'list', path: scope === 'file' ? 'allowed.txt' : '.', ...(scope === 'file' ? { text: 'allowed' } : {}) } }, { cwd });
  const key = descriptor.resources.find(row => row.key.startsWith(scope === 'file' ? 'path:' : 'workspace:') && (scope !== 'file' || row.scopeOnly !== true)).key;
  await tasks.ensure({ taskId, runId, nodeId, cwd, goal: 'Fixture file preparation', schemaVersion: 14, defaultPlan: true });
  const handler = createTaskToolHandler({ store: tasks, taskId, runId, nodeId, task: 'Fixture file preparation', schemaVersion: 14, planningMode: 'on', executionGuardrails: true, signal: controller.signal });
  const guard = await createPlanningWorkerGuard({ store: tasks, taskId, runId, nodeId, cwd, schemaVersion: 14, executionGuardrails: true, coordinator: true, signal: controller.signal, getOperationAdapter: item => item.name === 'relay_workspace' ? workspace : operationAdapter?.(item) });
  const invoke = wrapPlanningToolHandler(guard, async (item, context = {}) => {
    const denied = await guard.before(item, context); if (denied) return denied;
    context = guard.dispatchContext(item, context); await guard.dispatchFallback(item, context);
    return item.name === 'relay_task' ? guard.after(item, await handler(item, context)) : workspace(item, context);
  });
  const send = async (item, { deliver = true, shorten } = {}) => { const result = await invoke(item, { signal: controller.signal }); if (deliver) guard.observeToolDelivery({ call: item, result: shorten ? shorten(result) : result }); return result; };
  const read = await send(call('relay_task', { action: 'read' }));
  const plannedCall = call('relay_task', { action: 'plan', expectedRevision: body(read).revision, contract: typeof authored === 'function' ? await authored({ key, cwd }) : authored || draft([key]) });
  const planned = await send(plannedCall, { deliver: deliverPlan }); assert.equal(planned.success, true, JSON.stringify(planned));
  t.after(async () => { guard.finish('finished'); await tasks.close?.(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, cwd, tasks, taskId, runId, nodeId, controller, workspace, handler, guard, send, planned, plannedCall };
}

test('actual workspace operations append their own lifecycle without structural edits', async t => {
  const f = await fixture(t), initial = await f.tasks.get(f.taskId);
  for (const args of [{ action: 'list', path: '.' }, { action: 'read', path: 'input.txt' }, { action: 'write', path: 'output.txt', text: 'real completed local change' }]) {
    const result = await f.send(call('relay_workspace', args)); assert.equal(result.success, true, JSON.stringify(result));
  }
  assert.equal(await fs.readFile(path.join(f.cwd, 'output.txt'), 'utf8'), 'real completed local change');
  const current = await f.tasks.get(f.taskId), journal = await readContractJournal(f.tasks, f.taskId);
  assert.equal(current.revision, initial.revision); assert.equal(current.contract.planEpoch, initial.contract.planEpoch);
  assert.equal(journal.records.length, 3); assert.ok(journal.records.every(row => row.deliveryState === 'returned' && row.resultDigest));
  assert.ok(journal.records.every(row => row.dispatchedAt && row.finishedAt)); assert.ok(journal.evidence.length >= 2);
});

test('completion keeps working after distinct host reads and stops on repeated or failed reads', async t => {
  const f = await fixture(t), updates = [];
  await fs.writeFile(path.join(f.cwd, 'second.txt'), 'another actual fixture input');
  const completion = createContractCompletionController({ store: f.tasks, taskId: f.taskId, nodeId: f.nodeId,
    signal: f.controller.signal, onUpdate: update => updates.push(update) });
  const read = (target, options = {}) => f.send(call('relay_workspace', { action: 'read', path: target, ...options }));
  assert.equal((await read('input.txt')).success, true);
  assert.equal((await completion.beforeFinal()).continue, true);
  assert.equal((await read('second.txt')).success, true);
  assert.equal((await completion.beforeFinal()).continue, true, 'an unsatisfied criterion can need several distinct host reads');
  assert.deepEqual(updates.map(row => row.returnCount), [1, 2]);
  assert.ok(updates.every(row => row.complete === false), 'observations alone must not satisfy the requested judgment');

  assert.equal((await read('second.txt', { startLine: 1, lineCount: 1 })).success, true, 'same delivered lines with different arguments');
  assert.equal((await read('missing.txt')).success, false);
  assert.equal((await f.send(call('relay_task', { action: 'focus', workItemId: 'files', expectedPlanEpoch: 1 }))).success, true);
  await assert.rejects(completion.beforeFinal(), { code: 'TASK_CONTRACT_INCOMPLETE', message: /No new host-observed progress/ });
  assert.equal(updates.at(-1).stopReason, 'no_new_progress');
  await assert.rejects(completion.assertReady(), { code: 'TASK_CONTRACT_INCOMPLETE' });
});

test('continued observation progress counts newly covered lines and still respects the return cap', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.cwd, 'long.txt'), ['one', 'two', 'three', 'four', 'five'].join(String.fromCharCode(10)));
  const read = async (startLine, lineCount) => {
    const result = await f.send(call('relay_workspace', { action: 'read', path: 'long.txt', startLine, lineCount }));
    assert.equal(result.success, true);
  };
  const completion = createContractCompletionController({ store: f.tasks, taskId: f.taskId, nodeId: f.nodeId, maxReturns: 2 });
  await read(1, 2);
  assert.equal((await completion.beforeFinal()).continue, true);
  await read(2, 2);
  assert.equal((await completion.beforeFinal()).continue, true, 'partially overlapping ranges can still add new lines');
  await read(4, 1);
  await assert.rejects(completion.beforeFinal(), { code: 'TASK_CONTRACT_INCOMPLETE', message: /reached its continuation limit/ }, 'new evidence cannot override an explicit continuation cap');
  const duplicate = createContractCompletionController({ store: f.tasks, taskId: f.taskId, nodeId: f.nodeId });
  assert.equal((await duplicate.beforeFinal()).continue, true);
  await read(1, 4);
  await assert.rejects(duplicate.beforeFinal(), { code: 'TASK_CONTRACT_INCOMPLETE' }, 'a different page spanning only covered lines is not new progress');
});

test('default canonical completion grants up to twelve continuations for fresh host observations', async t => {
  const f = await fixture(t), updates = [];
  const completion = createPlanningCompletionController({ store: f.tasks, taskId: f.taskId, nodeId: f.nodeId,
    schemaVersion: 14, executionGuardrails: true, onUpdate: update => updates.push(update) });
  for (let index = 0; index < 13; index++) {
    const target = 'input-' + index + '.txt';
    await fs.writeFile(path.join(f.cwd, target), 'Actual fixture input ' + index);
    assert.equal((await f.send(call('relay_workspace', { action: 'read', path: target }))).success, true);
    if (index < 12) assert.equal((await completion.beforeFinal()).continue, true);
    else await assert.rejects(completion.beforeFinal(), { code: 'TASK_CONTRACT_INCOMPLETE', message: /reached its continuation limit/ });
  }
  assert.equal(updates.at(-1).stopReason, 'continuation_limit');
  assert.equal(updates.at(-1).returnCount, 12);
  assert.equal(updates.at(-1).complete, false);
});

test('an adopted goal keeps the same request open past the usual limit until evidence supports completion', async t => {
  const f = await fixture(t), updates = [];
  const completion = createPlanningCompletionController({ store: f.tasks, taskId: f.taskId, runId: f.runId, nodeId: f.nodeId,
    schemaVersion: 14, executionGuardrails: true, persistentGoal: true, onUpdate: update => updates.push(update) });
  for (let index = 0; index < 15; index++) {
    const target = 'goal-input-' + index + '.txt';
    await fs.writeFile(path.join(f.cwd, target), 'Required evidence ' + index);
    assert.equal((await f.send(call('relay_workspace', { action: 'read', path: target }))).success, true);
    assert.equal((await completion.beforeFinal()).continue, true);
    assert.equal(updates.at(-1).goalStatus, 'active');
  }
  const journal = await readContractJournal(f.tasks, f.taskId);
  const decision = await f.send(call('relay_task', { action: 'assess', expectedPlanEpoch: 1, workItemId: 'files',
    criterionId: 'checked', judgment: 'satisfied', note: 'The supplied files support the result.',
    evidenceIds: journal.evidence.filter(row => row.kind === 'observation').map(row => row.id) }));
  assert.equal(decision.success, true, JSON.stringify(decision));
  assert.equal(await completion.beforeFinal(), null);
  assert.equal(updates.at(-1).goalStatus, 'complete');
  assert.equal(updates.at(-1).complete, true);
  assert.equal(journal.records.length, 15);
  assert.ok(journal.records.every(row => row.runId === f.runId));

  const blocked = await f.send(call('relay_task', { action: 'assess', expectedPlanEpoch: 1, workItemId: 'files',
    criterionId: 'checked', judgment: 'blocked', note: 'The supplied files no longer support the requested result.',
    evidenceIds: [journal.evidence[0].id] }));
  assert.equal(blocked.success, true);
  const recheck = await completion.beforeFinal();
  assert.equal(recheck.continue, true);
  assert.match(recheck.prompt, /whether any stated condition for the requirement applies/);
  assert.match(recheck.prompt, /The supplied files no longer support the requested result/);
  assert.equal(updates.at(-1).goalStatus, 'active');
  assert.equal(await completion.beforeFinal(), null);
  assert.equal(updates.at(-1).goalStatus, 'blocked');
  assert.equal(updates.at(-1).complete, false);
});

test('a persistent goal gets a recovery turn but repeated identical evidence cannot keep it running', async t => {
  const f = await fixture(t), updates = [];
  const completion = createPlanningCompletionController({ store: f.tasks, taskId: f.taskId, runId: f.runId, nodeId: f.nodeId,
    schemaVersion: 14, executionGuardrails: true, persistentGoal: true, onUpdate: update => updates.push(update) });
  for (let index = 0; index < 4; index++) {
    assert.equal((await f.send(call('relay_workspace', { action: 'read', path: 'input.txt' }))).success, true);
    if (index < 2) assert.equal((await completion.beforeFinal()).continue, true);
    else if (index === 2) {
      const recovery = await completion.beforeFinal();
      assert.equal(recovery.continue, true);
      assert.match(recovery.prompt, /Try a different concrete observation/);
      assert.match(recovery.prompt, /"workItem":"files"/);
      assert.match(recovery.prompt, /Actual file evidence supports the requested preparation/);
      assert.equal(updates.at(-1).goalStatus, 'active');
    }
    else await assert.rejects(completion.beforeFinal(), { code: 'TASK_CONTRACT_INCOMPLETE' });
  }
  assert.equal(updates.at(-1).goalStatus, 'blocked');
  assert.equal(updates.at(-1).complete, false);
});

async function refineFixturePlan(f, refine) {
  const state = body(await f.send(call('relay_task', { action: 'read' })));
  const contract = structuredClone(state.contract);
  delete contract.planEpoch;
  refine(contract.workItems[0]);
  const result = await f.send(call('relay_task', { action: 'plan', expectedRevision: state.revision, contract }));
  assert.equal(result.success, true, JSON.stringify(result));
}

test('a scoped plan repair can extend completion after a real browser observation was denied', async t => {
  const origin = 'origin:https://jobs.ashbyhq.com';
  const f = await fixture(t, { operationAdapter: () => ({ describeOperation: item => describeHostOperation(item, { browserObservation: { tabs: [] } }) }) });
  const completion = createPlanningCompletionController({ store: f.tasks, taskId: f.taskId, runId: f.runId, nodeId: f.nodeId,
    schemaVersion: 14, executionGuardrails: true });
  for (let index = 0; index < 4; index++) {
    const target = 'input-' + index + '.txt';
    await fs.writeFile(path.join(f.cwd, target), 'Actual fixture input ' + index);
    assert.equal((await f.send(call('relay_workspace', { action: 'read', path: target }))).success, true);
    assert.equal((await completion.beforeFinal()).continue, true);
  }
  const open = call('relay_browser', { action: 'open', url: 'https://jobs.ashbyhq.com/example' });
  const before = await readContractJournal(f.tasks, f.taskId);
  assert.equal((await f.send(open)).code, 'TASK_CONTRACT_SCOPE');
  await refineFixturePlan(f, item => item.resourceKeys.push(origin));
  assert.deepEqual(await readContractJournal(f.tasks, f.taskId), before, 'refinement dispatches no operation and creates no evidence');

  const result = await completion.beforeFinal();
  assert.equal(result.continue, true);
  assert.match(result.prompt, /updated scope now permits a previously blocked observation/);
  assert.equal(await f.guard.before(open), null, 'the refined plan admits the observation through the normal host guard');
});

test('a denied tab inventory guides research to the authorized page without widening scope', async t => {
  const url = 'https://jobs.ashbyhq.com/example', origin = 'origin:https://jobs.ashbyhq.com';
  const f = await fixture(t, { contract: () => draft([origin]) });
  const before = await readContractJournal(f.tasks, f.taskId);
  const denied = await f.send(call('relay_browser', { action: 'tabs' }));
  assert.equal(denied.code, 'TASK_CONTRACT_SCOPE');
  assert.match(body(denied).resourceGuidance, /open that URL directly and read it using the returned tab ID/);
  assert.deepEqual(await readContractJournal(f.tasks, f.taskId), before);
  assert.equal(await f.guard.before(call('relay_browser', { action: 'open', url })), null);
  assert.equal((await f.guard.before(call('relay_browser', { action: 'open', url: 'https://unrelated.example/' }))).code, 'TASK_CONTRACT_SCOPE');
});

test('a scope repair cannot repeat the same grant or use unrelated material edits as progress', async t => {
  const f = await fixture(t, { scope: 'file' });
  const target = 'input.txt', read = () => f.send(call('relay_workspace', { action: 'read', path: target }));
  const descriptor = await describeHostOperation({ name: 'relay_workspace', arguments: { action: 'read', path: target } }, { cwd: f.cwd });
  const key = descriptor.resources.find(resource => resource.key.startsWith('path:') && !resource.scopeOnly).key;
  const unrelated = 'origin:https://unrelated.example';
  const completion = createContractCompletionController({ store: f.tasks, taskId: f.taskId, runId: f.runId, nodeId: f.nodeId,
    maxReturns: 1, maxObservationReturns: 4 });

  assert.equal((await completion.beforeFinal()).continue, true);
  assert.equal((await read()).code, 'TASK_CONTRACT_SCOPE');
  await refineFixturePlan(f, item => item.resourceKeys.push(key));
  assert.equal((await completion.beforeFinal()).continue, true);
  await refineFixturePlan(f, item => { item.resourceKeys = item.resourceKeys.filter(scope => scope !== key); });
  assert.equal((await read()).code, 'TASK_CONTRACT_SCOPE');
  await refineFixturePlan(f, item => {
    item.title = 'Read changed requirements';
    item.resourceKeys = [unrelated, key, ...item.resourceKeys].reverse();
  });
  await assert.rejects(completion.beforeFinal(), { code: 'TASK_CONTRACT_INCOMPLETE', message: /No new host-observed progress/ });
});

test('an actual scope repair respects explicit caps and cannot extend while an operation is live', async t => {
  for (const live of [false, true]) {
    await t.test(live ? 'live operation' : 'explicit cap', async t => {
      const f = await fixture(t, { scope: 'file' });
      const target = 'input.txt', read = call('relay_workspace', { action: 'read', path: target });
      const descriptor = await describeHostOperation(read, { cwd: f.cwd });
      const key = descriptor.resources.find(resource => resource.key.startsWith('path:') && !resource.scopeOnly).key;
      const completion = live
        ? createContractCompletionController({ store: f.tasks, taskId: f.taskId, runId: f.runId, nodeId: f.nodeId, maxReturns: 1, maxObservationReturns: 2 })
        : createPlanningCompletionController({ store: f.tasks, taskId: f.taskId, runId: f.runId, nodeId: f.nodeId, schemaVersion: 14, executionGuardrails: true, maxReturns: 1 });

      assert.equal((await completion.beforeFinal()).continue, true);
      assert.equal((await f.send(read)).code, 'TASK_CONTRACT_SCOPE');
      if (live) assert.equal(await f.guard.before(call('relay_workspace', { action: 'write', path: 'allowed.txt', text: 'never dispatched' })), null);
      await refineFixturePlan(f, item => item.resourceKeys.push(key));
      await assert.rejects(completion.beforeFinal(), { code: 'TASK_CONTRACT_INCOMPLETE', message: /continuation limit/ });
      await assert.rejects(fs.stat(path.join(f.cwd, 'allowed.txt')), { code: 'ENOENT' });
    });
  }
});

test('a new judgment without a new host observation cannot extend the ordinary cap', async t => {
  const f = await fixture(t, { contract: ({ key }) => {
    const value = draft([key]);
    value.criteria.push({ id: 'remaining', kind: 'judgment', description: 'A second requested review remains.' });
    value.workItems[0].criterionIds.push('remaining');
    return value;
  } });
  const completion = createContractCompletionController({ store: f.tasks, taskId: f.taskId, nodeId: f.nodeId,
    maxReturns: 1, maxObservationReturns: 2 });
  assert.equal((await f.send(call('relay_workspace', { action: 'read', path: 'input.txt' }))).success, true);
  assert.equal((await completion.beforeFinal()).continue, true);
  const journal = await readContractJournal(f.tasks, f.taskId);
  assert.equal((await f.send(call('relay_task', { action: 'assess', workItemId: 'files', expectedPlanEpoch: 1,
    criterionId: 'checked', judgment: 'satisfied', note: 'The fixture supports the completed review.', evidenceIds: journal.evidence.map(item => item.id) }))).success, true);
  await assert.rejects(completion.beforeFinal(), { code: 'TASK_CONTRACT_INCOMPLETE', message: /reached its continuation limit/ });
});

test('a workspace observation prerequisite is established by a real file read without a material plan edit', async t => {
  const f = await fixture(t, { contract: ({ key }) => {
    const value = draft([key]); value.criteria[0] = { id: 'checked', kind: 'observation', resourceKey: key, description: 'Inspect the supplied profile in this workspace.' }; return value;
  } });
  const before = await f.tasks.get(f.taskId);
  assert.equal(before.contractRuntime.criteria[0].satisfied, false);
  assert.equal((await f.send(call('relay_workspace', { action: 'read', path: 'input.txt' }))).success, true);
  const after = await f.tasks.get(f.taskId), journal = await readContractJournal(f.tasks, f.taskId);
  assert.equal(after.contractRuntime.criteria[0].satisfied, true);
  assert.equal(after.contractRuntime.workItems[0].status, 'satisfied');
  assert.equal(after.contract.planEpoch, before.contract.planEpoch);
  assert.equal(after.revision, before.revision);
  assert.ok(journal.evidence.every(row => row.resourceKey.startsWith('path:')));
  assert.equal(contractCompletionStatus(after, journal).complete, true);
});

test('assess accepts host-scoped evidence and rejects irrelevant positive citations before journaling them', async t => {
  const f = await fixture(t, { contract: ({ key }) => {
    const value = draft([key]); value.criteria[0].resourceKey = key;
    value.criteria.push({ id: 'foreign', kind: 'judgment', resourceKey: 'workspace:/unrelated-workspace', description: 'Review another workspace.' });
    value.workItems[0].criterionIds.push('foreign');
    value.workItems.push({ ...structuredClone(value.workItems[0]), id: 'other-item', criterionIds: ['checked'] });
    return value;
  } });
  await f.send(call('relay_task', { action: 'focus', workItemId: 'files', expectedPlanEpoch: 1 }));
  await f.send(call('relay_workspace', { action: 'read', path: 'input.txt' }));
  const before = await readContractJournal(f.tasks, f.taskId), evidenceIds = before.evidence.map(row => row.id);
  const assess = extra => f.send(call('relay_task', { action: 'assess', workItemId: 'files', criterionId: 'checked', expectedPlanEpoch: 1, judgment: 'satisfied', evidenceIds, note: 'The supplied input supports this qualitative review.', ...extra }));
  for (const [extra, reason] of [[{ criterionId: 'foreign' }, /no retained host scope binding/], [{ workItemId: 'other-item' }, /belongs to work item files/]]) {
    const rejected = await assess(extra);
    assert.equal(rejected.success, false);
    assert.equal(body(rejected).code, 'TASK_CONTRACT_EVIDENCE_INELIGIBLE');
    assert.match(body(rejected).error, reason);
    const unchanged = await readContractJournal(f.tasks, f.taskId);
    assert.equal(unchanged.journalSeq, before.journalSeq);
    assert.equal(unchanged.judgments.length, 0);
  }
  assert.equal((await assess({})).success, true);
  const accepted = await f.tasks.get(f.taskId);
  assert.equal(accepted.contractRuntime.criteria.find(row => row.id === 'checked').satisfied, true);
  assert.equal((await assess({ criterionId: 'foreign', judgment: 'blocked', note: 'The available input does not cover the other workspace.' })).success, true, 'A blocker can retain its explanatory evidence.');
  const saved = await readContractJournal(f.tasks, f.taskId);
  assert.equal(saved.judgments.length, 2);
  assert.deepEqual(saved.evidence, before.evidence);
});

test('a task handler return and a shortened downstream payload do not grant intent awareness', async t => {
  const f = await fixture(t, { deliverPlan: false });
  const denied = await f.send(call('relay_workspace', { action: 'list', path: '.' }));
  assert.equal(denied.code, 'TASK_CONTRACT_REVIEW_REQUIRED');
  const partial = structuredClone(f.planned), payload = body(partial); payload.contract.workItems[0].objective = 'shortened'; partial.contentItems[0].text = JSON.stringify(payload);
  f.guard.observeToolDelivery({ call: f.plannedCall, result: partial });
  assert.equal((await f.send(call('relay_workspace', { action: 'list', path: '.' }))).code, 'TASK_CONTRACT_REVIEW_REQUIRED');
  f.guard.observeToolDelivery({ call: f.plannedCall, result: f.planned });
  assert.equal((await f.send(call('relay_workspace', { action: 'list', path: '.' }))).success, true);
});

test('a relevant human change needs a newly delivered contract, while receipts alone do not change the epoch', async t => {
  const f = await fixture(t), state = await f.tasks.get(f.taskId), updated = structuredClone(state.contract); delete updated.planEpoch; updated.workItems[0].objective = 'Inspect and report the changed actual requirement.';
  await f.tasks.setContract(f.taskId, updated, { expectedRevision: state.revision, runId: 'human-edit', nodeId: 'human', schemaVersion: 14, source: 'human' });
  assert.equal((await f.send(call('relay_workspace', { action: 'read', path: 'input.txt' }))).code, 'TASK_CONTRACT_REVIEW_REQUIRED');
  await f.send(call('relay_task', { action: 'read' }));
  assert.equal((await f.send(call('relay_workspace', { action: 'read', path: 'input.txt' }))).success, true);
});

test('editing a downstream receipt step preserves its unchanged eligibility judgment', async t => {
  const f = await fixture(t, { contract: ({ key }) => {
    const value = draft([key]);
    value.workItems[0].effects = ['observe'];
    value.criteria.push({ id: 'receipt', kind: 'observation', description: 'Read the destination record.' });
    value.workItems.push({ id: 'report', title: 'Check the result', objective: 'Read the observed result.', owner: 'coordinator',
      resourceKeys: [key], effects: ['observe'], dependsOn: ['files'], criterionIds: ['receipt'] });
    return value;
  } });
  assert.equal((await f.send(call('relay_task', { action: 'focus', workItemId: 'files', expectedPlanEpoch: 1 }))).success, true);
  assert.equal((await f.send(call('relay_workspace', { action: 'read', path: 'input.txt' }))).success, true);
  const journal = await readContractJournal(f.tasks, f.taskId);
  assert.equal((await f.send(call('relay_task', { action: 'assess', workItemId: 'files', criterionId: 'checked', expectedPlanEpoch: 1,
    judgment: 'satisfied', evidenceIds: journal.evidence.map(row => row.id), note: 'The retained input supports the assessment.' }))).success, true);
  const state = body(await f.send(call('relay_task', { action: 'read' })));
  const next = structuredClone(state.contract);
  delete next.planEpoch;
  next.workItems[1].objective = 'Read the exact destination record.';
  assert.equal((await f.send(call('relay_task', { action: 'plan', expectedRevision: state.revision, contract: next }))).success, true);
  const reviewed = await f.tasks.get(f.taskId);
  assert.equal(reviewed.contract.planEpoch, 2);
  assert.equal(reviewed.contractRuntime.criteria.find(row => row.id === 'checked').satisfied, true);
});

test('a required form label or counterparty preference cannot end an adopted goal', async t => {
  const f = await fixture(t, { contract: ({ key }) => {
    const value = draft([key]);
    value.criteria.push({ id: 'alternate', kind: 'observation', description: 'Inspect the independent alternative.' });
    value.workItems.push({ id: 'alternative', title: 'Inspect the alternative', objective: 'Keep the independent work moving.',
      owner: 'coordinator', resourceKeys: [key], effects: ['observe'], dependsOn: [], criterionIds: ['alternate'] });
    return value;
  } });
  const initial = await f.tasks.get(f.taskId);
  const contract = structuredClone(initial.contract);
  delete contract.planEpoch;
  await f.tasks.setContract(f.taskId, contract, {
    expectedRevision: initial.revision, runId: f.runId, nodeId: f.nodeId, schemaVersion: 14,
    adoption: { operationalHoldPolicy: 1 },
  });
  const delivered = body(await f.send(call('relay_task', { action: 'read' })));
  assert.equal((await f.send(call('relay_task', { action: 'focus', workItemId: 'files', expectedPlanEpoch: delivered.contract.planEpoch }))).success, true);
  const read = await f.send(call('relay_workspace', { action: 'read', path: 'input.txt' }));
  assert.equal(read.success, true);
  const journal = await readContractJournal(f.tasks, f.taskId);
  const evidenceIds = journal.evidence.map(item => item.id);
  const args = { action: 'assess', expectedPlanEpoch: delivered.contract.planEpoch, workItemId: 'files',
    criterionId: 'checked', evidenceIds, judgment: 'blocked',
    note: 'A counterparty labels a routine Yes/No form input required and prefers a different format.' };
  assert.equal((await f.send(call('relay_task', args))).code, 'USER_AGENCY_REQUIRED');
  assert.equal((await f.send(call('relay_task', { ...args, userAgency: fixtureUserAgency() }))).code, 'USER_AGENCY_HOLD_NOT_JUSTIFIED');

  const preference = fixtureDeferredUserAgency('The counterparty prefers another file format.');
  preference.decisions[0].input.hardConstraints.push({
    id: 'outside_preference', kind: 'verified_requirement', rule: 'Use the preferred format.',
    source: evidenceIds[0], observedViolation: 'The site displays a format preference.', blockedOptionIds: ['proceed'],
  });
  assert.equal((await f.send(call('relay_task', { ...args, userAgency: preference }))).code, 'USER_AGENCY_HOLD_EVIDENCE');
  preference.decisions[0].input.hardConstraints[0].kind = 'user_constraint';
  assert.equal((await f.send(call('relay_task', { ...args, userAgency: preference }))).code, 'USER_AGENCY_HOLD_EVIDENCE');
  assert.equal((await readContractJournal(f.tasks, f.taskId)).judgments.length, 0);
  assert.equal(contractCompletionStatus(await f.tasks.get(f.taskId), journal).ready, false);

  const reason = 'The supplied record lacks the signature needed to attest the requested transfer, and available sources do not establish its authority.';
  const deferred = await f.send(call('relay_task', { ...args, note: reason, userAgency: fixtureDeferredUserAgency(reason) }));
  assert.equal(deferred.success, true, JSON.stringify(deferred));
  const saved = await readContractJournal(f.tasks, f.taskId);
  assert.equal(saved.judgments[0].userAgency.action, 'defer');
  const status = contractCompletionStatus(await f.tasks.get(f.taskId), saved);
  assert.deepEqual(status.remainingWorkItemIds, ['alternative']);
  assert.equal(status.ready, false);
  assert.equal(status.complete, false);
});

test('an accuracy-only material change invalidates awareness and prior judgments without creating evidence or authority', async t => {
  const f = await fixture(t, { contract: ({ key }) => {
    const value = draft([key]); value.criteria[0].accuracy = accuracyTarget(); value.workItems[0].effects = ['observe']; return value;
  } });
  assert.equal((await f.send(call('relay_workspace', { action: 'read', path: 'input.txt' }))).success, true);
  const observed = await readContractJournal(f.tasks, f.taskId), evidenceIds = observed.evidence.map(row => row.id);
  assert.ok(evidenceIds.length > 0);
  assert.equal((await f.send(call('relay_task', { action: 'assess', workItemId: 'files', criterionId: 'checked', expectedPlanEpoch: 1,
    judgment: 'satisfied', evidenceIds, note: 'The actual supplied file supports the stated qualitative review.' }))).success, true);
  const before = await f.tasks.get(f.taskId), journal = await readContractJournal(f.tasks, f.taskId);
  assert.equal(contractCompletionStatus(before, journal).complete, true);
  const next = structuredClone(before.contract); delete next.planEpoch;
  next.criteria[0].accuracy.decisionThreshold = 'The retained source must support each requested fact individually.';
  await f.tasks.setContract(f.taskId, next, { expectedRevision: before.revision, runId: 'human-edit', nodeId: 'human', schemaVersion: 14, source: 'human' });
  const changed = await f.tasks.get(f.taskId);
  assert.equal(changed.contract.planEpoch, before.contract.planEpoch + 1);
  assert.equal(changed.revision, before.revision + 1);
  assert.deepEqual(changed.contract.criteria[0].accuracy, next.criteria[0].accuracy);
  assert.deepEqual(changed.contract.workItems, before.contract.workItems);
  assert.deepEqual(await readContractJournal(f.tasks, f.taskId), journal, 'Accuracy changes preserve every operation, judgment and host evidence record.');
  assert.equal(changed.contractRuntime.criteria[0].satisfied, false, 'An earlier assessment cannot satisfy the materially changed criterion.');
  assert.equal(contractCompletionStatus(changed, journal).complete, false);
  const stale = await f.send(call('relay_workspace', { action: 'read', path: 'input.txt' }));
  assert.equal(stale.code, 'TASK_CONTRACT_REVIEW_REQUIRED', 'The worker signature includes the changed accuracy metadata.');
  assert.deepEqual(await readContractJournal(f.tasks, f.taskId), journal, 'An undelivered accuracy change admits no operation.');
  const delivered = body(await f.send(call('relay_task', { action: 'read' })));
  assert.deepEqual(delivered.contract.criteria[0].accuracy, next.criteria[0].accuracy);
  const denied = await f.send(call('relay_workspace', { action: 'write', path: 'unauthorized.txt', text: 'Accuracy metadata cannot authorize a write.' }));
  assert.equal(denied.code, 'TASK_CONTRACT_SCOPE');
  await assert.rejects(fs.stat(path.join(f.cwd, 'unauthorized.txt')), { code: 'ENOENT' });
  assert.deepEqual(await readContractJournal(f.tasks, f.taskId), journal);
  assert.equal((await f.send(call('relay_task', { action: 'assess', workItemId: 'files', criterionId: 'checked', expectedPlanEpoch: changed.contract.planEpoch,
    judgment: 'satisfied', evidenceIds, note: 'A fresh review checked each requested fact against the retained source evidence.' }))).success, true);
  const reassessed = await readContractJournal(f.tasks, f.taskId);
  assert.deepEqual(reassessed.evidence, journal.evidence);
  assert.deepEqual(reassessed.records, journal.records);
  assert.equal(reassessed.judgments.length, journal.judgments.length + 1);
  assert.equal(contractCompletionStatus(await f.tasks.get(f.taskId), reassessed).complete, true);
});

test('accuracy metadata cannot turn a source observation into an external confirmation', async t => {
  const f = await fixture(t, { contract: ({ key }) => {
    const value = draft([key]); value.criteria[0] = { id: 'checked', kind: 'external-confirmation', resourceKey: key,
      targetCount: 1, description: 'The requested outcome requires a distinct host-confirmed effect.',
      accuracy: accuracyTarget({ mode: 'exact', unknownPolicy: 'omit', stopWhen: 'Report the observed source and any omitted outcome explicitly.' }) };
    value.workItems[0].effects = ['observe']; return value;
  } });
  assert.equal((await f.send(call('relay_workspace', { action: 'read', path: 'input.txt' }))).success, true);
  const state = await f.tasks.get(f.taskId), journal = await readContractJournal(f.tasks, f.taskId);
  assert.ok(journal.evidence.length > 0);
  assert.ok(journal.evidence.every(row => row.kind !== 'external-confirmation'));
  assert.deepEqual(state.contractRuntime.outcomes, []);
  assert.equal(state.contractRuntime.criteria[0].satisfied, false);
  assert.equal(contractCompletionStatus(state, journal).complete, false);
});

test('same-tool same-action cannot use a matching source workspace to authorize another concrete path', async t => {
  const f = await fixture(t, { scope: 'file' });
  assert.equal((await f.send(call('relay_workspace', { action: 'write', path: 'allowed.txt', text: 'authorized' }))).success, true);
  const result = await f.send(call('relay_workspace', { action: 'write', path: 'foreign.txt', text: 'must not be written' }));
  assert.equal(result.code, 'TASK_CONTRACT_SCOPE'); await assert.rejects(fs.stat(path.join(f.cwd, 'foreign.txt')), { code: 'ENOENT' });
});

test('browser tab inventory reports its exact host resource without acquiring site scope or dispatching', async t => {
  const value = draft(['origin:https://portal.test']); value.workItems[0].effects = ['observe'];
  const f = await fixture(t, { contract: value, operationAdapter: () => ({ describeOperation: item => describeHostOperation(item, { browserObservation: { tabs: [] } }) }) });
  await f.send(call('relay_task', { action: 'focus', workItemId: 'files', expectedPlanEpoch: 1 }));
  const before = await readContractJournal(f.tasks, f.taskId);
  const denied = await f.send(call('relay_browser', { action: 'tabs', browser: 'relay' })), detail = body(denied);
  assert.equal(denied.code, 'TASK_CONTRACT_SCOPE');
  assert.equal(detail.scopeReason, 'resource-not-covered');
  assert.deepEqual(detail.operation, { effect: 'observe', resources: [{ key: 'browser:relay', access: 'read' }], omittedResourceCount: 0 });
  assert.deepEqual(detail.focusedWorkItem, { id: 'files', allowedEffects: ['observe'] });
  assert.deepEqual(detail.matchingWorkItemIds, []);
  assert.match(detail.resourceGuidance, /tab inventory.*browser:relay/);
  assert.deepEqual(await readContractJournal(f.tasks, f.taskId), before, 'An inventory scope denial reserves and dispatches no operation.');
});

test('missing observe is diagnosed explicitly and is not implied by interact or commit', async t => {
  const f = await fixture(t, { contract: ({ key }) => { const value = draft([key]); value.workItems[0].effects = ['interact', 'commit']; return value; } });
  await f.send(call('relay_task', { action: 'focus', workItemId: 'files', expectedPlanEpoch: 1 }));
  const before = await readContractJournal(f.tasks, f.taskId);
  const denied = await f.send(call('relay_workspace', { action: 'read', path: 'input.txt' })), detail = body(denied);
  assert.equal(denied.code, 'TASK_CONTRACT_SCOPE');
  assert.equal(detail.scopeReason, 'effect-not-declared');
  assert.equal(detail.operation.effect, 'observe');
  assert.ok(detail.operation.resources[0].key.endsWith('/input.txt'));
  assert.deepEqual(detail.focusedWorkItem.allowedEffects, ['interact', 'commit']);
  assert.deepEqual(await readContractJournal(f.tasks, f.taskId), before);
});

test('multiple matching owned items request focus without a material edit or operation dispatch', async t => {
  const f = await fixture(t, { contract: ({ key }) => {
    const value = draft([key]); value.workItems[0].effects = ['interact'];
    for (const id of ['reader-a', 'reader-b']) value.workItems.push({ ...structuredClone(value.workItems[0]), id, effects: ['observe'] });
    value.workItems.push({ ...structuredClone(value.workItems[0]), id: 'foreign-reader', owner: 'another-worker', effects: ['observe'] });
    return value;
  } });
  await f.send(call('relay_task', { action: 'focus', workItemId: 'files', expectedPlanEpoch: 1 }));
  const before = await readContractJournal(f.tasks, f.taskId), state = await f.tasks.get(f.taskId);
  const denied = await f.send(call('relay_workspace', { action: 'read', path: 'input.txt' })), detail = body(denied);
  assert.equal(denied.code, 'TASK_CONTRACT_FOCUS_REQUIRED');
  assert.equal(detail.scopeReason, 'multiple-matching-work-items');
  assert.deepEqual(detail.matchingWorkItemIds, ['reader-a', 'reader-b']);
  assert.deepEqual(detail.focusedWorkItem, { id: 'files', allowedEffects: ['interact'] });
  assert.deepEqual(await readContractJournal(f.tasks, f.taskId), before, 'The unresolved choice leaves no operation reservation or dispatch.');
  await f.send(call('relay_task', { action: 'focus', workItemId: 'reader-a', expectedPlanEpoch: state.contract.planEpoch }));
  assert.equal((await f.send(call('relay_workspace', { action: 'read', path: 'input.txt' }))).success, true);
  const after = await f.tasks.get(f.taskId), journal = await readContractJournal(f.tasks, f.taskId);
  assert.equal(after.revision, state.revision); assert.equal(after.contract.planEpoch, state.contract.planEpoch);
  assert.equal(journal.records.length, 1); assert.equal(journal.records[0].workItemId, 'reader-a');
});

test('independent actual reads can be admitted together without plan churn or result bookkeeping', async t => {
  const f = await fixture(t), before = await f.tasks.get(f.taskId);
  await fs.writeFile(path.join(f.cwd, 'second.txt'), 'second observed file\n');
  const results = await Promise.all(['input.txt','second.txt'].map(file => f.send(call('relay_workspace', { action: 'read', path: file }))));
  assert.ok(results.every(result => result.success));
  const after = await f.tasks.get(f.taskId); assert.equal(after.revision, before.revision); assert.equal(after.contract.planEpoch, before.contract.planEpoch);
  assert.equal((await readContractJournal(f.tasks, f.taskId)).records.length, 2);
});

test('a worker cannot change a criterion shared with another owner or rename its owner', async t => {
  const value = draft(['discovery']); value.workItems[0].owner = 'worker-a'; value.workItems.push({ ...structuredClone(value.workItems[0]), id: 'other', owner: 'coordinator' });
  const f = await fixture(t, { contract: value }), state = await f.tasks.get(f.taskId);
  const worker = createTaskToolHandler({ store: f.tasks, taskId: f.taskId, runId: f.runId, nodeId: 'worker-a', schemaVersion: 14, worker: true, planningMode: 'on', executionGuardrails: true });
  for (const change of [next => { next.criteria[0].description = 'A weaker unrelated criterion'; }, next => { next.criteria[0].accuracy = accuracyTarget(); }, next => { next.workItems[0].owner = 'coordinator'; }]) {
    const next = structuredClone(state.contract); delete next.planEpoch; change(next);
    const result = await worker(call('relay_task', { action: 'plan', expectedRevision: state.revision, contract: next }));
    assert.equal(result.success, false); assert.equal(body(result).code, 'TASK_CONTRACT_OWNERSHIP'); assert.equal((await f.tasks.get(f.taskId)).revision, state.revision);
  }
});

test('cancel before the queue-bound dispatch creates no file and records no possible effect', async t => {
  const f = await fixture(t), item = call('relay_workspace', { action: 'write', path: 'cancelled.txt', text: 'not dispatched' });
  assert.equal(await f.guard.before(item), null); const context = f.guard.dispatchContext(item, { signal: f.controller.signal }); f.controller.abort();
  let result; try { result = await f.workspace(item, context); } catch (error) { result = { success: false, code: error.code, contentItems: [{ type: 'inputText', text: error.message }] }; }
  await f.guard.annotate(item, result);
  await assert.rejects(fs.stat(path.join(f.cwd, 'cancelled.txt')), { code: 'ENOENT' });
  const journal = await readContractJournal(f.tasks, f.taskId); assert.equal(journal.records[0].deliveryState, 'cancelled-before-dispatch'); assert.equal(journal.records[0].effectState, 'absent');
});

test('a lost actual write receipt stays uncertain across worker turnover and blocks replay while allowing observation', async t => {
  const f = await fixture(t), item = call('relay_workspace', { action: 'write', path: 'written-once.txt', text: 'actual single effect' });
  assert.equal(await f.guard.before(item), null);
  const result = await f.workspace(item, f.guard.dispatchContext(item)); assert.equal(result.success, true);
  f.guard.finish('failed'); // Deliberately lose only the host return receipt after the actual fixture write.
  const next = await createPlanningWorkerGuard({ store: f.tasks, taskId: f.taskId, runId: 'continued-run', nodeId: f.nodeId, cwd: f.cwd, schemaVersion: 14, executionGuardrails: true, coordinator: true, getOperationAdapter: () => f.workspace });
  next.observeToolDelivery({ call: call('relay_task', { action: 'read' }), result: await f.handler(call('relay_task', { action: 'read' })) });
  assert.equal((await next.before(call('relay_workspace', { action: 'write', path: 'written-once.txt', text: 'duplicate effect' }))).code, 'TASK_CONTRACT_EFFECT_UNCERTAIN');
  const completion = createContractCompletionController({ store: f.tasks, taskId: f.taskId, nodeId: f.nodeId,
    maxReturns: 1, maxObservationReturns: 2 });
  assert.equal((await completion.beforeFinal()).continue, true);
  const inspection = call('relay_workspace', { action: 'read', path: 'written-once.txt' });
  assert.equal(await next.before(inspection), null);
  const inspected = await f.workspace(inspection, next.dispatchContext(inspection));
  assert.equal(inspected.success, true);
  await next.annotate(inspection, inspected);
  await assert.rejects(completion.beforeFinal(), { code: 'TASK_CONTRACT_INCOMPLETE', message: /reached its continuation limit/ },
    'an unresolved effect keeps the original bound even when additional observation is available');
  const status = contractCompletionStatus(await f.tasks.get(f.taskId), await readContractJournal(f.tasks, f.taskId));
  assert.equal(status.complete, false); assert.equal(status.outcome, 'uncertain');
  assert.equal(await fs.readFile(path.join(f.cwd, 'written-once.txt'), 'utf8'), 'actual single effect'); next.finish('finished');
});

for (const status of ['confirmed', 'absent']) test('journal projection preserves later verified ' + status + ' reconciliation without inventing the lost transport return', () => {
  const resourceKey = 'origin:https://fixture.invalid', effectKey = 'saved-effect';
  const contract = draft([resourceKey]); contract.planEpoch = 1;
  contract.criteria = [{ id: 'checked', kind: 'external-confirmation', resourceKey, targetCount: 1, description: 'A distinct requested result is actually confirmed.' }];
  const evidence = normalizeContractEvidence({ kind: 'external-confirmation', resourceKey, confirmation: { outcomeId: 'actual-receipt', effectKey, status } }, { operationId: 'later-observation', workItemId: 'files', at: '2026-11-05T19:00:00.000Z' });
  const state = { taskId: 'projection-fixture', contract };
  const journal = { version: 3, policy: 'work-items-v2', taskId: state.taskId, journalSeq: 3, focuses: [], judgments: [], findings: [], progress: [], evidence: [evidence], records: [{ operationId: 'lost-transport-return', workItemId: 'files', nodeId: 'coordinator-node', runId: 'previous-run', planEpoch: 1, journalSeq: 2, effect: 'commit', resources: [{ key: resourceKey, access: 'write' }], commit: { effectKey }, deliveryState: 'dispatched', effectState: status, evidenceIds: [], reconciliationEvidenceIds: [evidence.id] }] };
  const view = contractRuntimeView(state, journal), completion = contractCompletionStatus(state, journal);
  assert.equal(view.operations[0].deliveryState, 'dispatched');
  assert.equal(view.operations[0].effectState, status);
  assert.deepEqual(view.unresolved, []);
  assert.equal(completion.complete, status === 'confirmed');
  assert.notEqual(completion.outcome, 'uncertain');
});

// These two race tests isolate the host admission boundary with a trusted
// adapter double. They emit no external confirmation or fabricated outcome.
const raceOrigin = 'origin:https://fixture.invalid';
const digest = value => createHash('sha256').update(value).digest('hex');
const commitDescriptor = item => {
  const target = item.arguments.target;
  return { version: 1, effect: 'commit', resources: [{ key: 'form:' + target, access: 'write', scopeKeys: [raceOrigin] }], operationKey: digest('operation:' + target),
    commit: { effectKey: digest('effect:' + target), destinationKey: 'https://fixture.invalid/' + target, formKey: 'form:' + target, documentKey: 'document:' + target, payloadDigest: digest('payload:' + target), attachmentDigests: [] } };
};
const raceAdapter = { describeOperation: async item => commitDescriptor(item) };

test('an adopted condition blocks the next commitment until this run records its own evidence', async t => {
  const f = await fixture(t, { operationAdapter: () => raceAdapter, contract: ({ key }) => {
    const value = draft([key]);
    value.workItems[0].effects = ['observe'];
    value.criteria.push({ id: 'receipt', kind: 'external-confirmation', description: 'Verify the external result.' });
    value.workItems.push({ id: 'commit', title: 'Commit result', objective: 'Use the current input.', owner: 'coordinator',
      resourceKeys: [raceOrigin], effects: ['commit'], dependsOn: ['files'], criterionIds: ['receipt'] });
    return value;
  } });
  const original = await f.tasks.get(f.taskId), { planEpoch, ...contract } = original.contract;
  await f.tasks.setContract(f.taskId, contract, { expectedRevision: original.revision, schemaVersion: 14, adoption: {
    runId: f.runId, planRef: { cycleId: 'first-occurrence' }, freshEvidence: true,
    requiredCriterionIds: ['checked'], commitPrerequisiteIds: ['checked']
  } });
  await f.send(call('relay_task', { action: 'read' }));
  const submit = call('fixture_commit', { action: 'submit', target: 'after-current-check' });
  assert.equal((await f.guard.before(submit)).code, 'TASK_CONTRACT_PREREQUISITE');
  const observe = () => call('relay_workspace', { action: 'read', path: 'input.txt' });
  assert.equal((await f.send(observe())).success, true);
  const assess = evidenceId => call('relay_task', { action: 'assess', expectedPlanEpoch: planEpoch, workItemId: 'files',
    criterionId: 'checked', judgment: 'satisfied', note: 'Current fixture input satisfies the condition.', evidenceIds: [evidenceId] });
  const prior = await readContractJournal(f.tasks, f.taskId);
  assert.equal((await f.send(assess(prior.evidence[0].id))).success, true);
  const first = await f.tasks.get(f.taskId);
  assert.equal(first.contractRuntime.criteria.find(row => row.id === 'checked').satisfied, true);

  const runId = 'next-run';
  await f.tasks.setContract(f.taskId, contract, { expectedRevision: first.revision, schemaVersion: 14, adoption: {
    ...first.contractAdoption, runId, planRef: { cycleId: 'next-occurrence' }
  } });
  const second = await f.tasks.get(f.taskId);
  assert.equal(second.contractRuntime.criteria.find(row => row.id === 'checked').satisfied, false);
  const next = await createPlanningWorkerGuard({ store: f.tasks, taskId: f.taskId, runId, nodeId: f.nodeId,
    cwd: f.cwd, schemaVersion: 14, executionGuardrails: true, coordinator: true,
    getOperationAdapter: item => item.name === 'relay_workspace' ? f.workspace : raceAdapter });
  t.after(() => next.finish('finished'));
  const handler = createTaskToolHandler({ store: f.tasks, taskId: f.taskId, runId, nodeId: f.nodeId, schemaVersion: 14 });
  const read = call('relay_task', { action: 'read' });
  next.observeToolDelivery({ call: read, result: await handler(read) });
  assert.equal((await next.before(submit)).code, 'TASK_CONTRACT_PREREQUISITE');
  assert.equal((await readContractJournal(f.tasks, f.taskId)).records.length, prior.records.length);

  const inspection = observe();
  assert.equal(await next.before(inspection), null);
  const observation = await f.workspace(inspection, next.dispatchContext(inspection));
  await next.annotate(inspection, observation);
  const fresh = await readContractJournal(f.tasks, f.taskId);
  const evidence = fresh.evidence.find(row => row.operationId === fresh.records.find(record => record.runId === runId).operationId);
  assert.equal((await handler(assess(evidence.id))).success, true);
  assert.equal(await next.before(submit), null);
  await next.dispatchContext(submit).onOperationDispatch(commitDescriptor(submit));
  assert.equal((await readContractJournal(f.tasks, f.taskId)).records.at(-1).deliveryState, 'dispatched');
});

test('concurrent live reservations cannot both occupy the last outcome slot, and dispatch excludes its own slot', async t => {
  const value = draft([raceOrigin]); value.criteria = [{ id: 'checked', kind: 'external-confirmation', resourceKey: raceOrigin, targetCount: 1, description: 'Exactly one distinct outcome is requested.' }];
  const f = await fixture(t, { contract: value, operationAdapter: () => raceAdapter });
  const calls = ['first', 'second'].map(target => call('fixture_commit', { action: 'submit', target }));
  const results = await Promise.all(calls.map(item => f.guard.before(item)));
  assert.equal(results.filter(result => result === null).length, 1);
  assert.equal(results.find(result => result)?.code, 'TASK_CONTRACT_OUTCOME_PENDING');
  const admitted = calls[results.findIndex(result => result === null)];
  await f.guard.dispatchContext(admitted).onOperationDispatch(commitDescriptor(admitted));
  assert.equal((await readContractJournal(f.tasks, f.taskId)).records.length, 1);
  assert.equal((await f.tasks.get(f.taskId)).contractRuntime.outcomes.length, 0);
});

test('a newly observed source version invalidates a queued commit prerequisite at actual dispatch', async t => {
  const f = await fixture(t, { operationAdapter: () => raceAdapter, contract: async ({ key, cwd }) => {
    const source = await describeHostOperation(call('relay_workspace', { action: 'read', path: 'input.txt' }), { cwd });
    const resourceKey = source.resources.find(row => row.key.startsWith('path:') && row.scopeOnly !== true).key;
    const value = draft([key]); value.criteria = [{ id: 'coverage', kind: 'source-coverage', resourceKey, description: 'Read the complete current source.' }, { id: 'checked', kind: 'external-confirmation', resourceKey: raceOrigin, targetCount: 1, description: 'A confirmed outcome follows current-source review.' }];
    value.workItems[0].criterionIds = ['coverage']; value.workItems[0].effects = ['observe'];
    value.workItems.push({ id: 'commit', title: 'Commit result', objective: 'Use the complete current input.', owner: 'coordinator', resourceKeys: [raceOrigin], effects: ['commit'], dependsOn: ['files'], criterionIds: ['checked'] }); return value;
  } });
  await f.send(call('relay_workspace', { action: 'read', path: 'input.txt' }));
  const initial = await f.tasks.get(f.taskId); assert.equal(initial.contractRuntime.criteria.find(row => row.id === 'coverage').satisfied, true);
  const item = call('fixture_commit', { action: 'submit', target: 'after-review' }); assert.equal(await f.guard.before(item), null);
  await fs.writeFile(path.join(f.cwd, 'input.txt'), 'changed first line\nnew unseen second line\nnew unseen third line\n');
  await f.send(call('relay_workspace', { action: 'read', path: 'input.txt', startLine: 1, lineCount: 1 }));
  const current = await f.tasks.get(f.taskId); assert.equal(current.contract.planEpoch, initial.contract.planEpoch); assert.equal(current.contractRuntime.criteria.find(row => row.id === 'coverage').satisfied, false);
  await assert.rejects(f.guard.dispatchContext(item).onOperationDispatch(commitDescriptor(item)), { code: 'TASK_CONTRACT_PREREQUISITE' });
  await f.guard.annotate(item, { success: false, code: 'TASK_CONTRACT_PREREQUISITE', actionDispatched: false, contentItems: [] });
  const operation = (await readContractJournal(f.tasks, f.taskId)).records.find(row => row.tool === 'fixture_commit');
  assert.equal(operation.deliveryState, 'cancelled-before-dispatch'); assert.equal(operation.effectState, 'absent');
});

test('host shared admission runs inside native canonical dispatch lock after original guard checks',async t=>{
 const f=await fixture(t),item=call('relay_workspace',{action:'list',path:'.'});
 assert.equal(await f.guard.before(item,{}),null);const context=f.guard.dispatchContext(item,{});
 assert.equal(context.canonicalAdmission,true);let admitted=0;
 await context.onOperationDispatch(context.operationDescriptor,{onAdmission:async({state,operation})=>{
  assert.ok(f.tasks.lockOwners.has(f.taskId));assert.equal(state.taskId,f.taskId);assert.equal(operation.deliveryState,'reserved');admitted++;
 }});
 assert.equal(admitted,1);assert.equal((await readContractJournal(f.tasks,f.taskId)).records.at(-1).deliveryState,'dispatched');
});
test('native stale plan rejects before shared admission and cannot mark effect dispatched',async t=>{
 const f=await fixture(t),item=call('relay_workspace',{action:'list',path:'.'});
 assert.equal(await f.guard.before(item,{}),null);const context=f.guard.dispatchContext(item,{});
 const state=await f.tasks.get(f.taskId),contract=structuredClone(state.contract);delete contract.planEpoch;contract.workItems[0].objective='A changed relevant instruction';
 await f.tasks.setContract(f.taskId,contract,{expectedRevision:state.revision,schemaVersion:14,runId:f.runId,nodeId:f.nodeId});
 let admitted=0;await assert.rejects(context.onOperationDispatch(context.operationDescriptor,{onAdmission:()=>{admitted++;}}),{code:'TASK_CONTRACT_REVIEW_REQUIRED'});
 assert.equal(admitted,0);assert.equal((await readContractJournal(f.tasks,f.taskId)).records.at(-1).deliveryState,'reserved');
});
test('shared admission denial leaves original native reservation undispatched',async t=>{
 const f=await fixture(t),item=call('relay_workspace',{action:'list',path:'.'});
 assert.equal(await f.guard.before(item,{}),null);const context=f.guard.dispatchContext(item,{});
 await assert.rejects(context.onOperationDispatch(context.operationDescriptor,{onAdmission:()=>{throw Object.assign(Error('shared conflict'),{code:'SHARED_CONFLICT'});}}),{code:'SHARED_CONFLICT'});
 assert.equal((await readContractJournal(f.tasks,f.taskId)).records.at(-1).deliveryState,'reserved');
});
