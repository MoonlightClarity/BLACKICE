import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskStateStore, createTaskToolHandler } from '../lib/task-state.mjs';
import { createPlanningWorkerGuard, wrapPlanningToolHandler } from '../lib/planning-awareness.mjs';

const body = receipt => JSON.parse(receipt.contentItems[0].text);
const leaf = (id, status = 'pending', action = 'write') => ({ id, title: `Perform ${id}`, kind: 'action', status,
  result: `The ${id} fixture result.`, note: `Perform the specified ${id} operation against the fixture target.`,
  doneWhen: `The ${id} operation's actual returned result has been checked.`,
  operation: { kind: 'tool', tool: 'relay_workspace', action, target: `${id}.txt` } });
const call = (id, action = 'write') => ({ callId: id, name: 'relay_workspace', arguments: { action, path: `${id}.txt`, text: id } });
const success = () => ({ success: true, contentItems: [{ type: 'inputText', text: '{"result":"actual fixture result"}' }] });
async function fixture(t, { steps = [leaf('first', 'active'), leaf('second')], layout = 'sequence', schemaVersion = 8, sequentialEnabled = true } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-sequential-')), cwd = path.join(directory, 'work'); await mkdir(cwd);
  const stores = [], guards = []; let store = await new TaskStateStore({ dataDir: directory }).init(); stores.push(store);
  let current = await store.ensure({ taskId: 'task-one', runId: 'run-one', cwd, goal: 'Execute concrete fixture operations one at a time.', defaultPlan: true });
  current = await store.setPlan('task-one', { plan: { layout }, steps }, { expectedRevision: current.revision, schemaVersion: 8, runId: 'run-one', nodeId: 'agent' });
  let effects = 0;
  const fixture = { directory, cwd, get store() { return store; }, get effects() { return effects; },
    async guard(nodeId = `worker-${guards.length + 1}`, execute = async value => {
      effects++; await writeFile(path.join(cwd, value.arguments.path), value.arguments.text || 'read observed'); return success();
    }, runId = 'run-one') {
      const guard = await createPlanningWorkerGuard({ store, taskId: 'task-one', runId, nodeId, sequentialEnabled, schemaVersion, executionGuardrails: true }); guards.push(guard);
      const task = createTaskToolHandler({ store, taskId: 'task-one', runId, nodeId, schemaVersion, executionGuardrails: true });
      const dispatch = wrapPlanningToolHandler(guard, async (value, context) => {
        const denied = await guard.before(value, context); if (denied) return denied;
        if (value.name === 'relay_task') return guard.after(value, await task(value, context));
        return execute(value, context);
      });
      const taskCall = async args => { const receipt = await dispatch({ name: 'relay_task', arguments: args }); assert.equal(receipt.success, true, receipt.contentItems[0].text); return body(receipt); };
      return { dispatch, task: taskCall, guard };
    },
    async reopen() { await store.close(); store = await new TaskStateStore({ dataDir: directory }).init(); stores.push(store); },
    sequenceFile() { return `${store.file('task-one')}.sequence`; },
  };
  t.after(async () => { for (const guard of guards) guard.finish('completed'); for (const item of stores) await item.close(); await rm(directory, { recursive: true, force: true }); });
  return fixture;
}

test('pending-only and simultaneous active leaves never reach an operational handler', async t => {
  for (const steps of [[leaf('first')], [leaf('first', 'active'), leaf('second', 'active')]]) {
    const f = await fixture(t, { steps, layout: 'parallel' }), worker = await f.guard();
    const rejected = await worker.dispatch(call('unplanned'));
    assert.equal(rejected.code, 'TASK_PLAN_ACTIVE_STEP_REQUIRED'); assert.equal(f.effects, 0);
    await assert.rejects(readFile(path.join(f.cwd, 'unplanned.txt')), { code: 'ENOENT' });
  }
});

test('one operation requires actual result reconciliation before activating the next leaf', async t => {
  const f = await fixture(t), worker = await f.guard();
  assert.equal((await worker.dispatch(call('first'))).success, true);
  assert.equal((await worker.dispatch(call('repeated'))).code, 'TASK_PLAN_RESULT_REQUIRED');
  assert.equal(f.effects, 1);
  let state = await worker.task({ action: 'read' });
  assert.equal(state.steps.find(step => step.id === 'first').status, 'active', 'A successful tool never marks its leaf done.');
  state = await worker.task({ action: 'step', expectedRevision: state.revision, stepId: 'first', status: 'done', evidence: 'The actual first fixture write returned the expected result.' });
  state = await worker.task({ action: 'step', expectedRevision: state.revision, stepId: 'second', status: 'active' });
  assert.equal((await worker.dispatch(call('second'))).success, true);
  assert.equal(f.effects, 2);
});

