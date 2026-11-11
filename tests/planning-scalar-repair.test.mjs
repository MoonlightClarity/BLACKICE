import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixtureUserAgency } from './fixture-user-agency.mjs';
import { PlanningBrowserStore } from '../lib/planning-browser.mjs';
import {
  PlanningBrowserRuntime, planningModuleOutputSchema, planningModulePrompt,
  planningFormatDiagnostic, validatePlanningModuleResponse, PLANNING_MAX_FORMAT_REPAIRS
} from '../lib/planning-browser-runtime.mjs';
import {
  createPlanningAccuracyFieldRepair, applyPlanningAccuracyFieldRepair, planningAccuracyFieldRepairPrompt,
  planningFieldRepairEvidence, validatePlanningFieldRepairEvidence, replayPlanningFieldRepairEvidence,
  PLANNING_FIELD_REPAIR_PROTOCOL, PLANNING_SCALAR_REPAIR_PROTOCOL, PLANNING_FIELD_REPAIR_MAX_CHARS
} from '../lib/planning-field-repair.mjs';
import { responseCycleStage, responseCycleTemplate } from '../public/response-cycle-model.mjs';
import { USER_AGENCY_CONTRACT_VERSION } from '../public/planning-user-agency.mjs';

const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const inputOf = options => JSON.parse(options.prompt.slice(options.prompt.lastIndexOf('\n\n') + 2));
const invalidPatch = { code: 'PLANNING_FIELD_REPAIR_INVALID' };
const accuracy = {
  mode: 'exact', tolerance: '', decisionThreshold: 'At least five supplied seats.',
  evidenceNeeded: 'Use the two fictional capacities supplied in the task.',
  consequence: 'A mistaken capacity could choose a room that does not seat five.',
  unknownPolicy: 'block', stopWhen: 'Both supplied capacities have been compared.'
};
const attempt = {
  requestId: 'scalar-fixture', nodeId: 'scalar-inference', nodeRevision: 1, pipelineVersion: 2,
  userAgencyVersion: USER_AGENCY_CONTRACT_VERSION,
  node: { kind: 'inference', title: 'Interpret the supplied room capacities', prompt: 'Compare North and South.' },
  template: responseCycleTemplate('inference', { pipelineVersion: 2 }),
  sources: [{ id: 'fixture-facts', kind: 'user_request', text: 'North has four seats; South has six seats. Choose a room for five.' }],
  challenges: [], inputs: [], workflowNodeIds: []
};
function bodyFor(input = attempt) {
  const template = input.template, sources = input.sources, sourceId = sources[0].id;
  return {
    userAgency: fixtureUserAgency(),
    values: Object.fromEntries(template.fields.map(field => [field.id,
      'The supplied fictional capacities support South for five people; the difference is exactly two seats.'])),
    grounding: template.fields.filter(field => field.grounding === 'required').map(field => ({ field: field.id, sourceId })),
    openQuestions: [], challengeResponses: [],
    checks: responseCycleStage('inference', { pipelineVersion: 2 }).checks.map(check => ({
      id: check.id, assessment: 'supported', sourceIds: [sourceId],
      note: 'The supplied fictional capacities support this bounded finding.'
    })),
    inferences: [
      { id: 'room-choice', claim: 'South seats six, enough for five.', basis: 'inferred', sourceIds: [sourceId],
        limitation: 'Scoped to supplied facts, not a live observation.' },
      { id: 'given-capacity', claim: 'North has four seats.', basis: 'observed', sourceIds: [sourceId],
        limitation: 'This is the user-supplied fictional premise.' }
    ],
    subproblems: [{
      key: 'difference', title: 'Compute the seat difference', objective: 'What is six minus four?',
      reason: 'Check the exact arithmetic separately.', required: true, sourceIds: [sourceId], executionTarget: 'analysis',
      acceptanceCriteria: [{
        id: 'difference-correct', label: 'Exact difference', description: 'Compute the two-seat difference from supplied facts.',
        verification: 'response', accuracy: clone(accuracy)
      }]
    }], childResults: []
  };
}
const firstAccuracy = body => body.subproblems[0].acceptanceCriteria[0].accuracy;
function mixedBody(input = attempt) {
  const body = bodyFor(input);
  delete firstAccuracy(body).unknownPolicy; delete firstAccuracy(body).consequence;
  body.inferences[0].basis = 'assumption';
  return body;
}
function repairFor(body, captured = attempt) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  let diagnostic;
  try { validatePlanningModuleResponse(captured, raw); }
  catch (error) { diagnostic = planningFormatDiagnostic(captured, raw, error); }
  const repair = { ...clone(captured), formatRepair: {
    previousAttemptId: 'failed-scalar-fixture', previousOutput: raw,
    diagnostic: diagnostic || { code: 'PLANNING_RESPONSE_FORMAT', message: 'Synthetic invalid scalar.', issues: [] }
  }};
  return { repair, plan: createPlanningAccuracyFieldRepair(repair, planningModuleOutputSchema(repair)) };
}
function patchFor(plan, changes = {}) {
  const values = { ...accuracy, basis: 'inferred', ...changes };
  return JSON.stringify({ repairs: Object.fromEntries(plan.targets.map(target => [
    target.id, Object.fromEntries(target.missing.map(field => [field, values[field]]))
  ])) });
}
const targetFor = (plan, path) => plan.targets.find(target => target.path === path);
const basisPath = 'response.inferences[0]';
const accuracyPath = 'response.subproblems[0].acceptanceCriteria[0].accuracy';

