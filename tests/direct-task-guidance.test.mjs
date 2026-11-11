import test from 'node:test';
import assert from 'node:assert/strict';
import { directTaskContractInterpretation } from '../lib/direct-task-guidance.mjs';
import { createDirectTaskContractTools } from '../lib/direct-task-contract-tools.mjs';

const contract = () => ({
  contractVersion: 2, goal: 'Choose useful opportunities within the requested risk policy',
  criteria: [{ id: 'result', kind: 'external-confirmation', description: 'One confirmed outcome' }],
  workItems: [{ id: 'work', title: 'Pursue opportunity', objective: 'Use the current user intent',
    owner: 'caller', resourceKeys: ['origin:https://example.test'], effects: ['observe', 'commit'],
    dependsOn: [], criterionIds: ['result'] }],
  instructions: [
    { id: 'explicit-gate', text: 'The user requires no purchase above $25.', handling: 'preserve' },
    { id: 'working-assumption', text: 'A listed qualification not mentioned in a short profile is a reason to reject every option.', handling: 'audit' },
  ],
});
const context = { client: { id: 'owner' }, jobId: 'job' };
const payload = result => JSON.parse(result.contentItems[0].text);
const frozen = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
};
function fixture(record) {
  const calls = [];
  const runtime = Object.fromEntries(['create', 'read', 'update', 'measure', 'bind', 'reconcile', 'authorizeRepeat'].map(action => [
    action, async input => { calls.push({ action, input }); return record; },
  ]));
  const bindPlan = async input => { calls.push({ action: 'bind_plan', input }); return record; };
  return { calls, tool: createDirectTaskContractTools({ runtime, bindPlan })[0] };
}

test('contract echoes label caller supply without claiming verified human authorship or automatic conflict detection', () => {
  const record = frozen({ contract: contract(), revision: 1, bindings: {}, operations: [] });
  const bytes = JSON.stringify(record);
  const result = directTaskContractInterpretation(record);
  assert.deepEqual(result.provenance, {
    contractSource: 'authenticated-caller-supplied', userAuthorshipVerified: false, semanticConflictsChecked: false,
  });
  assert.equal(JSON.stringify(record), bytes);
  assert.equal(Object.hasOwn(record, 'contractInterpretation'), false);
});

test('canonical source linkage is preserved but never promoted to verified user authorship', () => {
  const record = frozen({ contract: contract(), source: { kind: 'task-state-v14', taskId: 'canonical', revision: 7, contractDigest: 'unchanged' } });
  const bytes = JSON.stringify(record);
  assert.deepEqual(directTaskContractInterpretation(record).provenance, {
    contractSource: 'linked-canonical-plan', userAuthorshipVerified: false, semanticConflictsChecked: false,
    sourceTaskId: 'canonical', sourceRevision: 7,
  });
  assert.equal(JSON.stringify(record), bytes);
});

test('create read update and canonical binding return a sidecar without modifying any contract, explicit gate, history or runtime arguments', async () => {
  for (const action of ['create', 'read', 'update', 'bind_plan']) {
    const record = frozen({ taskId: 'task', contract: contract(), revision: 4, bindings: { old: { state: 'UNKNOWN' } },
      operations: [{ id: 'retained' }], sourceHistory: [{ revision: 2 }] });
    const before = JSON.stringify(record), { calls, tool } = fixture(record);
    const args = { requestId: 'request', action, ...(action === 'bind_plan' ? { sourceTaskId: 'canonical', expectedSourceRevision: 4 } : { taskId: 'task' }),
      ...(['create', 'update'].includes(action) ? { contract: record.contract } : {}), ...(action === 'update' ? { expectedRevision: 4 } : {}) };
    const originalArgs = JSON.stringify(args), result = payload(await tool.execute(args, context));
    assert.deepEqual(result.result, record);
    assert.equal(JSON.stringify(record), before);
    assert.equal(JSON.stringify(args), originalArgs);
    assert.equal(calls.length, 1);
    assert.equal(Object.hasOwn(calls[0].input, 'contractInterpretation'), false);
    assert.equal(result.result.contract.instructions[0].text, 'The user requires no purchase above $25.');
    assert.ok(result.contractInterpretation.decisionGuidance.length);
  }
});

// These assertions check delivered advice, not compliance by an external model.
test('delivered guidance covers explicit gates, bounded inference and scoped process evidence without adding domain rules', () => {
  const text = directTaskContractInterpretation({ contract: contract() }).decisionGuidance.join(' ');
  for (const expected of ['latest actual user intent', 'explicit user gates', 'requested uncertainty policy',
    'Missing documentation is unknown, not proven absence', 'probability-based inference and satisficing',
    'beyond one document', 'expected value', 'explicit factual question', 'Continue independent authorized work',
    'UNKNOWN prior external effects', 'duplicate-effect protections', 'Do not fabricate support',
    'Agent disagreement or preference is advisory', 'specific higher-priority rule or tool limitation',
    'governing clause', 'known, inferred or unknown', 'support and confidence', 'governing basis and affected scope',
    'coarse decision check', 'not a per-field ritual', 'not higher-priority instructions',
    'proportional effort against user limits', 'precise process terms', 'personal certifications',
    'do not make false attestations', 'Isolate affected work', 'adds no admission gate']) assert.ok(text.includes(expected), expected);
  for (const forbidden of ['resume-only', 'work authorization', 'sponsorship', 'SQL', 'always ask', 'never infer']) assert.equal(text.includes(forbidden), false, forbidden);
});

test('guidance has fixed bounded cost, no source traversal, and does not label non-contract results', () => {
  assert.equal(directTaskContractInterpretation({ measurement: { status: 'UNKNOWN' } }), undefined);
  const unreadableContract = new Proxy({}, { ownKeys() { throw Error('Must not inspect or classify contract text'); }, get() { throw Error('Must not inspect or classify contract text'); } });
  const a = directTaskContractInterpretation({ contract: unreadableContract });
  const b = directTaskContractInterpretation({ contract: contract() });
  assert.deepEqual(a, b);
  assert.equal(a.decisionGuidance, b.decisionGuidance);
  assert.ok(Object.isFrozen(a.decisionGuidance));
  assert.ok(Buffer.byteLength(JSON.stringify(a)) < 3500);
});
