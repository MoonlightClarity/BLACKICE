import test from 'node:test';
import assert from 'node:assert/strict';
import { planningSchemaIssues } from '../lib/planning-schema-diagnostics.mjs';
import { planningFormatDiagnostic, planningModuleOutputSchema, planningStructureGuide, validatePlanningModuleResponse } from '../lib/planning-browser-runtime.mjs';
import { responseCycleTemplate, responseCycleStage } from '../public/response-cycle-model.mjs';
import { taskAccuracySchema, validateTaskAccuracy, TASK_ACCURACY_REQUIRED_TEXT_FIELDS } from '../public/task-viability-model.mjs';
import { compatibleWireOutputSchema } from '../lib/provider-output-schema.mjs';

const accuracy = () => ({ mode: 'qualitative', tolerance: '', decisionThreshold: '', evidenceNeeded: 'The two supplied fictional room capacities.', consequence: 'The answer could select an unsuitable room.', unknownPolicy: 'block', stopWhen: 'Both supplied capacities have been compared.' });
const planAttempt = () => ({ node: { kind: 'plan' }, pipelineVersion: 2, template: responseCycleTemplate('plan'), sources: [{ id: 'cycle:execution-contract:fixture', kind: 'source', text: '{"taskSchemaVersion":14,"contractVersion":2}' }], challenges: [] });
const planBody = () => ({
  values: Object.fromEntries(responseCycleTemplate('plan').fields.map(field => [field.id, 'Use the supplied fictional capacities to compare the two rooms.'])), grounding: [], openQuestions: [], challengeResponses: [],
  checks: responseCycleStage('plan').checks.map(check => ({ id: check.id, assessment: 'supported', sourceIds: [], note: 'The supplied fictional capacities support this bounded comparison.' })),
  subproblems: [], childResults: [],
  contract: { contractVersion: 2, goal: 'Compare the two supplied fictional rooms.',
    criteria: [{ id: 'comparison', kind: 'judgment', label: 'Supported room comparison', description: 'Identify the room that meets the capacity requirement.', accuracy: accuracy(), resourceKey: 'context:fictional-rooms', targetCount: 1, receiptBinding: null, receiptBindings: null }],
    workItems: [{ id: 'compare', title: 'Compare capacities', objective: 'Use the supplied fictional capacities.', owner: 'agent', resourceKeys: ['context:fictional-rooms'], effects: ['observe'], dependsOn: [], criterionIds: ['comparison'], operationScopes: null }], instructions: [] }
});

test('attempt-generation accuracy schema advertises the same nonempty and bounded text obligations as the host', () => {
  const schema = taskAccuracySchema({ generation: true }), fields = schema.anyOf[0].properties;
  for (const key of TASK_ACCURACY_REQUIRED_TEXT_FIELDS) {
    assert.equal(fields[key].minLength, 1); assert.equal(fields[key].maxLength, 2000);
    assert.match(fields[key].description, /nonempty/);
    for (const invalid of ['', ' \n\t', 'x\0y', 'x'.repeat(2001)]) {
      const value = { ...accuracy(), [key]: invalid }, before = structuredClone(value);
      assert.throws(() => validateTaskAccuracy(value), /bounded text/);
      const issues = planningSchemaIssues(value, schema);
      assert.ok(issues.some(issue => issue.path === 'response.' + key), key + ' must have an exact repair path');
      assert.deepEqual(value, before);
    }
  }
  assert.deepEqual(planningSchemaIssues(accuracy(), schema), []);
  assert.deepEqual(planningSchemaIssues(null, schema), []);
  const guide = planningStructureGuide(planAttempt());
  assert.deepEqual(guide.accuracy.requiredTextFields, TASK_ACCURACY_REQUIRED_TEXT_FIELDS);
  assert.equal(guide.accuracy.textMaxLength, 2000);
});

test('missing accuracy fields tell the first repair which ones cannot be empty', () => {
  const issues = planningSchemaIssues({ mode: 'qualitative' }, taskAccuracySchema({ generation: true }));
  assert.equal(issues[0].path, 'response');
  assert.match(issues[0].message, /These fields require nonempty text: evidenceNeeded, consequence, stopWhen/);
  assert.ok(!issues.some(issue => /Expected null/.test(issue.message)));
});

test('mode-dependent tolerance and optional text bounds retain strict validation', () => {
  const value = { ...accuracy(), mode: 'bounded_estimate', tolerance: ' \t' };
  assert.throws(() => validateTaskAccuracy(value));
  assert.deepEqual(planningSchemaIssues(value, taskAccuracySchema({ generation: true })), [{ path: 'response.tolerance', message: 'A bounded_estimate requires nonempty tolerance text describing the permitted deviation.' }]);
  value.tolerance = 'Within one seat.'; assert.deepEqual(planningSchemaIssues(value, taskAccuracySchema({ generation: true })), []);
  for (const key of ['tolerance', 'decisionThreshold']) assert.ok(planningSchemaIssues({ ...accuracy(), [key]: 'x'.repeat(2001) }, taskAccuracySchema({ generation: true })).some(issue => issue.path.endsWith('.' + key)));
});

