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
  createPlanningAccuracyFieldRepair, applyPlanningAccuracyFieldRepair,
  planningAccuracyFieldRepairPrompt, planningFieldRepairEvidence, validatePlanningFieldRepairEvidence, replayPlanningFieldRepairEvidence,
  PLANNING_FIELD_REPAIR_MAX_CHARS, PLANNING_FIELD_REPAIR_PROTOCOL
} from '../lib/planning-field-repair.mjs';
import { responseCycleStage, responseCycleTemplate } from '../public/response-cycle-model.mjs';

const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const inputOf = options => JSON.parse(options.prompt.slice(options.prompt.lastIndexOf('\n\n') + 2));
const accuracy = {
  mode: 'qualitative', tolerance: 'Compare only the supplied fictional alternatives.',
  decisionThreshold: 'Choose the alternative meeting the stated constraint.',
  evidenceNeeded: 'The supplied fictional capacities, without outside observations.',
  consequence: 'An unsupported recommendation would fail the requested comparison.',
  unknownPolicy: 'omit', stopWhen: 'Both supplied alternatives have been compared.'
};
const canonicalAttempt = {
  requestId: 'fixture-request', nodeId: 'fixture-plan', nodeRevision: 1,
  node: { kind: 'plan', title: 'Compare supplied alternatives', prompt: 'Choose the room with five seats.' },
  pipelineVersion: 2, template: responseCycleTemplate('plan'),
  sources: [{ id: 'cycle:execution-contract:test', kind: 'source', text: '{"taskSchemaVersion":14,"contractVersion":2}' }],
  challenges: [], inputs: []
};
function canonicalBody(count = 1) {
  return {
    values: Object.fromEntries(canonicalAttempt.template.fields.map(field => [field.id, 'Compare the supplied fictional capacities only.'])),
    grounding: [], openQuestions: [], challengeResponses: [],
    checks: responseCycleStage('plan').checks.map(check => ({
      id: check.id, assessment: 'supported', sourceIds: [], note: 'The supplied fictional comparison is bounded.'
    })),
    subproblems: [], childResults: [],
    contract: {
      contractVersion: 2, goal: 'Compare supplied fictional alternatives.',
      criteria: Array.from({ length: count }, (_, index) => ({
        id: 'comparison' + index, kind: 'judgment', label: 'Supported comparison ' + index,
        description: 'Compare the supplied alternatives against the requested constraint.',
        accuracy: clone(accuracy), resourceKey: null, targetCount: null, receiptBinding: null, receiptBindings: null
      })),
      workItems: [{
        id: 'compare', title: 'Compare alternatives',
        objective: 'Use the supplied evidence to compare alternatives.', owner: 'agent',
        resourceKeys: ['context:supplied-alternatives'], effects: ['observe'], dependsOn: [], operationScopes: null,
        criterionIds: Array.from({ length: count }, (_, index) => 'comparison' + index)
      }], instructions: []
    }
  };
}
function repairAttempt(body, attempt = canonicalAttempt) {
  const output = typeof body === 'string' ? body : JSON.stringify(body);
  let diagnostic;
  try { validatePlanningModuleResponse(attempt, output); }
  catch (error) { diagnostic = planningFormatDiagnostic(attempt, output, error); }
  return { ...clone(attempt), formatRepair: {
    previousAttemptId: 'failed-fixture', previousOutput: output,
    diagnostic: diagnostic || { code: 'PLANNING_RESPONSE_FORMAT', message: 'Synthetic missing fields.', issues: [] }
  } };
}
function planFor(body, attempt = canonicalAttempt) {
  const repair = repairAttempt(body, attempt);
  return { repair, plan: createPlanningAccuracyFieldRepair(repair, planningModuleOutputSchema(repair)) };
}
function partialBody(missing = ['unknownPolicy'], count = 1) {
  const body = canonicalBody(count);
  for (const criterion of body.contract.criteria) for (const field of missing) delete criterion.accuracy[field];
  return body;
}
function patchFor(plan, values = accuracy) {
  return JSON.stringify({ repairs: Object.fromEntries(plan.targets.map(target => [
    target.id, Object.fromEntries(target.missing.map(field => [field, values[field]]))
  ])) });
}
const invalidPatch = { code: 'PLANNING_FIELD_REPAIR_INVALID' };

test('missing scalar accuracy fields produce only fixed-ID patches and preserve every existing value', async t => {
  for (const [label, missing, count] of [
    ['unknown policy only', ['unknownPolicy'], 1],
    ['mode and consequence only', ['mode', 'consequence'], 1],
    ['mode-only object across criteria', Object.keys(accuracy).filter(field => field !== 'mode'), 3],
    ['multiple incomplete criteria', ['unknownPolicy', 'consequence'], 3]
  ]) await t.test(label, () => {
    const complete = canonicalBody(count), partial = partialBody(missing, count), untouched = clone(partial);
    const { repair, plan } = planFor(partial);
    assert.ok(plan); assert.equal(plan.protocol, PLANNING_FIELD_REPAIR_PROTOCOL);
    assert.equal(plan.targets.length, count);
    assert.deepEqual(plan.schema.required, ['repairs']);
    assert.deepEqual(plan.schema.properties.repairs.required, plan.targets.map(target => target.id));
    assert.equal(plan.schema.additionalProperties, false);
    assert.equal(plan.schema.properties.repairs.additionalProperties, false);
    for (const [index, target] of plan.targets.entries()) {
      assert.equal(target.id, 'r' + index);
      assert.equal(target.path, 'response.contract.criteria[' + index + '].accuracy');
      const schema = plan.schema.properties.repairs.properties[target.id];
      assert.deepEqual(new Set(schema.required), new Set(missing));
      assert.deepEqual(new Set(Object.keys(schema.properties)), new Set(missing));
      assert.equal(schema.additionalProperties, false);
      for (const field of Object.keys(partial.contract.criteria[index].accuracy))
        assert.equal(schema.properties[field], undefined);
    }
    const merged = applyPlanningAccuracyFieldRepair(plan, patchFor(plan));
    assert.deepEqual(JSON.parse(merged), complete);
    assert.deepEqual(partial, untouched);
    assert.deepEqual(plan.base, untouched);
    assert.equal(plan.baseOutput, repair.formatRepair.previousOutput);
    assert.deepEqual(validatePlanningModuleResponse(canonicalAttempt, merged).contract,
      validatePlanningModuleResponse(canonicalAttempt, JSON.stringify(complete)).contract);
    assert.deepEqual(planningModuleOutputSchema(repair), planningModuleOutputSchema(canonicalAttempt),
      'The full response contract must not become a patch contract.');
  });
});

