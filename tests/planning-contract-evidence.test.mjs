import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeContractEvidence, evaluateContractCriteria, checkContractJudgmentEvidence } from '../lib/planning-contract-evidence.mjs';
import { describeHostOperation, normalizeHostOperationResult } from '../lib/operation-descriptors.mjs';
import { createWorkspaceToolHandler } from '../lib/workspace-tools.mjs';

const at = '2026-11-05T18:00:00.000Z';
let sequence = 0;
const bind = (input, options = {}) => normalizeContractEvidence(input, {
  operationId: `operation-${++sequence}`, workItemId: 'work-a', at, ...options,
});
const plan = (kind, extras = {}, workItems = [{ id: 'work-a', criterionIds: ['criterion'] }]) => ({
  contractVersion: 2,
  criteria: [{ id: 'criterion', kind, description: 'Evaluate actual evidence', ...extras }],
  workItems,
});
const evaluate = (kind, evidence, extras = {}, options) => evaluateContractCriteria(plan(kind, extras), evidence, options).criteria[0];
const coverage = (start, end, { resourceKey = 'file:history.csv', sourceVersion = 'version-a', total = 93, unit = 'lines', ...binding } = {}) =>
  bind({ kind: 'source-coverage', resourceKey, ...(sourceVersion === null ? {} : { sourceVersion }), coverage: { unit, start, end, total } }, binding);
const receipt = (outcomeId, { resourceKey = 'destination:workshops', effectKey = `effect:${outcomeId}`, status = 'confirmed', prior, ...binding } = {}) =>
  bind({ kind: 'external-confirmation', resourceKey, confirmation: {
    outcomeId, status, ...(effectKey === null ? {} : { effectKey }), ...(prior === undefined ? {} : { prior }),
  } }, binding);

test('host identity is stable across result replay and timestamps, while content and operation changes remain distinct', () => {
  const input = { resourceKey: 'file:a', kind: 'observation', validation: { b: 2, a: 1 } };
  const one = bind(input, { operationId: 'same' });
  const replay = bind({ ...input, validation: { a: 1, b: 2 } }, { operationId: 'same', at: '2026-11-05T18:00:01Z' });
  assert.equal(one.id, replay.id);
  assert.notEqual(one.id, bind(input).id);
  assert.notEqual(one.id, bind({ ...input, resourceKey: 'file:b' }, { operationId: 'same' }).id);
  assert.ok(Object.isFrozen(one));
  assert.ok(Object.isFrozen(one.validation));
  assert.equal(replay.at, '2026-11-05T18:00:01.000Z');
});

test('normalization rejects model-supplied bindings, unknown fields, invalid timestamps, digests and interval units', () => {
  const input = { kind: 'observation', resourceKey: 'file:a' };
  for (const change of [{ id: 'invented' }, { operationId: 'invented' }, { done: true }, { sourceVersion: '' }, { digest: 'not-a-hash' }]) {
    assert.throws(() => bind({ ...input, ...change }), TypeError);
  }
  for (const timestamp of ['yesterday', '2026-02-30T18:00:00Z', '2026-11-05T18:00:00+00:00']) {
    assert.throws(() => bind(input, { at: timestamp }), TypeError);
  }
  for (const range of [
    { start: -1, end: 2, total: 3 }, { start: 3, end: 2, total: 3 },
    { start: 0, end: 4, total: 3 }, { start: 0, end: 1.5, total: 3 },
    { start: 0, end: 1, total: Number.MAX_SAFE_INTEGER + 1 },
  ]) assert.throws(() => bind({ ...input, coverage: { unit: 'lines', ...range } }), TypeError);
  assert.throws(() => bind({ ...input, coverage: { unit: 'pages', start: 0, end: 1, total: 1 } }), TypeError);
});

test('adapter metadata rejects getters, prototypes, circular or unbounded values', () => {
  let getterRan = false;
  const input = { kind: 'validation', resourceKey: 'form:a' };
  const accessor = Object.defineProperty({}, 'message', { enumerable: true, get() { getterRan = true; return 'unsafe'; } });
  assert.throws(() => bind({ ...input, validation: accessor }), TypeError);
  assert.equal(getterRan, false);
  assert.throws(() => bind({ ...input, validation: new Date() }), TypeError);
  const circular = {}; circular.self = circular;
  assert.throws(() => bind({ ...input, validation: circular }), TypeError);
  assert.throws(() => bind({ ...input, validation: { values: Array(300).fill(1) } }), TypeError);
  assert.throws(() => bind({ ...input, validation: { message: 'x'.repeat(2049) } }), TypeError);
});

