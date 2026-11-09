import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCanonicalCycleEvidence, canonicalContractHash, canonicalOutcomeSummary } from '../lib/planning-contract-cycle.mjs';
import { canonicalCycleTaskContext } from '../public/planning-contract-cycle-model.mjs';
import { normalizeContractEvidence } from '../lib/planning-contract-evidence.mjs';
import { describeHostOperation, normalizeHostOperationResult } from '../lib/operation-descriptors.mjs';
import { contractRuntimeView } from '../lib/planning-contract-runtime.mjs';

function fixture() {
  const run = { id: 'run-1', taskId: 'task-1', planningContractVersion: 14 };
  const planRef = { requestId: 'request-1', cycleId: 'cycle-1', nodeId: 'plan-1', nodeRevision: 2, responseId: 'response-1' };
  const contract = {
    contractVersion: 2, goal: 'Enroll one new participant in a workshop.',
    criteria: [{ id: 'enrolled', kind: 'external-confirmation', description: 'One new workshop enrollment is confirmed.', resourceKey: 'destination:workshops', targetCount: 1 }],
    workItems: [{ id: 'form', title: 'Complete the form', objective: 'Inspect, fill, submit and verify the enrollment.', owner: 'coordinator', resourceKeys: ['destination:workshops'], effects: ['observe', 'interact', 'commit'], dependsOn: [], criterionIds: ['enrolled'] }],
    instructions: [],
  };
  const acceptedPlan = { values: { approach: 'Complete and verify the form.' }, contract: structuredClone(contract) };
  const taskState = {
    taskId: run.taskId, revision: 3, contract: { ...contract, planEpoch: 1 },
    contractAdoption: { version: 1, contractVersion: 2, taskId: run.taskId, runId: run.id, nodeId: 'worker-1', planRef,
      sourceSha256: canonicalContractHash(acceptedPlan), acceptedContractSha256: canonicalContractHash(contract) },
  };
  const observed = normalizeContractEvidence({ kind: 'external-confirmation', resourceKey: 'destination:workshops',
    confirmation: { outcomeId: 'participant:workshop-one', effectKey: 'effect-one', status: 'confirmed' } },
  { operationId: 'observe-1', workItemId: 'form', at: '2026-11-05T18:00:00Z' });
  const journal = { version: 3, taskId: run.taskId, journalSeq: 4, evidence: [observed], judgments: [], findings: [], records: [
    { operationId: 'commit-1', workItemId: 'form', runId: run.id, nodeId: 'worker-1', callId: 'call-1', tool: 'relay_browser', action: 'click', planEpoch: 1,
      deliveryState: 'returned', effect: 'commit', effectState: 'confirmed', evidenceIds: [], reconciliationEvidenceIds: [observed.id], commit: { effectKey: 'effect-one', destinationKey: 'destination:workshops' } },
    { operationId: 'observe-1', workItemId: 'form', runId: run.id, nodeId: 'worker-1', callId: 'call-2', tool: 'relay_browser', action: 'read', planEpoch: 1,
      deliveryState: 'returned', effect: 'observe', effectState: 'not-applicable', evidenceIds: [observed.id] },
  ] };
  return { run, taskState, journal, planRef, acceptedPlan };
}

test('actual host evidence produces a current canonical source and a bound external-effect receipt', () => {
  const input = fixture(), before = structuredClone(input);
  const result = buildCanonicalCycleEvidence(input);
  assert.deepEqual(input, before);
  assert.equal(result.data.complete, true);
  assert.equal(result.effectReceipts.length, 1);
  const receipt = result.effectReceipts[0];
  assert.equal(receipt.sourceId, result.sources[0].id);
  assert.equal(receipt.proofSha256, result.sources[0].contentHash);
  assert.equal(receipt.canonicalContract.planEpoch, 1);
  assert.equal(receipt.canonicalContract.journalSeq, 4);
  assert.deepEqual(JSON.parse(result.sources[0].text).receiptBindings, [{ id: receipt.id, criterionIds: ['enrolled'] }]);
  const context = canonicalCycleTaskContext(result.sources, { cycleId: 'cycle-1', runId: input.run.id, planRef: input.planRef });
  assert.equal(context.complete, true);
  assert.equal(context.criteria[0].observedCount, 1);
});

