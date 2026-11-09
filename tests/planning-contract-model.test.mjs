import test from 'node:test';
import assert from 'node:assert/strict';
import { taskAccuracySchema, validateTaskAccuracy } from '../public/task-viability-model.mjs';
import { parseResponseCycleResponse, responseCycleStage } from '../public/response-cycle-model.mjs';
import {
  PLAN_CONTRACT_VERSION, PLAN_CONTRACT_SCHEMA, PLAN_CONTRACT_LIMITS, CONTRACT_AUTHORING_GUIDANCE, CONTRACT_INSTRUCTIONS,
  normalizePlanContract, normalizePlanContractResponse, isPlanContractTask, contractPlanProjection,
} from '../public/planning-contract-model.mjs';

const draft = () => ({
  contractVersion: 2,
  goal: 'Complete the requested work and report observed outcomes.',
  criteria: [
    { id: 'history-read', kind: 'source-coverage', description: 'Read the complete known history.', resourceKey: 'file:history.csv' },
    { id: 'submitted', kind: 'external-confirmation', description: 'Receive a new destination confirmation.', resourceKey: 'web:https://example.test/tenant/a/submit', targetCount: 1 },
  ],
  workItems: [
    { id: 'form', title: 'Complete and verify the form', objective: 'Inspect, fill, correct validation, submit and observe the receipt.',
      owner: 'coordinator', resourceKeys: ['web:https://example.test/tenant/a/submit'], effects: ['observe', 'interact', 'commit'], dependsOn: ['history'], criterionIds: ['submitted'] },
    { id: 'history', title: 'Inspect the complete history', objective: 'Identify existing outcomes from the full source.',
      owner: 'coordinator', resourceKeys: ['file:history.csv'], effects: ['observe'], dependsOn: [], criterionIds: ['history-read'] },
  ],
  instructions: [{ id: 'ordinary-preference', text: 'Report a missed ordinary preference and continue authorized work.', handling: 'audit' }],
});
const binding = () => ({
  version: 1, format: 'dom', resourceKey: 'web:https://example.test/tenant/a/submit',
  record: '[data-receipt]', status: 'data-status', confirmedValues: ['confirmed'], absentValues: ['absent'],
  outcomeId: 'data-outcome-id', destination: 'data-form-action', history: false,
  prior: { field: 'data-prior', values: ['true'] },
  identity: [{ field: 'data-workshop', formField: 'workshopId' }],
});
const withBinding = () => {
  const input = draft(); input.criteria[1].receiptBinding = binding(); return input;
};

const accuracyTarget = () => ({ mode: 'exact', tolerance: 'No unverified outcomes.', decisionThreshold: 'The required distinct outcome count is observed.',
  evidenceNeeded: 'Matching host-observed destination confirmations.', consequence: 'An inaccurate count would misstate completion.',
  unknownPolicy: 'block', stopWhen: 'The declared target is established by the retained evidence.' });

test('canonical model null markers preserve optionality without weakening host receipt rules', () => {
  const original = draft();
  const candidate = structuredClone(original);
  Object.assign(candidate.criteria[0], { label: null, accuracy: null, targetCount: null, receiptBinding: null, receiptBindings: null });
  const criterion = candidate.criteria[1];
  Object.assign(criterion, { label: null, accuracy: null, receiptBinding: null, receiptBindings: [{
    ...binding(), absentValues: null, destination: null, prior: null, identity: null,
  }] });
  const sources = [{ id: 'cycle:execution-contract:fixture', text: JSON.stringify({ taskSchemaVersion: 14, contractVersion: 2 }) }];
  const stage = responseCycleStage('plan');
  const result = parseResponseCycleResponse({
    values: {}, checks: stage.checks.map(check => ({ id: check.id, assessment: 'supported', sourceIds: [], note: 'Synthetic Plan check.' })),
    subproblems: [], childResults: [], contract: candidate,
  }, 'plan', { sources });
  const parsed = result.contract;
  assert.equal(result.acceptanceCriteria[1].verification, 'effect');
  assert.deepEqual(parsed.criteria[0], normalizePlanContract(original).criteria[0]);
  assert.deepEqual(parsed.criteria[1].receiptBindings[0].confirmedValues, ['confirmed']);
  for (const field of ['absentValues', 'destination', 'prior', 'identity']) assert.equal(Object.hasOwn(parsed.criteria[1].receiptBindings[0], field), false);
  assert.equal(criterion.receiptBindings[0].destination, null);
  assert.throws(() => normalizePlanContract(candidate), { code: 'TASK_CONTRACT_INVALID' }, 'direct host authoring rules stay unchanged');

  const both = structuredClone(candidate);
  both.criteria[1].receiptBinding = binding();
  assert.throws(() => normalizePlanContractResponse(both), /Use receiptBinding or receiptBindings/);
  const noObservedStatus = structuredClone(candidate);
  noObservedStatus.criteria[1].receiptBindings[0].confirmedValues = [];
  assert.throws(() => normalizePlanContractResponse(noObservedStatus), /at least one observed confirmed or absent value/);
  const wrongRequired = structuredClone(candidate);
  wrongRequired.criteria[1].receiptBindings[0].status = null;
  assert.throws(() => normalizePlanContractResponse(wrongRequired), { code: 'TASK_CONTRACT_INVALID' });
});

