import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStateStore } from '../lib/task-state.mjs';
import { normalizeTaskPlan, taskPlanAvailability, taskPlanProgress } from '../lib/task-plan.mjs';
import { applyPlanningEdits } from '../lib/planning-edits.mjs';
import { validatePlanningOutline } from '../lib/planning-policy.mjs';
import { createSequentialPlanningGuard } from '../lib/planning-sequence.mjs';

const payload = receipt => JSON.parse(receipt.contentItems[0].text);
const action = (id, { parentId = null, status = 'pending', dependsOn = [] } = {}) => ({
  id, title: 'Check ' + id, kind: 'action', parentId, status, dependsOn,
  result: 'The checked value for ' + id + '.', note: 'Compare the supplied ' + id + ' value with its recorded reference.',
  doneWhen: 'The ' + id + ' comparison yields its match or exact discrepancy.',
  operation: { kind: 'reasoning', target: 'The ' + id + ' comparison' },
  ...(status === 'done' ? { evidence: 'The ' + id + ' value matched the supplied reference.' } : {}),
});
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'blackice-recursive-integration-'));
  const store = await new TaskStateStore({ dataDir: directory }).init(), taskId = 'recursive-integration';
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const initial = await store.ensure({ taskId, runId: 'run', nodeId: 'agent', cwd: directory, goal: 'Perform and revise the requested work.', defaultPlan: true });
  return { directory, store, taskId, initial };
}

test('returning to an earlier prerequisite can change Boolean paths while invalidating only affected chronological work', () => {
  const state = { taskId: 'saved', revision: 7, artifacts: [], ...normalizeTaskPlan({
    plan: { layout: 'parallel', facts: [{ id: 'ready', value: true, evidence: 'The first inspection found the input ready.' }] },
    steps: [
      { id: 'chain', title: 'Check and apply the selected path', kind: 'sequence' },
      action('source', { parentId: 'chain', status: 'done' }),
      { id: 'decision', parentId: 'chain', title: 'Use the observed readiness', kind: 'choice', branch: { if: { fact: 'ready' }, then: 'use', else: 'repair' } },
      action('use', { parentId: 'decision', status: 'done' }),
      action('repair', { parentId: 'decision' }),
      action('after', { parentId: 'chain', status: 'done' }),
      action('independent', { status: 'done' }),
    ],
  }) };
  const before = structuredClone(state), next = applyPlanningEdits(state, { operations: [
    { type: 'revisit', stepId: 'source', reason: 'A new observation contradicted the initial readiness result.' },
    { type: 'metadata', patch: { facts: [{ id: 'ready', value: false, evidence: 'The later inspection found an incomplete input.' }] } },
  ] });
  validatePlanningOutline(next, { mode: 'on', executionGuardrails: true, previous: state, schemaVersion: 9 });
  const byId = new Map(next.steps.map(step => [step.id, step]));
  assert.equal(byId.get('source').status, 'pending');
  assert.equal(byId.get('source').attempt, 2);
  assert.equal(byId.get('decision').selectedChildId, 'repair');
  assert.equal(byId.get('use').status, 'pending', 'an excluded prior path is preserved, not a live blocker');
  assert.equal(byId.get('use').pastAttempts[0].status, 'done');
  assert.equal(byId.get('use').pastAttempts[0].evidence, before.steps.find(step => step.id === 'use').evidence);
  assert.equal(byId.get('after').status, 'blocked');
  assert.match(byId.get('after').blockedReason, /Earlier step source/);
  assert.equal(byId.get('after').pastAttempts[0].status, 'done');
  assert.deepEqual(byId.get('independent'), before.steps.find(step => step.id === 'independent'));
  assert.equal(taskPlanAvailability(next).byId.use.state, 'unselected');
  assert.equal(taskPlanAvailability(next).byId.source.state, 'ready');
  assert.equal(taskPlanProgress(next).complete, false);
  assert.deepEqual(state, before, 'the historical input snapshot is not rewritten');
});