test('a new scheduled occurrence cannot count a confirmation from the previous occurrence', () => {
  const input = fixture();
  input.taskState.contractAdoption.freshEvidence = true;
  input.journal.records[0].dispatchedAt = '2026-11-05T17:59:00Z';
  assert.equal(buildCanonicalCycleEvidence(input).data.complete, true);

  const previousRun = input.run.id;
  input.run.id = 'run-2';
  input.planRef.cycleId = 'cycle-2';
  input.taskState.contractAdoption.runId = input.run.id;
  const next = buildCanonicalCycleEvidence(input);
  assert.equal(next.data.complete, false);
  assert.equal(next.data.outcomes[0].status, 'confirmed');
  assert.equal(next.data.outcomes[0].isNew, false);
  assert.equal(next.effectReceipts.length, 0);
  assert.equal(input.journal.records[0].runId, previousRun);
});

for (const kind of ['observation', 'judgment']) test('final review and live progress use the same retained host scopes for ' + kind, async () => {
  const input = fixture(), resourceKey = 'origin:https://portal.test';
  input.taskState.contract.goal = 'Inspect the workshop catalog.';
  input.taskState.contract.criteria = [{ id: 'catalog', kind, description: 'Inspect the actual catalog at this service.', resourceKey, targetCount: 1 }];
  Object.assign(input.taskState.contract.workItems[0], { resourceKeys: [resourceKey], effects: ['observe'], criterionIds: ['catalog'] });
  input.taskState.contract.planEpoch = 2;
  const call = { name: 'relay_browser', arguments: { action: 'open', url: 'https://portal.test/catalog' } };
  const descriptor = await describeHostOperation(call);
  const result = { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ url: call.arguments.url, documentId: 'catalog:1', text: 'Actual catalog' }) }] };
  const observed = await normalizeHostOperationResult(result, { call, descriptor });
  const evidence = observed.evidence.map(row => normalizeContractEvidence(row, { operationId: 'catalog-read', workItemId: 'form', at: '2026-11-05T18:00:00Z' }));
  input.journal.evidence = evidence;
  input.journal.records = [{ operationId: 'catalog-read', workItemId: 'form', runId: input.run.id, nodeId: 'worker-1', callId: 'catalog-call', tool: call.name, action: 'open', planEpoch: 2,
    effect: 'observe', effectState: 'not-applicable', deliveryState: 'returned', success: true, resources: descriptor.resources, evidenceIds: evidence.map(row => row.id) }];
  input.journal.focuses = []; input.journal.progress = [];
  input.journal.judgments = kind === 'judgment' ? [{ workItemId: 'form', criterionId: 'catalog', judgment: 'satisfied', evidenceIds: evidence.map(row => row.id), planEpoch: 2 }] : [];
  const before = JSON.stringify(input), reviewed = buildCanonicalCycleEvidence(input), live = contractRuntimeView(input.taskState, input.journal);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(reviewed.data.criteria, live.criteria);
  assert.equal(reviewed.data.complete, true);
  assert.equal(reviewed.effectReceipts.length, 0, 'A scoped observation or judgment remains separate from an external outcome.');
  assert.deepEqual(reviewed.data.evidence.map(row => row.id), evidence.map(row => row.id));
  assert.equal(canonicalCycleTaskContext(reviewed.sources, { cycleId: input.planRef.cycleId, runId: input.run.id, planRef: input.planRef }).complete, true);
  input.journal.records[0].resources.forEach(resource => { delete resource.scopeKeys; });
  const missingMembership = buildCanonicalCycleEvidence(input);
  assert.equal(missingMembership.data.complete, false, 'A scopeOnly marker cannot establish final-review scope membership.');
  assert.deepEqual(missingMembership.data.criteria, contractRuntimeView(input.taskState, input.journal).criteria);
});

test('current canonical edits supersede original criteria without rewriting the accepted Plan', () => {
  const input = fixture(), original = structuredClone(input.acceptedPlan);
  input.taskState.contract.criteria[0].targetCount = 2;
  input.taskState.contract.criteria[0].description = 'Two new workshop enrollments are confirmed.';
  input.taskState.contract.planEpoch = 2;
  input.taskState.revision = 4;
  const result = buildCanonicalCycleEvidence(input);
  assert.deepEqual(input.acceptedPlan, original);
  assert.equal(result.data.planEpoch, 2);
  assert.equal(result.data.criteria[0].targetCount, 2);
  assert.equal(result.data.complete, false);
  assert.equal(result.effectReceipts.length, 0);
  const context = canonicalCycleTaskContext(result.sources, { cycleId: 'cycle-1', runId: input.run.id, planRef: input.planRef });
  assert.match(context.acceptanceCriteria[0].description, /^Two/);
});

test('model-supplied runtime projections cannot override journal evidence or manufacture an effect receipt', () => {
  const input = fixture();
  input.journal.evidence = [];
  input.journal.records.forEach(record => { record.evidenceIds = []; });
  input.taskState.contractRuntime = { criteria: [{ id: 'enrolled', satisfied: true }], outcomes: [{ isNew: true }] };
  input.journal.judgments = [{ workItemId: 'form', criterionId: 'enrolled', judgment: 'satisfied', note: 'All done', evidenceIds: ['invented'], planEpoch: 1 }];
  const result = buildCanonicalCycleEvidence(input);
  assert.equal(result.data.complete, false);
  assert.equal(result.effectReceipts.length, 0);
});