test('canonical criteria retain declared task accuracy in the derived Plan without changing verification', () => {
  const input = withBinding(); input.criteria[1].accuracy = accuracyTarget();
  const before = structuredClone(input), normalized = normalizePlanContract(input), projection = contractPlanProjection(normalized);
  assert.deepEqual(input, before);
  assert.deepEqual(normalized.criteria[1].accuracy, validateTaskAccuracy(before.criteria[1].accuracy));
  assert.deepEqual(projection.acceptanceCriteria[1].accuracy, before.criteria[1].accuracy);
  assert.equal(projection.acceptanceCriteria[1].verification, 'effect');
  assert.deepEqual(normalized.criteria[1].receiptBinding, before.criteria[1].receiptBinding);
  input.criteria[1].accuracy.stopWhen = 'Mutation of the authored object.';
  projection.acceptanceCriteria[1].accuracy.unknownPolicy = 'omit';
  assert.deepEqual(normalized.criteria[1].accuracy, before.criteria[1].accuracy);
  assert.deepEqual(PLAN_CONTRACT_SCHEMA.properties.criteria.items.properties.accuracy, taskAccuracySchema());
  assert.equal(PLAN_CONTRACT_SCHEMA.properties.criteria.items.required.includes('accuracy'), false);
});

test('canonical accuracy uses the shared validation rules and absent targets preserve historical projections', () => {
  const absent = withBinding(), historical = normalizePlanContract(absent), expected = contractPlanProjection(absent);
  for (const accuracy of [undefined, null]) {
    const input = structuredClone(absent); if (accuracy !== undefined) input.criteria[1].accuracy = accuracy;
    assert.deepEqual(normalizePlanContract(input), historical);
    assert.deepEqual(contractPlanProjection(input), expected);
    assert.equal(Object.hasOwn(normalizePlanContract(input).criteria[1], 'accuracy'), false);
  }
  for (const mode of ['exact', 'bounded_estimate', 'qualitative']) {
    const input = withBinding(); input.criteria[1].accuracy = { ...accuracyTarget(), mode, tolerance: 'Within the supplied bounded range.' };
    assert.deepEqual(normalizePlanContract(input).criteria[1].accuracy, validateTaskAccuracy(input.criteria[1].accuracy));
  }
  const invalid = [ { ...accuracyTarget(), mode: 'certain' }, { ...accuracyTarget(), unknownPolicy: 'ignore' },
    { ...accuracyTarget(), mode: 'bounded_estimate', tolerance: '' }, { ...accuracyTarget(), evidenceNeeded: '' },
    { ...accuracyTarget(), stopWhen: 'x'.repeat(2001) }, { ...accuracyTarget(), verified: true } ];
  for (const field of Object.keys(accuracyTarget())) { const target = accuracyTarget(); delete target[field]; invalid.push(target); }
  for (const accuracy of invalid) {
    const input = withBinding(); input.criteria[1].accuracy = accuracy;
    assert.throws(() => validateTaskAccuracy(accuracy)); assert.throws(() => normalizePlanContract(input));
  }
});