test('a provider must choose each strict unknownPolicy; no missing policy is silently defaulted', () => {
  const { plan } = planFor(partialBody());
  assert.deepEqual(plan.schema.properties.repairs.properties.r0.properties.unknownPolicy.enum,
    ['block', 'assumption', 'range', 'omit']);
  for (const unknownPolicy of ['block', 'assumption', 'range', 'omit']) {
    const merged = applyPlanningAccuracyFieldRepair(plan, patchFor(plan, { ...accuracy, unknownPolicy }));
    assert.equal(JSON.parse(merged).contract.criteria[0].accuracy.unknownPolicy, unknownPolicy);
  }
  assert.throws(() => applyPlanningAccuracyFieldRepair(plan, '{"repairs":{"r0":{}}}'), invalidPatch);
  assert.equal(Object.hasOwn(plan.base.contract.criteria[0].accuracy, 'unknownPolicy'), false);
});

test('the narrow prompt includes captured evidence and exact inherited criteria without the full response contract', () => {
  const body = partialBody(['unknownPolicy']);
  body.contract.criteria[0].accuracy.evidenceNeeded = 'Preserve exact spacing:  two spaces, Unicode café, and "quotes".';
  const inherited = { ...canonicalBody().contract.criteria[0], accuracy: {
    ...clone(body.contract.criteria[0].accuracy), unknownPolicy: 'range'
  }};
  for (const key of ['kind', 'resourceKey', 'targetCount', 'receiptBinding', 'receiptBindings']) delete inherited[key];
  inherited.verification = 'response';
  const attempt = {
    ...canonicalAttempt,
    sources: [...canonicalAttempt.sources, { id: 'task-facts', kind: 'user_request', text: 'North has four seats; South has six. Preserve undisclosed facts.' }],
    inputs: [{ marker: 'captured-input' }], challenges: [{ edgeId: 'challenge-fixture', text: 'Do not invent facts.' }],
    cycleContext: { objective: 'Compare the two rooms.', workflowRequests: [{ requiredForPlan: true, acceptanceCriteria: [inherited] }] },
    stageReview: { marker: 'captured-review' }
  };
  const { repair, plan } = planFor(body, attempt);
  assert.ok(plan);
  const prompt = planningAccuracyFieldRepairPrompt(repair, plan), data = inputOf({ prompt });
  assert.equal(planningModulePrompt(repair), prompt);
  for (const key of ['sources', 'inputs', 'challenges']) assert.deepEqual(data[key], attempt[key]);
  assert.deepEqual(data.cycle, attempt.cycleContext);
  assert.deepEqual(data.stageReview, attempt.stageReview);
  assert.deepEqual(data.responseContext.values, body.values);
  assert.deepEqual(data.targets[0].currentAccuracy, body.contract.criteria[0].accuracy);
  const { accuracy: ignored, ...enclosing } = body.contract.criteria[0];
  assert.deepEqual(data.targets[0].enclosingRequirement, enclosing);
  assert.equal(data.formatRepair.previousOutput, undefined);
  assert.equal(data.formatRepair.baseOutputHash, hash(repair.formatRepair.previousOutput));
  assert.ok(prompt.includes(JSON.stringify(plan.schema)));
  assert.ok(!prompt.includes(JSON.stringify(planningModuleOutputSchema(repair))));
  assert.match(prompt, /block means.*assumption means.*range means.*omit means/);
  assert.match(prompt, /never a host default/);
  assert.match(prompt, /inherited value exactly/);
  const merged = applyPlanningAccuracyFieldRepair(plan, patchFor(plan, { ...accuracy, unknownPolicy: 'range' }));
  assert.deepEqual(validatePlanningModuleResponse(attempt, merged).acceptanceCriteria[0], inherited);
  for (const [field, value] of Object.entries(body.contract.criteria[0].accuracy))
    assert.equal(JSON.parse(merged).contract.criteria[0].accuracy[field], value);
});

test('invalid existing accuracy values and unrelated schema failures retain the full-response repair', async t => {
  const variants = {
    'invalid present enum': body => { body.contract.criteria[0].accuracy.mode = 'approximate'; },
    'null present scalar': body => { body.contract.criteria[0].accuracy.consequence = null; },
    'blank required text': body => { body.contract.criteria[0].accuracy.evidenceNeeded = '   '; },
    'unknown present field': body => { body.contract.criteria[0].accuracy.confidence = 0.9; },
    'array accuracy': body => { body.contract.criteria[0].accuracy = []; },
    'missing whole accuracy': body => { delete body.contract.criteria[0].accuracy; },
    'missing unrelated field': body => { delete body.contract.workItems; },
    'extra response field': body => { body.injected = true; },
    'invalid source reference': body => { body.checks[0].sourceIds = ['not-captured']; },
    'blank present bounded tolerance': body => { body.contract.criteria[0].accuracy.mode = 'bounded_estimate'; body.contract.criteria[0].accuracy.tolerance = ''; }
  };
  for (const [label, change] of Object.entries(variants)) await t.test(label, () => {
    const body = partialBody(); change(body);
    const { repair, plan } = planFor(body);
    assert.equal(plan, null);
    assert.match(planningModulePrompt(repair), /^REPAIR THE REJECTED RESPONSE/);
    assert.ok(planningModulePrompt(repair).includes(JSON.stringify(planningModuleOutputSchema(repair))));
  });
  const full = canonicalBody();
  assert.equal(planFor(full).plan, null);
  full.contract.criteria[0].accuracy = null;
  assert.equal(planFor(full).plan, null);
  assert.equal(createPlanningAccuracyFieldRepair(canonicalAttempt, planningModuleOutputSchema(canonicalAttempt)), null);
});