test('valid-looking evidence still needs its actual operation and matching work item', () => {
  for (const change of [
    value => { value.journal.records.pop(); },
    value => { value.journal.records[1].workItemId = 'different'; },
    value => { value.journal.records[1].evidenceIds = []; },
    value => { value.journal.records.push({ ...value.journal.records[1] }); },
  ]) { const input = fixture(); change(input); assert.throws(() => buildCanonicalCycleEvidence(input), /operation|observation/i); }
});

test('cross-task, foreign Plan and changed authoring provenance are rejected', () => {
  for (const change of [
    value => { value.run.planningContractVersion = 13; },
    value => { value.taskState.taskId = 'other'; },
    value => { value.journal.taskId = 'other'; },
    value => { value.taskState.contractAdoption.sourceSha256 = '0'.repeat(64); },
    value => { value.taskState.contractAdoption.acceptedContractSha256 = '0'.repeat(64); },
    value => { value.planRef = { ...value.planRef, responseId: 'other' }; },
    value => { value.acceptedPlan.values.approach = 'Changed historical Plan'; },
  ]) { const input = fixture(); change(input); assert.throws(() => buildCanonicalCycleEvidence(input), { code: 'TASK_CONTRACT_CYCLE_BINDING' }); }
});

test('reconciled lost responses do not stay unresolved, but unknown or active work prevents full completion', () => {
  for (const deliveryState of ['interrupted', 'dispatched']) {
    const reconciled = fixture(); reconciled.journal.records[0].deliveryState = deliveryState;
    assert.equal(buildCanonicalCycleEvidence(reconciled).data.complete, true);
    assert.equal(buildCanonicalCycleEvidence({ ...reconciled, runningOperationIds: ['commit-1'] }).data.complete, false);
  }
  const unbound = fixture(); unbound.journal.records[0].deliveryState = 'dispatched';
  unbound.journal.records[0].reconciliationEvidenceIds = [];
  assert.equal(buildCanonicalCycleEvidence(unbound).data.complete, false);
  const absent = fixture(); absent.journal.records[0].deliveryState = 'dispatched'; absent.journal.records[0].effectState = 'absent';
  const absence = normalizeContractEvidence({ kind: 'external-confirmation', resourceKey: 'destination:workshops',
    confirmation: { outcomeId: 'participant:workshop-one', effectKey: 'effect-one', status: 'absent' } },
  { operationId: 'observe-1', workItemId: 'form', at: '2026-11-05T18:01:00Z' });
  absent.journal.evidence.push(absence); absent.journal.records[1].evidenceIds.push(absence.id);
  absent.journal.records[0].reconciliationEvidenceIds.push(absence.id);
  const absentResult = buildCanonicalCycleEvidence(absent);
  assert.equal(absentResult.data.unresolved.length, 0);
  assert.equal(absentResult.data.criteria[0].observedCount, 0);
  assert.equal(absentResult.data.complete, false);
  for (const state of ['unknown', 'unconfirmed']) {
    const input = fixture(); input.journal.records[0].deliveryState = 'interrupted'; input.journal.records[0].effectState = state;
    const result = buildCanonicalCycleEvidence(input);
    assert.equal(result.data.complete, false);
    assert.equal(result.data.unresolved.length, 1);
    // The separately established outcome stays true; it does not settle every operation.
    assert.equal(result.effectReceipts.length, 1);
  }
  const active = fixture(); active.journal.records[1].deliveryState = 'dispatched';
  assert.equal(buildCanonicalCycleEvidence({ ...active, runningOperationIds: ['observe-1'] }).data.complete, false);
});

test('an incomplete final review reports host counts and uncertainty without claiming completion', () => {
  const input = fixture();
  input.taskState.contract.criteria[0].targetCount = 20;
  input.taskState.contract.planEpoch = 2;
  input.journal.records[0].effectState = 'unknown';
  const data = buildCanonicalCycleEvidence(input).data;
  const summary = canonicalOutcomeSummary(data, 'The final analytical review was not performed.');
  assert.match(summary, /0 of 1 completion criteria/);
  assert.match(summary, /1 of 20 new confirmed outcomes/);
  assert.match(summary, /1 operation remains unsettled or unverified/);
  assert.match(summary, /final analytical review was not performed/);
  assert.doesNotMatch(summary, /task completed|all done|20 of 20/i);
});