test('one cohesive work item preserves a form interaction sequence without adding atomic execution leaves', () => {
  const input = draft(), before = structuredClone(input);
  const normalized = normalizePlanContract(input);
  assert.deepEqual(input, before);
  assert.equal(normalized.workItems.length, 2);
  assert.deepEqual(normalized.workItems[0].effects, ['observe', 'interact', 'commit']);
  assert.deepEqual(normalized.workItems[0].dependsOn, ['history']);
  assert.equal(normalized.workItems[0].objective, before.workItems[0].objective);
  assert.equal('steps' in normalized, false);
  assert.equal('operation' in normalized.workItems[0], false);
  assert.equal('done' in normalized.workItems[0], false);
});

test('the explicit contract version does not reinterpret legacy task documents', () => {
  assert.equal(PLAN_CONTRACT_VERSION, 2);
  assert.equal(isPlanContractTask({ schemaVersion: 13, steps: [{ id: 'old', status: 'done', evidence: 'done' }] }), false);
  assert.equal(isPlanContractTask({ contract: { contractVersion: 1 } }), false);
  assert.equal(isPlanContractTask({ schemaVersion: 14, contract: normalizePlanContract(draft()) }), true);
  for (const version of [1, 3, '2', undefined]) assert.throws(() => normalizePlanContract({ ...draft(), contractVersion: version }), /contractVersion|canonical/i);
});

test('the accepted canonical contract does not retain mutable arrays owned by its authoring response', () => {
  const input = draft();
  const accepted = normalizePlanContract(input);
  input.workItems[0].effects.push('opaque');
  input.workItems[0].resourceKeys.push('origin:https://unrelated.test');
  input.workItems[0].dependsOn.length = 0;
  input.instructions[0].handling = 'preserve';
  assert.deepEqual(accepted.workItems[0].effects, ['observe', 'interact', 'commit']);
  assert.deepEqual(accepted.workItems[0].resourceKeys, ['web:https://example.test/tenant/a/submit']);
  assert.deepEqual(accepted.workItems[0].dependsOn, ['history']);
  assert.equal(accepted.instructions[0].handling, 'audit');
});

test('provider-authored plans cannot invent the host epoch, revision, task identity or execution receipts', () => {
  for (const extra of [{ planEpoch: 2 }, { revision: 5 }, { taskId: 'invented' }, { evidence: [] }, { outcomes: [] }]) {
    assert.throws(() => normalizePlanContract({ ...draft(), ...extra }), /undeclared/);
  }
  const saved = normalizePlanContract({ ...draft(), planEpoch: 3 }, { allowEpoch: true });
  assert.equal(saved.planEpoch, 3);
  for (const planEpoch of [0, -1, 1.5, '2']) assert.throws(() => normalizePlanContract({ ...draft(), planEpoch }, { allowEpoch: true }), /planEpoch/);
});

test('list order is not a dependency; forward references are valid and real cycles are rejected with participating IDs', () => {
  assert.deepEqual(normalizePlanContract(draft()).workItems.map(item => item.id), ['form', 'history']);
  const independent = draft(); independent.workItems[0].dependsOn = [];
  assert.deepEqual(normalizePlanContract(independent).workItems[0].dependsOn, []);
  const cycle = draft(); cycle.workItems[1].dependsOn = ['form'];
  assert.throws(() => normalizePlanContract(cycle), error => error.code === 'TASK_CONTRACT_INVALID' && /cycle.*form.*history.*form/.test(error.message));
  const self = draft(); self.workItems[1].dependsOn = ['history'];
  assert.throws(() => normalizePlanContract(self), /cycle.*history.*history/);
  const missing = draft(); missing.workItems[0].dependsOn = ['unknown'];
  assert.throws(() => normalizePlanContract(missing), /Unknown work item dependency/);
});

test('criterion coverage and reference identity are explicit, bounded, and free of duplicate IDs', () => {
  const changes = [
    value => value.criteria.push({ ...value.criteria[0] }),
    value => value.workItems.push({ ...value.workItems[0] }),
    value => value.workItems[0].criterionIds.push('unrecognized'),
    value => value.workItems[0].criterionIds.push('submitted'),
    value => value.workItems[0].dependsOn.push('history'),
    value => value.criteria.push({ id: 'uncovered', kind: 'observation', description: 'Unassigned' }),
  ];
  for (const change of changes) { const input = draft(); change(input); assert.throws(() => normalizePlanContract(input)); }
  const missingSource = draft(); delete missingSource.criteria[0].resourceKey;
  assert.throws(() => normalizePlanContract(missingSource), /exact resourceKey/);
  for (const targetCount of [0, -1, 0.5, 1001]) {
    const input = draft(); input.criteria[1].targetCount = targetCount;
    assert.throws(() => normalizePlanContract(input), /targetCount/);
  }
});