test('ambiguous or malformed rejected JSON never enters field repair', () => {
  const raw = JSON.stringify(partialBody());
  for (const malformed of [
    raw.slice(0, -1), raw + ' trailing', '[]', 'null',
    raw.replace('"mode":"qualitative"', '"mode":"exact","mode":"qualitative"'),
    raw.replace('"mode":"qualitative"', '"m\\u006fde":"exact","mode":"qualitative"'),
    raw.replace('"mode":"qualitative"', '"__proto__":{},"mode":"qualitative"'),
    raw.replace('"mode":"qualitative"', '"constructor":{},"mode":"qualitative"'),
    raw.replace('"mode":"qualitative"', '"prototype":{},"mode":"qualitative"')
  ]) {
    const { repair, plan } = planFor(malformed);
    assert.equal(plan, null);
    assert.match(planningModulePrompt(repair), /^REPAIR THE REJECTED RESPONSE/);
  }
});

test('patch parser rejects extra IDs, paths, existing fields, duplicate keys and full replacements', async t => {
  const { plan } = planFor(partialBody());
  const attacks = {
    'missing repairs': '{}',
    'missing target': '{"repairs":{}}',
    'extra target': '{"repairs":{"r0":{"unknownPolicy":"omit"},"r1":{"unknownPolicy":"omit"}}}',
    'author-controlled path': '{"repairs":{"r0":{"unknownPolicy":"omit","path":"response.userAgency"}}}',
    'top-level path': '{"repairs":{"r0":{"unknownPolicy":"omit"}},"path":"response.contract.criteria[0].accuracy"}',
    'overwrite mode': '{"repairs":{"r0":{"unknownPolicy":"omit","mode":"exact"}}}',
    'replacement accuracy object': JSON.stringify({ repairs: { r0: { accuracy } } }),
    'full response': JSON.stringify(canonicalBody()),
    'array targets': '{"repairs":[{"unknownPolicy":"omit"}]}',
    'null target': '{"repairs":{"r0":null}}',
    'bad enum': '{"repairs":{"r0":{"unknownPolicy":"ignore"}}}',
    'non-string value': '{"repairs":{"r0":{"unknownPolicy":true}}}',
    'duplicate top key': '{"repairs":{},"repairs":{"r0":{"unknownPolicy":"omit"}}}',
    'duplicate target': '{"repairs":{"r0":{"unknownPolicy":"block"},"r0":{"unknownPolicy":"omit"}}}',
    'duplicate field': '{"repairs":{"r0":{"unknownPolicy":"block","unknownPolicy":"omit"}}}',
    'escaped duplicate target': '{"repairs":{"r\\u0030":{"unknownPolicy":"block"},"r0":{"unknownPolicy":"omit"}}}',
    'escaped duplicate field': '{"repairs":{"r0":{"unknown\\u0050olicy":"block","unknownPolicy":"omit"}}}',
    'proto pollution': '{"repairs":{"r0":{"unknownPolicy":"omit","__proto__":{"polluted":true}}}}',
    'constructor injection': '{"repairs":{"r0":{"unknownPolicy":"omit","constructor":{}}}}',
    'prototype injection': '{"repairs":{"r0":{"unknownPolicy":"omit","prototype":{}}}}',
    'oversize output': ' '.repeat(PLANNING_FIELD_REPAIR_MAX_CHARS) + patchFor(plan),
    'embedded NUL': patchFor(plan) + '\0',
    'trailing text': patchFor(plan) + ' done',
    'deep nesting': '{"repairs":{"r0":' + '['.repeat(70) + '0' + ']'.repeat(70) + '}}'
  };
  const before = clone(plan.base);
  for (const [label, raw] of Object.entries(attacks)) await t.test(label, () => {
    assert.throws(() => applyPlanningAccuracyFieldRepair(plan, raw), invalidPatch);
    assert.deepEqual(plan.base, before);
    assert.equal({}.polluted, undefined);
  });
});

test('all fixed targets and all missing required text must be supplied with schema-valid scalars', () => {
  const { plan } = planFor(partialBody(['evidenceNeeded', 'consequence', 'stopWhen'], 2));
  for (const field of ['evidenceNeeded', 'consequence', 'stopWhen']) {
    for (const value of ['', '  \n\t', null, 123, {}, [], 'x'.repeat(2001)]) {
      const patch = JSON.parse(patchFor(plan)); patch.repairs.r0[field] = value;
      assert.throws(() => applyPlanningAccuracyFieldRepair(plan, JSON.stringify(patch)), invalidPatch);
    }
    const missing = JSON.parse(patchFor(plan)); delete missing.repairs.r0[field];
    assert.throws(() => applyPlanningAccuracyFieldRepair(plan, JSON.stringify(missing)), invalidPatch);
  }
  const missingTarget = JSON.parse(patchFor(plan)); delete missingTarget.repairs.r1;
  assert.throws(() => applyPlanningAccuracyFieldRepair(plan, JSON.stringify(missingTarget)), invalidPatch);
  assert.doesNotThrow(() => applyPlanningAccuracyFieldRepair(plan, patchFor(plan)));
});

test('bounded estimates retain authoritative conditional tolerance validation after merge', () => {
  const body = partialBody(['tolerance']);
  body.contract.criteria[0].accuracy.mode = 'bounded_estimate';
  const { plan } = planFor(body);
  assert.ok(plan);
  const good = applyPlanningAccuracyFieldRepair(plan, patchFor(plan, { ...accuracy, tolerance: 'Within one supplied seat.' }));
  assert.doesNotThrow(() => validatePlanningModuleResponse(canonicalAttempt, good));
  for (const tolerance of ['', '   ']) {
    assert.throws(() => {
      const merged = applyPlanningAccuracyFieldRepair(plan, patchFor(plan, { ...accuracy, tolerance }));
      validatePlanningModuleResponse(canonicalAttempt, merged);
    }, /tolerance|accuracy|bounded/i);
  }
});