test('mixed missing accuracy and invalid inference basis use fixed v2 scalar targets', () => {
  assert.equal(PLANNING_SCALAR_REPAIR_PROTOCOL, 'accuracy-and-inference-scalars-v2');
  const partial = mixedBody(), original = clone(partial), { repair, plan } = repairFor(partial);
  assert.ok(plan); assert.equal(plan.protocol, PLANNING_SCALAR_REPAIR_PROTOCOL);
  assert.equal(plan.targets.length, 2);
  const basisTarget = targetFor(plan, basisPath), accuracyTarget = targetFor(plan, accuracyPath);
  assert.ok(basisTarget); assert.ok(accuracyTarget);
  assert.deepEqual(basisTarget.parts, ['inferences', 0]);
  assert.deepEqual(basisTarget.missing, ['basis']);
  assert.deepEqual(basisTarget.properties.basis, { type: 'string', enum: ['observed', 'inferred', 'unknown'] });
  assert.deepEqual(new Set(accuracyTarget.missing), new Set(['consequence', 'unknownPolicy']));
  assert.deepEqual(plan.schema.required, ['repairs']);
  assert.equal(plan.schema.additionalProperties, false);
  assert.deepEqual(plan.schema.properties.repairs.required, plan.targets.map(target => target.id));
  for (const target of plan.targets) {
    const rule = plan.schema.properties.repairs.properties[target.id];
    assert.equal(rule.additionalProperties, false);
    assert.deepEqual(new Set(rule.required), new Set(target.missing));
    assert.deepEqual(new Set(Object.keys(rule.properties)), new Set(target.missing));
  }
  const merged = applyPlanningAccuracyFieldRepair(plan, patchFor(plan));
  assert.deepEqual(JSON.parse(merged), bodyFor());
  assert.deepEqual(partial, original); assert.deepEqual(plan.base, original);
  assert.equal(plan.baseOutput, repair.formatRepair.previousOutput);
  assert.doesNotThrow(() => validatePlanningModuleResponse(attempt, merged));
  assert.deepEqual(planningModuleOutputSchema(repair), planningModuleOutputSchema(attempt));
  const raw = patchFor(plan), evidence = planningFieldRepairEvidence(plan, raw, merged);
  assert.equal(evidence.protocol, PLANNING_SCALAR_REPAIR_PROTOCOL);
  assert.equal(replayPlanningFieldRepairEvidence(evidence, plan.baseOutput), merged);
});

test('valid scalar values and surrounding facts remain exact, including valid inference basis', () => {
  const partial = mixedBody();
  partial.inferences[0].claim = 'Keep  two spaces, café, and "quoted" supplied facts.';
  partial.inferences[1].basis = 'unknown';
  partial.inferences[1].limitation = 'The original limitation is unchanged.';
  firstAccuracy(partial).evidenceNeeded = 'Keep  this exact Unicode evidence: café.';
  const before = clone(partial), { plan } = repairFor(partial); assert.ok(plan);
  const merged = JSON.parse(applyPlanningAccuracyFieldRepair(plan, patchFor(plan)));
  const expected = clone(before);
  expected.inferences[0].basis = 'inferred';
  firstAccuracy(expected).unknownPolicy = accuracy.unknownPolicy;
  firstAccuracy(expected).consequence = accuracy.consequence;
  assert.deepEqual(merged, expected); assert.deepEqual(plan.base, before);
  assert.equal(plan.targets.some(target => target.path === 'response.inferences[1]'), false);
  const basis = targetFor(plan, basisPath), patch = JSON.parse(patchFor(plan));
  patch.repairs[basis.id].claim = 'Changed factual assertion';
  assert.throws(() => applyPlanningAccuracyFieldRepair(plan, JSON.stringify(patch)), invalidPatch);
  const acc = targetFor(plan, accuracyPath), overwrite = JSON.parse(patchFor(plan));
  overwrite.repairs[acc.id].evidenceNeeded = 'Weakened evidence';
  assert.throws(() => applyPlanningAccuracyFieldRepair(plan, JSON.stringify(overwrite)), invalidPatch);
});

test('the model chooses every inference basis explicitly and missing basis is never defaulted', async t => {
  for (const badBasis of ['source', 'assumption', '', '  ', null, 13, false, undefined])
    await t.test(String(badBasis), () => {
      const body = bodyFor();
      if (badBasis === undefined) delete body.inferences[0].basis;
      else body.inferences[0].basis = badBasis;
      const { plan } = repairFor(body);
      assert.ok(plan); assert.equal(plan.protocol, PLANNING_SCALAR_REPAIR_PROTOCOL);
      assert.equal(plan.targets.length, 1);
      assert.deepEqual(plan.targets[0].missing, ['basis']);
      for (const basis of ['observed', 'inferred', 'unknown']) {
        const output = applyPlanningAccuracyFieldRepair(plan, patchFor(plan, { basis }));
        assert.equal(JSON.parse(output).inferences[0].basis, basis);
        assert.doesNotThrow(() => validatePlanningModuleResponse(attempt, output));
      }
      assert.throws(() => applyPlanningAccuracyFieldRepair(plan,
        JSON.stringify({ repairs: { [plan.targets[0].id]: {} } })), invalidPatch);
    });
});

