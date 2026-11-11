import test from 'node:test';
import assert from 'node:assert/strict';
import { taskAccuracySchema, taskAccuracyFieldDescription, validateTaskAccuracy } from '../public/task-viability-model.mjs';
import { createPlanningAccuracyFieldRepair, applyPlanningAccuracyFieldRepair, planningAccuracyFieldRepairPrompt,
  planningFieldRepairEvidence, replayPlanningFieldRepairEvidence,
  PLANNING_FIELD_REPAIR_PROTOCOL, PLANNING_SCALAR_REPAIR_PROTOCOL } from '../lib/planning-field-repair.mjs';

const complete = {
  mode: 'exact', tolerance: 'Preserve expressly permitted equivalents.', decisionThreshold: 'Apply the supplied decision boundary.',
  evidenceNeeded: 'The supplied fictional criterion and source.', consequence: 'An unsupported result could fail this fictional task.',
  unknownPolicy: 'block', stopWhen: 'The supplied criterion is assessed with its captured evidence.'
};
function fixture({ mode = 'exact', missing = ['tolerance', 'decisionThreshold'], changes = {} } = {}) {
  const accuracy = { ...complete, mode, ...changes };
  for (const key of missing) delete accuracy[key];
  const base = { requirements: [{ id: 'criterion', accuracy }] };
  const schema = { type: 'object', additionalProperties: false, required: ['requirements'], properties: {
    requirements: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'accuracy'],
      properties: { id: { type: 'string' }, accuracy: taskAccuracySchema({ generation: true }) } } }
  } };
  const attempt = { requestId: 'field-guidance', nodeId: 'criterion', nodeRevision: 1,
    node: { kind: 'viability', title: 'Assess a supplied criterion', prompt: 'Use the captured fictional evidence.' },
    sources: [{ id: 'source', kind: 'user_request', text: 'Preserve these explicitly supplied equivalents and decision boundaries.' }],
    inputs: [], challenges: [],
    formatRepair: { previousAttemptId: 'failed-guidance', previousOutput: JSON.stringify(base),
      diagnostic: { code: 'TASK_VIABILITY_INVALID', message: 'Missing or invalid accuracy fields.', issues: [] } } };
  const plan = createPlanningAccuracyFieldRepair(attempt, schema);
  return { attempt, schema, base, plan };
}
const stripDescriptions = value => Array.isArray(value) ? value.map(stripDescriptions) :
  value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'description')
    .map(([key, item]) => [key, stripDescriptions(item)])) : value;

test('generation guidance describes distinct scalar roles without changing the legacy schema or scalar contract', () => {
  const legacy = taskAccuracySchema(), generated = taskAccuracySchema({ generation: true });
  assert.equal(JSON.stringify(legacy).includes('description'), false);
  const fields = generated.anyOf[0].properties;
  for (const field of ['mode', 'tolerance', 'decisionThreshold', 'evidenceNeeded', 'consequence', 'unknownPolicy', 'stopWhen'])
    assert.equal(fields[field].description, taskAccuracyFieldDescription(field));
  assert.match(fields.tolerance.description, /permitted deviation, range, granularity or equivalence/);
  assert.match(fields.tolerance.description, /different role from the precision category/);
  assert.match(fields.decisionThreshold.description, /boundary or condition that would change the decision/);
  assert.match(fields.unknownPolicy.description, /permissions supported by the captured task/);
  const withoutDescriptions = stripDescriptions(generated).anyOf[0];
  assert.deepEqual(withoutDescriptions.required, ['mode', 'tolerance', 'decisionThreshold', 'evidenceNeeded', 'consequence', 'unknownPolicy', 'stopWhen']);
  assert.deepEqual(withoutDescriptions.properties.mode, { type: 'string', enum: ['exact', 'bounded_estimate', 'qualitative'] });
  assert.deepEqual(withoutDescriptions.properties.unknownPolicy, { type: 'string', enum: ['block', 'assumption', 'range', 'omit'] });
  for (const field of ['tolerance', 'decisionThreshold', 'evidenceNeeded', 'consequence', 'stopWhen']) {
    assert.equal(withoutDescriptions.properties[field].type, 'string');
    assert.equal(withoutDescriptions.properties[field].maxLength, 2000);
    assert.equal(withoutDescriptions.properties[field].minLength, ['evidenceNeeded', 'consequence', 'stopWhen'].includes(field) ? 1 : 0);
  }
});