test('a saved revision alone does not reconcile or replay a completed call', async t => {
  const f = await fixture(t), worker = await f.guard();
  await worker.dispatch(call('first'));
  let state = await worker.task({ action: 'read' });
  state = await worker.task({ action: 'edit', expectedRevision: state.revision, operations: [{ type: 'metadata', patch: { focusStepId: 'first' } }] });
  assert.equal((await worker.dispatch(call('do-not-repeat'))).code, 'TASK_PLAN_RESULT_REQUIRED');
  assert.equal(f.effects, 1);
});

test('concurrent guards reserve one task operation atomically', async t => {
  const f = await fixture(t); let enter, release, executions = 0;
  const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; });
  const first = await f.guard('first-worker', async () => { executions++; enter(); await held; return success(); });
  const other = await f.guard('other-worker', async () => { executions++; return success(); });
  const running = first.dispatch(call('long-operation')); await entered;
  try {
    const rejected = await other.dispatch(call('concurrent-operation'));
    assert.equal(rejected.code, 'TASK_PLAN_STEP_IN_FLIGHT'); assert.equal(executions, 1);
  } finally { release(); }
  assert.equal((await running).success, true);
});

test('a live operation cannot be completed or skipped before its actual result returns', async t => {
  const f = await fixture(t); let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; });
  const worker = await f.guard('held-worker', async () => { enter(); await held; return success(); });
  const running = worker.dispatch(call('held')); await entered;
  try {
    const state = await f.store.get('task-one');
    for (const patch of [{ status: 'done', evidence: 'The still-running effect is claimed complete.' }, { status: 'skipped', skipReason: 'The still-running effect is claimed skipped.' }]) {
      await assert.rejects(f.store.setStep('task-one', 'first', patch, { expectedRevision: state.revision, source: 'human', executionGuardrails: true }), { code: 'TASK_PLAN_STEP_IN_FLIGHT' });
      assert.equal((await f.store.get('task-one')).revision, state.revision);
    }
    const blocked = await f.store.setStep('task-one', 'first', { status: 'blocked', blockedReason: 'The actual running call has not returned yet.' }, { expectedRevision: state.revision, source: 'human', executionGuardrails: true });
    assert.equal(blocked.steps[0].status, 'blocked', 'An honest stop or uncertainty record remains available.');
  } finally { release(); }
  assert.equal((await running).success, true);
  const current = await worker.task({ action: 'read' });
  const completed = await worker.task({ action: 'step', expectedRevision: current.revision, stepId: 'first', status: 'done', evidence: 'The actual held operation has now returned success.' });
  assert.equal(completed.steps[0].status, 'done');
});

test('failure and thrown errors return to planning without manufacturing completion', async t => {
  for (const throws of [false, true]) {
    const f = await fixture(t), worker = await f.guard('worker', async () => {
      if (throws) throw Object.assign(new Error('The fixture operation failed.'), { code: 'WORKSPACE_FIXTURE_FAILURE' });
      return { success: false, code: 'WORKSPACE_FIXTURE_FAILURE', contentItems: [{ type: 'inputText', text: 'The fixture operation failed.' }] };
    });
    if (throws) await assert.rejects(worker.dispatch(call('first')), /fixture operation failed/);
    else assert.equal((await worker.dispatch(call('first'))).success, false);
    const state = await worker.task({ action: 'read' });
    assert.equal(state.steps.find(step => step.id === 'first').status, 'active');
    assert.equal((await worker.dispatch(call('blind-retry'))).code, 'TASK_PLAN_RESULT_REQUIRED');
    const ledger = JSON.parse(await readFile(f.sequenceFile(), 'utf8'));
    assert.equal(ledger.records[0].status, throws ? 'running' : 'returned'); assert.equal(ledger.records[0].success, throws ? undefined : false);
  }
});