test('invalid primitive accuracy leaves use v2 while pure missing accuracy retains v1', async t => {
  const missing = bodyFor(); delete firstAccuracy(missing).unknownPolicy;
  assert.equal(repairFor(missing).plan.protocol, PLANNING_FIELD_REPAIR_PROTOCOL);
  for (const [field, value] of [
    ['mode', 'approximate'], ['mode', null], ['unknownPolicy', 'ignore'], ['unknownPolicy', 3],
    ['evidenceNeeded', ''], ['evidenceNeeded', '  \n'], ['consequence', false], ['stopWhen', 12],
    ['tolerance', null], ['decisionThreshold', true], ['stopWhen', 'x'.repeat(2001)]
  ]) await t.test(field + ':' + String(value).slice(0, 20), () => {
    const partial = bodyFor(); firstAccuracy(partial)[field] = value;
    const { plan } = repairFor(partial); assert.ok(plan);
    assert.equal(plan.protocol, PLANNING_SCALAR_REPAIR_PROTOCOL);
    assert.deepEqual(plan.targets[0].missing, [field]);
    const merged = applyPlanningAccuracyFieldRepair(plan, patchFor(plan));
    assert.deepEqual(JSON.parse(merged), bodyFor());
    assert.equal(replayPlanningFieldRepairEvidence(planningFieldRepairEvidence(plan, patchFor(plan), merged), plan.baseOutput), merged);
  });
});

test('the original bounded-estimate tolerance mask cannot expand when the patch changes mode', () => {
  const bounded = bodyFor(); firstAccuracy(bounded).mode = 'bounded_estimate'; firstAccuracy(bounded).tolerance = '   ';
  const { plan } = repairFor(bounded); assert.ok(plan);
  assert.equal(plan.protocol, PLANNING_SCALAR_REPAIR_PROTOCOL);
  assert.deepEqual(plan.targets[0].missing, ['tolerance']);
  const good = applyPlanningAccuracyFieldRepair(plan, patchFor(plan, { tolerance: 'Within one supplied seat.' }));
  assert.doesNotThrow(() => validatePlanningModuleResponse(attempt, good));
  assert.throws(() => {
    const bad = applyPlanningAccuracyFieldRepair(plan, patchFor(plan, { tolerance: '' }));
    validatePlanningModuleResponse(attempt, bad);
  });
  const modeOnly = bodyFor(); firstAccuracy(modeOnly).mode = 'approximate';
  const original = clone(modeOnly), modeRepair = repairFor(modeOnly).plan;
  assert.ok(modeRepair); assert.deepEqual(modeRepair.targets[0].missing, ['mode']);
  const escalated = JSON.parse(patchFor(modeRepair, { mode: 'bounded_estimate' }));
  escalated.repairs[modeRepair.targets[0].id].tolerance = 'A new tolerance';
  assert.throws(() => applyPlanningAccuracyFieldRepair(modeRepair, JSON.stringify(escalated)), invalidPatch);
  const merged = applyPlanningAccuracyFieldRepair(modeRepair, patchFor(modeRepair, { mode: 'bounded_estimate' }));
  assert.equal(firstAccuracy(JSON.parse(merged)).tolerance, '');
  assert.throws(() => validatePlanningModuleResponse(attempt, merged));
  assert.deepEqual(modeRepair.base, original);
});

test('objects, arrays, whole-object gaps and unrelated schema errors retain full-response fallback', async t => {
  const variants = {
    'basis object': body => { body.inferences[0].basis = {}; },
    'basis array': body => { body.inferences[0].basis = []; },
    'accuracy primitive object': body => { firstAccuracy(body).consequence = { text: 'Incorrect choice.' }; },
    'accuracy primitive array': body => { firstAccuracy(body).mode = ['exact']; },
    'whole accuracy absent': body => { delete body.subproblems[0].acceptanceCriteria[0].accuracy; },
    'whole accuracy wrong type': body => { body.subproblems[0].acceptanceCriteria[0].accuracy = 'exact'; },
    'extra inference field': body => { body.inferences[0].confidence = 0.9; },
    'invalid inference ID': body => { body.inferences[0].id = null; },
    'missing inference claim': body => { delete body.inferences[0].claim; },
    'missing source array': body => { delete body.inferences[0].sourceIds; },
    'invalid source reference': body => { body.inferences[0].sourceIds = ['uncaptured']; },
    'invalid verification enum': body => { body.subproblems[0].acceptanceCriteria[0].verification = 'guess'; },
    'unexpected accuracy field': body => { firstAccuracy(body).confidence = 'certain'; }
  };
  for (const [label, change] of Object.entries(variants)) await t.test(label, () => {
    const partial = mixedBody(); change(partial);
    const { repair, plan } = repairFor(partial);
    assert.equal(plan, null);
    assert.match(planningModulePrompt(repair), /^REPAIR THE REJECTED RESPONSE/);
  });
});