test('37 of 93 lines and repeated intervals stay incomplete; contiguous delivered remainder completes', () => {
  const first = coverage(0, 37);
  const repeat = coverage(0, 37);
  assert.equal(evaluate('source-coverage', [first, repeat]).satisfied, false);
  const result = evaluate('source-coverage', [first, repeat, coverage(37, 93)]);
  assert.equal(result.satisfied, true);
  assert.equal(result.observedCount, 1);
});

test('overlap can close coverage, but one missing record cannot', () => {
  assert.equal(evaluate('source-coverage', [coverage(0, 50), coverage(40, 93)]).satisfied, true);
  assert.equal(evaluate('source-coverage', [coverage(0, 50), coverage(51, 93)]).satisfied, false);
});

test('different stable versions, units, totals and resources never combine into full coverage', () => {
  for (const last of [
    coverage(37, 93, { sourceVersion: 'version-b' }),
    coverage(37, 93, { unit: 'records' }),
    coverage(37, 94, { total: 94 }),
    coverage(37, 93, { resourceKey: 'file:other.csv' }),
  ]) assert.equal(evaluate('source-coverage', [coverage(0, 37), last]).satisfied, false);
  // Even a complete interval cannot certify contradictory total metadata.
  assert.equal(evaluate('source-coverage', [coverage(0, 93), coverage(0, 37, { total: 94 })]).satisfied, false);
});

test('missing stable metadata remains unknown, including after an earlier complete version', () => {
  assert.equal(evaluate('source-coverage', [coverage(0, 93, { sourceVersion: null })]).satisfied, false);
  const result = evaluate('source-coverage', [coverage(0, 93), coverage(0, 37, { sourceVersion: null })]);
  assert.equal(result.satisfied, false);
  assert.match(result.reason, /unknown/);
  assert.equal(evaluate('source-coverage', [bind({ kind: 'source-coverage', resourceKey: 'file:history.csv', sourceVersion: 'version-a' })]).satisfied, false);
});

test('a newer partial version invalidates older complete coverage until its own remainder arrives', () => {
  const old = coverage(0, 93);
  const latest = coverage(0, 37, { sourceVersion: 'version-b' });
  assert.equal(evaluate('source-coverage', [old, latest]).satisfied, false);
  assert.equal(evaluate('source-coverage', [old, latest, coverage(37, 93, { sourceVersion: 'version-b' })]).satisfied, true);
  const replay = { ...old, at: '2026-11-05T18:59:00.000Z' };
  assert.equal(evaluate('source-coverage', [old, latest, replay]).satisfied, false);
});

test('source changes observed by another work item still invalidate an older scoped read', () => {
  const evidence = [coverage(0, 93), coverage(0, 37, { sourceVersion: 'version-b', workItemId: 'work-b' })];
  assert.equal(evaluate('source-coverage', evidence).satisfied, false);
  const observedChange = bind({ kind: 'observation', resourceKey: 'file:history.csv', sourceVersion: 'version-c' }, { workItemId: 'work-b' });
  assert.equal(evaluate('source-coverage', [evidence[0], observedChange]).satisfied, false);
});

test('empty stable sources have complete zero-length coverage', () => {
  assert.equal(evaluate('source-coverage', [coverage(0, 0, { total: 0 })]).satisfied, true);
});

test('external confirmations exclude old, absent, unlinked, interaction and validation results', () => {
  const evidence = [
    receipt('new-one'), receipt('old-one', { prior: true }), receipt('missing', { status: 'absent' }),
    receipt('unlinked', { effectKey: null }),
    bind({ kind: 'observation', resourceKey: 'button:submit' }),
    bind({ kind: 'validation', resourceKey: 'form:a', validation: { state: 'invalid', fields: ['location'] } }),
  ];
  const result = evaluateContractCriteria(plan('external-confirmation', { targetCount: 2 }), evidence);
  assert.equal(result.criteria[0].observedCount, 1);
  assert.equal(result.criteria[0].satisfied, false);
  assert.equal(result.outcomes.find(outcome => outcome.outcomeId === 'old-one').prior, true);
  assert.equal(result.outcomes.find(outcome => outcome.outcomeId === 'unlinked').isNew, false);
});