test('the narrow target and scalar limits are inclusive and never truncate an eligible patch', () => {
  const eight = planFor(partialBody(['unknownPolicy'], 8)).plan;
  assert.ok(eight); assert.equal(eight.targets.length, 8);
  assert.equal(planFor(partialBody(['unknownPolicy'], 9)).plan, null);
  const thirtyTwo = planFor(partialBody(['unknownPolicy', 'consequence', 'stopWhen', 'evidenceNeeded'], 8)).plan;
  assert.ok(thirtyTwo); assert.equal(thirtyTwo.targets.reduce((sum, target) => sum + target.missing.length, 0), 32);
  assert.equal(planFor(partialBody(['unknownPolicy', 'consequence', 'stopWhen', 'evidenceNeeded', 'tolerance'], 8)).plan, null);
  const padded = patchFor(eight).padEnd(PLANNING_FIELD_REPAIR_MAX_CHARS, ' ');
  assert.doesNotThrow(() => applyPlanningAccuracyFieldRepair(eight, padded));
  assert.throws(() => applyPlanningAccuracyFieldRepair(eight, padded + ' '), invalidPatch);
});

test('a syntactically valid patch cannot suppress inherited-criterion or relationship failures', () => {
  const inherited = { ...canonicalBody().contract.criteria[0], verification: 'response' };
  for (const key of ['kind', 'resourceKey', 'targetCount', 'receiptBinding', 'receiptBindings']) delete inherited[key];
  const attempt = { ...canonicalAttempt, cycleContext: {
    workflowRequests: [{ requiredForPlan: true, acceptanceCriteria: [inherited] }]
  }};
  const body = partialBody(); body.contract.criteria[0].label = 'Changed inherited criterion';
  const { plan } = planFor(body, attempt); assert.ok(plan);
  const merged = applyPlanningAccuracyFieldRepair(plan, patchFor(plan));
  assert.throws(() => validatePlanningModuleResponse(attempt, merged), { code: 'PLANNING_RESPONSE_FORMAT' });
  const broken = partialBody(); broken.contract.workItems[0].criterionIds = ['not-declared'];
  const relationship = planFor(broken).plan; assert.ok(relationship);
  assert.throws(() => validatePlanningModuleResponse(canonicalAttempt,
    applyPlanningAccuracyFieldRepair(relationship, patchFor(relationship))));
});

test('field-repair evidence binds exact raw bytes and rejects malformed provenance', () => {
  const { plan } = planFor(partialBody());
  const raw = patchFor(plan), merged = applyPlanningAccuracyFieldRepair(plan, raw);
  const evidence = planningFieldRepairEvidence(plan, raw, merged);
  assert.equal(evidence.baseOutputHash, hash(plan.baseOutput));
  assert.equal(evidence.patchOutputHash, hash(raw));
  assert.equal(evidence.mergedOutputHash, hash(merged));
  assert.deepEqual(evidence.targetPaths, plan.targets.map(target => target.path));
  assert.deepEqual(validatePlanningFieldRepairEvidence(evidence), evidence);
  const checked = validatePlanningFieldRepairEvidence(evidence); checked.targetPaths.push('response.injected.accuracy');
  assert.equal(evidence.targetPaths.length, 1);
  const attacks = [
    { rawPatch: raw + ' ' }, { protocol: 'other' }, { previousAttemptId: '../outside' },
    { baseOutputHash: '0' }, { patchOutputHash: 'f'.repeat(64) }, { mergedOutputHash: 'xyz' },
    { targetPaths: [] }, { targetPaths: [...evidence.targetPaths, ...evidence.targetPaths] },
    { targetPaths: ['response.__proto__.accuracy'] }, { targetPaths: ['response.constructor.accuracy'] }, { targetPaths: ['response.prototype.accuracy'] },
    { targetPaths: Array.from({ length: 9 }, (_, i) => 'response.criteria[' + i + '].accuracy') },
    { extra: 'not accepted' }
  ];
  for (const attack of attacks) assert.throws(() => validatePlanningFieldRepairEvidence({ ...evidence, ...attack }), invalidPatch, JSON.stringify(attack));
  assert.throws(() => planningFieldRepairEvidence(plan, ' '.repeat(PLANNING_FIELD_REPAIR_MAX_CHARS + 1)), invalidPatch);
  const changed = clone(plan); changed.baseOutput += ' ';
  assert.throws(() => applyPlanningAccuracyFieldRepair(changed, raw), invalidPatch);
});