test('v2 patch scope rejects extra fields, paths, IDs, valid-value overwrites and ambiguous raw JSON', async t => {
  const { plan } = repairFor(mixedBody()), valid = JSON.parse(patchFor(plan));
  const basis = targetFor(plan, basisPath), acc = targetFor(plan, accuracyPath);
  const mutated = change => { const patch = clone(valid); change(patch); return JSON.stringify(patch); };
  const attacks = {
    'claim edit': mutated(patch => { patch.repairs[basis.id].claim = 'Invented'; }),
    'source IDs edit': mutated(patch => { patch.repairs[basis.id].sourceIds = []; }),
    'valid accuracy edit': mutated(patch => { patch.repairs[acc.id].mode = 'qualitative'; }),
    'path at target': mutated(patch => { patch.repairs[basis.id].path = 'response.inferences[1]'; }),
    'path at root': mutated(patch => { patch.path = 'response.userAgency'; }),
    'extra target': mutated(patch => { patch.repairs.r99 = { basis: 'observed' }; }),
    'missing target': mutated(patch => { delete patch.repairs[basis.id]; }),
    'missing required scalar': mutated(patch => { delete patch.repairs[acc.id].unknownPolicy; }),
    'bad basis enum': mutated(patch => { patch.repairs[basis.id].basis = 'assumption'; }),
    'basis number': mutated(patch => { patch.repairs[basis.id].basis = 1; }),
    'basis null': mutated(patch => { patch.repairs[basis.id].basis = null; }),
    'basis object': mutated(patch => { patch.repairs[basis.id].basis = {}; }),
    'full response': JSON.stringify(bodyFor()),
    'duplicate basis': JSON.stringify(valid).replace('"basis":"inferred"', '"basis":"observed","basis":"inferred"'),
    'unicode duplicate basis': JSON.stringify(valid).replace('"basis":"inferred"', '"b\\u0061sis":"observed","basis":"inferred"'),
    'unsafe constructor': JSON.stringify(valid).replace('"basis":"inferred"', '"basis":"inferred","constructor":{}'),
    'unsafe proto': JSON.stringify(valid).replace('"basis":"inferred"', '"basis":"inferred","__proto__":{}'),
    'oversized raw patch': JSON.stringify(valid).padEnd(PLANNING_FIELD_REPAIR_MAX_CHARS + 1, ' ')
  };
  const before = clone(plan.base);
  for (const [label, raw] of Object.entries(attacks)) await t.test(label, () => {
    assert.throws(() => applyPlanningAccuracyFieldRepair(plan, raw), invalidPatch);
    assert.deepEqual(plan.base, before);
  });
});

test('v2 prompts expose exact inference context and captured evidence without authorizing semantic rewrites', () => {
  const captured = { ...attempt, inputs: [{ id: 'captured-input' }], stageReview: { note: 'Preserve the supplied facts.' },
    cycleContext: { objective: 'Choose a room.', workflowRequests: [] } };
  const { repair, plan } = repairFor(mixedBody(), captured);
  const prompt = planningAccuracyFieldRepairPrompt(repair, plan), data = inputOf({ prompt });
  assert.equal(planningModulePrompt(repair), prompt); assert.equal(data.protocol, PLANNING_SCALAR_REPAIR_PROTOCOL);
  for (const key of ['sources', 'inputs', 'challenges']) assert.deepEqual(data[key], captured[key]);
  assert.deepEqual(data.cycle, captured.cycleContext); assert.deepEqual(data.stageReview, captured.stageReview);
  assert.ok(prompt.includes(mixedBody().inferences[0].claim));
  assert.ok(prompt.includes(mixedBody().inferences[0].limitation));
  assert.ok(prompt.includes('assumption'));
  assert.ok(prompt.includes(JSON.stringify(plan.schema)));
  assert.ok(!prompt.includes(JSON.stringify(planningModuleOutputSchema(repair))));
  assert.equal(data.formatRepair.previousOutput, undefined);
  assert.match(prompt, /valid|existing/i);
});

test('v2 eligibility rejects semantic scalar schema drift and ignores harmless ordering or description edits', () => {
  const { repair } = repairFor(mixedBody());
  for (const change of [
    schema => { schema.properties.inferences.items.properties.basis.enum.push('source'); },
    schema => { schema.properties.inferences.items.properties.basis.maxLength = 8; },
    schema => { schema.properties.subproblems.items.properties.acceptanceCriteria.items.properties.accuracy.anyOf[0].properties.mode.enum.push('approximate'); }
  ]) {
    const schema = planningModuleOutputSchema(repair); change(schema);
    assert.equal(createPlanningAccuracyFieldRepair(repair, schema), null);
  }
  for (const change of [
    schema => { schema.properties.inferences.items.required.reverse(); },
    schema => { schema.properties.inferences.items.properties.basis.description = 'Choose the basis supported by captured facts.'; },
    schema => { schema.properties.subproblems.items.properties.acceptanceCriteria.items.properties.accuracy.anyOf[0].required.reverse(); }
  ]) {
    const schema = planningModuleOutputSchema(repair); change(schema);
    const plan = createPlanningAccuracyFieldRepair(repair, schema); assert.ok(plan);
    const raw = patchFor(plan), merged = applyPlanningAccuracyFieldRepair(plan, raw);
    assert.equal(replayPlanningFieldRepairEvidence(planningFieldRepairEvidence(plan, raw, merged), plan.baseOutput), merged);
  }
});

