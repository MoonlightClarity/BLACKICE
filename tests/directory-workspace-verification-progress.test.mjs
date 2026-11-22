import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createDirectoryVerificationProgress } from '../lib/directory-verification-progress.mjs';

const cwd = path.resolve('directory-workspace-progress-fixture');
const scope = { runId: 'run-1', taskId: 'task-1', nodeId: 'agent', cwd };
const capability = { caseId: 'D0', caseCount: 2, command: 'node test-public.cjs' };
const json = value => ({ type: 'inputText', text: JSON.stringify(value) });
function fixture(workspacePublicCheck = capability) {
  return { tracker: createDirectoryVerificationProgress({ ...scope, workspacePublicCheck }),
    snapshot: { focus: 'implement', actionRevision: 2, actions: [{ id: 'implement', state: 'active' }], receipts: [] },
    state: { reason: 'pending-actions', focus: 'implement', unknown: [] } };
}
function envelope(f, call, body) {
  const receipt = { runId: scope.runId, taskId: scope.taskId, nodeId: scope.nodeId,
    id: 'receipt-' + call.callId, actionId: f.snapshot.focus, tool: call.name, state: 'returned', success: true };
  return { call, body, receipt, result: { success: true, contentItems: [json(body),
    { type: 'inputText', text: 'DIRECTORY HOST RECEIPT ' + receipt.id + '; this records handler activity, not task completion.' }] } };
}
function workspaceEvidence(f, { id = 'workspace-1', snapshot = 'a'.repeat(64) } = {}) {
  const worker = path.join(cwd, 'test-support', 'module-worker.cjs');
  const report = { schema: 'blackice.minicpm.public-smoke.v1', taskId: 'D0', publicSmokeOnly: true,
    sourceSnapshotSha256: snapshot, moduleCount: 1, semanticPass: true,
    passedCases: 2, caseCount: 2, executedCases: 2, elapsedMs: 10, compileError: null, workerError: null,
    child: { executable: process.execPath,
      args: ['--permission', '--allow-fs-read=' + worker, '--no-addons', '--disable-proto=throw', '--max-old-space-size=128', worker],
      cwd: path.join(cwd, 'test-support'), exitCode: 0, status: 0, signal: null, timedOut: false, stderr: '', error: null },
    failures: [] };
  const call = { name: 'relay_workspace', callId: id, arguments: { action: 'run', command: capability.command } };
  const body = { cwd, exitCode: 0, signal: null, stdout: JSON.stringify(report), stderr: '',
    truncated: false, timedOut: false, durationMs: 20, command: capability.command, shell: 'none',
    executable: process.execPath, args: ['test-public.cjs'], actionDispatched: true,
    reportValid: true, sourceSnapshotVerified: true, sourceSnapshotBeforeSha256: snapshot, sourceSnapshotAfterSha256: snapshot };
  return { ...envelope(f, call, body), report };
}
function codeEvidence(f, { id = 'code-1', snapshot = 'a'.repeat(64), fileHash = 'b'.repeat(64), file = 'src/index.cjs' } = {}) {
  const source = { sha256: fileHash, bytes: 37 };
  const call = { name: 'relay_code', callId: id,
    arguments: { action: 'check', check: 'public', language: 'javascript', path: file, expectedHash: fileHash } };
  const native = { exitCode: 0, signal: null, timedOut: false, command: capability.command };
  const actual = { ...native, kind: 'public', language: 'javascript', path: file, performed: true,
    checkedSource: source, sourceAtomic: false, nativeResult: { success: true, contentItems: [json(native)] },
    reportValid: true, sourceSnapshotVerified: true, sourceSnapshotBeforeSha256: snapshot, sourceSnapshotAfterSha256: snapshot };
  return envelope(f, call, { ...actual, action: 'check', path: path.resolve(cwd, file),
    check: { kind: 'public', performed: true, passed: true, receipt: actual },
    source: { before: source, after: { ...source }, unchanged: true } });
}
function stage(f, e) {
  const operation = f.tracker.start(e.call, { mutating: true });
  f.tracker.finish(operation); f.snapshot.receipts.push(e.receipt);
  return f.tracker.record({ ...e, snapshot: f.snapshot, operation });
}
const sync = e => { e.result.contentItems[0] = json(e.body); };
const deliver = (f, e) => f.tracker.delivered({ call: e.call, result: e.result });
const take = f => f.tracker.take({ snapshot: f.snapshot, state: f.state, admitted: true });
const consume = (f, e) => {
  assert.equal(stage(f, e), true); assert.equal(deliver(f, e), true);
  const value = take(f); assert.ok(value); return value;
};