test('exact tolerance repair uses the captured mode and omits irrelevant mode examples from host guidance', () => {
  const { attempt, plan } = fixture();
  assert.equal(plan.protocol, PLANNING_FIELD_REPAIR_PROTOCOL);
  assert.deepEqual(plan.targets[0].missing, ['tolerance', 'decisionThreshold']);
  const properties = plan.schema.properties.repairs.properties.r0.properties;
  assert.match(properties.tolerance.description, /captured precision is exact and stays unchanged/);
  assert.match(properties.tolerance.description, /host does not make that choice/);
  assert.equal(JSON.stringify(properties).includes('bounded_estimate'), false);
  assert.match(properties.decisionThreshold.description, /decision rule, distinct from permitted variation/);
  const prompt = planningAccuracyFieldRepairPrompt(attempt, plan);
  const payload = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n') + 2));
  assert.equal(prompt.slice(0, prompt.lastIndexOf('\n\n')).includes('bounded_estimate'), false);
  assert.deepEqual(payload.sources, attempt.sources);
  assert.deepEqual(payload.targets[0].currentAccuracy, plan.targets[0].currentAccuracy);
  assert.equal(prompt.includes('Missing unknownPolicy is a task-specific decision'), false);
});

test('bounded and qualitative tolerance descriptions are local and do not default applicability', () => {
  const bounded = fixture({ mode: 'bounded_estimate' }).plan;
  assert.match(bounded.targets[0].properties.tolerance.description, /requires a bounded estimate and stays unchanged/);
  assert.match(bounded.targets[0].properties.tolerance.description, /Provide nonempty text/);
  const qualitative = fixture({ mode: 'qualitative' }).plan;
  assert.match(qualitative.targets[0].properties.tolerance.description, /captured precision is qualitative and stays unchanged/);
  assert.match(qualitative.targets[0].properties.tolerance.description, /only when a tolerance statement is immaterial/);
});

test('v2 mode repair does not assume a mode or widen the original editable mask', () => {
  const { plan } = fixture({ mode: null, missing: [], changes: { tolerance: 'Preserve this valid inherited text.' } });
  assert.equal(plan.protocol, PLANNING_SCALAR_REPAIR_PROTOCOL);
  assert.deepEqual(plan.targets[0].missing, ['mode']);
  assert.match(plan.targets[0].properties.mode.description, /precision category/);
  const patch = JSON.stringify({ repairs: { r0: { mode: 'exact' } } });
  const merged = JSON.parse(applyPlanningAccuracyFieldRepair(plan, patch));
  assert.equal(merged.requirements[0].accuracy.tolerance, 'Preserve this valid inherited text.');
  assert.throws(() => applyPlanningAccuracyFieldRepair(plan, JSON.stringify({ repairs: { r0: {
    mode: 'exact', tolerance: ''
  } } })), { code: 'PLANNING_FIELD_REPAIR_INVALID' });
});

test('unknown-policy guidance is supplied only when that field is requested', () => {
  const { attempt, plan } = fixture({ missing: ['unknownPolicy'] });
  assert.match(plan.targets[0].properties.unknownPolicy.description, /block means unresolved uncertainty prevents satisfaction/);
  const prompt = planningAccuracyFieldRepairPrompt(attempt, plan);
  assert.match(prompt, /requested unknownPolicy is an evidence-based choice/);
  assert.deepEqual(plan.targets[0].properties.unknownPolicy.enum, ['block', 'assumption', 'range', 'omit']);
});

test('field descriptions preserve exact raw-choice audit replay for v1 and v2', () => {
  for (const options of [{}, { missing: [], changes: { decisionThreshold: null } }]) {
    const { plan } = fixture(options);
    const patch = JSON.stringify({ repairs: { r0: Object.fromEntries(plan.targets[0].missing.map(field =>
      [field, field === 'tolerance' ? 'Only explicitly permitted equivalents.' : ''])) } });
    const output = applyPlanningAccuracyFieldRepair(plan, patch);
    const receipt = planningFieldRepairEvidence(plan, patch, output);
    assert.equal(replayPlanningFieldRepairEvidence(receipt, plan.baseOutput), output);
    assert.equal(receipt.rawPatch, patch);
  }
});

test('guidance is not a semantic default or a blacklist for user-defined text', () => {
  const chosen = { ...complete, tolerance: 'bounded_estimate' };
  assert.equal(validateTaskAccuracy(chosen).tolerance, 'bounded_estimate');
  const { plan } = fixture();
  const patch = JSON.stringify({ repairs: { r0: { tolerance: 'bounded_estimate', decisionThreshold: '' } } });
  assert.equal(JSON.parse(applyPlanningAccuracyFieldRepair(plan, patch)).requirements[0].accuracy.tolerance, 'bounded_estimate');
  assert.throws(() => applyPlanningAccuracyFieldRepair(plan, '{"repairs":{"r0":{"tolerance":"","decisionThreshold":""}}'),
    { code: 'PLANNING_FIELD_REPAIR_INVALID' }, 'Malformed JSON remains rejected, never completed by guidance.');
});