test('actual returned work must be reconciled before revisit can archive its attempt', async t => {
  const f = await fixture(t), options = { schemaVersion: 9, executionGuardrails: true, planningMode: 'on' };
  const read = { ...action('read'), status: 'active', operation: { kind: 'tool', tool: 'relay_workspace', action: 'read', target: 'source.txt' } };
  let state = await f.store.setPlan(f.taskId, { plan: { layout: 'sequence' }, steps: [read] }, { ...options, expectedRevision: f.initial.revision });
  const guard = createSequentialPlanningGuard({ executionGuardrails: true, store: f.store, taskId: f.taskId, runId: 'run', nodeId: 'agent' });
  const call = { name: 'relay_workspace', callId: 'read-one', arguments: { action: 'read', path: 'source.txt' } };
  assert.equal(await guard.before(call, { expectedRevision: state.revision }), null);
  await guard.after(call, { success: true, contentItems: [{ type: 'inputText', text: 'Observed source text.' }] });
  await assert.rejects(f.store.editPlan(f.taskId, { operations: [{ type: 'revisit', stepId: 'read', reason: 'Reread after thinking.' }] }, { ...options, expectedRevision: state.revision }), /outcome|reconcil|active/i);
  assert.equal((await f.store.get(f.taskId)).revision, state.revision, 'an invalid revisit cannot strand the dispatch in immutable history');
  state = await f.store.setStep(f.taskId, 'read', { status: 'done', evidence: 'The returned source text was present and readable.' }, { ...options, expectedRevision: state.revision });
  state = await f.store.editPlan(f.taskId, { operations: [{ type: 'revisit', stepId: 'read', reason: 'Inspect the changed source in another attempt.' }] }, { ...options, expectedRevision: state.revision });
  assert.equal(state.steps[0].attempt, 2);
  assert.equal(state.steps[0].pastAttempts[0].evidence, 'The returned source text was present and readable.');
  state = await f.store.setStep(f.taskId, 'read', { status: 'active' }, { ...options, expectedRevision: state.revision });
  const repeated = { ...call, callId: 'read-two' };
  assert.equal(await guard.before(repeated, { expectedRevision: state.revision }), null);
  await guard.after(repeated, { success: true, contentItems: [{ type: 'inputText', text: 'Changed source text.' }] });
});

test('returning to a prerequisite cannot archive a dependent operation that is still active', async t => {
  const f = await fixture(t), options = { schemaVersion: 9, executionGuardrails: true, planningMode: 'on' };
  let state = await f.store.setPlan(f.taskId, { plan: { layout: 'sequence' }, steps: [
    action('earlier', { status: 'done' }),
    { ...action('read', { status: 'active' }), operation: { kind: 'tool', tool: 'relay_workspace', action: 'read', target: 'source.txt' } },
  ] }, { ...options, source: 'human', expectedRevision: f.initial.revision });
  const guard = createSequentialPlanningGuard({ executionGuardrails: true, store: f.store, taskId: f.taskId, runId: 'run', nodeId: 'agent' });
  const call = { name: 'relay_workspace', callId: 'dependent-read', arguments: { action: 'read', path: 'source.txt' } };
  assert.equal(await guard.before(call, { expectedRevision: state.revision }), null);
  const revisit = () => f.store.editPlan(f.taskId, { operations: [{ type: 'revisit', stepId: 'earlier', reason: 'New evidence changes the prerequisite.' }] }, { ...options, source: 'human', expectedRevision: state.revision });
  await assert.rejects(revisit(), /outcome|reconcil|active/i, 'a live dependent attempt must remain recoverable even for a human edit');
  await guard.after(call, { success: true, contentItems: [{ type: 'inputText', text: 'Observed dependent source text.' }] });
  await assert.rejects(revisit(), /outcome|reconcil|active/i, 'a returned result still needs its disposition saved before archiving');
  assert.equal((await f.store.get(f.taskId)).revision, state.revision);
  state = await f.store.setStep(f.taskId, 'read', { status: 'done', evidence: 'The dependent source text returned its actual value.' }, { ...options, expectedRevision: state.revision });
  state = await revisit();
  assert.equal(state.steps.find(step => step.id === 'earlier').status, 'pending');
  const dependent = state.steps.find(step => step.id === 'read');
  assert.equal(dependent.status, 'blocked');
  assert.equal(dependent.attempt, 2);
  assert.equal(dependent.pastAttempts[0].status, 'done');
  assert.equal(dependent.pastAttempts[0].evidence, 'The dependent source text returned its actual value.');
});