test('workspace public progress requires an explicit immutable host capability', () => {
  const ordinary = fixture(null), e = workspaceEvidence(ordinary);
  assert.equal(stage(ordinary, e), false); assert.equal(deliver(ordinary, e), false); assert.equal(take(ordinary), null);
  for (const invalid of [false, {}, { ...capability, caseId: '' }, { ...capability, caseCount: 0 },
    { ...capability, caseCount: 1.5 }, { ...capability, caseCount: '2' },
    { ...capability, command: 'node other.cjs' }, { ...capability, extra: true }]) {
    assert.throws(() => fixture(invalid), undefined, JSON.stringify(invalid));
  }
  const descriptor = { ...capability }, f = fixture(descriptor);
  descriptor.caseId = 'L4'; descriptor.caseCount = 99; descriptor.command = 'arbitrary';
  assert.ok(consume(f, workspaceEvidence(f)));
});

test('delivered workspace verification grants one whole-module progress receipt without changing Directory', () => {
  const f = fixture(), e = workspaceEvidence(f);
  e.call.arguments = JSON.stringify(e.call.arguments);
  assert.equal(stage(f, e), true); assert.equal(take(f), null, 'Handler return alone is not delivery');
  assert.equal(deliver(f, e), true);
  const before = structuredClone(f.snapshot), progress = take(f);
  assert.equal(progress.kind, 'public'); assert.equal(progress.sourceScope, 'module-snapshot');
  assert.equal(progress.sha256, e.report.sourceSnapshotSha256);
  assert.equal(progress.receiptId, e.receipt.id); assert.equal(progress.actionId, 'implement');
  assert.equal(progress.path, undefined); assert.equal(progress.bytes, undefined);
  assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(progress)), 'path'), false, 'Do not invent a per-file identity');
  assert.deepEqual(f.snapshot, before, 'Only the model can record an observation');
  assert.equal(take(f), null);
});

test('workspace delivery must preserve the exact call and all returned text', () => {
  const f = fixture(), e = workspaceEvidence(f); assert.equal(stage(f, e), true);
  const variants = [
    [e.call, { ...e.result, success: false }],
    [e.call, { ...e.result, contentItems: e.result.contentItems.slice(0, 1) }],
    [e.call, { ...e.result, contentItems: [json({ forged: true }), e.result.contentItems[1]] }],
    [{ ...e.call, callId: 'another' }, e.result],
    [{ ...e.call, namespace: 'external' }, e.result],
    [{ ...e.call, arguments: { ...e.call.arguments, timeoutMs: 1000 } }, e.result],
    [{ ...e.call, name: 'relay_code' }, e.result],
  ];
  for (const [call, result] of variants) assert.equal(f.tracker.delivered({ call, result }), false);
  const compatible = structuredClone(e.result); delete compatible.success;
  assert.equal(f.tracker.delivered({ call: e.call, result: compatible }), true);
  assert.ok(take(f));
});

test('workspace progress rejects commands outside the shared scoped contract', () => {
  const changes = [
    ['arbitrary command', e => { e.call.arguments.command = 'node other.cjs'; }],
    ['extra command argument', e => { e.call.arguments.args = ['test-public.cjs']; }],
    ['cwd override', e => { e.call.arguments.cwd = cwd; }],
    ['wrong namespace', e => { e.call.namespace = 'external'; }],
    ['wrong tool', e => { e.call.name = 'relay_control'; }],
    ['missing command', e => { delete e.call.arguments.command; }],
    ['wrong action', e => { e.call.arguments.action = 'read'; }],
    ['invalid timeout', e => { e.call.arguments.timeoutMs = 0; }],
    ['malformed arguments', e => { e.call.arguments = '{'; }],
    ['missing call identity', e => { delete e.call.callId; }],
  ];
  for (const [name, change] of changes) {
    const f = fixture(), e = workspaceEvidence(f); change(e);
    assert.equal(stage(f, e), false, name); assert.equal(take(f), null, name);
  }
});