test('duplicate outcome IDs, repeated reads and effect aliases count a single new effect', () => {
  const evidence = [receipt('canonical'), receipt('canonical'), receipt('alias', { effectKey: 'effect:canonical' })];
  const result = evaluateContractCriteria(plan('external-confirmation', { targetCount: 2 }), evidence);
  assert.equal(result.criteria[0].observedCount, 1);
  assert.equal(result.outcomes.length, 1);
  assert.equal(result.outcomes[0].evidenceIds.length, 3);
});

test('transitive aliases unify across resource identities while unrelated local IDs stay distinct', () => {
  const distinct = [receipt('123', { resourceKey: 'tenant:a', effectKey: 'effect:a' }), receipt('123', { resourceKey: 'tenant:b', effectKey: 'effect:b' })];
  assert.equal(evaluate('external-confirmation', distinct, { targetCount: 2 }).satisfied, true);
  const aliases = [
    ...distinct,
    receipt('bridge', { resourceKey: 'tenant:c', effectKey: 'effect:a' }),
    receipt('bridge', { resourceKey: 'tenant:c', effectKey: 'effect:b' }),
  ];
  assert.equal(evaluate('external-confirmation', aliases, { targetCount: 2 }).observedCount, 1);
});

test('any prior alias prevents a historical outcome from becoming new through a later receipt', () => {
  const evidence = [
    receipt('old-id', { effectKey: null, prior: true, workItemId: 'history' }),
    receipt('old-id', { effectKey: 'effect:retry' }),
    receipt('new-alias', { effectKey: 'effect:retry' }),
  ];
  assert.equal(evaluate('external-confirmation', evidence).observedCount, 0);
});

test('later confirmed or absent evidence changes effect state without increasing effect count', () => {
  const missing = receipt('one', { status: 'absent' });
  const committed = receipt('one');
  assert.equal(evaluate('external-confirmation', [missing, committed]).observedCount, 1);
  assert.equal(evaluate('external-confirmation', [committed, missing]).observedCount, 0);
  assert.equal(evaluate('external-confirmation', [missing, committed, { ...missing }]).observedCount, 1);
});

test('twenty distinct newly linked confirmations satisfy twenty; nineteen plus aliases do not', () => {
  const nineteen = Array.from({ length: 19 }, (_, i) => receipt(`workshop-${i}`));
  const falseTwentieth = receipt('workshop-alias', { effectKey: 'effect:workshop-0' });
  assert.equal(evaluate('external-confirmation', [...nineteen, falseTwentieth], { targetCount: 20 }).satisfied, false);
  const complete = evaluate('external-confirmation', [...nineteen, receipt('workshop-19')], { targetCount: 20 });
  assert.equal(complete.observedCount, 20);
  assert.equal(complete.satisfied, true);
});

test('criterion evidence is bound to exact resources and assigned work items', () => {
  const evidence = [receipt('wrong-work', { workItemId: 'work-b' }), receipt('wrong-resource', { resourceKey: 'destination:other' })];
  assert.equal(evaluate('external-confirmation', evidence, { resourceKey: 'destination:workshops' }).satisfied, false);
  const unscoped = plan('external-confirmation', {}, [{ id: 'work-a', criterionIds: [] }, { id: 'work-b', criterionIds: [] }]);
  assert.equal(evaluateContractCriteria(unscoped, evidence).criteria[0].observedCount, 2);
});

test('observation count is distinct resources, not repeated reads or validation messages', () => {
  const evidence = [bind({ kind: 'observation', resourceKey: 'file:a' }), bind({ kind: 'observation', resourceKey: 'file:a' })];
  assert.equal(evaluate('observation', evidence, { targetCount: 2 }).satisfied, false);
  assert.equal(evaluate('observation', [...evidence, bind({ kind: 'observation', resourceKey: 'file:b' })], { targetCount: 2 }).satisfied, true);
});

