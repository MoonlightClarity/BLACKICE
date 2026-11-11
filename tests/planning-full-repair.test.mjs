import test from 'node:test';
import assert from 'node:assert/strict';
import { planningFullRepairInventory } from '../lib/planning-full-repair.mjs';
import { planningSkillInstructions } from '../lib/planning-skill.mjs';
import { PLANNING_BROWSER_LIMITS } from '../public/planning-browser-model.mjs';
import { planningModuleOutputSchema, planningModulePrompt, planningFormatDiagnostic,
  validatePlanningModuleResponse, PLANNING_MAX_FORMAT_REPAIRS } from '../lib/planning-browser-runtime.mjs';
import { createPlanningAccuracyFieldRepair } from '../lib/planning-field-repair.mjs';
import { responseCycleStage, responseCycleTemplate } from '../public/response-cycle-model.mjs';
import { fixtureUserAgency } from './fixture-user-agency.mjs';
import { USER_AGENCY_CONTRACT_VERSION } from '../public/planning-user-agency.mjs';
import { viabilityRequirementSchema } from '../public/task-viability-model.mjs';

const attempt = {
  requestId: 'full-repair-fixture', nodeId: 'fixture-inference', nodeRevision: 1, pipelineVersion: 2,
  userAgencyVersion: USER_AGENCY_CONTRACT_VERSION,
  node: { kind: 'inference', title: 'Interpret fictional capacities', prompt: 'Compare the supplied capacities.' },
  template: responseCycleTemplate('inference', { pipelineVersion: 2 }),
  sources: [{ id: 'fixture-source', kind: 'user_request', text: 'North has four seats. South has six seats. Compare them for five people.' }],
  challenges: [], inputs: [], workflowNodeIds: []
};
function rejectedFixture() {
  const body = {
    userAgency: fixtureUserAgency(),
    values: Object.fromEntries(attempt.template.fields.map(field => [field.id, 'The supplied fictional capacities support South for five people.'])),
    grounding: attempt.template.fields.filter(field => field.grounding === 'required').map(field => ({ field: field.id, sourceId: 'fixture-source' })),
    openQuestions: [], challengeResponses: [],
    checks: responseCycleStage('inference', { pipelineVersion: 2 }).checks.map((check, index) => ({
      id: check.id, assessment: 'supported', sourceIds: ['fixture-source'],
      note: index === 1 ? 'Second supplied check finding.' : 'The supplied capacities support this bounded check.'
    })),
    inferences: [0, 1].map(index => ({ id: 'finding-' + index, claim: 'South has room for five.',
      basis: 'assumption', sourceIds: ['fixture-source'], limitation: 'The finding is limited to supplied fictional facts.' })),
    subproblems: [{
      key: 'difference', title: 'Compute the difference', objective: 'What is six minus four?',
      reason: 'Check the exact arithmetic.', required: true, sourceIds: ['fixture-source'], executionTarget: 'analysis',
      acceptanceCriteria: [0, 1, 2, 3].map(index => ({
        id: 'criterion-' + index, label: 'Supplied comparison', description: 'Compare the fictional capacities without claiming external work.',
        verification: 'response', accuracy: {
          mode: 'exact', consequence: 'An incorrect comparison could choose an undersized room.',
          stopWhen: 'The supplied capacities have been compared.',
          ...(index === 2 ? { tolerance: '', decisionThreshold: '', evidenceNeeded: 'The supplied fictional capacities.' } : {})
        }
      }))
    }], childResults: []
  };
  const raw = JSON.stringify(body).replace('"note":"Second supplied check finding."',
    '"note":"Second supplied check finding.","note":"A different synthetic check finding."');
  assert.notEqual(raw, JSON.stringify(body));
  return { body, raw };
}

test('full repair exposes duplicate note, every missing scalar and exact enum choices without choosing values', () => {
  const { raw } = rejectedFixture(), schema = planningModuleOutputSchema(attempt);
  const inventory = planningFullRepairInventory(raw, schema);
  assert.equal(inventory.complete, true);
  assert.equal(inventory.issues.length, 7);
  assert.equal(inventory.issues[0].path, 'response.checks[1].note');
  assert.match(inventory.issues[0].message, /Duplicate JSON member/);
  assert.match(inventory.issues[0].message, /exactly one evidence-supported value/);
  for (const index of [0, 1, 2, 3]) {
    const issue = inventory.issues.find(item => item.path === 'response.subproblems[0].acceptanceCriteria[' + index + '].accuracy');
    assert.ok(issue);
    assert.deepEqual(issue.missingFields.map(item => item.field),
      index === 2 ? ['unknownPolicy'] : ['tolerance', 'decisionThreshold', 'evidenceNeeded', 'unknownPolicy']);
    assert.deepEqual(issue.missingFields.find(item => item.field === 'unknownPolicy').contract.enum, ['block', 'assumption', 'range', 'omit']);
    if (index !== 2) assert.equal(issue.missingFields.find(item => item.field === 'evidenceNeeded').contract.minLength, 1);
  }
  for (const index of [0, 1]) {
    const issue = inventory.issues.find(item => item.path === 'response.inferences[' + index + '].basis');
    assert.deepEqual(issue.contract.enum, ['observed', 'inferred', 'unknown']);
    assert.match(issue.message, /Allowed values: \["observed","inferred","unknown"\]/);
  }
  assert.equal(raw, rejectedFixture().raw);
  assert.throws(() => validatePlanningModuleResponse(attempt, raw), { code: 'TASK_VIABILITY_INVALID' });
});