test('full validation still rejects unsupported inferred bases and invalid child relationships after merge', () => {
  const missingEvidence = mixedBody(); missingEvidence.inferences[0].sourceIds = [];
  const { plan } = repairFor(missingEvidence); assert.ok(plan);
  const merged = applyPlanningAccuracyFieldRepair(plan, patchFor(plan, { basis: 'inferred' }));
  assert.throws(() => validatePlanningModuleResponse(attempt, merged));
  const unknown = applyPlanningAccuracyFieldRepair(plan, patchFor(plan, { basis: 'unknown' }));
  assert.doesNotThrow(() => validatePlanningModuleResponse(attempt, unknown));
  const child = mixedBody(); child.subproblems[0].objective = 'Choose a room.';
  const contextual = { ...attempt, cycleContext: { objective: 'Choose a room.' } };
  const relationship = repairFor(child, contextual).plan; assert.ok(relationship);
  assert.throws(() => validatePlanningModuleResponse(contextual,
    applyPlanningAccuracyFieldRepair(relationship, patchFor(relationship))), { code: 'PLANNING_RESPONSE_FORMAT' });
});

test('literal frozen v1 receipts replay without reinterpretation under v2', () => {
  const baseOutput = '{"requirements":[{"accuracy":{"mode":"exact","tolerance":"","decisionThreshold":"","evidenceNeeded":"Supplied facts.","consequence":"Incorrect choice.","stopWhen":"Checked."}}]}';
  const rawPatch = '{"repairs":{"r0":{"unknownPolicy":"block"}}}';
  const mergedOutput = '{"requirements":[{"accuracy":{"mode":"exact","tolerance":"","decisionThreshold":"","evidenceNeeded":"Supplied facts.","consequence":"Incorrect choice.","stopWhen":"Checked.","unknownPolicy":"block"}}]}';
  const receipt = {
    protocol: 'accuracy-missing-fields-v1', previousAttemptId: 'frozen-v1-attempt',
    baseOutputHash: hash(baseOutput), rawPatch, patchOutputHash: hash(rawPatch),
    targetPaths: ['response.requirements[0].accuracy'], mergedOutputHash: hash(mergedOutput)
  };
  assert.deepEqual(validatePlanningFieldRepairEvidence(receipt), receipt);
  assert.equal(replayPlanningFieldRepairEvidence(receipt, baseOutput), mergedOutput);
  const malformedBase = baseOutput.replace('"mode":"exact"', '"mode":"approximate"');
  assert.throws(() => replayPlanningFieldRepairEvidence({
    ...receipt, baseOutputHash: hash(malformedBase)
  }, malformedBase), invalidPatch, 'V1 must never acquire the new invalid-present-scalar authority.');
  assert.throws(() => validatePlanningFieldRepairEvidence({
    ...receipt, targetPaths: ['response.inferences[0]']
  }), invalidPatch, 'V1 never repairs inference bases.');
});

test('v2 evidence rejects fabricated paths, family changes and raw/output hash inconsistencies', () => {
  const { plan } = repairFor(mixedBody()), raw = patchFor(plan), output = applyPlanningAccuracyFieldRepair(plan, raw);
  const receipt = planningFieldRepairEvidence(plan, raw, output);
  assert.equal(replayPlanningFieldRepairEvidence(receipt, plan.baseOutput), output);
  for (const path of ['response.inferences[0].basis', 'response.subproblems[0].inferences[0]',
    'response.userAgency', 'response.constructor', 'response.__proto__']) {
    const changed = { ...receipt, targetPaths: [path] };
    assert.throws(() => replayPlanningFieldRepairEvidence(changed, plan.baseOutput), invalidPatch);
  }
  for (const changed of [
    { rawPatch: raw + ' ' }, { baseOutputHash: 'f'.repeat(64) }, { mergedOutputHash: 'f'.repeat(64) },
    { protocol: PLANNING_FIELD_REPAIR_PROTOCOL }
  ]) assert.throws(() => replayPlanningFieldRepairEvidence({ ...receipt, ...changed }, plan.baseOutput), invalidPatch);
  const otherRaw = patchFor(plan, { basis: 'observed' });
  assert.throws(() => replayPlanningFieldRepairEvidence({
    ...receipt, rawPatch: otherRaw, patchOutputHash: hash(otherRaw)
  }, plan.baseOutput), invalidPatch);
});

