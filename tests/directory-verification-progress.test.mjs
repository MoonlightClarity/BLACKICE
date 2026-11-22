import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createDirectoryVerificationProgress } from '../lib/directory-verification-progress.mjs';

const cwd = path.resolve('directory-verification-fixture');
const scope = { runId: 'run-1', taskId: 'task-1', nodeId: 'agent', cwd };
const json = value => ({ type: 'inputText', text: JSON.stringify(value) });
function fixture() {
  return { tracker: createDirectoryVerificationProgress(scope),
    snapshot: { focus: 'encode', actionRevision: 2, actions: [{ id: 'encode', state: 'active' }], receipts: [] },
    state: { reason: 'pending-actions', focus: 'encode', unknown: [] } };
}
function evidence(f, { id = 'call-1', kind = 'public', language = 'javascript', sha256 = 'a'.repeat(64), actionId = f.snapshot.focus } = {}) {
  const source = { sha256, bytes: 37 };
  const call = { name: 'relay_code', callId: id,
    arguments: { action: 'check', check: kind, language, path: 'src/index.cjs', expectedHash: sha256 } };
  const native = { exitCode: 0, signal: null, timedOut: false, command: kind === 'public' ? 'node test-public.cjs' : 'node --check src/index.cjs' };
  const actual = { ...native, kind, language, path: 'src/index.cjs', performed: true, checkedSource: source,
    sourceAtomic: false, nativeResult: { success: true, contentItems: [json(native)] },
    ...(kind === 'public' ? { reportValid: true, sourceSnapshotVerified: true,
      sourceSnapshotBeforeSha256: 'c'.repeat(64), sourceSnapshotAfterSha256: 'c'.repeat(64) } : {}) };
  const body = { ...actual, action: 'check', path: path.resolve(cwd, 'src/index.cjs'),
    check: { kind, performed: true, passed: true, receipt: actual },
    source: { before: source, after: { ...source }, unchanged: true } };
  const receipt = { ...scope, id: 'receipt-' + id, actionId, tool: 'relay_code', state: 'returned', success: true };
  delete receipt.cwd;
  const result = { success: true, contentItems: [json(body),
    { type: 'inputText', text: 'DIRECTORY HOST RECEIPT ' + receipt.id + '; current revision 4. This is handler activity, not verified task completion.' }] };
  return { call, result, receipt, body };
}
function stage(f, e) {
  const operation = f.tracker.start(e.call, { mutating: true });
  f.tracker.finish(operation);
  f.snapshot.receipts.push(e.receipt);
  return f.tracker.record({ ...e, snapshot: f.snapshot, operation });
}
const deliver = (f, e) => f.tracker.delivered({ call: e.call, result: e.result });
const take = f => f.tracker.take({ snapshot: f.snapshot, state: f.state, admitted: true });
const syncBody = e => { e.result.contentItems[0] = json(e.body); };