test('realistic full-repair prompt retains all sources/schema and emphasizes one detailed checklist', () => {
  const { raw } = rejectedFixture(), schema = planningModuleOutputSchema(attempt);
  let diagnostic;
  assert.throws(() => validatePlanningModuleResponse(attempt, raw), error => {
    diagnostic = planningFormatDiagnostic(attempt, raw, error); return true;
  });
  assert.equal(diagnostic.issues[0].path, 'response.checks[1].note');
  assert.ok(diagnostic.issues.some(item => item.path.endsWith('.basis') && item.message.includes('"observed","inferred","unknown"')));
  assert.ok(diagnostic.issues.some(item => item.path.endsWith('.accuracy') && item.message.includes('"block","assumption","range","omit"')));
  const repair = { ...structuredClone(attempt), formatRepair: {
    previousAttemptId: 'failed-fixture', previousOutput: raw, diagnostic
  } };
  assert.equal(createPlanningAccuracyFieldRepair(repair, schema), null, 'Ambiguous base must remain a full response repair.');
  const prompt = planningModulePrompt(repair), payload = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n') + 2));
  assert.deepEqual(payload.sources, attempt.sources);
  assert.equal(payload.formatRepair.previousOutput, raw);
  assert.deepEqual(payload.formatRepair.diagnostic, diagnostic);
  const checklist = JSON.stringify(planningFullRepairInventory(raw, schema));
  assert.ok(prompt.includes(checklist));
  assert.equal(prompt.indexOf(checklist), prompt.lastIndexOf(checklist), 'The detailed checklist appears only once.');
  assert.equal(payload.formatRepair.repairChecklist, undefined);
  assert.ok(prompt.indexOf(JSON.stringify(diagnostic)) < prompt.indexOf('Produce the public analytical response'));
  assert.ok(!prompt.includes(planningSkillInstructions('on')), 'A repair does not repeat generic Planning boilerplate.');
  assert.ok(planningModulePrompt(attempt).includes(planningSkillInstructions('on')), 'Initial generation retains its mandatory skill.');
  assert.ok(prompt.includes(JSON.stringify(schema)));
  assert.ok(prompt.indexOf('"path":"response.checks[1].note"') < prompt.indexOf('Produce the public analytical response'));
  assert.match(prompt, /host will not choose between conflicting values/);
  assert.match(prompt, /Every declared enum is exact, not a synonym/);
  assert.match(prompt, /no BLACKICE action tools/);
  assert.match(payload.repairReminder, /every JSON member exactly once/);
  assert.equal(PLANNING_MAX_FORMAT_REPAIRS, 1);
});

test('duplicate scanning catches nested and escaped keys without confusing string contents', () => {
  const schema = { type: 'object' };
  const raw = '{"a":{"note":"first","n\\u006fte":"second"},"a":{"note":"third"},"s":"braces { } and a comma, are text"}';
  const inventory = planningFullRepairInventory(raw, schema);
  assert.equal(inventory.complete, true);
  assert.deepEqual(inventory.issues.map(item => item.path), ['response.a.note', 'response.a']);
  assert.equal(planningFullRepairInventory('{"a":1,"a":1}', schema).issues.length, 1);
  const before = Object.prototype.polluted;
  const unsafe = planningFullRepairInventory('{"__proto__":{"polluted":true},"__proto__":{"polluted":false}}', schema);
  assert.match(unsafe.issues[0].path, /__proto__/);
  assert.equal(Object.prototype.polluted, before);
});

test('duplicate diagnostics do not collapse numeric or nested conflicts', () => {
  const inventory = planningFullRepairInventory('{"a":9007199254740992,"a":9007199254740993,"b":{"x":1,"x":2},"b":{"x":1,"x":2}}', {});
  assert.equal(inventory.complete, true);
  assert.deepEqual(inventory.issues.map(item => item.path), ['response.a', 'response.b.x', 'response.b', 'response.b.x']);
});