const profile = { model: 'fixture-free::small-fast', effort: 'default', serviceTier: 'default' };
async function fixture(t, handler) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'planning-scalar-repair-'));
  const store = await new PlanningBrowserStore({ dataDir: dir }).init(), calls = [];
  let f;
  const runtime = { runAgent: async options => {
    const input = inputOf(options); calls.push({ input, options });
    options.onEvent({ type: 'capabilities', profile: 'planning-response', native: false, attachedTools: 0,
      structuredOutput: 'provider-json-schema', structuredOutputTransport: 'response_format', hostValidationRequired: true });
    const output = await handler({ options, input, index: calls.length, f });
    return { output, threadId: 'scalar-thread-' + calls.length, turnId: 'scalar-turn-' + calls.length,
      model: profile.model, provider: 'fixture-free', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
  }};
  const runner = new PlanningBrowserRuntime({ store, runtime, defaultCwd: dir,
    getSettings: () => ({ defaultModel: 'unused-global', defaultEffort: 'high', maxSubagents: 3 }) });
  const request = await store.create({ conversationId: 'scalar-fixture', title: 'Fictional room comparison',
    objective: 'North has four seats and South has six. Choose the room for five people.', cwd: dir });
  const withNode = await store.addNode(request.id, { kind: 'inference', title: 'Interpret supplied capacities', prompt: request.objective });
  const node = withNode.nodes.at(-1), options = { requestId: request.id, nodeId: node.id,
    expectedNodeRevision: node.revision, clientRequestId: 'one-explicit-scalar-check', ...profile };
  f = { dir, store, runtime, runner, calls, request, node, options };
  t.after(async () => { await runner.close(); await store.close(); await rm(dir, { recursive: true, force: true }); });
  return f;
}
function runtimePatch(input, values = {}) {
  return JSON.stringify({ repairs: Object.fromEntries(input.targets.map(target => [
    target.id, Object.fromEntries((target.editableFields || target.missing).map(field => [field, ({ ...accuracy, basis: 'inferred', ...values })[field]]))
  ])) });
}
async function run(f, extra = {}) {
  const admitted = await f.runner.start({ ...f.options, ...extra });
  const finished = await f.runner.wait(f.options.requestId, admitted.attempt.id);
  return { admitted, finished, saved: await f.store.get(f.options.requestId) };
}
async function reopen(f, t) {
  await f.runner.close(); await f.store.close();
  const store = await new PlanningBrowserStore({ dataDir: f.dir }).init();
  const runner = new PlanningBrowserRuntime({ store, runtime: { runAgent() {
    throw Error('Durable completed repair replay must not call a provider.');
  } }, defaultCwd: f.dir });
  t.after(async () => { await runner.close(); await store.close(); });
  return { store, runner };
}

test('mock Inference runtime completes mixed v2 repair in two calls and persists exact merged output', async t => {
  const f = await fixture(t, ({ input, index }) => index === 1 ? JSON.stringify(mixedBody(input)) : runtimePatch(input));
  const budget = { used: 0, max: 2 }, { finished, saved } = await run(f, { providerBudget: budget });
  assert.equal(finished.attempt.status, 'completed', finished.attempt.message);
  assert.equal(f.calls.length, 2); assert.equal(budget.used, 2); assert.equal(PLANNING_MAX_FORMAT_REPAIRS, 1);
  const [original, repair] = saved.attempts;
  assert.equal(original.status, 'failed'); assert.equal(repair.repairOf, original.id); assert.equal(repair.repairIndex, 1);
  assert.equal(original.partialOutput, JSON.stringify(mixedBody(f.calls[0].input)));
  assert.deepEqual(JSON.parse(repair.output), bodyFor(f.calls[0].input));
  assert.equal(f.calls[1].input.protocol, PLANNING_SCALAR_REPAIR_PROTOCOL);
  assert.deepEqual(f.calls[1].input.sources, f.calls[0].input.sources);
  assert.deepEqual(f.calls[1].input.responseContext.userAgency, bodyFor(f.calls[0].input).userAgency);
  assert.deepEqual(Object.keys(f.calls[1].options.outputSchema.properties), ['repairs']);
  assert.ok(f.calls[1].options.prompt.length < f.calls[0].options.prompt.length);
  for (const key of ['node', 'template', 'sources', 'inputs', 'challenges', 'workflowNodeIds'])
    assert.deepEqual(repair[key], original[key]);
  for (const { options } of f.calls) {
    for (const [key, value] of Object.entries(profile)) assert.equal(options[key], value);
    assert.equal(options.responseOnly, true); assert.equal(options.sandbox, 'read-only');
    assert.deepEqual(options.dynamicTools, []); assert.equal(options.threadId, undefined);
  }
  const evidence = repair.metadata.fieldRepair;
  assert.equal(evidence.protocol, PLANNING_SCALAR_REPAIR_PROTOCOL);
  assert.equal(evidence.rawPatch, runtimePatch(f.calls[1].input));
  assert.equal(evidence.baseOutputHash, hash(original.partialOutput));
  assert.equal(evidence.patchOutputHash, hash(evidence.rawPatch));
  assert.equal(evidence.mergedOutputHash, hash(repair.output));
  assert.equal(replayPlanningFieldRepairEvidence(evidence, original.partialOutput), repair.output);
  const restored = await reopen(f, t);
  assert.deepEqual((await restored.store.get(f.options.requestId)).attempts, saved.attempts);
  const replay = await restored.runner.start(f.options), terminal = await restored.runner.wait(f.options.requestId, replay.attempt.id);
  assert.equal(terminal.attempt.id, repair.id); assert.equal(terminal.attempt.status, 'completed');
  assert.equal(f.calls.length, 2);
});