test('nullable integers are numbers in JavaScript and valid counts must not receive false repair hints', () => {
  const schema = { anyOf: [{ type: 'integer', minimum: 1, maximum: 1000 }, { type: 'null' }] };
  for (const value of [null, 1, 1000]) assert.deepEqual(planningSchemaIssues(value, schema), []);
  assert.match(planningSchemaIssues(0, schema)[0].message, /at least 1/);
  assert.match(planningSchemaIssues(1001, schema)[0].message, /at most 1000/);
  for (const value of [1.5, '1', {}]) assert.equal(planningSchemaIssues(value, schema).length, 1);
});

test('same-shape unions inspect their actual discriminator and retain parent constraints', () => {
  const schema = { type: 'object', required: ['format'], properties: { format: { type: 'string' } }, anyOf: [
    { type: 'object', properties: { format: { const: 'dom' }, record: { type: 'string', minLength: 1 } }, required: ['format', 'record'] },
    { type: 'object', properties: { format: { const: 'dom-text' }, history: { const: false } }, required: ['format', 'history'] }
  ] };
  assert.deepEqual(planningSchemaIssues({ format: 'dom-text', history: false }, schema), []);
  assert.deepEqual(planningSchemaIssues({ format: 'dom-text', history: true }, schema), [{ path: 'response.history', message: 'Use the declared constant false.' }]);
});

test('diagnostics cover numeric, text, array and identifier constraints without mutating data or schema', () => {
  const schema = { type: 'object', properties: {
    id: { type: 'string', pattern: '^[a-z]+$' }, count: { type: 'integer', minimum: 1, maximum: 2 },
    rows: { type: 'array', maxItems: 1, uniqueItems: true, items: { type: 'string', maxLength: 3 } }
  } };
  const value = { id: 'bad id', count: 3, rows: ['long', 'long'] }, before = structuredClone({ value, schema });
  const issues = planningSchemaIssues(value, schema);
  for (const field of ['id', 'count', 'rows', 'rows[0]']) assert.ok(issues.some(issue => issue.path === 'response.' + field));
  assert.deepEqual({ value, schema }, before);
  assert.equal(planningSchemaIssues(value, schema, { maxIssues: 2 }).length, 2);
});

test('the observed blank-evidence repair failure identifies both nested fields and never flags its valid targetCount', () => {
  const attempt = planAttempt(), body = planBody();
  body.contract.criteria[0].accuracy.evidenceNeeded = '';
  body.subproblems = [{ key: 'compare-detail', title: 'Compare the supplied capacities', objective: 'Compare the two fictional room capacities.', reason: 'The comparison supports the requested room choice.', required: true, executionTarget: 'analysis', sourceIds: [], acceptanceCriteria: [{ id: 'detail', label: 'Capacity comparison', description: 'Compare both supplied capacities.', verification: 'response', accuracy: { ...accuracy(), evidenceNeeded: '' } }] }];
  // The observed provider also omitted nullable receipt fields. The diagnostics
  // must explain those omissions without hiding either invalid evidence string.
  delete body.contract.criteria[0].receiptBinding; delete body.contract.criteria[0].receiptBindings;
  const output = JSON.stringify(body);
  let diagnostic;
  assert.throws(() => validatePlanningModuleResponse(attempt, output), error => { diagnostic = planningFormatDiagnostic(attempt, output, error); return true; });
  for (const path of ['response.subproblems[0].acceptanceCriteria[0].accuracy.evidenceNeeded', 'response.contract.criteria[0].accuracy.evidenceNeeded']) assert.ok(diagnostic.issues.some(issue => issue.path === path && /nonempty/.test(issue.message)));
  assert.ok(diagnostic.issues.some(issue => issue.path === 'response.contract.criteria[0]' && /receiptBinding/.test(issue.message)));
  assert.ok(!diagnostic.issues.some(issue => issue.path.includes('targetCount')));
  assert.deepEqual(body, JSON.parse(output));
  const valid = planBody(); assert.doesNotThrow(() => validatePlanningModuleResponse(attempt, JSON.stringify(valid)));
  assert.deepEqual(planningSchemaIssues(valid, planningModuleOutputSchema(attempt)), []);
  assert.ok(compatibleWireOutputSchema(planningModuleOutputSchema(attempt)), 'New bounds remain eligible for supported structured-output transports.');
});

test('public historical accuracy contracts stay unchanged while only attempt schemas get generation bounds', () => {
  const original = taskAccuracySchema(), before = JSON.stringify(original);
  const publicFields = original.anyOf[0].properties;
  for (const key of ['tolerance', 'decisionThreshold', 'evidenceNeeded', 'consequence', 'stopWhen']) assert.deepEqual(publicFields[key], { type: 'string' });
  const schema = planningModuleOutputSchema(planAttempt());
  const generated = schema.properties.contract.properties.criteria.items.properties.accuracy.anyOf[0].properties;
  assert.equal(generated.evidenceNeeded.minLength, 1);
  assert.equal(generated.evidenceNeeded.maxLength, 2000);
  assert.match(generated.evidenceNeeded.description, /nonempty/);
  assert.equal(JSON.stringify(taskAccuracySchema()), before);
  assert.equal(JSON.stringify(original), before);
});