test('work-item scope does not accept wildcard authority, unsupported effect labels or fabricated permission fields', () => {
  for (const key of ['*', 'https://*/submit']) {
    const input = draft(); input.workItems[0].resourceKeys = [key];
    assert.throws(() => normalizePlanContract(input), /wildcard/);
  }
  for (const effect of ['anything', 'readOnly', 'safe', 'control']) {
    const input = draft(); input.workItems[0].effects = [effect];
    assert.throws(() => normalizePlanContract(input), /effect/);
  }
  for (const field of ['authorized', 'readOnly', 'confirmed', 'done']) {
    const input = draft(); input.workItems[0][field] = true;
    assert.throws(() => normalizePlanContract(input), /undeclared/);
  }
});

test('canonical planning and execution explain how to expand bounded public research scope', () => {
  assert.match(CONTRACT_AUTHORING_GUIDANCE, /observe and a concrete browser scope.*actual origin from the captured evidence/);
  assert.match(CONTRACT_AUTHORING_GUIDANCE, /browser:relay scope covers tab inventory/);
  assert.match(CONTRACT_AUTHORING_GUIDANCE, /revise that same work item with the exact resource, preserving prior IDs and evidence/);
  assert.match(CONTRACT_AUTHORING_GUIDANCE, /Research scope does not authorize form submissions, messages, or other commitments/);
  assert.ok(CONTRACT_INSTRUCTIONS.includes(CONTRACT_AUTHORING_GUIDANCE));
});

test('ordinary audit handling remains separate from resource and effect permissions', () => {
  const input = draft();
  const normalized = normalizePlanContract(input);
  assert.equal(normalized.instructions[0].handling, 'audit');
  assert.deepEqual(normalized.workItems[0].resourceKeys, input.workItems[0].resourceKeys);
  assert.deepEqual(normalized.workItems[0].effects, input.workItems[0].effects);
  input.instructions[0].handling = 'preserve';
  assert.equal(normalizePlanContract(input).instructions[0].handling, 'preserve');
  input.instructions[0].handling = 'skip-authorization';
  assert.throws(() => normalizePlanContract(input), /handling/);
});

test('receipt bindings declare observed fields and destination identity without accepting a claimed effect identity', () => {
  const normalized = normalizePlanContract(withBinding());
  assert.deepEqual(normalized.criteria[1].receiptBinding, binding());
  for (const key of ['effectKey', 'operationId', 'confirmed', 'payloadDigest']) {
    const input = withBinding(); input.criteria[1].receiptBinding[key] = 'model-claim';
    assert.throws(() => normalizePlanContract(input), /undeclared/);
  }
  const foreign = withBinding(); foreign.criteria[1].receiptBinding.resourceKey = 'web:https://example.test/tenant/b/submit';
  assert.throws(() => normalizePlanContract(foreign), /same resource/);
  const observation = withBinding(); observation.criteria[1].kind = 'observation';
  assert.throws(() => normalizePlanContract(observation), /Only external-confirmation/);
});

test('ambiguous or unspecified receipt status semantics are not accepted', () => {
  const overlap = withBinding(); overlap.criteria[1].receiptBinding.absentValues = ['confirmed'];
  assert.throws(() => normalizePlanContract(overlap), /both confirmed and absent/);
  const missing = withBinding(); delete missing.criteria[1].receiptBinding.history;
  assert.throws(() => normalizePlanContract(missing), /missing.*history/);
  const duplicate = withBinding(); duplicate.criteria[1].receiptBinding.confirmedValues = ['confirmed', 'confirmed'];
  assert.throws(() => normalizePlanContract(duplicate));
  const empty = withBinding(); Object.assign(empty.criteria[1].receiptBinding, { confirmedValues: [], absentValues: [] });
  assert.throws(() => normalizePlanContract(empty), /at least one observed confirmed or absent/);
  const format = withBinding(); format.criteria[1].receiptBinding.format = 'free-form-prose';
  assert.throws(() => normalizePlanContract(format), /DOM or JSON/);
});