test('replanning preserves dispatched work until its actual result has been reconciled', async t => {
  const f = await fixture(t), options = { schemaVersion: 9, executionGuardrails: true, planningMode: 'on' };
  const read = { ...action('read', { status: 'active' }), operation: { kind: 'tool', tool: 'relay_workspace', action: 'read', target: 'source.txt' } };
  let state = await f.store.setPlan(f.taskId, { plan: { layout: 'sequence' }, steps: [read] }, { ...options, expectedRevision: f.initial.revision });
  const guard = createSequentialPlanningGuard({ executionGuardrails: true, store: f.store, taskId: f.taskId, runId: 'run', nodeId: 'agent' });
  const call = { name: 'relay_workspace', callId: 'before-replan', arguments: { action: 'read', path: 'source.txt' } };
  assert.equal(await guard.before(call, { expectedRevision: state.revision }), null);
  const replace = () => f.store.setPlan(f.taskId, { plan: { layout: 'sequence' }, steps: [action('replacement', { status: 'active' })] }, { ...options, source: 'human', expectedRevision: state.revision });
  const expand = () => f.store.setPlan(f.taskId, { plan: { layout: 'sequence' }, steps: [action('child', { status: 'active' })] }, { ...options, scopeStepId: 'read', expectedRevision: state.revision });
  const error = /dispatched|unresolved|reconcil|definition|result|in.flight/i;
  await assert.rejects(replace(), error, 'a live operation cannot lose its saved leaf during a human replan');
  await assert.rejects(expand(), error, 'a live dispatched leaf cannot become a group');
  await guard.after(call, { success: true, contentItems: [{ type: 'inputText', text: 'The observed source text.' }] });
  await assert.rejects(replace(), error, 'a returned operation still needs its actual disposition');
  await assert.rejects(expand(), error);
  assert.equal((await f.store.get(f.taskId)).revision, state.revision);
  state = await f.store.setStep(f.taskId, 'read', { status: 'done', evidence: 'The read returned the actual source text without an error.' }, { ...options, expectedRevision: state.revision });
  assert.equal(state.steps[0].status, 'done');
  assert.equal(state.steps[0].evidence, 'The read returned the actual source text without an error.');
});

test('an assigned worker can recursively split its unexecuted leaf into sequential operations', async t => {
  const f = await fixture(t), options = { schemaVersion: 9, executionGuardrails: true, planningMode: 'on' };
  let state = await f.store.setPlan(f.taskId, { plan: { layout: 'sequence' }, steps: [
    { ...action('assigned', { status: 'active' }), operation: { kind: 'tool', tool: 'relay_delegate', target: 'assigned' } },
    action('after-worker'),
  ] }, { ...options, expectedRevision: f.initial.revision });
  const independentDefinition = structuredClone(state.steps.find(step => step.id === 'after-worker'));
  state = await f.store.bindDelegates(f.taskId, [{ id: 'inspect-worker', stepId: 'assigned' }], { runId: 'run', nodeId: 'agent' });
  const workerId = Object.keys(state.execution.nodes)[0];
  state = await f.store.recordExecution(f.taskId, workerId, { status: 'running' }, { runId: 'run' });
  const workerOptions = { ...options, runId: 'run', nodeId: workerId, scopeStepId: 'assigned' };
  state = await f.store.setPlan(f.taskId, { plan: { layout: 'sequence' }, steps: [
    { ...action('read', { status: 'active' }), operation: { kind: 'tool', tool: 'relay_workspace', action: 'read', target: 'source.txt' } },
    action('compare'),
  ] }, { ...workerOptions, expectedRevision: state.revision });
  assert.equal(state.steps.find(step => step.id === 'assigned').kind, 'sequence');
  assert.equal(state.steps.find(step => step.id === 'assigned').operation, undefined, 'an expanded group has no inherited executable leaf operation');
  assert.deepEqual(state.steps.find(step => step.id === 'after-worker'), independentDefinition);
  assert.equal(state.steps.find(step => step.id === 'read').parentId, 'assigned');
  assert.deepEqual(state.availableWork.active, ['read']);
  const guard = createSequentialPlanningGuard({ executionGuardrails: true, store: f.store, taskId: f.taskId, runId: 'run', nodeId: workerId, scopeStepId: 'assigned' });
  const read = { name: 'relay_workspace', callId: 'worker-read', arguments: { action: 'read', path: 'source.txt' } };
  assert.equal(await guard.before(read, { expectedRevision: state.revision }), null);
  await guard.after(read, { success: true, contentItems: [{ type: 'inputText', text: 'The source comparison input.' }] });
  state = await f.store.setStep(f.taskId, 'read', { status: 'done', evidence: 'The named source returned its actual comparison input.' }, { ...workerOptions, expectedRevision: state.revision });
  state = await f.store.setStep(f.taskId, 'compare', { status: 'active' }, { ...workerOptions, expectedRevision: state.revision });
  state = await f.store.setStep(f.taskId, 'compare', { status: 'done', evidence: 'The supplied value matched the inspected source exactly.' }, { ...workerOptions, expectedRevision: state.revision });
  assert.equal(state.steps.find(step => step.id === 'assigned').status, 'done');
  assert.equal(state.availableWork.byId['after-worker'].state, 'waiting', 'saved work does not invent a finished worker runtime');
  state = await f.store.recordExecution(f.taskId, workerId, { status: 'completed' }, { runId: 'run' });
  assert.equal(state.availableWork.byId['after-worker'].state, 'ready');
});

