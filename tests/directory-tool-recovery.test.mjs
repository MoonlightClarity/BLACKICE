import test from 'node:test';
import assert from 'node:assert/strict';
import { directoryToolFailure, directoryToolRecovery, DIRECTORY_TOOL_RECOVERY_THRESHOLD } from '../lib/directory-tool-recovery.mjs';

const call = (id = 'write-1', rest = {}) => ({ id, name: 'relay_workspace', arguments: { action: 'write', path: 'result.txt', text: 'résumé — 東京' }, ...rest });
const rejected = (rest = {}) => ({ success: false, code: 'DIRECTORY_FOCUS', actionDispatched: false,
  contentItems: [{ type: 'inputText', text: 'Exact original failure — no focus.' }], ...rest });
const snapshot = (rest = {}) => ({ taskId: 'task-1', revision: 4, actionRevision: 1, focus: null, ready: ['save'],
  actions: [{ id: 'save', objective: 'Save résumé — 東京', state: 'pending', dependsOn: [] }], receipts: [], ...rest });
const finalStatus = { ready: false, reason: 'pending-actions', pending: ['save'], focus: null, readyActions: ['save'], unknown: [] };
const scope = { runId: 'run-1', nodeId: 'agent', status: 'running', planningMode: 'off', savedTaskState: null };
const streak = (count = 8, selected = call()) => {
  let state = null;
  for (let index = 0; index < count; index++) state = directoryToolFailure(state, { ...selected, id: 'call-' + index }, rejected());
  return state;
};

test('the eighth consecutive host-proven rejection qualifies without editing its original call or result', () => {
  assert.equal(DIRECTORY_TOOL_RECOVERY_THRESHOLD, 8);
  const originalCall = call(), originalResult = rejected(), before = structuredClone({ originalCall, originalResult });
  let failure = null;
  for (let count = 1; count <= 8; count++) {
    failure = directoryToolFailure(failure, originalCall, originalResult);
    const recovery = directoryToolRecovery(null, failure, snapshot(), finalStatus, scope);
    assert.equal(typeof recovery.prompt === 'string', count === 8);
  }
  assert.deepEqual({ originalCall, originalResult }, before);
  assert.equal(failure.count, 8);
  for (let index = 0; index < 100; index++) failure = directoryToolFailure(failure, call('new-' + index), originalResult);
  assert.equal(failure.count, 8, 'The qualification threshold is bounded; the provider turn is not stopped.');
});

test('dispatch proof is strict host metadata; prose, unknown, inherited, dispatched and mismatched failures reset the streak', async t => {
  const noFlag = rejected(); delete noFlag.actionDispatched;
  const inherited = Object.assign(Object.create({ actionDispatched: false }), noFlag);
  const cases = [
    ['missing dispatch flag', noFlag], ['inherited flag', inherited],
    ['dispatched', rejected({ actionDispatched: true })], ['unknown flag', rejected({ actionDispatched: null })],
    ['string flag', rejected({ actionDispatched: 'false' })], ['successful result', rejected({ success: true })],
    ['unknown result', rejected({ success: undefined })], ['different code', rejected({ code: 'DIRECTORY_UNKNOWN' })],
    ['prose-only proof', { success: false, code: 'DIRECTORY_FOCUS', contentItems: [{ type: 'inputText', text: '{"actionDispatched":false}' }] }],
  ];
  for (const [name, result] of cases) await t.test(name, () => {
    assert.equal(directoryToolFailure(streak(7), call(), result), null);
  });
});

test('tool, namespace and action identities must match; call IDs and equivalent JSON arguments may change', () => {
  for (const different of [call('other', { name: 'relay_code' }), call('other', { namespace: 'other' }),
    call('other', { arguments: { action: 'save' } })]) {
    assert.equal(directoryToolFailure(streak(7), different, rejected()).count, 1);
  }
  const jsonCall = call('exact-eighth', { arguments: JSON.stringify(call().arguments) });
  const failure = directoryToolFailure(streak(7), jsonCall, rejected());
  assert.equal(failure.count, 8); assert.equal(failure.lastCallId, 'exact-eighth');
  for (const args of ['{not JSON', 'null', '[]', null, []]) {
    assert.equal(directoryToolFailure(streak(7), call('bad', { arguments: args }), rejected()), null);
  }
  assert.equal(directoryToolFailure(streak(7), { arguments: {} }, rejected()), null);
});