test('judgments require current positive assessments with real relevant evidence', () => {
  const observed = bind({ kind: 'observation', resourceKey: 'file:a' });
  const assessment = { workItemId: 'work-a', criterionId: 'criterion', judgment: 'satisfied', evidenceIds: [observed.id], note: 'Reviewed' };
  assert.equal(evaluate('judgment', [observed], {}, { judgments: [assessment] }).satisfied, true);
  for (const change of [
    { evidenceIds: [] }, { evidenceIds: ['invented'] }, { workItemId: 'invented' }, { judgment: 'blocked' },
  ]) assert.equal(evaluate('judgment', [observed], {}, { judgments: [{ ...assessment, ...change }] }).satisfied, false);
  assert.equal(evaluate('judgment', [observed], { resourceKey: 'file:b' }, { judgments: [assessment] }).satisfied, false);
  assert.equal(evaluate('judgment', [observed], {}, { judgments: [assessment, { ...assessment, judgment: 'blocked' }] }).satisfied, false);
});

test('model judgments and done prose cannot promote clicks or partial source coverage', () => {
  const click = bind({ kind: 'observation', resourceKey: 'button:submit' });
  const judgment = { workItemId: 'work-a', criterionId: 'criterion', judgment: 'satisfied', evidenceIds: [click.id], note: 'Done: submitted successfully' };
  assert.equal(evaluate('external-confirmation', [click], {}, { judgments: [judgment] }).satisfied, false);
  const partial = coverage(0, 37);
  assert.equal(evaluate('source-coverage', [partial], {}, { judgments: [{ ...judgment, evidenceIds: [partial.id] }] }).satisfied, false);
});

test('a material plan change requires a new qualitative assessment, while actual evidence remains available', () => {
  const observed = bind({ kind: 'observation', resourceKey: 'file:a' });
  const contract = { ...plan('judgment'), planEpoch: 2 };
  const assessment = { workItemId: 'work-a', criterionId: 'criterion', judgment: 'satisfied', evidenceIds: [observed.id], planEpoch: 1 };
  assert.equal(evaluateContractCriteria(contract, [observed], { judgments: [assessment] }).criteria[0].satisfied, false);
  assert.equal(evaluateContractCriteria(contract, [observed], { judgments: [{ ...assessment, planEpoch: 2 }] }).criteria[0].satisfied, true);
});

test('persisted evidence tampering, duplicate criteria and invalid count targets fail explicitly', () => {
  const observed = bind({ kind: 'observation', resourceKey: 'file:a' });
  for (const change of [{ id: 'invented' }, { resourceKey: 'file:b' }, { operationId: 'other' }]) {
    assert.throws(() => evaluate('observation', [{ ...observed, ...change }]), /identity|binding/);
  }
  assert.throws(() => evaluate('observation', [observed], { targetCount: 0 }), /targetCount/);
  const duplicate = plan('observation'); duplicate.criteria.push({ ...duplicate.criteria[0] });
  assert.throws(() => evaluateContractCriteria(duplicate, [observed]), /duplicate criterion/);
});

async function observedOperation(call, result, context = {}, workItemId = 'work-a') {
  const descriptor = await describeHostOperation(call, context);
  const returned = await normalizeHostOperationResult(result, { ...context, call, descriptor });
  const operationId = `operation-${++sequence}`;
  const evidence = returned.evidence.map(input => normalizeContractEvidence(input, { operationId, workItemId, at }));
  return { descriptor, evidence, operation: { operationId, workItemId, deliveryState: 'returned', success: true,
    resources: descriptor.resources, evidenceIds: evidence.map(record => record.id) } };
}
const browserResult = body => ({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(body) }] });