const profile = { model: 'fixture-free::small-fast', effort: 'default', serviceTier: 'default' };
function viabilityBody(input) {
  const sourceId = input.sources.find(source => source.kind === 'user_request')?.id || input.sources[0].id;
  return {
    userAgency: fixtureUserAgency(),
    values: Object.fromEntries(input.template.fields.map(field => [field.id, field.id === 'objective'
      ? 'Choose the fictional room that seats five from the supplied capacities.'
      : 'South has 6 seats and North has 4 seats, so South meets the five-seat constraint.'])),
    grounding: input.template.fields.filter(field => field.grounding === 'required').map(field => ({ field: field.id, sourceId })),
    openQuestions: [], challengeResponses: [],
    requirements: [{
      id: 'capacity', label: 'Room capacity', importance: 'essential', basis: 'task',
      consequence: 'The selected room must seat five.', resolution: 'observed',
      value: 'North has 4 seats; South has 6 seats.', sourceIds: [sourceId],
      checkedSourceIds: input.sources.filter(source => source.kind !== 'response').map(source => source.id),
      rationale: 'These fictional capacities were supplied in the request.', inferable: false,
      omissionAllowed: false, question: '', dependentNodeIds: [], stopKind: null, commitPrerequisite: false,
      accuracy: clone(accuracy)
    }]
  };
}
function incompleteViability(input) {
  const body = viabilityBody(input); delete body.requirements[0].accuracy.unknownPolicy;
  return JSON.stringify(body);
}
function runtimePatch(input, changes = {}) {
  return JSON.stringify({ repairs: Object.fromEntries(input.targets.map(target => [
    target.id, Object.fromEntries(target.missing.map(field => [field, changes[field] ?? accuracy[field]]))
  ])) });
}
async function runtimeFixture(t, handler) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'planning-field-repair-'));
  const store = await new PlanningBrowserStore({ dataDir: dir }).init(), calls = [];
  let fixture;
  const runtime = { runAgent: async options => {
    const input = inputOf(options); calls.push({ input, options });
    options.onEvent({ type: 'capabilities', profile: 'planning-response', native: false, attachedTools: 0,
      structuredOutput: 'provider-json-schema', structuredOutputTransport: 'response_format', hostValidationRequired: true });
    const result = await handler({ options, input, index: calls.length, f: fixture });
    return typeof result === 'string' ? { output: result, threadId: 'fixture-thread-' + calls.length,
      turnId: 'fixture-turn-' + calls.length, model: profile.model, provider: 'fixture-free',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } : result;
  }};
  const runner = new PlanningBrowserRuntime({ store, runtime, defaultCwd: dir,
    getSettings: () => ({ defaultModel: 'unused-global', defaultEffort: 'high', maxSubagents: 3 }) });
  const request = await store.create({ conversationId: 'field-repair-fixture', title: 'Fictional room capacity',
    objective: 'North seats four and South seats six. Choose the room for five people.', cwd: dir });
  fixture = { dir, store, runtime, runner, request, calls };
  t.after(async () => { await runner.close(); await store.close(); await rm(dir, { recursive: true, force: true }); });
  return fixture;
}
async function addViability(f) {
  const request = await f.store.addNode(f.request.id, { kind: 'viability', title: 'Check fictional capacities', prompt: f.request.objective });
  const node = request.nodes.at(-1);
  return { request, node, options: { requestId: request.id, nodeId: node.id, expectedNodeRevision: node.revision,
    clientRequestId: 'one-explicit-field-check', ...profile } };
}
async function runFixture(f, options, extra = {}) {
  const admitted = await f.runner.start({ ...options, ...extra });
  const finished = await f.runner.wait(options.requestId, admitted.attempt.id);
  return { admitted, finished, saved: await f.store.get(options.requestId) };
}

test('runtime uses two bounded calls, preserves the capture, and reopens merged output with raw provenance', async t => {
  const f = await runtimeFixture(t, ({ input, index }) => index === 1 ? incompleteViability(input) : runtimePatch(input));
  const { options } = await addViability(f), budget = { used: 0, max: 2 };
  const { admitted, finished, saved } = await runFixture(f, options, { providerBudget: budget });
  assert.equal(finished.attempt.status, 'completed', finished.attempt.message);
  assert.equal(PLANNING_MAX_FORMAT_REPAIRS, 1); assert.equal(f.calls.length, 2); assert.equal(budget.used, 2);
  assert.equal(saved.attempts.length, 2); assert.equal(saved.responses.length, 1);
  const [failed, repaired] = saved.attempts, [first, second] = f.calls;
  assert.equal(failed.status, 'failed'); assert.equal(repaired.repairOf, failed.id); assert.equal(repaired.repairIndex, 1);
  assert.equal(failed.repairAttemptId, repaired.id); assert.equal(repaired.formatRepair.previousOutput, failed.partialOutput);
  assert.equal(failed.partialOutput, incompleteViability(first.input));
  for (const key of ['node', 'template', 'sources', 'inputs', 'challenges', 'workflowNodeIds'])
    assert.deepEqual(repaired[key], failed[key]);
  for (const { options: call } of f.calls) {
    for (const [key, value] of Object.entries(profile)) assert.equal(call[key], value);
    assert.equal(call.responseOnly, true); assert.equal(call.sandbox, 'read-only');
    assert.deepEqual(call.dynamicTools, []); assert.equal(call.threadId, undefined);
  }
  assert.equal(second.input.protocol, PLANNING_FIELD_REPAIR_PROTOCOL);
  assert.deepEqual(second.input.sources, first.input.sources);
  assert.deepEqual(Object.keys(second.options.outputSchema.properties), ['repairs']);
  assert.deepEqual(second.options.outputSchema.properties.repairs.properties.r0.required, ['unknownPolicy']);
  assert.ok(second.options.prompt.length < first.options.prompt.length);
  assert.equal(second.input.formatRepair.previousOutput, undefined);
  const rawPatch = runtimePatch(second.input), expected = viabilityBody(first.input);
  assert.deepEqual(JSON.parse(repaired.output), expected);
  assert.equal(repaired.metadata.fieldRepair.rawPatch, rawPatch);
  assert.equal(repaired.metadata.fieldRepair.previousAttemptId, failed.id);
  assert.equal(repaired.metadata.fieldRepair.baseOutputHash, hash(failed.partialOutput));
  assert.equal(repaired.metadata.fieldRepair.patchOutputHash, hash(rawPatch));
  assert.equal(repaired.metadata.fieldRepair.mergedOutputHash, hash(repaired.output));
  assert.deepEqual(repaired.metadata.fieldRepair.targetPaths, ['response.requirements[0].accuracy']);
  assert.equal(saved.responses[0].requirements[0].accuracy.unknownPolicy, accuracy.unknownPolicy);
  assert.notEqual(failed.metadata.runId, repaired.metadata.runId);
  assert.notEqual(failed.metadata.threadId, repaired.metadata.threadId);
  await f.runner.close(); await f.store.close();
  const reopenedStore = await new PlanningBrowserStore({ dataDir: f.dir }).init();
  const restored = new PlanningBrowserRuntime({ store: reopenedStore, runtime: { runAgent() {
    throw Error('An already completed repair cannot call a provider on restart.');
  } }, defaultCwd: f.dir });
  t.after(async () => { await restored.close(); await reopenedStore.close(); });
  const reopened = await reopenedStore.get(options.requestId);
  assert.deepEqual(reopened.attempts, saved.attempts);
  assert.deepEqual(reopened.responses, saved.responses);
  const replay = await restored.start(options), result = await restored.wait(options.requestId, replay.attempt.id);
  assert.equal(result.attempt.id, repaired.id); assert.equal(result.attempt.status, 'completed');
  assert.equal(f.calls.length, 2); assert.equal(admitted.attempt.id, failed.id);
});