test('stored executable conditions keep an unknown NOT out of ELSE', async t => {
  const f = await fixture(t), steps = [
    { id: 'decision', title: 'Choose after the observation', kind: 'choice', branch: { if: { not: { fact: 'broken' } }, then: 'use', else: 'repair' } },
    action('use', { parentId: 'decision' }), action('repair', { parentId: 'decision' }),
  ];
  const options = { schemaVersion: 13, executionGuardrails: true, planningMode: 'on' };
  let state = await f.store.setPlan(f.taskId, { plan: { layout: 'sequence', facts: [{ id: 'broken', value: null }] }, steps }, { ...options, expectedRevision: f.initial.revision });
  assert.equal(state.steps[0].selectedChildId, undefined);
  assert.equal(state.availableWork.byId.repair.state, 'awaiting-choice');
  await assert.rejects(f.store.setStep(f.taskId, 'repair', { status: 'active' }, { ...options, expectedRevision: state.revision }));
  assert.equal((await f.store.get(f.taskId)).revision, state.revision);
  state = await f.store.editPlan(f.taskId, { operations: [{ type: 'metadata', patch: { facts: [{ id: 'broken', value: true, evidence: 'The observed validation failed.' }] } }] }, { ...options, expectedRevision: state.revision });
  assert.equal(state.steps[0].selectedChildId, 'repair');
  state = await f.store.setStep(f.taskId, 'repair', { status: 'active' }, { ...options, expectedRevision: state.revision });
  assert.deepEqual(state.availableWork.active, ['repair']);
});

test('stored IF/ELIF/ELSE evaluates typed comparisons in order and stops on an earlier unknown', async t => {
  const f = await fixture(t), compare = (id, op, value) => ({ compare: { left: { fact: id }, op, right: { value } } });
  const rule = { if: { xor: [{ fact: 'override' }, compare('count', '>=', 10)] }, then: 'fast', elif: [
    { if: { and: [compare('tag', 'in', ['ready', 'retry']), { not: { fact: 'stopped' } }] }, then: 'ready' },
    { if: compare('optional', 'is', null), then: 'empty' },
  ], else: 'fallback' };
  const observations = (stopped, optional, known = true) => [
    { id: 'override', value: false, evidence: 'The user supplied no override.' },
    { id: 'count', value: 4, evidence: 'Counted four supplied items.' },
    { id: 'tag', value: 'ready', evidence: 'The inspected status is ready.' },
    { id: 'stopped', value: stopped, ...(stopped === null ? {} : { evidence: stopped ? 'The stop flag was set.' : 'The stop flag was clear.' }) },
    { id: 'optional', value: optional, known, ...(known ? { evidence: optional === null ? 'The response explicitly returned None.' : 'The response returned the observed string.' } : {}) },
  ];
  const options = { schemaVersion: 13, executionGuardrails: true, planningMode: 'on' };
  let state = await f.store.setPlan(f.taskId, { plan: { layout: 'sequence', facts: observations(null, null) }, steps: [
    { id: 'decision', title: 'Choose the next bounded check', kind: 'choice', branch: rule },
    ...['fast', 'ready', 'empty', 'fallback'].map(id => action(id, { parentId: 'decision' })),
  ] }, { ...options, expectedRevision: f.initial.revision });
  assert.equal(state.steps[0].selectedChildId, undefined, 'an earlier unknown blocks a later true ELIF');
  assert.equal(state.availableWork.byId.empty.state, 'awaiting-choice');
  await assert.rejects(f.store.setStep(f.taskId, 'empty', { status: 'active' }, { ...options, expectedRevision: state.revision }));
  const observe = async facts => {
    state = await f.store.editPlan(f.taskId, { operations: [{ type: 'metadata', patch: { facts } }] }, { ...options, expectedRevision: state.revision });
  };
  await observe(observations(false, null));
  assert.equal(state.steps[0].selectedChildId, 'ready');
  await observe(observations(true, null));
  assert.equal(state.steps[0].selectedChildId, 'empty', 'known None is an observed value rather than missing evidence');
  await observe(observations(true, null, false));
  assert.equal(state.steps[0].selectedChildId, undefined);
  assert.equal(state.availableWork.byId.fallback.state, 'awaiting-choice');
  await observe(observations(true, 'present'));
  assert.equal(state.steps[0].selectedChildId, 'fallback');
  state = await f.store.setStep(f.taskId, 'fallback', { status: 'active' }, { ...options, expectedRevision: state.revision });
  assert.deepEqual(state.availableWork.active, ['fallback']);
});