test('pure missing accuracy remains a restart-safe v1 runtime record', async t => {
  const f = await fixture(t, ({ input, index }) => {
    if (index === 2) { assert.equal(input.protocol, PLANNING_FIELD_REPAIR_PROTOCOL); return runtimePatch(input); }
    const body = bodyFor(input); delete firstAccuracy(body).unknownPolicy; return JSON.stringify(body);
  });
  const { saved, finished } = await run(f);
  assert.equal(finished.attempt.status, 'completed');
  assert.equal(saved.attempts[1].metadata.fieldRepair.protocol, 'accuracy-missing-fields-v1');
  const restored = await reopen(f, t);
  assert.deepEqual((await restored.store.get(f.options.requestId)).attempts, saved.attempts);
  assert.equal(f.calls.length, 2);
});

test('invalid v2 patches and merged semantic failures consume the single existing repair', async t => {
  for (const kind of ['bad-basis', 'extra-field', 'full-response', 'empty-evidence-after-merge', 'provider-exception'])
    await t.test(kind, async t => {
      const f = await fixture(t, ({ input, index, f }) => {
        if (index === 1) {
          const body = mixedBody(input);
          if (kind === 'empty-evidence-after-merge') body.inferences[0].sourceIds = [];
          return JSON.stringify(body);
        }
        if (kind === 'provider-exception') throw Object.assign(Error('Synthetic provider failure.'), { code: 'ECONNRESET' });
        if (kind === 'full-response') return JSON.stringify(bodyFor(f.calls[0].input));
        if (kind === 'bad-basis') return runtimePatch(input, { basis: 'source' });
        const patch = JSON.parse(runtimePatch(input));
        if (kind === 'extra-field') patch.repairs[input.targets.find(target => target.path === basisPath).id].claim = 'New claim';
        return JSON.stringify(patch);
      });
      const budget = { used: 0, max: 10 }, { admitted, finished, saved } = await run(f, { providerBudget: budget });
      assert.equal(finished.attempt.status, 'failed'); assert.equal(f.calls.length, 2); assert.equal(budget.used, 2);
      assert.equal(saved.attempts.length, 2); assert.equal(saved.responses.length, 0);
      assert.equal(saved.attempts[1].repairAttemptId, undefined);
      if (kind === 'empty-evidence-after-merge') {
        assert.ok(saved.attempts[1].metadata.fieldRepair.mergedOutputHash);
        assert.notEqual(saved.attempts[1].validation.code, 'PLANNING_FIELD_REPAIR_INVALID');
      }
      if (kind === 'provider-exception') assert.equal(saved.attempts[1].validation, undefined);
      else if (kind !== 'empty-evidence-after-merge') assert.equal(saved.attempts[1].validation.code, 'PLANNING_FIELD_REPAIR_INVALID');
      await f.runner.wait(f.options.requestId, admitted.attempt.id); assert.equal(f.calls.length, 2);
      const restored = await reopen(f, t);
      assert.deepEqual((await restored.store.get(f.options.requestId)).attempts, saved.attempts);
    });
});

test('v2 repair cannot bypass exhausted budgets or cancellation', async t => {
  for (const kind of ['budget', 'origin-cancellation']) await t.test(kind, async t => {
    const controller = new AbortController();
    const f = await fixture(t, ({ input }) => {
      if (kind === 'origin-cancellation') controller.abort();
      return JSON.stringify(mixedBody(input));
    });
    const budget = { used: 0, max: kind === 'budget' ? 1 : 4 };
    const { finished, saved } = await run(f, { providerBudget: budget, signal: controller.signal });
    assert.equal(f.calls.length, 1); assert.equal(budget.used, 1); assert.equal(saved.attempts.length, 1);
    assert.equal(saved.responses.length, 0);
    assert.equal(finished.attempt.status, kind === 'origin-cancellation' ? 'cancelled' : 'failed');
  });
  await t.test('repair cancellation', async t => {
    let ready; const began = new Promise(resolve => { ready = resolve; });
    const f = await fixture(t, async ({ input, index, options }) => {
      if (index === 1) return JSON.stringify(mixedBody(input));
      ready(); await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
      return runtimePatch(input);
    });
    const admitted = await f.runner.start(f.options); await began;
    const saved = await f.store.get(f.options.requestId);
    await f.runner.cancel(saved.attempts[1].id);
    const terminal = await f.runner.wait(f.options.requestId, admitted.attempt.id);
    assert.equal(terminal.attempt.status, 'cancelled'); assert.equal(f.calls.length, 2);
    assert.equal((await f.store.get(f.options.requestId)).responses.length, 0);
  });
});