test('restart preserves the need to reconcile the previous operation', async t => {
  const f = await fixture(t), first = await f.guard(); await first.dispatch(call('first')); first.guard.finish('completed');
  await f.reopen(); const resumed = await f.guard();
  assert.equal((await resumed.dispatch(call('restart-replay'))).code, 'TASK_PLAN_RESULT_REQUIRED');
  assert.equal(f.effects, 1);
});

test('interrupted work can use a planned read-only reconciliation after uncertainty is recorded', async t => {
  const f = await fixture(t, { layout: 'parallel', steps: [leaf('uncertain', 'active'), leaf('inspect', 'pending', 'read'), leaf('next')] });
  const initial = await f.store.get('task-one');
  await writeFile(f.sequenceFile(), JSON.stringify({ version: 1, taskId: 'task-one', records: [{ stepId: 'uncertain', attempt: 1, token: 'interrupted-token', callId: 'lost-call', runId: 'old-run', nodeId: 'old-worker', planRevision: initial.revision, status: 'running', startedAt: new Date().toISOString(), pid: 2147483647 }] }));
  const worker = await f.guard();
  assert.equal((await worker.dispatch(call('no-evidence'))).code, 'TASK_PLAN_RESULT_REQUIRED');
  let state = await worker.task({ action: 'read' });
  state = await worker.task({ action: 'edit', expectedRevision: state.revision, operations: [
    { type: 'update', stepId: 'uncertain', patch: { status: 'blocked', blockedReason: 'The original call may have written the file; its response was lost.', evidence: 'Dispatch was recorded but no result was received before restart.' } },
    { type: 'update', stepId: 'inspect', patch: { status: 'active' } },
  ] });
  assert.equal((await worker.dispatch(call('must-not-write'))).code, 'TASK_PLAN_OPERATION_MISMATCH');
  assert.equal((await worker.dispatch(call('inspect', 'read'))).success, true);
  assert.equal((await f.store.get('task-one')).steps.find(step => step.id === 'uncertain').status, 'blocked');
});

test('Planning Off does not add dispatch reservations or a new operation requirement', async t => {
  const f = await fixture(t, { steps: [leaf('first')], sequentialEnabled: false }), worker = await f.guard();
  assert.equal((await worker.dispatch(call('first'))).success, true);
  assert.equal((await worker.dispatch(call('again'))).success, true);
  assert.equal(f.effects, 2); await assert.rejects(readFile(f.sequenceFile()), { code: 'ENOENT' });
});

test('one attempt cannot dispatch a second call after its result has been reported', async t => {
  const f = await fixture(t, { layout: 'parallel' }), worker = await f.guard();
  await worker.dispatch(call('first'));
  let state = await worker.task({ action: 'read' });
  state = await worker.task({ action: 'step', expectedRevision: state.revision, stepId: 'first', status: 'blocked', blockedReason: 'The returned operation needs a revised follow-up.' });
  state = await worker.task({ action: 'step', expectedRevision: state.revision, stepId: 'first', status: 'active' });
  assert.equal((await worker.dispatch(call('same-attempt'))).code, 'TASK_PLAN_REPLAN_REQUIRED');
  assert.equal(f.effects, 1);
});

test('schema 9 binds an operation to the planned tool and action, including reasoning leaves', async t => {
  const f = await fixture(t, { schemaVersion: 9 }), worker = await f.guard();
  assert.equal((await worker.dispatch(call('wrong-action', 'read'))).code, 'TASK_PLAN_OPERATION_MISMATCH');
  assert.equal((await worker.dispatch({ ...call('wrong-tool'), name: 'relay_browser' })).code, 'TASK_PLAN_OPERATION_MISMATCH');
  let state = await worker.task({ action: 'read' });
  state = await worker.task({ action: 'edit', expectedRevision: state.revision, operations: [{ type: 'update', stepId: 'first', patch: { operation: { kind: 'reasoning', target: 'Compare the two fixture options.' } } }] });
  assert.equal((await worker.dispatch(call('reasoning-bypass'))).code, 'TASK_PLAN_OPERATION_MISMATCH');
  assert.equal(f.effects, 0);
});