test('guarded relay_task edit rejects JSON-encoded operations without changing the plan or dispatch ledger', async t => {
  const f = await fixture(t);
  const options = { schemaVersion: 13, executionGuardrails: true, planningMode: 'on' };
  const read = { ...action('read', { status: 'active' }), operation: { kind: 'tool', tool: 'relay_workspace', action: 'read', target: 'source.txt' } };
  const state = await f.store.setPlan(f.taskId, { plan: { layout: 'sequence' }, steps: [read] }, { ...options, expectedRevision: f.initial.revision });
  const guard = createSequentialPlanningGuard({ ...options, store: f.store, taskId: f.taskId, runId: 'run', nodeId: 'agent' });
  const sourceCall = { name: 'relay_workspace', callId: 'observed-source', arguments: { action: 'read', path: 'source.txt' } };
  assert.equal(await guard.before(sourceCall, { expectedRevision: state.revision }), null);
  await guard.after(sourceCall, { success: true, contentItems: [{ type: 'inputText', text: 'The supplied source returned its observed value.' }] });
  const before = await f.store.get(f.taskId), ledgerPath = f.store.file(f.taskId) + '.sequence';
  const ledgerBefore = await readFile(ledgerPath, 'utf8');
  const operations = [{ type: 'update', stepId: 'read', patch: { status: 'done', evidence: 'The supplied source returned its observed value.' } }];
  let handled = 0;
  const dispatch = async args => {
    const call = { name: 'relay_task', arguments: JSON.stringify(args) };
    const originalArguments = call.arguments;
    const denied = await guard.before(call, { expectedRevision: state.revision });
    assert.equal(call.arguments, originalArguments, 'The guard must not coerce or rewrite model arguments.');
    if (denied) return denied;
    handled++;
    throw new Error('Malformed edit reached the mutation boundary.');
  };
  for (const malformed of [JSON.stringify(operations), {}, null, [null], ['update']]) {
    const receipt = await dispatch({ action: 'edit', expectedRevision: state.revision, operations: malformed });
    assert.equal(receipt.success, false);
    assert.equal(receipt.code, 'INVALID_PLAN_EDIT');
    assert.match(payload(receipt).message, /JSON array of plan edit objects/);
    assert.doesNotMatch(receipt.contentItems[0].text, /some is not a function|Cannot read/);
    assert.deepEqual(await f.store.get(f.taskId), before);
    assert.equal(await readFile(ledgerPath, 'utf8'), ledgerBefore);
  }
  assert.equal(handled, 0, 'Malformed edits must stop before the mutation handler.');
  const valid = await f.store.editPlan(f.taskId, { operations }, { ...options, expectedRevision: state.revision });
  assert.equal(valid.steps[0].status, 'done');
  assert.equal(valid.steps[0].evidence, operations[0].patch.evidence);
  assert.equal(valid.revision, state.revision + 1);
});