test('a lost reservation creates no effect uncertainty while a live reservation still blocks handoff', () => {
  const input = fixture();
  input.journal.records.push({ operationId: 'reserved-1', workItemId: 'form', runId: input.run.id,
    nodeId: 'worker-1', callId: 'reserved-call', tool: 'relay_browser', action: 'click', planEpoch: 1,
    deliveryState: 'reserved', effect: 'commit', effectState: 'unconfirmed', evidenceIds: [],
    commit: { effectKey: 'unperformed-effect', destinationKey: 'destination:workshops' } });
  const settled = buildCanonicalCycleEvidence(input);
  assert.equal(settled.data.complete, true);
  assert.equal(settled.data.unresolved.length, 0);
  assert.equal(settled.data.criteria[0].observedCount, 1);
  const live = buildCanonicalCycleEvidence({ ...input, runningOperationIds: ['reserved-1'] });
  assert.equal(live.data.complete, false);
  assert.equal(live.data.unresolved.length, 1);
  assert.equal(live.data.criteria[0].observedCount, 1);
});

test('fallback preserves findings while keeping verified outcomes separate from final review', () => {
  const input = fixture();
  input.journal.findings.push({ ruleId: 'ordinary-preference', message: 'An optional preference was missed.', disposition: 'audit', evidenceIds: [input.journal.evidence[0].id] });
  const summary = canonicalOutcomeSummary(buildCanonicalCycleEvidence(input).data, 'Final response checks did not pass.');
  assert.match(summary, /1 of 1 new confirmed outcomes/);
  assert.match(summary, /ordinary-preference: An optional preference was missed/);
  assert.match(summary, /Final response checks did not pass/);
});

test('missing current authoring provenance produces no invented counts in a fallback', () => {
  const summary = canonicalOutcomeSummary(null, 'The original Plan changed and requires review.');
  assert.match(summary, /current verified outcome summary is unavailable/);
  assert.match(summary, /Plan changed/);
  assert.doesNotMatch(summary, /\d+ of \d+|new confirmed outcomes/);
});

test('only external-confirmation criteria generate effect receipts, never grounded qualitative judgments', () => {
  const input = fixture();
  input.taskState.contract.criteria[0].kind = 'judgment';
  input.taskState.contract.planEpoch = 2;
  input.journal.judgments.push({ workItemId: 'form', criterionId: 'enrolled', judgment: 'satisfied', evidenceIds: [input.journal.evidence[0].id], planEpoch: 2 });
  const result = buildCanonicalCycleEvidence(input);
  assert.equal(result.data.complete, true);
  assert.equal(result.effectReceipts.length, 0);
});

test('large canonical evidence is split without truncation and reconstructed only from complete matching parts', () => {
  const input = fixture();
  input.taskState.contract.instructions = Array.from({ length: 30 }, (_, i) => ({ id: `instruction-${i}`, text: 'Preserve actual observed evidence and report unknowns. '.repeat(50).trim(), handling: 'preserve' }));
  input.taskState.contract.planEpoch = 2;
  const result = buildCanonicalCycleEvidence(input);
  assert.ok(result.sources.length > 1);
  assert.ok(result.sources.every(source => source.text.length <= 38000));
  const options = { cycleId: 'cycle-1', runId: input.run.id, planRef: input.planRef };
  const context = canonicalCycleTaskContext(result.sources, options);
  assert.equal(context.complete, true);
  assert.equal(context.contract.instructions.length, 30);
  assert.deepEqual(context.contract.instructions, input.taskState.contract.instructions);
  assert.equal(canonicalCycleTaskContext(result.sources.slice(0, -1), options).invalid, true);
  const mixed = structuredClone(result.sources);
  const part = JSON.parse(mixed[1].text); part.journalSeq += 1; mixed[1].text = JSON.stringify(part);
  assert.equal(canonicalCycleTaskContext(mixed, options).invalid, true);
});

test('public context rejects mismatched Plan, run or internally contradictory completion', () => {
  const input = fixture(), result = buildCanonicalCycleEvidence(input);
  assert.equal(canonicalCycleTaskContext(result.sources, { cycleId: 'cycle-1', runId: 'other', planRef: input.planRef }).invalid, true);
  assert.equal(canonicalCycleTaskContext(result.sources, { cycleId: 'cycle-1', runId: input.run.id, planRef: { ...input.planRef, nodeRevision: 3 } }).invalid, true);
  const changed = structuredClone(result.sources), data = JSON.parse(changed[0].text); data.complete = false; changed[0].text = JSON.stringify(data);
  assert.equal(canonicalCycleTaskContext(changed, { cycleId: 'cycle-1', runId: input.run.id, planRef: input.planRef }).invalid, true);
});