test('explicit revisit opens one new attempt after the actual earlier outcome is saved', async t => {
  const f = await fixture(t, { steps: [leaf('first', 'active')], schemaVersion: 9 }), worker = await f.guard();
  assert.equal((await worker.dispatch(call('first'))).success, true);
  let state = await worker.task({ action: 'read' });
  const premature = await worker.dispatch({ name: 'relay_task', arguments: { action: 'edit', expectedRevision: state.revision, operations: [{ type: 'revisit', stepId: 'first', reason: 'New thinking changes the operation.' }] } });
  assert.equal(premature.code, 'TASK_PLAN_RESULT_REQUIRED');
  state = await worker.task({ action: 'step', expectedRevision: state.revision, stepId: 'first', status: 'done', evidence: 'The first actual write returned its expected fixture result.' });
  state = await worker.task({ action: 'edit', expectedRevision: state.revision, operations: [{ type: 'revisit', stepId: 'first', reason: 'Reassess the earlier checked write under the new requirement.' }] });
  assert.equal(state.steps[0].attempt, 2); assert.equal(state.steps[0].pastAttempts[0].status, 'done');
  state = await worker.task({ action: 'step', expectedRevision: state.revision, stepId: 'first', status: 'active' });
  assert.equal((await worker.dispatch(call('second-attempt'))).success, true);
  assert.equal(f.effects, 2);
});

test('a duplicate concurrent call ID cannot settle the original reservation', async t => {
  const f = await fixture(t); let enter, release, count = 0;
  const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; });
  const worker = await f.guard('worker', async () => { count++; enter(); await held; return success(); });
  const sharedCall = call('same-call-id'), original = worker.dispatch(sharedCall); await entered;
  let duplicateSettled = false;
  const duplicate = worker.dispatch(sharedCall);
  duplicate.then(() => { duplicateSettled = true; }, () => { duplicateSettled = true; });
  try {
    assert.equal((await worker.dispatch({ ...sharedCall, arguments: { ...sharedCall.arguments, text: 'conflicting payload' } })).code, 'TOOL_CALL_ID_CONFLICT');
    assert.equal((await worker.dispatch(call('third-call'))).code, 'TASK_PLAN_STEP_IN_FLIGHT');
    assert.equal(count, 1); assert.equal(duplicateSettled, false, 'An exact replay waits for the original actual result.');
    const saved = JSON.parse(await readFile(f.sequenceFile(), 'utf8'));
    assert.equal(saved.records.length, 1); assert.equal(saved.records[0].status, 'running');
  } finally { release(); }
  const [result, replay] = await Promise.all([original, duplicate]);
  assert.equal(result.success, true); assert.deepEqual(replay, result);
  assert.equal(count, 1, 'The duplicate callback never executes or settles a second operation.');
});

test('an invalid tool response preserves uncertainty and does not leave a live reservation', async t => {
  const f = await fixture(t), worker = await f.guard('worker', async () => undefined);
  const returned = await worker.dispatch(call('invalid-result'));
  assert.equal(returned.code, 'TASK_PLAN_RESULT_UNCONFIRMED');
  assert.equal((await worker.dispatch(call('next'))).code, 'TASK_PLAN_RESULT_REQUIRED');
  const saved = JSON.parse(await readFile(f.sequenceFile(), 'utf8'));
  assert.equal(saved.records[0].status, 'running');
});