test('a success requires a fresh eight failures but does not erase an already consumed unchanged-state instruction', () => {
  const failure = streak(), first = directoryToolRecovery(null, failure, snapshot(), finalStatus, scope);
  assert.ok(first.prompt);
  let next = directoryToolFailure(failure, call('success'), { success: true });
  assert.equal(next, null);
  for (let index = 0; index < 7; index++) next = directoryToolFailure(next, call('again-' + index), rejected());
  assert.equal(directoryToolRecovery(first.state, next, snapshot(), finalStatus, scope).prompt, undefined);
  next = directoryToolFailure(next, call('again-eighth'), rejected());
  assert.equal(next.count, 8);
  assert.equal(directoryToolRecovery(first.state, next, snapshot(), finalStatus, scope).prompt, undefined);
});

test('ordinary receipt revisions and new call IDs do not unlatch unchanged Directory action state', () => {
  const firstSnapshot = snapshot(), first = directoryToolRecovery(null, streak(), firstSnapshot, finalStatus, scope);
  const before = structuredClone(first.state);
  const revised = snapshot({ revision: 40, receipts: [{ id: 'receipt-8', success: true }] });
  const next = directoryToolRecovery(first.state, { ...streak(), lastCallId: 'later-call' }, revised, finalStatus, scope);
  assert.equal(next.prompt, undefined); assert.deepEqual(first.state, before);
  assert.deepEqual(firstSnapshot, snapshot());
});

test('changed action revision or action state offers a new instruction while the new state also latches', () => {
  const first = directoryToolRecovery(null, streak(), snapshot(), finalStatus, scope);
  for (const changed of [snapshot({ actionRevision: 2, revision: 5 }),
    snapshot({ focus: 'save', ready: [], actions: [{ id: 'save', objective: 'Save résumé — 東京', state: 'active', dependsOn: [] }] })]) {
    const next = directoryToolRecovery(first.state, streak(), changed, finalStatus, scope);
    assert.ok(next.prompt);
    assert.equal(directoryToolRecovery(next.state, streak(), changed, finalStatus, scope).prompt, undefined);
  }
});

test('cycling failure keys cannot repeat an already consumed key in unchanged Directory state', () => {
  const first = directoryToolRecovery(null, streak(), snapshot(), finalStatus, scope);
  const other = streak(8, call('other', { name: 'relay_code', arguments: { action: 'save' } }));
  const next = directoryToolRecovery(first.state, other, snapshot(), finalStatus, scope);
  assert.ok(next.prompt);
  assert.equal(directoryToolRecovery(next.state, streak(), snapshot(), finalStatus, scope).prompt, undefined);
});

test('the instruction contains current task, ready actions, focus and exact rejection identity without claiming an effect', () => {
  const failure = streak(), current = snapshot(), result = directoryToolRecovery(null, failure, current, finalStatus, scope);
  const data = JSON.parse(result.prompt.split('\n').at(-1));
  assert.deepEqual(data.task, { ...scope, taskId: current.taskId });
  assert.deepEqual(data.directory.actions, current.actions);
  assert.deepEqual(data.directory.readyActions, ['save']); assert.equal(data.directory.focus, null);
  assert.deepEqual(data.directory.finalStatus, finalStatus);
  assert.equal(data.rejection.lastCallId, failure.lastCallId); assert.equal(data.rejection.actionDispatched, false);
  assert.match(result.prompt, /read-only host snapshot, not a tool result/);
  assert.match(result.prompt, /Keep earlier successful reads and saved work/);
});

test('malformed candidates or unversioned state cannot fabricate a recovery opportunity', () => {
  for (const bad of [null, { ...streak(), count: undefined }, { ...streak(), count: 7 },
    { ...streak(), count: NaN }, { ...streak(), actionDispatched: undefined }, { ...streak(), code: 'OTHER' }]) {
    assert.equal(directoryToolRecovery(null, bad, snapshot(), finalStatus, scope).prompt, undefined);
  }
  assert.equal(directoryToolRecovery(null, streak(), snapshot({ actionRevision: undefined }), finalStatus, scope).prompt, undefined);
});