test('workspace progress rejects failed or mismatched native command envelopes', () => {
  const changes = [
    ['outer failure', e => { e.result.success = false; }],
    ['nonzero exit', e => { e.body.exitCode = 2; }],
    ['missing exit', e => { delete e.body.exitCode; }],
    ['signal', e => { e.body.signal = 'SIGTERM'; }],
    ['timeout', e => { e.body.timedOut = true; }],
    ['cancelled', e => { e.body.cancelled = true; }],
    ['unconfirmed dispatch', e => { delete e.body.actionDispatched; }],
    ['undispatched', e => { e.body.actionDispatched = false; }],
    ['truncated', e => { e.body.truncated = true; }],
    ['different command', e => { e.body.command = 'node other.cjs'; }],
    ['shell substitution', e => { e.body.shell = 'powershell'; }],
    ['different native args', e => { e.body.args = ['other.cjs']; }],
    ['relative cwd', e => { e.body.cwd = '.'; }],
    ['foreign cwd', e => { e.body.cwd = path.resolve(cwd, '..'); }],
    ['relative executable', e => { e.body.executable = 'node'; }],
    ['malformed stdout', e => { e.body.stdout = 'passed'; }],
    ['unvalidated report', e => { e.body.reportValid = false; }],
    ['unverified snapshot', e => { e.body.sourceSnapshotVerified = false; }],
    ['invalid snapshot hash', e => { e.body.sourceSnapshotBeforeSha256 = 'invalid'; }],
    ['source changed', e => { e.body.sourceSnapshotAfterSha256 = 'c'.repeat(64); }],
    ['nontext content', e => { e.result.contentItems.push({ type: 'inputImage', imageUrl: 'omitted' }); }],
  ];
  for (const [name, change] of changes) {
    const f = fixture(), e = workspaceEvidence(f); change(e); sync(e);
    assert.equal(stage(f, e), false, name); assert.equal(deliver(f, e), false, name);
  }
});

test('workspace progress requires the complete successful report for the admitted task and source', () => {
  const changes = [
    ['wrong schema', r => { r.schema = 'another'; }],
    ['wrong task', r => { r.taskId = 'L4'; }],
    ['wrong contract', r => { r.publicSmokeOnly = false; }],
    ['wrong case count', r => { r.caseCount = 1; }],
    ['partial execution', r => { r.executedCases = 1; }],
    ['partial pass', r => { r.passedCases = 1; }],
    ['semantic failure', r => { r.semanticPass = false; }],
    ['foreign source', r => { r.sourceSnapshotSha256 = 'c'.repeat(64); }],
    ['no modules', r => { r.moduleCount = 0; }],
    ['compile error', r => { r.compileError = { message: 'SyntaxError' }; }],
    ['worker error', r => { r.workerError = 'failed'; }],
    ['reported failures', r => { r.failures = [{ id: 'case-1' }]; }],
    ['child exit failure', r => { r.child.exitCode = 2; }],
    ['child status failure', r => { r.child.status = 2; }],
    ['child signal', r => { r.child.signal = 'SIGTERM'; }],
    ['child timeout', r => { r.child.timedOut = true; }],
    ['child process error', r => { r.child.error = { code: 'EACCES' }; }],
    ['different child executable', r => { r.child.executable = path.join(cwd, 'other-node.exe'); }],
    ['different child cwd', r => { r.child.cwd = cwd; }],
    ['missing child', r => { delete r.child; }],
  ];
  for (const [name, change] of changes) {
    const f = fixture(), e = workspaceEvidence(f); change(e.report);
    e.body.stdout = JSON.stringify(e.report); sync(e);
    assert.equal(stage(f, e), false, name); assert.equal(take(f), null, name);
  }
});

test('workspace Directory receipt must belong to the current run task node tool and active action', () => {
  for (const [key, value] of [['runId', 'other'], ['taskId', 'other'], ['nodeId', 'other'],
    ['tool', 'relay_code'], ['actionId', 'other'], ['state', 'reserved'], ['success', false], ['id', '']]) {
    const f = fixture(), e = workspaceEvidence(f); e.receipt[key] = value;
    assert.equal(stage(f, e), false, key);
  }
  const f = fixture(), e = workspaceEvidence(f); f.snapshot.actions[0].state = 'pending';
  assert.equal(stage(f, e), false);
});

test('workspace final credit still requires admission unchanged revision focus and returned receipt', () => {
  const f = fixture(), e = workspaceEvidence(f); stage(f, e); deliver(f, e);
  const cases = [
    { admitted: false },
    { state: { ...f.state, unknown: ['unsettled'] } },
    { state: { ...f.state, reason: 'blocked-paths' } },
    { snapshot: { ...f.snapshot, actionRevision: 3 } },
    { snapshot: { ...f.snapshot, focus: 'other' } },
    { snapshot: { ...f.snapshot, receipts: [] } },
    { snapshot: { ...f.snapshot, receipts: [{ ...e.receipt, tool: 'relay_code' }] } },
    { snapshot: { ...f.snapshot, actions: [{ id: 'implement', state: 'observed' }] } },
  ];
  for (const override of cases) assert.equal(f.tracker.take({ snapshot: f.snapshot, state: f.state, admitted: true, ...override }), null);
  assert.ok(take(f));
});