test('JSON receipt bindings use explicit observed fields just like DOM bindings', () => {
  const input = withBinding();
  Object.assign(input.criteria[1].receiptBinding, { format: 'json', record: '/receipts', status: '/status', outcomeId: '/id', destination: '/formAction', history: true, identity: [{ field: '/workshopId', formField: 'workshopId' }] });
  const result = normalizePlanContract(input).criteria[1].receiptBinding;
  assert.equal(result.format, 'json');
  assert.equal(result.record, '/receipts');
  assert.equal(result.history, true);
});

test('legacy UI projections preserve intent and dependencies without manufacturing receipt status', () => {
  const accepted = normalizePlanContract({ ...draft(), planEpoch: 2 }, { allowEpoch: true });
  const projection = contractPlanProjection(accepted, ['request-1']);
  assert.equal(projection.steps.length, accepted.workItems.length);
  assert.deepEqual(projection.steps[0].dependsOn, ['history']);
  assert.deepEqual(projection.steps[0].criterionIds, ['submitted']);
  assert.deepEqual(projection.steps[0].sourceIds, ['request-1']);
  assert.equal(projection.acceptanceCriteria.find(item => item.id === 'submitted').verification, 'effect');
  assert.equal(projection.acceptanceCriteria.find(item => item.id === 'history-read').verification, 'evidence');
  assert.equal('status' in projection.steps[0], false);
  assert.equal('outcomes' in projection, false);
});

test('schema remains bounded and self-contained for provider response-only preparation', () => {
  const schema = JSON.stringify(PLAN_CONTRACT_SCHEMA);
  assert.ok(schema.length < 60000, `schema size ${schema.length}`);
  let depth = 0;
  function visit(value, current = 0) {
    depth = Math.max(depth, current);
    if (!value || typeof value !== 'object') return;
    assert.equal('$ref' in value, false);
    assert.equal('$dynamicRef' in value, false);
    for (const child of Object.values(value)) visit(child, current + 1);
  }
  visit(PLAN_CONTRACT_SCHEMA);
  assert.ok(depth <= 24, `schema depth ${depth}`);
  assert.ok(PLAN_CONTRACT_LIMITS.workItems >= 20);
  assert.equal(PLAN_CONTRACT_SCHEMA.additionalProperties, false);
});

const textBinding = () => ({
  version: 1, format: 'dom-text', resourceKey: 'web:https://example.test/tenant/a/submit',
  record: 'main h1', confirmedValues: ['Enrollment received'], absentValues: ['Enrollment rejected'],
  history: false, outcomeFields: ['email', 'workshopId'],
});
const withTextBinding = () => {
  const input = draft(); input.criteria[1].receiptBinding = textBinding(); return input;
};

test('ordinary text bindings declare observed status and real subject fields without authoring a receipt', () => {
  const input = withTextBinding(), normalized = normalizePlanContract(input);
  assert.deepEqual(normalized.criteria[1].receiptBinding, textBinding());
  input.criteria[1].receiptBinding.outcomeFields.push('unrelated');
  input.criteria[1].receiptBinding.confirmedValues.push('Invented success');
  assert.deepEqual(normalized.criteria[1].receiptBinding.outcomeFields, ['email', 'workshopId']);
  assert.deepEqual(normalized.criteria[1].receiptBinding.confirmedValues, ['Enrollment received']);
  assert.equal('effectKey' in normalized.criteria[1].receiptBinding, false);
});

test('ordinary text cannot claim historical confirmation or import structured receipt authority', () => {
  const history = withTextBinding(); history.criteria[1].receiptBinding.history = true;
  assert.throws(() => normalizePlanContract(history));
  for (const [key, value] of Object.entries({
    status: 'data-status', outcomeId: 'invented-id', destination: 'data-destination',
    identity: [{ field: 'data-email', formField: 'email' }], prior: { field: 'data-prior', values: ['true'] },
    effectKey: 'claimed-effect', operationId: 'claimed-operation',
  })) {
    const input = withTextBinding(); input.criteria[1].receiptBinding[key] = value;
    assert.throws(() => normalizePlanContract(input), /undeclared/);
  }
});