test('an invalid patch consumes the existing single repair and cannot trigger a third provider call', async t => {
  for (const kind of ['extra-field', 'wrong-enum', 'full-response', 'duplicate', 'oversize']) await t.test(kind, async t => {
    const f = await runtimeFixture(t, ({ input, index, f }) => {
      if (index === 1) return incompleteViability(input);
      if (kind === 'extra-field') return '{"repairs":{"r0":{"unknownPolicy":"omit","mode":"exact"}}}';
      if (kind === 'wrong-enum') return '{"repairs":{"r0":{"unknownPolicy":"ignore"}}}';
      if (kind === 'full-response') return JSON.stringify(viabilityBody(f.calls[0].input));
      if (kind === 'duplicate') return '{"repairs":{"r0":{"unknownPolicy":"block","unknownPolicy":"omit"}}}';
      return ' '.repeat(PLANNING_FIELD_REPAIR_MAX_CHARS + 1) + runtimePatch(input);
    });
    const { options } = await addViability(f), budget = { used: 0, max: 10 };
    const { admitted, finished, saved } = await runFixture(f, options, { providerBudget: budget });
    assert.equal(finished.attempt.status, 'failed'); assert.equal(f.calls.length, 2); assert.equal(budget.used, 2);
    assert.equal(saved.attempts.length, 2); assert.equal(saved.responses.length, 0);
    assert.equal(saved.attempts[1].repairAttemptId, undefined);
    assert.equal(saved.attempts[1].validation.code, 'PLANNING_FIELD_REPAIR_INVALID');
    if (kind !== 'oversize') assert.equal(saved.attempts[1].metadata.fieldRepair.rawPatch, saved.attempts[1].partialOutput);
    await f.runner.wait(options.requestId, admitted.attempt.id); assert.equal(f.calls.length, 2);
  });
});

test('malformed JSON and invalid present fields still use the existing full-response repair', async t => {
  for (const kind of ['malformed-json', 'blank-existing', 'invalid-reference']) await t.test(kind, async t => {
    const f = await runtimeFixture(t, ({ input, index, options }) => {
      if (index === 2) {
        assert.equal(input.protocol, undefined); assert.ok(input.formatRepair.previousOutput);
        assert.equal(options.outputSchema.properties.repairs, undefined);
        assert.match(options.prompt, /^REPAIR THE REJECTED RESPONSE/);
        return JSON.stringify(viabilityBody(input));
      }
      if (kind === 'malformed-json') return '{"values":';
      const body = JSON.parse(incompleteViability(input));
      if (kind === 'blank-existing') body.requirements[0].accuracy.evidenceNeeded = '';
      else body.requirements[0].sourceIds = ['not-captured'];
      return JSON.stringify(body);
    });
    const { options } = await addViability(f), { finished, saved } = await runFixture(f, options);
    assert.equal(finished.attempt.status, 'completed', finished.attempt.message);
    assert.equal(f.calls.length, 2); assert.equal(saved.attempts[1].metadata.fieldRepair, undefined);
  });
});

test('provider errors, cancellation and exhausted budgets cannot create extra field repair calls', async t => {
  for (const kind of ['initial-provider-error', 'repair-provider-error', 'empty-repair', 'origin-cancel', 'budget']) await t.test(kind, async t => {
    const controller = new AbortController();
    const f = await runtimeFixture(t, ({ input, index }) => {
      if (kind === 'initial-provider-error' || kind === 'repair-provider-error' && index === 2)
        throw Object.assign(Error('Synthetic provider exception.'), { code: 'ECONNRESET' });
      if (kind === 'origin-cancel') controller.abort();
      if (kind === 'empty-repair' && index === 2) return '';
      return index === 1 ? incompleteViability(input) : runtimePatch(input);
    });
    const { options } = await addViability(f), budget = { used: 0, max: kind === 'budget' ? 1 : 4 };
    const { finished, saved } = await runFixture(f, options, { signal: controller.signal, providerBudget: budget });
    const expected = ['repair-provider-error', 'empty-repair'].includes(kind) ? 2 : 1;
    assert.equal(f.calls.length, expected); assert.equal(budget.used, expected);
    assert.equal(saved.attempts.length, expected); assert.equal(saved.responses.length, 0);
    assert.equal(finished.attempt.status, kind === 'origin-cancel' ? 'cancelled' : 'failed');
    if (kind.includes('provider-error') || kind === 'empty-repair') assert.equal(saved.attempts.at(-1).validation, undefined);
  });
  await t.test('cancel the repair attempt', async t => {
    let started; const began = new Promise(resolve => { started = resolve; });
    const f = await runtimeFixture(t, async ({ input, index, options }) => {
      if (index === 1) return incompleteViability(input);
      started();
      await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
      return runtimePatch(input);
    });
    const { options } = await addViability(f);
    const admitted = await f.runner.start(options); await began;
    const current = await f.store.get(options.requestId);
    await f.runner.cancel(current.attempts[1].id);
    const finished = await f.runner.wait(options.requestId, admitted.attempt.id);
    assert.equal(finished.attempt.status, 'cancelled'); assert.equal(f.calls.length, 2);
    assert.equal((await f.store.get(options.requestId)).responses.length, 0);
  });
});