for (const [kind, language] of [['public', 'javascript'], ['syntax', 'javascript'], ['syntax', 'json']]) {
  test('actual delivered ' + kind + '/' + language + ' verification earns feedback without changing Directory', () => {
    const f = fixture(), e = evidence(f, { kind, language });
    assert.equal(stage(f, e), true);
    assert.equal(take(f), null, 'A handler return is not delivery.');
    assert.equal(deliver(f, e), true);
    const before = structuredClone(f.snapshot), progress = take(f);
    assert.equal(progress.kind, kind); assert.equal(progress.language, language);
    assert.equal(progress.receiptId, e.receipt.id); assert.equal(progress.sha256, 'a'.repeat(64));
    assert.deepEqual(f.snapshot, before, 'The collector cannot observe or complete an action.');
    assert.equal(take(f), null);
  });
}
test('compatible exact delivery may omit success metadata but cannot change the complete text', () => {
  const f = fixture(), e = evidence(f);
  assert.equal(stage(f, e), true);
  const partial = structuredClone(e.result); partial.contentItems.pop();
  assert.equal(f.tracker.delivered({ call: e.call, result: partial }), false);
  const altered = structuredClone(e.result); altered.contentItems[0].text += ' ';
  assert.equal(f.tracker.delivered({ call: e.call, result: altered }), false);
  const wrong = structuredClone(e.call); wrong.arguments.check = 'syntax';
  assert.equal(f.tracker.delivered({ call: wrong, result: e.result }), false);
  const wire = structuredClone(e.result); delete wire.success;
  assert.equal(f.tracker.delivered({ call: e.call, result: wire }), true);
  assert.ok(take(f));
});
test('new call/receipt/time/action IDs do not make the same checked state new progress', () => {
  const f = fixture(), first = evidence(f);
  assert.equal(stage(f, first), true); assert.equal(deliver(f, first), true); assert.ok(take(f));
  const again = evidence(f, { id: 'fresh-call' });
  again.body.check.receipt.durationMs = 700; again.body.check.receipt.stdout = 'different incidental formatting';
  syncBody(again); assert.equal(stage(f, again), false);
  f.snapshot.focus = f.state.focus = 'renamed'; f.snapshot.actionRevision++;
  f.snapshot.actions = [{ id: 'renamed', state: 'active' }];
  assert.equal(stage(f, evidence(f, { id: 'renamed-call' })), false);
});
test('new source/check state qualifies, but cycling back to a consumed source does not', () => {
  const f = fixture();
  for (const [id, sha256] of [['first', 'a'.repeat(64)], ['new-source', 'b'.repeat(64)]]) {
    const e = evidence(f, { id, sha256 }); assert.equal(stage(f, e), true); assert.equal(deliver(f, e), true); assert.ok(take(f));
  }
  assert.equal(stage(f, evidence(f, { id: 'recycled', sha256: 'a'.repeat(64) })), false);
  const syntax = evidence(f, { id: 'different-explicit-check', kind: 'syntax', sha256: 'b'.repeat(64) });
  assert.equal(stage(f, syntax), true); assert.equal(deliver(f, syntax), true); assert.equal(take(f).kind, 'syntax');
});
test('preceding-final checkpoint prevents old verification from being replayed as new progress', () => {
  const f = fixture(), e = evidence(f);
  stage(f, e); deliver(f, e); f.tracker.checkpoint();
  assert.equal(take(f), null);
  assert.equal(stage(f, evidence(f, { id: 'after-final' })), false);
});
test('later actual mutation invalidates delivered and pending verification', () => {
  for (const wasDelivered of [false, true]) {
    const f = fixture(), e = evidence(f); stage(f, e); if (wasDelivered) deliver(f, e);
    const edit = f.tracker.start({ name: 'relay_code', arguments: { action: 'save' } }, { mutating: true });
    assert.equal(take(f), null); f.tracker.finish(edit);
    assert.equal(deliver(f, e), false); assert.equal(take(f), null);
  }
});
test('checks overlapping an actual mutation cannot authorize reconciliation', () => {
  for (const editFirst of [false, true]) {
    const f = fixture(), e = evidence(f);
    let edit, check;
    if (editFirst) edit = f.tracker.start({ name: 'relay_workspace', arguments: { action: 'write' } }, { mutating: true });
    check = f.tracker.start(e.call, { mutating: true });
    if (!editFirst) edit = f.tracker.start({ name: 'relay_workspace', arguments: { action: 'run' } }, { mutating: true });
    f.tracker.finish(edit); f.tracker.finish(check); f.snapshot.receipts.push(e.receipt);
    assert.equal(f.tracker.record({ ...e, snapshot: f.snapshot, operation: check }), false);
  }
});
const invalid = [
  ['failed outer result', e => { e.result.success = false; }],
  ['unperformed check', e => { e.body.check.performed = false; }],
  ['failed check', e => { e.body.check.passed = false; }],
  ['unconfirmed actual receipt', e => { e.body.check.receipt.performed = 'unconfirmed'; }],
  ['missing terminal exit', e => { delete e.body.check.receipt.exitCode; }],
  ['nonzero actual exit', e => { e.body.check.receipt.exitCode = 2; }],
  ['timed out check', e => { e.body.check.receipt.timedOut = true; }],
  ['cancelled check', e => { e.body.check.receipt.cancelled = true; }],
  ['signalled check', e => { e.body.check.receipt.signal = 'SIGTERM'; }],
  ['unexecuted check', e => { e.body.check.receipt.actionDispatched = false; }],
  ['missing actual native receipt', e => { delete e.body.check.receipt.nativeResult; }],
  ['failed native receipt', e => { e.body.check.receipt.nativeResult.success = false; }],
  ['changed source', e => { e.body.source.after.sha256 = 'b'.repeat(64); }],
  ['unverified source', e => { e.body.source.unchanged = false; }],
  ['wrong checked identity', e => { e.body.check.receipt.checkedSource = { sha256: 'b'.repeat(64), bytes: 37 }; }],
  ['expected hash conflict', e => { e.call.arguments.expectedHash = 'b'.repeat(64); }],
  ['mismatched checker kind', e => { e.body.check.kind = 'syntax'; }],
  ['mismatched target', e => { e.body.path = 'src/other.cjs'; }],
  ['mismatched actual target', e => { e.body.check.receipt.path = 'src/other.cjs'; }],
  ['mismatched language', e => { e.body.language = 'json'; }],
  ['foreign run', e => { e.receipt.runId = 'other'; }],
  ['foreign task', e => { e.receipt.taskId = 'other'; }],
  ['foreign node', e => { e.receipt.nodeId = 'other'; }],
  ['foreign action', e => { e.receipt.actionId = 'other'; }],
  ['unsettled receipt', e => { e.receipt.state = 'reserved'; }],
  ['failed Directory receipt', e => { e.receipt.success = false; }],
  ['arbitrary workspace stdout', e => { e.call.name = 'relay_workspace'; e.call.arguments.action = 'run'; }],
  ['namespaced tool', e => { e.call.namespace = 'foreign'; }],
  ['missing call identity', e => { delete e.call.callId; }],
  ['invalid public snapshot', e => { e.body.check.receipt.sourceSnapshotAfterSha256 = 'd'.repeat(64); }],
  ['invalid public report', e => { e.body.check.receipt.reportValid = false; }],
  ['nontext result item', e => { e.result.contentItems.push({ type: 'inputImage', imageUrl: 'omitted' }); }],
];
for (const [name, change] of invalid) test('does not count ' + name, () => {
  const f = fixture(), e = evidence(f); change(e); syncBody(e);
  assert.equal(stage(f, e), false); assert.equal(deliver(f, e), false); assert.equal(take(f), null);
});
test('admission, unknown outcomes, current focus, revision and receipt remain mandatory at final', () => {
  const f = fixture(), e = evidence(f); stage(f, e); deliver(f, e);
  assert.equal(f.tracker.take({ snapshot: f.snapshot, state: f.state, admitted: false }), null);
  assert.equal(f.tracker.take({ snapshot: f.snapshot, state: { ...f.state, unknown: ['uncertain'] }, admitted: true }), null);
  assert.equal(f.tracker.take({ snapshot: f.snapshot, state: { ...f.state, reason: 'blocked-paths' }, admitted: true }), null);
  assert.equal(f.tracker.take({ snapshot: { ...f.snapshot, actionRevision: 9 }, state: f.state, admitted: true }), null);
  assert.equal(f.tracker.take({ snapshot: { ...f.snapshot, focus: 'other' }, state: f.state, admitted: true }), null);
  assert.equal(f.tracker.take({ snapshot: { ...f.snapshot, receipts: [] }, state: f.state, admitted: true }), null);
  assert.ok(take(f));
});
test('malformed, forged and unfinished dispatch handles cannot create evidence', () => {
  const f = fixture(), e = evidence(f); f.snapshot.receipts.push(e.receipt);
  assert.equal(f.tracker.record({ ...e, snapshot: f.snapshot, operation: {} }), false);
  const operation = f.tracker.start(e.call);
  assert.equal(f.tracker.record({ ...e, snapshot: f.snapshot, operation }), false);
  assert.equal(f.tracker.delivered({}), false); assert.equal(f.tracker.take(), null);
});