test('text bindings reject ambiguous status and missing, duplicate or excessive subject fields', () => {
  const overlap = withTextBinding(); overlap.criteria[1].receiptBinding.absentValues = ['Enrollment received'];
  assert.throws(() => normalizePlanContract(overlap), /both confirmed and absent/);
  for (const outcomeFields of [[], ['email', 'email'], [''], Array.from({ length: 21 }, (_, i) => `field-${i}`)]) {
    const input = withTextBinding(); input.criteria[1].receiptBinding.outcomeFields = outcomeFields;
    assert.throws(() => normalizePlanContract(input));
  }
  for (const missing of ['history', 'outcomeFields', 'record', 'confirmedValues']) {
    const input = withTextBinding(); delete input.criteria[1].receiptBinding[missing];
    assert.throws(() => normalizePlanContract(input));
  }
});



test('observed absence-only bindings are valid for DOM, JSON and native text without inventing positive statuses', () => {
  const bindings = [
    { ...binding(), confirmedValues: [] },
    { ...binding(), format: 'json', record: '/receipt', status: '/status', outcomeId: '/id', destination: '/destination', confirmedValues: [] },
    { version: 1, format: 'dom-text', resourceKey: binding().resourceKey, record: '#status', confirmedValues: [], absentValues: ['Please correct this form.'], history: false, outcomeFields: ['workshopId'] },
  ];
  for (const receiptBinding of bindings) {
    const input = draft(); input.criteria[1].receiptBinding = receiptBinding;
    assert.deepEqual(normalizePlanContract(input).criteria[1].receiptBinding, receiptBinding);
    for (const absentValues of [undefined, []]) {
      const empty = structuredClone(input);
      if (absentValues === undefined) delete empty.criteria[1].receiptBinding.absentValues;
      else empty.criteria[1].receiptBinding.absentValues = absentValues;
      assert.throws(() => normalizePlanContract(empty), /at least one observed confirmed or absent/);
    }
    for (const absentValues of [['', 'absent'], ['absent', 'absent'], Array.from({ length: 21 }, (_, index) => `status-${index}`)]) {
      const invalid = structuredClone(input); invalid.criteria[1].receiptBinding.absentValues = absentValues;
      assert.throws(() => normalizePlanContract(invalid));
    }
    const overlap = structuredClone(input); overlap.criteria[1].receiptBinding.confirmedValues = [...receiptBinding.absentValues];
    assert.throws(() => normalizePlanContract(overlap), /both confirmed and absent/);
  }
  assert.deepEqual(normalizePlanContract(withBinding()).criteria[1].receiptBinding, binding(), 'Existing stored positive bindings remain unchanged.');
});


test('bounded receipt alternatives retain one criterion target across sites and legacy remains exclusive',()=>{
 const plan=draft();const criterion=plan.criteria[1];delete criterion.resourceKey;criterion.targetCount=5;
 criterion.receiptBindings=[binding(),{...binding(),format:'json',resourceKey:'origin:https://other.test',record:'/receipts'}];
 const saved=normalizePlanContract(plan);assert.equal(saved.criteria[1].targetCount,5);assert.equal(saved.criteria[1].receiptBindings.length,2);assert.equal(saved.criteria[1].receiptBinding,undefined);
 for(const variants of [[],Array(9).fill(binding()),[binding(),binding()]]){const bad=structuredClone(plan);bad.criteria[1].receiptBindings=variants;assert.throws(()=>normalizePlanContract(bad),{code:'TASK_CONTRACT_INVALID'});}
 const both=structuredClone(plan);both.criteria[1].receiptBinding=binding();assert.throws(()=>normalizePlanContract(both),{code:'TASK_CONTRACT_INVALID'});
 const observation=structuredClone(plan);observation.criteria[1].kind='observation';assert.throws(()=>normalizePlanContract(observation),{code:'TASK_CONTRACT_INVALID'});
 const scoped=structuredClone(plan);scoped.criteria[1].resourceKey=binding().resourceKey;assert.throws(()=>normalizePlanContract(scoped),{code:'TASK_CONTRACT_INVALID'});
 assert.deepEqual(PLAN_CONTRACT_SCHEMA.properties.criteria.items.not,{required:['receiptBinding','receiptBindings']});
});

test('receipt variant duplicate detection ignores incoming object property order',()=>{const plan=draft();delete plan.criteria[1].resourceKey;const original=binding(),reordered=Object.fromEntries(Object.entries(original).reverse());plan.criteria[1].receiptBindings=[original,reordered];assert.throws(()=>normalizePlanContract(plan),{code:'TASK_CONTRACT_INVALID'});});