test('store rejects field-repair evidence attached to another base, attempt or output', async t => {
  const f = await runtimeFixture(t, () => { throw Error('Store-only test must not call a provider.'); });
  const { options } = await addViability(f), writer = f.store.runtimeWriter();
  const started = await writer.beginAttempt(options.requestId, options.nodeId, {
    ownerId: 'fixture-worker', expectedNodeRevision: options.expectedNodeRevision, ...profile
  });
  const input = inputOf({ prompt: planningModulePrompt(started.attempt) });
  const original = incompleteViability(input);
  let diagnostic;
  try { validatePlanningModuleResponse(started.attempt, original); }
  catch (error) { diagnostic = planningFormatDiagnostic(started.attempt, original, error); }
  await writer.fail(options.requestId, started.attempt.id, { message: 'Missing policy.', partialOutput: original, validation: diagnostic });
  const repair = await writer.beginRepairAttempt(options.requestId, started.attempt.id);
  const plan = createPlanningAccuracyFieldRepair(repair.attempt, planningModuleOutputSchema(repair.attempt));
  assert.ok(plan);
  const raw = patchFor(plan), output = applyPlanningAccuracyFieldRepair(plan, raw);
  const evidence = planningFieldRepairEvidence(plan, raw, output);
  const metadata = { runId: 'fixture-run', executionNodeId: options.nodeId, fieldRepair: evidence };
  for (const change of [
    { previousAttemptId: 'another-attempt' }, { baseOutputHash: 'f'.repeat(64) }, { mergedOutputHash: 'e'.repeat(64) }
  ]) {
    await assert.rejects(writer.recordResponse(options.requestId, repair.attempt.id, {
      output, metadata: { ...metadata, fieldRepair: { ...evidence, ...change } }
    }), { code: 'PLANNING_RUNTIME_PROVENANCE' });
  }
  const saved = await writer.recordResponse(options.requestId, repair.attempt.id, { output, metadata });
  assert.equal(saved.attempts.at(-1).status, 'completed'); assert.equal(f.calls.length, 0);
});

test('changed future scalar schemas fall back without reinterpreting the v1 audit protocol', () => {
  const repair = repairAttempt(partialBody()), schema = planningModuleOutputSchema(repair);
  const rule = schema.properties.contract.properties.criteria.items.properties.accuracy.anyOf.find(item => item.type === 'object');
  rule.properties.unknownPolicy.enum.push('future-policy');
  assert.equal(createPlanningAccuracyFieldRepair(repair, schema), null);
});

test('subproblem criteria retain their exact surrounding question and host-owned nested target', () => {
  const body = canonicalBody(), criterion = {
    id: 'subcomparison', label: 'Smaller comparison', description: 'Compare the difference in supplied seat counts.',
    verification: 'response', accuracy: clone(accuracy)
  };
  delete criterion.accuracy.unknownPolicy;
  body.subproblems.push({
    key: 'difference', title: 'Compute the difference', objective: 'What is six minus four?',
    reason: 'Establish the exact two-seat difference before choosing.', required: true,
    sourceIds: [], acceptanceCriteria: [criterion], executionTarget: 'analysis'
  });
  const { repair, plan } = planFor(body);
  assert.ok(plan); assert.equal(plan.targets.length, 1);
  assert.equal(plan.targets[0].path, 'response.subproblems[0].acceptanceCriteria[0].accuracy');
  const data = inputOf({ prompt: planningAccuracyFieldRepairPrompt(repair, plan) });
  assert.equal(data.targets[0].subproblem.objective, body.subproblems[0].objective);
  assert.equal(data.targets[0].subproblem.executionTarget, 'analysis');
  const merged = JSON.parse(applyPlanningAccuracyFieldRepair(plan, patchFor(plan)));
  const expected = clone(body); expected.subproblems[0].acceptanceCriteria[0].accuracy.unknownPolicy = accuracy.unknownPolicy;
  assert.deepEqual(merged, expected);
  assert.doesNotThrow(() => validatePlanningModuleResponse(canonicalAttempt, JSON.stringify(merged)));
});

test('a narrow patch still failing full accuracy validation is saved truthfully without a third call', async t => {
  const f = await runtimeFixture(t, ({ input, index }) => {
    if (index === 2) return runtimePatch(input, { tolerance: '' });
    const body = viabilityBody(input);
    body.requirements[0].accuracy.mode = 'bounded_estimate';
    delete body.requirements[0].accuracy.tolerance;
    return JSON.stringify(body);
  });
  const { options } = await addViability(f), { finished, saved } = await runFixture(f, options);
  assert.equal(finished.attempt.status, 'failed'); assert.equal(f.calls.length, 2);
  assert.equal(saved.responses.length, 0);
  const repair = saved.attempts[1];
  assert.ok(repair.metadata.fieldRepair.mergedOutputHash);
  assert.equal(repair.partialOutput, repair.metadata.fieldRepair.rawPatch);
  assert.notEqual(repair.validation.code, 'PLANNING_FIELD_REPAIR_INVALID',
    'This patch was merged, then rejected by the authoritative full validator.');
  await f.runner.close(); await f.store.close();
  const reopened = await new PlanningBrowserStore({ dataDir: f.dir }).init();
  t.after(() => reopened.close());
  assert.deepEqual((await reopened.get(options.requestId)).attempts, saved.attempts);
});