for (const claimedDone of [false, true]) test(`an effect followed by AbortError stays uncertain after ${claimedDone ? 'a done claim' : 'a blocked result'} and revisit until actually observed`, async t => {
  const f = await fixture(t, { schemaVersion: 9, layout: 'parallel', steps: [leaf('first', 'active'), leaf('inspect', 'pending', 'read')] });
  let writes = 0;
  const worker = await f.guard('interrupted-worker', async value => {
    if (value.arguments.action === 'read') return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ content: await readFile(path.join(f.cwd, 'effect.txt'), 'utf8') }) }] };
    writes++; await writeFile(path.join(f.cwd, 'effect.txt'), `Actual effect ${writes}`);
    throw Object.assign(Error('Interrupted after the actual effect.'), { name: 'AbortError', code: 'ABORT_ERR' });
  });
  await assert.rejects(worker.dispatch(call('provider-interrupted')), { name: 'AbortError', code: 'ABORT_ERR' });
  const record = JSON.parse(await readFile(f.sequenceFile(), 'utf8')).records[0];
  assert.equal(record.status, 'running'); assert.equal(record.success, undefined);
  let state = await worker.task({ action: 'read' });
  state = await worker.task({ action: 'step', expectedRevision: state.revision, stepId: 'first', ...(claimedDone
    ? { status: 'done', evidence: 'The wrapper threw AbortError; the model claims this completed the action without a fresh observation.' }
    : { status: 'blocked', blockedReason: 'The handler was interrupted after dispatch; its actual effect is unknown.' }) });
  state = await worker.task({ action: 'edit', expectedRevision: state.revision, operations: [{ type: 'revisit', stepId: 'first', reason: 'Reassess the interrupted operation before deciding on a retry.' }] });
  state = await worker.task({ action: 'step', expectedRevision: state.revision, stepId: 'first', status: 'active' });
  assert.equal((await worker.dispatch(call('blind-retry'))).code, 'TASK_PLAN_RECONCILIATION_REQUIRED');
  assert.equal(writes, 1, 'A saved disposition or done claim and new attempt do not establish absence of the earlier effect.');
  state = await worker.task({ action: 'edit', expectedRevision: state.revision, operations: [
    { type: 'update', stepId: 'first', patch: { status: 'pending' } }, { type: 'update', stepId: 'inspect', patch: { status: 'active' } }
  ] });
  const observation = await worker.dispatch(call('observe-interrupted', 'read')); assert.match(observation.contentItems[0].text, /Actual effect 1/);
  await worker.task({ action: 'step', expectedRevision: state.revision, stepId: 'inspect', status: 'done', evidence: 'The actual file read returned Actual effect 1.', reconciliation: { callId: record.callId, outcome: 'confirmed', evidence: 'effect.txt contains the exact first dispatched effect.' } });
  assert.equal(JSON.parse(await readFile(f.sequenceFile(), 'utf8')).records[0].reconciliation.outcome, 'confirmed');
  assert.equal(writes, 1);
});

test('provider call IDs are scoped to run and worker while dispatch IDs remain unambiguous', async t => {
  for (const newRun of [false, true]) {
    const f = await fixture(t, { steps: [leaf('first', 'active'), leaf('second'), leaf('third')] });
    const first = await f.guard('same-worker', async () => success());
    assert.equal((await first.dispatch(call('1'))).success, true);
    let state = await first.task({ action: 'read' });
    state = await first.task({ action: 'step', expectedRevision: state.revision, stepId: 'first', status: 'done', evidence: 'The first actual response was observed.' });
    await first.task({ action: 'step', expectedRevision: state.revision, stepId: 'second', status: 'active' });
    const second = await f.guard(newRun ? 'same-worker' : 'other-worker', async () => success(), newRun ? 'run-two' : 'run-one');
    assert.equal((await second.dispatch(call('1'))).success, true, 'A new run or worker may receive the same raw provider ID.');
    const records = JSON.parse(await readFile(f.sequenceFile(), 'utf8')).records;
    assert.equal(records[0].providerCallId, '1'); assert.equal(records[1].providerCallId, '1'); assert.notEqual(records[0].callId, records[1].callId);
    state = await second.task({ action: 'read' });
    state = await second.task({ action: 'step', expectedRevision: state.revision, stepId: 'second', status: 'done', evidence: 'The second actual response was observed.' });
    await second.task({ action: 'step', expectedRevision: state.revision, stepId: 'third', status: 'active' });
    const replay = await second.dispatch(call('1'));
    assert.equal(replay.success, true, 'An exact same-scope replay returns its original settled receipt.');
    assert.equal((await second.dispatch(call('1', 'read'))).code, 'TOOL_CALL_ID_CONFLICT', 'A changed payload cannot reuse the original callback ID.');
    assert.equal(JSON.parse(await readFile(f.sequenceFile(), 'utf8')).records.length, 2, 'The replay and conflict create no additional dispatch.');
    assert.equal((await f.store.get('task-one')).steps.find(step => step.id === 'third').status, 'active', 'The old receipt cannot complete newly active work.');
  }
});