test('bounded inventories explicitly report incomplete coverage', () => {
  const raw = '{"a":1,"a":2,"b":1,"b":2,"c":1,"c":2}';
  const inventory = planningFullRepairInventory(raw, {}, { maxIssues: 2 });
  assert.equal(inventory.complete, false); assert.equal(inventory.issues.length, 2);
  assert.match(inventory.limitation, /complete output schema/);
  const tooSmall = planningFullRepairInventory(raw, {}, { maxChars: 80 });
  assert.equal(tooSmall.complete, false); assert.equal(tooSmall.issues.length, 0);
  const deep = '{"a":'.repeat(70) + '1' + '}'.repeat(70);
  assert.equal(planningFullRepairInventory(deep, {}).complete, false);
});

test('parse failure is diagnostic only and full schema remains required', () => {
  const inventory = planningFullRepairInventory('{"a":', {});
  assert.equal(inventory.complete, false);
  assert.match(inventory.issues[0].message, /not parseable JSON/);
  const fenced = String.fromCharCode(96).repeat(3) + 'json\n{"a":1,"a":2}\n' + String.fromCharCode(96).repeat(3);
  assert.equal(planningFullRepairInventory(fenced, {}).issues[0].path, 'response.a');
});

test('large enums point to the full schema instead of offering a misleading subset', () => {
  const inventory = planningFullRepairInventory('{"id":"bad"}', { type: 'object', properties: {
    id: { type: 'string', enum: Array.from({ length: 50 }, (_, index) => 'allowed-' + index) }
  } });
  assert.equal(inventory.complete, true);
  assert.equal(inventory.issues[0].contract.enum, undefined);
  assert.match(inventory.issues[0].contract.enumReference, /50 values/);
});

test('schema array-tail and text bounds cannot be presented as complete diagnostics', () => {
  const items = Array.from({ length: 201 }, () => ({ basis: 'observed' }));
  items[200].basis = 'invalid';
  const inventory = planningFullRepairInventory(JSON.stringify({ items }), { type: 'object', properties: {
    items: { type: 'array', items: { type: 'object', properties: { basis: { type: 'string', enum: ['observed'] } } } }
  } });
  assert.equal(inventory.complete, false);
  assert.match(inventory.limitation, /complete output schema/);
  const oversized = planningFullRepairInventory('x'.repeat(PLANNING_BROWSER_LIMITS.responseChars + 1), {});
  assert.equal(oversized.complete, false);
  assert.match(oversized.issues[0].message, /exceeds the response text bound/);
  for (const maxChars of [80, 300, 600]) {
    const bounded = planningFullRepairInventory('{"a":1,"a":2,"b":1,"b":2,"c":1,"c":2}', {}, { maxChars });
    assert.ok(JSON.stringify(bounded).length <= maxChars);
    assert.equal(bounded.complete, false);
  }
});
test('relationship-only original diagnostics remain prominent even when schema hints are empty', () => {
  const diagnostic = { code: 'PLANNING_RESPONSE_FORMAT', message: 'Preserve the inherited criterion exactly.',
    issues: [{ path: 'response.contract.criteria[0]', message: 'Do not change the captured verification mode.' }] };
  const repair = { ...attempt, formatRepair: { previousAttemptId: 'prior', previousOutput: '{}', diagnostic } };
  const prompt = planningModulePrompt(repair, { fieldRepair: null });
  assert.ok(prompt.indexOf(JSON.stringify(diagnostic)) < prompt.indexOf('Produce the public analytical response'));
});

test('original relationship issues retain priority within the durable diagnostic cap', () => {
  const raw = '{' + Array.from({ length: 14 }, (_, index) => '"duplicate' + index + '":1,"duplicate' + index + '":2').join(',') + '}';
  const cause = Object.assign(new Error('A required criterion changed.'), { code: 'PLANNING_RESPONSE_FORMAT',
    issues: [{ path: 'response.contract.criteria[0].kind', message: 'Preserve the exact inherited evidence verification and criterion.' }] });
  const diagnostic = planningFormatDiagnostic(attempt, raw, cause);
  assert.equal(diagnostic.issues.length, 12);
  assert.deepEqual(diagnostic.issues[0], cause.issues[0]);
});
test('Inference basis guidance is explicit and distinct from requirement basis categories', () => {
  const initial = planningModulePrompt(attempt);
  assert.match(initial, /basis:"observed", basis:"inferred", or basis:"unknown"/);
  assert.match(initial, /explanation in claim or limitation/);
  assert.match(initial, /nonempty sourceIds naming captured sources/);
  const inferenceSchema = planningModuleOutputSchema(attempt);
  assert.deepEqual(inferenceSchema.properties.inferences.items.properties.basis.enum, ['observed', 'inferred', 'unknown']);
  assert.deepEqual(viabilityRequirementSchema().items.properties.basis.enum, ['user', 'task', 'external']);
  const { raw } = rejectedFixture();
  const repair = { ...attempt, formatRepair: { previousAttemptId: 'prior', previousOutput: raw,
    diagnostic: { code: 'TASK_VIABILITY_INVALID', message: 'Missing accuracy fields.', issues: [] } } };
  assert.match(planningModulePrompt(repair), /basis:"observed", basis:"inferred", or basis:"unknown"/);
});