test('reopened completed repairs reject self-consistent but contradictory saved provenance', async t => {
  const f = await runtimeFixture(t, ({ input, index }) => index === 1 ? incompleteViability(input) : runtimePatch(input));
  const { options } = await addViability(f), { saved } = await runFixture(f, options);
  assert.equal(saved.attempts.at(-1).status, 'completed');
  await f.runner.close(); await f.store.close();
  const file = f.store.file(options.requestId), originalBytes = await readFile(file, 'utf8');
  const attacks = {
    'wrong base hash': attempt => { attempt.metadata.fieldRepair.baseOutputHash = 'f'.repeat(64); },
    'wrong merged hash': attempt => { attempt.metadata.fieldRepair.mergedOutputHash = 'f'.repeat(64); },
    'different patch with its own valid hash': attempt => {
      const raw = '{"repairs":{"r0":{"unknownPolicy":"block"}}}';
      attempt.metadata.fieldRepair.rawPatch = raw;
      attempt.metadata.fieldRepair.patchOutputHash = hash(raw);
    },
    'different output with its own valid hashes': attempt => {
      const body = JSON.parse(attempt.output); body.requirements[0].accuracy.unknownPolicy = 'block';
      attempt.output = JSON.stringify(body); attempt.outputHash = hash(attempt.output);
      attempt.metadata.fieldRepair.mergedOutputHash = hash(attempt.output);
    },
    'different base with its own valid hash': attempt => {
      attempt.formatRepair.previousOutput += ' ';
      attempt.metadata.fieldRepair.baseOutputHash = hash(attempt.formatRepair.previousOutput);
    },
    'unrelated target path': attempt => { attempt.metadata.fieldRepair.targetPaths = ['response.values.accuracy']; },
    'lost repair relationship': attempt => { attempt.repairOf = 'different-attempt'; }
  };
  for (const [label, change] of Object.entries(attacks)) await t.test(label, async () => {
    const damaged = JSON.parse(originalBytes); change(damaged.attempts[1]);
    const bytes = JSON.stringify(damaged);
    await writeFile(file, bytes, 'utf8');
    const reopened = await new PlanningBrowserStore({ dataDir: f.dir }).init();
    try { await assert.rejects(reopened.get(options.requestId), { code: 'PLANNING_BROWSER_DAMAGED' }); }
    finally { await reopened.close(); }
    assert.equal(await readFile(file, 'utf8'), bytes, 'A damaged receipt must not be rewritten or repaired silently.');
  });
  await writeFile(file, originalBytes, 'utf8');
});

test('failed and cancelled field-repair raw receipts remain auditable after reopening', async t => {
  for (const status of ['failed', 'cancelled']) await t.test(status, async t => {
    const f = await runtimeFixture(t, () => { throw Error('Store-only audit must not call a provider.'); });
    const { options } = await addViability(f), writer = f.store.runtimeWriter();
    const started = await writer.beginAttempt(options.requestId, options.nodeId, {
      ownerId: 'fixture-worker', expectedNodeRevision: options.expectedNodeRevision, ...profile
    });
    const input = inputOf({ prompt: planningModulePrompt(started.attempt) }), original = incompleteViability(input);
    let diagnostic;
    try { validatePlanningModuleResponse(started.attempt, original); }
    catch (error) { diagnostic = planningFormatDiagnostic(started.attempt, original, error); }
    await writer.fail(options.requestId, started.attempt.id, {
      message: 'Missing policy.', partialOutput: original, validation: diagnostic
    });
    const repair = await writer.beginRepairAttempt(options.requestId, started.attempt.id);
    const plan = createPlanningAccuracyFieldRepair(repair.attempt, planningModuleOutputSchema(repair.attempt));
    const rawPatch = '{"repairs":{"r0":{"unknownPolicy":"bad-policy"}}}';
    const evidence = planningFieldRepairEvidence(plan, rawPatch);
    const metadata = { runId: 'fixture-run', executionNodeId: options.nodeId, fieldRepair: evidence };
    await writer[status === 'cancelled' ? 'cancel' : 'fail'](options.requestId, repair.attempt.id, {
      message: 'Synthetic terminal field repair.', partialOutput: rawPatch, metadata
    });
    await f.runner.close(); await f.store.close();
    const file = f.store.file(options.requestId), originalBytes = await readFile(file, 'utf8');
    let reopened = await new PlanningBrowserStore({ dataDir: f.dir }).init();
    const valid = await reopened.get(options.requestId); await reopened.close();
    assert.equal(valid.attempts[1].status, status);
    assert.equal(valid.attempts[1].metadata.fieldRepair.rawPatch, rawPatch);
    for (const change of [
      attempt => { attempt.metadata.fieldRepair.baseOutputHash = 'f'.repeat(64); },
      attempt => { attempt.metadata.fieldRepair.rawPatch += ' '; attempt.metadata.fieldRepair.patchOutputHash = hash(attempt.metadata.fieldRepair.rawPatch); },
      attempt => { attempt.partialOutput = '{}'; },
      attempt => { attempt.metadata.fieldRepair.mergedOutputHash = 'f'.repeat(64); }
    ]) {
      const damaged = JSON.parse(originalBytes); change(damaged.attempts[1]);
      await writeFile(file, JSON.stringify(damaged), 'utf8');
      reopened = await new PlanningBrowserStore({ dataDir: f.dir }).init();
      try { await assert.rejects(reopened.get(options.requestId), { code: 'PLANNING_BROWSER_DAMAGED' }); }
      finally { await reopened.close(); }
    }
    await writeFile(file, originalBytes, 'utf8');
    assert.equal(f.calls.length, 0);
  });
});

test('v1 evidence remains replayable when schema field order or explanatory descriptions change', () => {
  const repair = repairAttempt(partialBody(['mode', 'consequence', 'unknownPolicy']));
  for (const mutation of [
    rule => { rule.required.reverse(); },
    rule => { rule.properties.unknownPolicy.description = 'A harmless updated explanation.'; }
  ]) {
    const schema = planningModuleOutputSchema(repair);
    mutation(schema.properties.contract.properties.criteria.items.properties.accuracy.anyOf.find(item => item.type === 'object'));
    const plan = createPlanningAccuracyFieldRepair(repair, schema);
    if (!plan) continue; // Conservative full-response fallback is also safe.
    const raw = patchFor(plan), merged = applyPlanningAccuracyFieldRepair(plan, raw);
    assert.equal(replayPlanningFieldRepairEvidence(planningFieldRepairEvidence(plan, raw, merged), plan.baseOutput), merged);
  }
});