test('observed absence resolves a lost result without falsely completing its failed effect', async t => {
  const f = await fixture(t, { schemaVersion: 9, layout: 'parallel', steps: [leaf('uncertain', 'active'), leaf('inspect', 'pending', 'read')] });
  const original = await f.store.get('task-one');
  await writeFile(f.sequenceFile(), JSON.stringify({ version: 1, taskId: 'task-one', records: [{ stepId: 'uncertain', attempt: 1, token: 'lost-token', callId: 'lost-call', runId: 'old-run', nodeId: 'old-worker', planRevision: original.revision, status: 'running', startedAt: new Date().toISOString(), pid: 2147483647, tool: 'relay_workspace', action: 'write' }] }));
  let observations = 0, writes = 0;
  const worker = await f.guard('worker', async value => {
    if (value.arguments.action === 'read') {
      observations++;
      await assert.rejects(readFile(path.join(f.cwd, 'uncertain.txt')), { code: 'ENOENT' });
      return { success: true, contentItems: [{ type: 'inputText', text: '{"exists":false}' }] };
    }
    writes++; await writeFile(path.join(f.cwd, 'uncertain.txt'), 'The new planned attempt.'); return success();
  });
  let state = await worker.task({ action: 'read' });
  state = await worker.task({ action: 'edit', expectedRevision: state.revision, operations: [
    { type: 'update', stepId: 'uncertain', patch: { status: 'blocked', blockedReason: 'The original response was lost; its effect must be observed.', evidence: 'Only a dispatch record was recovered.' } },
    { type: 'update', stepId: 'inspect', patch: { status: 'active' } },
  ] });
  assert.equal((await worker.dispatch(call('absence-observation', 'read'))).success, true);
  const claim = { action: 'step', expectedRevision: state.revision, stepId: 'inspect', status: 'done', evidence: 'The actual filesystem read establishes that uncertain.txt is absent.',
    reconciliation: { evidence: '  A fresh filesystem read returned ENOENT for uncertain.txt.  ', outcome: 'absent', callId: 'lost-call' } };
  const invalid = await worker.dispatch({ name: 'relay_task', arguments: { ...claim, reconciliation: { ...claim.reconciliation, callId: 'invented-call' } } });
  assert.equal(invalid.code, 'TASK_PLAN_RECONCILIATION_INVALID');
  assert.equal((await f.store.get('task-one')).revision, state.revision, 'An invalid reconciliation must not save the plan write.');
  state = await worker.task(claim);
  assert.equal(state.steps.find(step => step.id === 'uncertain').status, 'blocked', 'Observed absence is not the requested successful write.');
  const reconciled = JSON.parse(await readFile(f.sequenceFile(), 'utf8'));
  assert.equal(reconciled.records.find(record => record.callId === 'lost-call').reconciliation.outcome, 'absent');
  state = await worker.task({ action: 'edit', expectedRevision: state.revision, operations: [{ type: 'revisit', stepId: 'uncertain', reason: 'Fresh observation established no prior effect; perform the planned write as a new attempt.' }] });
  state = await worker.task({ action: 'step', expectedRevision: state.revision, stepId: 'uncertain', status: 'active' });
  assert.equal((await worker.dispatch(call('new-write'))).success, true);
  assert.equal(observations, 1); assert.equal(writes, 1);
  assert.equal(state.steps.find(step => step.id === 'uncertain').pastAttempts[0].status, 'blocked');
});

for (const failedObservation of [false, true]) test(`a ${failedObservation ? 'failed observation' : 'mutation'} cannot be declared reconciliation evidence`, async t => {
  const f = await fixture(t, { schemaVersion: 9, steps: [leaf('first', 'active'), leaf('second', 'pending', failedObservation ? 'read' : 'write')] });
  const worker = await f.guard('worker', async value => value.arguments.action === 'read' ? { success: false, contentItems: [{ type: 'inputText', text: 'The observation failed.' }] } : success());
  await worker.dispatch(call('first'));
  const firstRecord = JSON.parse(await readFile(f.sequenceFile(), 'utf8')).records[0];
  let state = await worker.task({ action: 'read' });
  state = await worker.task({ action: 'step', expectedRevision: state.revision, stepId: 'first', status: 'done', evidence: 'The first operation returned its actual saved path.' });
  state = await worker.task({ action: 'step', expectedRevision: state.revision, stepId: 'second', status: 'active' });
  await worker.dispatch(call('second', failedObservation ? 'read' : 'write'));
  const rejected = await worker.dispatch({ name: 'relay_task', arguments: { action: 'step', expectedRevision: state.revision, stepId: 'second', status: 'done', evidence: 'The second actual call returned its receipt.', reconciliation: { callId: firstRecord.callId, outcome: 'confirmed', evidence: 'The second call allegedly confirms the first.' } } });
  assert.equal(rejected.code, 'TASK_PLAN_RECONCILIATION_INVALID');
  assert.equal((await f.store.get('task-one')).steps.find(step => step.id === 'second').status, 'active');
});