test('reopening v2 records rejects substituted raw patches even when their own hashes match', async t => {
  const f = await fixture(t, ({ input, index }) => index === 1 ? JSON.stringify(mixedBody(input)) : runtimePatch(input));
  const { saved } = await run(f); assert.equal(saved.attempts[1].status, 'completed');
  await f.runner.close(); await f.store.close();
  const file = f.store.file(f.options.requestId), original = await readFile(file, 'utf8');
  const data = JSON.parse(original), evidence = data.attempts[1].metadata.fieldRepair;
  evidence.rawPatch = runtimePatch(f.calls[1].input, { basis: 'observed' });
  evidence.patchOutputHash = hash(evidence.rawPatch);
  const changed = JSON.stringify(data); await writeFile(file, changed, 'utf8');
  const restored = await new PlanningBrowserStore({ dataDir: f.dir }).init();
  try { await assert.rejects(restored.get(f.options.requestId), { code: 'PLANNING_BROWSER_DAMAGED' }); }
  finally { await restored.close(); }
  assert.equal(await readFile(file, 'utf8'), changed);
  await writeFile(file, original, 'utf8');
});

test('v2 mixed-family target and scalar limits are inclusive and never truncate repairs', () => {
  const basisBody = count => {
    const body = bodyFor();
    body.inferences = Array.from({ length: count }, (_, index) => ({
      ...clone(body.inferences[0]), id: 'claim-' + index, basis: 'source'
    }));
    return body;
  };
  const eight = repairFor(basisBody(8)).plan;
  assert.ok(eight); assert.equal(eight.protocol, PLANNING_SCALAR_REPAIR_PROTOCOL); assert.equal(eight.targets.length, 8);
  assert.equal(repairFor(basisBody(9)).plan, null);
  const mixed = (criteria, inferences, invalidFields) => {
    const body = basisBody(inferences), child = clone(body.subproblems[0]);
    body.subproblems = Array.from({ length: criteria }, (_, index) => {
      const item = clone(child); item.key = 'question-' + index;
      item.acceptanceCriteria[0].id = 'criterion-' + index;
      for (const field of invalidFields) item.acceptanceCriteria[0].accuracy[field] = null;
      return item;
    });
    return body;
  };
  const allFields = Object.keys(accuracy);
  const thirtyTwo = repairFor(mixed(4, 4, allFields)).plan;
  assert.ok(thirtyTwo); assert.equal(thirtyTwo.targets.length, 8);
  assert.equal(thirtyTwo.targets.reduce((count, target) => count + target.missing.length, 0), 32);
  const raw = patchFor(thirtyTwo), output = applyPlanningAccuracyFieldRepair(thirtyTwo, raw);
  assert.equal(replayPlanningFieldRepairEvidence(planningFieldRepairEvidence(thirtyTwo, raw, output), thirtyTwo.baseOutput), output);
  assert.equal(repairFor(mixed(5, 3, allFields.filter(field => field !== 'mode'))).plan, null);
});

test('v2 apply recomputes its editable mask instead of trusting mutated target descriptors', () => {
  const { plan } = repairFor(mixedBody()), forged = clone(plan), basis = targetFor(forged, basisPath);
  basis.missing.push('claim'); basis.properties.claim = { type: 'string' };
  const patch = JSON.parse(patchFor(plan)); patch.repairs[basis.id].claim = 'An edited factual claim.';
  assert.throws(() => applyPlanningAccuracyFieldRepair(forged, JSON.stringify(patch)), invalidPatch);
  const redirected = clone(plan); targetFor(redirected, basisPath).path = 'response.inferences[1]';
  assert.throws(() => applyPlanningAccuracyFieldRepair(redirected, patchFor(plan)), invalidPatch,
    'A valid original basis must never become editable by redirecting a target.');
});

test('v2 rejects noncanonical array indices and duplicate-slot aliases before applying or replaying patches', () => {
  const { plan } = repairFor(mixedBody()), raw = patchFor(plan), output = applyPlanningAccuracyFieldRepair(plan, raw);
  const evidence = planningFieldRepairEvidence(plan, raw, output);
  for (const [index, target] of plan.targets.entries()) for (const alias of ['[00]', '[000]']) {
    const path = target.path.replace('[0]', alias), changed = clone(plan);
    changed.targets[index].path = path;
    assert.throws(() => applyPlanningAccuracyFieldRepair(changed, raw), invalidPatch, path);
    const receipt = clone(evidence); receipt.targetPaths[index] = path;
    assert.throws(() => replayPlanningFieldRepairEvidence(receipt, plan.baseOutput), invalidPatch, path);
  }
  const body = bodyFor(); body.inferences[0].basis = 'source';
  const single = repairFor(body).plan, duplicated = clone(single);
  duplicated.targets.push({ ...clone(single.targets[0]), id: 'r1', path: 'response.inferences[00]' });
  const conflicting = '{"repairs":{"r0":{"basis":"inferred"},"r1":{"basis":"unknown"}}}';
  assert.throws(() => applyPlanningAccuracyFieldRepair(duplicated, conflicting), invalidPatch);
  const receipt = planningFieldRepairEvidence(duplicated, conflicting);
  assert.throws(() => replayPlanningFieldRepairEvidence(receipt, single.baseOutput), invalidPatch);
});