test('real workspace read satisfies a tool-free workspace selector through retained host scope and preserves old evidence bytes', async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'contract-scope-read-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await fs.writeFile(path.join(cwd, 'demo-profile.json'), '{\n  "name": "Fixture participant"\n}\n');
  const call = { name: 'relay_workspace', arguments: { action: 'read', path: 'demo-profile.json' } };
  const fixture = await observedOperation(call, await createWorkspaceToolHandler({ cwd })(call), { cwd });
  const key = fixture.descriptor.resources.find(resource => resource.key.startsWith('workspace:')).key;
  const exact = fixture.evidence[0].resourceKey;
  const saved = JSON.stringify({ records: [fixture.operation], evidence: fixture.evidence });
  const journal = JSON.parse(saved), options = { operations: journal.records };
  assert.equal(evaluate('observation', journal.evidence, { resourceKey: key }).satisfied, false, 'Legacy exact matching alone reproduces the native prerequisite failure.');
  assert.equal(evaluate('observation', journal.evidence, { resourceKey: key }, options).satisfied, true);
  const judgment = { workItemId: 'work-a', criterionId: 'criterion', judgment: 'satisfied', evidenceIds: journal.evidence.map(record => record.id) };
  assert.equal(evaluate('judgment', journal.evidence, { resourceKey: key }, { ...options, judgments: [judgment] }).satisfied, true);
  assert.equal(checkContractJudgmentEvidence(plan('judgment', { resourceKey: key }), journal.evidence, judgment, options).valid, true);
  assert.equal(evaluate('source-coverage', journal.evidence, { resourceKey: key }, options).satisfied, false, 'Coverage still needs the exact source.');
  assert.equal(evaluate('source-coverage', journal.evidence, { resourceKey: exact }, options).satisfied, true);
  assert.equal(evaluate('observation', journal.evidence, { resourceKey: exact }).satisfied, true, 'Older journals without scope metadata retain exact matching.');
  const noScopes = structuredClone(journal.records); noScopes[0].resources.forEach(resource => { delete resource.scopeKeys; });
  assert.equal(evaluate('observation', journal.evidence, { resourceKey: key }, { operations: noScopes }).satisfied, false, 'A broad marker alone cannot reconstruct missing scope membership.');
  assert.equal(JSON.stringify(journal), saved, 'Evaluation neither migrates saved evidence nor changes its content-addressed identities.');
});

test('scope membership requires the producing operation, work item, retained evidence ID and exact concrete resource', () => {
  const key = 'workspace:/work/tenant-a', observed = bind({ kind: 'observation', resourceKey: 'path:/work/tenant-a/profile.json' });
  const operation = { operationId: observed.operationId, workItemId: observed.workItemId, deliveryState: 'returned', success: true,
    evidenceIds: [observed.id], resources: [{ key, access: 'read', scopeOnly: true }, { key: observed.resourceKey, access: 'read', scopeKeys: [key] }] };
  assert.equal(evaluate('observation', [observed], { resourceKey: key }, { operations: [operation] }).satisfied, true);
  for (const change of [
    row => { row.operationId = 'another-operation'; }, row => { row.workItemId = 'another-work-item'; }, row => { row.evidenceIds = []; },
    row => { row.deliveryState = 'reserved'; }, row => { row.deliveryState = 'cancelled-before-dispatch'; }, row => { row.success = false; },
    row => { row.resources[1].key += '.other'; }, row => { row.resources[1].scopeOnly = true; },
    row => { row.resources = [row.resources[0]]; }, row => { delete row.resources[1].scopeKeys; },
  ]) {
    const changed = structuredClone(operation); change(changed);
    assert.equal(evaluate('observation', [observed], { resourceKey: key }, { operations: [changed] }).satisfied, false, JSON.stringify(changed));
  }
  const ownedElsewhere = bind({ kind: 'observation', resourceKey: observed.resourceKey }, { workItemId: 'work-b' });
  const otherOperation = { ...operation, operationId: ownedElsewhere.operationId, workItemId: 'work-b', evidenceIds: [ownedElsewhere.id] };
  assert.equal(evaluate('observation', [ownedElsewhere], { resourceKey: key }, { operations: [otherOperation] }).satisfied, false);
});