test('unowned or unfinished workspace dispatch handles cannot manufacture progress', () => {
  const f = fixture(), e = workspaceEvidence(f); f.snapshot.receipts.push(e.receipt);
  assert.equal(f.tracker.record({ ...e, snapshot: f.snapshot, operation: {} }), false);
  const operation = f.tracker.start(e.call, { mutating: true });
  assert.equal(f.tracker.record({ ...e, snapshot: f.snapshot, operation }), false);
  f.tracker.finish(operation);
  assert.equal(f.tracker.record({ ...e, snapshot: f.snapshot, operation }), false);
  assert.equal(take(f), null);
});

test('workspace verification is invalidated by later mutations and concurrent source edits', () => {
  for (const delivered of [false, true]) {
    const f = fixture(), e = workspaceEvidence(f); stage(f, e); if (delivered) deliver(f, e);
    const edit = f.tracker.start({ name: 'relay_code', arguments: { action: 'save' } }, { mutating: true });
    assert.equal(take(f), null); f.tracker.finish(edit); assert.equal(deliver(f, e), false);
  }
  for (const editFirst of [false, true]) {
    const f = fixture(), e = workspaceEvidence(f); let edit;
    const mutate = () => f.tracker.start({ name: 'relay_workspace', arguments: { action: 'write' } }, { mutating: true });
    if (editFirst) edit = mutate();
    const operation = f.tracker.start(e.call, { mutating: true });
    if (!editFirst) edit = mutate();
    f.tracker.finish(edit); f.tracker.finish(operation); f.snapshot.receipts.push(e.receipt);
    assert.equal(f.tracker.record({ ...e, snapshot: f.snapshot, operation }), false);
  }
});

test('new IDs incidental fields and action renaming cannot recycle a consumed workspace snapshot', () => {
  const f = fixture(); consume(f, workspaceEvidence(f));
  const again = workspaceEvidence(f, { id: 'new-id' }); again.body.durationMs = 999; sync(again);
  assert.equal(stage(f, again), false);
  f.snapshot.focus = f.state.focus = 'renamed'; f.snapshot.actionRevision++;
  f.snapshot.actions = [{ id: 'renamed', state: 'active' }];
  assert.equal(stage(f, workspaceEvidence(f, { id: 'new-action' })), false);
  consume(f, workspaceEvidence(f, { id: 'new-source', snapshot: 'c'.repeat(64) }));
  assert.equal(stage(f, workspaceEvidence(f, { id: 'old-source' })), false);
});

test('final checkpoint consumes workspace verification without repeating it on the next final', () => {
  const f = fixture(), e = workspaceEvidence(f); stage(f, e); deliver(f, e); f.tracker.checkpoint();
  assert.equal(take(f), null);
  assert.equal(stage(f, workspaceEvidence(f, { id: 'after-final' })), false);
  assert.equal(stage(f, codeEvidence(f)), false, 'The route cannot reset whole-source progress');
});

test('alternating Code and Workspace routes cannot earn two credits for the same public source', () => {
  for (const [first, second] of [[codeEvidence, workspaceEvidence], [workspaceEvidence, codeEvidence]]) {
    const f = fixture(); consume(f, first(f));
    assert.equal(stage(f, second(f)), false);
    consume(f, second(f, { id: 'changed-source', snapshot: 'c'.repeat(64) }));
  }
});

test('two pending route results cannot evade the shared whole-source consumption check', () => {
  for (const [first, second] of [[codeEvidence, workspaceEvidence], [workspaceEvidence, codeEvidence]]) {
    const f = fixture(), a = first(f), b = second(f);
    assert.equal(stage(f, a), true); assert.equal(stage(f, b), true);
    assert.equal(deliver(f, a), true); assert.equal(deliver(f, b), true);
    assert.ok(take(f)); assert.equal(take(f), null);
  }
});

test('Code-to-Code per-file verification behavior remains unchanged with a workspace capability', () => {
  const f = fixture();
  consume(f, codeEvidence(f));
  const other = codeEvidence(f, { id: 'other-file', file: 'src/helper.cjs', fileHash: 'c'.repeat(64) });
  assert.equal(consume(f, other).path, path.join(cwd, 'src', 'helper.cjs'));
  assert.equal(stage(f, workspaceEvidence(f)), false);
});

test('an ordinary Workspace command remains a mutation without the trusted capability', () => {
  const f = fixture(null), checked = codeEvidence(f);
  stage(f, checked); deliver(f, checked);
  const ordinary = workspaceEvidence(f);
  assert.equal(stage(f, ordinary), false);
  assert.equal(take(f), null, 'Ordinary process execution must invalidate earlier source evidence');
});