test('workspace siblings and model-authored scope claims cannot acquire a workspace selector', async () => {
  const cwd = path.resolve(os.tmpdir(), 'contract-workspace-a'), target = path.resolve(cwd + '-other', 'profile.json');
  const intended = await describeHostOperation({ name: 'relay_workspace', arguments: { action: 'read', path: 'profile.json' } }, { cwd });
  const key = intended.resources.find(resource => resource.key.startsWith('workspace:')).key;
  const call = { name: 'relay_workspace', arguments: { action: 'read', path: target, resourceKeys: [key], scopeKeys: [key], resources: [{ key, scopeOnly: true }] } };
  const descriptor = await describeHostOperation(call, { cwd });
  assert.ok(descriptor.resources.every(resource => !resource.scopeKeys?.includes(key)));
  const observed = bind({ kind: 'observation', resourceKey: descriptor.resources.find(resource => !resource.scopeOnly).key, validation: { scopeKeys: [key], workspace: key } });
  const operation = { operationId: observed.operationId, workItemId: 'work-a', deliveryState: 'returned', success: true, resources: descriptor.resources, evidenceIds: [observed.id] };
  assert.equal(evaluate('observation', [observed], { resourceKey: key }, { operations: [operation] }).satisfied, false);
  assert.throws(() => bind({ kind: 'observation', resourceKey: observed.resourceKey, scopeKeys: [key] }), /not supported/);
});

test('browser source scopes follow the actual concrete target and cannot borrow another origin in the operation', async () => {
  const source = { current: true, tabId: 'relay:scope', documentId: 'scope:1', url: 'https://old.test/tenant-a/form' };
  const call = { name: 'relay_browser', arguments: { action: 'navigate', tabId: source.tabId, url: 'https://portal.test/tenant-a/catalog?topic=engineering' } };
  const fixture = await observedOperation(call, browserResult({ documentId: 'scope:2', url: call.arguments.url, text: 'Observed catalog' }), { browserObservation: source });
  const options = { operations: [fixture.operation] };
  assert.equal(fixture.evidence[0].resourceKey, 'document:scope:1');
  assert.ok(fixture.descriptor.resources.some(resource => resource.key === 'origin:https://old.test'), 'The operation also contains the old source origin.');
  for (const key of ['origin:https://portal.test', 'url:https://portal.test/tenant-a/'])
    assert.equal(evaluate('observation', fixture.evidence, { resourceKey: key }, options).satisfied, true);
  for (const key of ['origin:https://old.test', 'origin:https://portal.test.evil', 'url:https://portal.test/tenant-ab/'])
    assert.equal(evaluate('observation', fixture.evidence, { resourceKey: key }, options).satisfied, false);
  const judgment = { workItemId: 'work-a', criterionId: 'criterion', judgment: 'satisfied', evidenceIds: [fixture.evidence[0].id] };
  assert.equal(evaluate('judgment', fixture.evidence, { resourceKey: 'origin:https://portal.test' }, { ...options, judgments: [judgment] }).satisfied, true);
});

test('scoped qualitative assessment cannot reuse another assigned work item’s evidence', () => {
  const observed = bind({ kind: 'observation', resourceKey: 'file:a' });
  const contract = plan('judgment', { resourceKey: 'file:a', targetCount: 2 }, [{ id: 'work-a', criterionIds: ['criterion'] }, { id: 'work-b', criterionIds: ['criterion'] }]);
  const judgment = workItemId => ({ workItemId, criterionId: 'criterion', judgment: 'satisfied', evidenceIds: [observed.id] });
  const assessed = evaluateContractCriteria(contract, [observed], { judgments: [judgment('work-a'), judgment('work-b')] }).criteria[0];
  assert.equal(assessed.observedCount, 1);
  assert.equal(assessed.satisfied, false);
  assert.match(assessed.reason, /belongs to work item work-a/);
  assert.equal(checkContractJudgmentEvidence(contract, [observed], judgment('work-b')).valid, false);
});

test('host scope membership does not broaden external confirmation identity or count rules', () => {
  const key = 'origin:https://portal.test', observed = receipt('actual-outcome', { resourceKey: 'destination:https://portal.test/enroll' });
  const operation = { operationId: observed.operationId, workItemId: observed.workItemId, deliveryState: 'returned', success: true,
    resources: [{ key: observed.resourceKey, access: 'write', scopeKeys: [key] }], evidenceIds: [observed.id] };
  const options = { operations: [operation] };
  assert.equal(evaluate('external-confirmation', [observed], { resourceKey: key }, options).satisfied, false);
  assert.equal(evaluate('external-confirmation', [observed], { resourceKey: observed.resourceKey }, options).satisfied, true);
  assert.equal(evaluate('external-confirmation', [observed, observed], { resourceKey: observed.resourceKey, targetCount: 2 }, options).observedCount, 1);
});
