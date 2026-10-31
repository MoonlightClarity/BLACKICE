import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RESPONSE_CYCLE_STAGES, RESPONSE_CYCLE_TEMPLATES, RESPONSE_CYCLE_LIMITS, RESPONSE_CYCLE_CONTAINER_TEMPLATE,
  responseCycleStage, responseCycleTemplate, responseCycleResponseSchema, parseResponseCycleResponse,
  evaluateResponseCycleStage, validatePlanRevision, planningExecutionModeOf, responseCycleInstructions
} from '../public/response-cycle-model.mjs';
import { validateTaskAccuracy, validateViabilityRequirements, taskAccuracySchema } from '../public/task-viability-model.mjs';

const clone = value => structuredClone(value);
const criterion = (id = 'answer', verification = 'response') => ({ id, label: 'Requested outcome', description: 'Answer the requested bounded question with actual findings.', verification });
const source = (id, text, kind = 'source') => ({ id, kind, text, revision: 1, provenance: { kind: 'fixture' } });
const fact = overrides => ({ id: 'essential_fact', label: 'Essential fact', importance: 'essential', basis: 'task', consequence: 'The operation depends on the correct fact.', resolution: 'observed', value: 'Known fixture value', sourceIds: ['evidence'], checkedSourceIds: ['request:fixture', 'evidence'], rationale: 'The captured record supplies the actual fact.', inferable: false, omissionAllowed: false, question: '', dependentNodeIds: ['worker'], ...overrides });
const plan = () => ({ acceptanceCriteria: [criterion()], steps: [{ id: 'inspect', label: 'Inspect the evidence', description: 'Use captured evidence to prepare the requested answer.', dependsOn: [], criterionIds: ['answer'], sourceIds: ['evidence'] }] });
const subproblem = (key = 'details', required = true) => ({ key, title: 'Resolve a bounded detail', objective: 'Determine the one detail required by the parent.', reason: 'The parent cannot infer this consequential detail.', required, sourceIds: ['evidence'], acceptanceCriteria: [criterion('detail')] });
function fixture(kind, { effects = false } = {}) {
  const stage = responseCycleStage(kind), template = responseCycleTemplate(kind), criteria = [criterion('answer', effects ? 'effect' : 'response')];
  const sources = [source('request:fixture', 'The user requested this concrete outcome.', 'user_request'), source('evidence', 'The host captured the actual fixture observation.')];
  const payload = { values: Object.fromEntries(template.fields.map(field => [field.id, field.label + ': concise public fixture findings.'])), grounding: template.fields.filter(field => field.grounding === 'required').map(field => ({ field: field.id, sourceId: 'evidence' })), openQuestions: [], challengeResponses: [] };
  const context = { sources, nodeRevision: 1, prerequisites: [], children: [], acceptanceCriteria: criteria, criterionResults: [{ criterionId: 'answer', assessment: 'satisfied', sourceIds: ['evidence'], receiptIds: [], rationale: 'The actual fixture observation satisfies the criterion.' }], execution: { required: false }, workflowNodeIds: ['worker'] };
  if (kind === 'viability' || kind === 'feasibility') payload.requirements = [fact()];
  else {
    const prior = RESPONSE_CYCLE_STAGES[stage.order - 2], previous = { ...source('response:previous', 'Recorded prerequisite findings.', 'response'), responseId: 'previous' };
    sources.push(previous); context.prerequisites.push({ stageId: prior.id, nodeId: prior.id + '-node', responseId: 'previous', responseRevision: 1, state: 'ready', analysisReady: true, dispatchReady: true });
    payload.checks = stage.checks.map(check => ({ id: check.id, assessment: check.when === 'effects' && !effects ? 'not_applicable' : 'supported', sourceIds: check.grounding === 'required' ? ['evidence'] : [], note: 'The declared assessment has been completed against the captured fixture.' }));
    payload.subproblems = []; payload.childResults = [];
    if (kind === 'inference') payload.inferences = [{ id: 'bounded_claim', claim: 'The captured evidence supports the bounded finding.', basis: 'inferred', sourceIds: ['evidence'], limitation: 'The fixture does not establish facts beyond its stated scope.' }];
    if (kind === 'plan') Object.assign(payload, plan());
    if (kind === 'think') payload.criterionResults = clone(context.criterionResults);
    if (kind === 'respond') {
      payload.values.answer = 'The requested outcome is supported by the captured evidence.';
      payload.coverage = [{ criterionId: 'answer', disposition: 'addressed', sourceIds: ['evidence'], responseExcerpt: 'The requested outcome is supported', limitation: '' }];
    }
  }
  const record = () => ({ ...clone(payload), id: 'current', nodeRevision: 1, sources: clone(sources), inputs: [] });
  const evaluate = (recordOverride = record(), contextOverride = {}) => evaluateResponseCycleStage(kind, recordOverride, { ...context, ...contextOverride });
  return { stage, payload, sources, context, record, evaluate };
}

test('the five actual stages have frozen ordered templates and a non-executable cycle container', () => {
  assert.deepEqual(RESPONSE_CYCLE_STAGES.map(item => item.label), ['Feasibility', 'Inference', 'Plan', 'Think', 'Respond']);
  assert.deepEqual(RESPONSE_CYCLE_STAGES.map(item => item.kind), ['viability', 'inference', 'plan', 'think', 'respond']);
  assert.deepEqual(RESPONSE_CYCLE_STAGES.map(item => item.order), [1, 2, 3, 4, 5]);
  assert.equal(RESPONSE_CYCLE_TEMPLATES[0].label, 'Feasibility');
  assert.equal(RESPONSE_CYCLE_CONTAINER_TEMPLATE.kind, 'cycle');
  assert.deepEqual(RESPONSE_CYCLE_CONTAINER_TEMPLATE.fields, []);
  assert.ok(Object.isFrozen(RESPONSE_CYCLE_STAGES[1].checks));
  assert.throws(() => responseCycleResponseSchema('cycle'), { code: 'RESPONSE_CYCLE_INVALID' });
  assert.match(responseCycleInstructions('think'), /Do not provide private reasoning transcripts/);
});

test('execution mode is caller-neutral, exact and optional only when omitted', () => {
  assert.equal(planningExecutionModeOf(undefined), undefined);
  assert.equal(planningExecutionModeOf('automatic'), 'automatic');
  assert.equal(planningExecutionModeOf('plan_only'), 'plan_only');
  for (const value of [null, '', 'approval', 'Automatic', false]) assert.throws(() => planningExecutionModeOf(value), { code: 'PLANNING_EXECUTION_MODE_INVALID', status: 400 });
});

test('valid evidence-bound stage fixtures are accepted and schema closes every object', () => {
  const visit = schema => { if (schema.type === 'object') { assert.equal(schema.additionalProperties, false); assert.deepEqual(schema.required, Object.keys(schema.properties)); for (const child of Object.values(schema.properties)) visit(child); } if (schema.items) visit(schema.items); for (const child of schema.anyOf || []) visit(child); };
  for (const { kind } of RESPONSE_CYCLE_STAGES) {
    const f = fixture(kind); const parsed = parseResponseCycleResponse(JSON.stringify(f.payload), kind);
    assert.deepEqual(parsed.missingFields, []); visit(responseCycleResponseSchema(kind));
    const result = f.evaluate(); assert.equal(result.state, 'ready', kind + ': ' + JSON.stringify(result)); assert.equal(result.analysisReady, true); assert.equal(result.dispatchReady, true);
  }
  assert.ok(!responseCycleResponseSchema('viability').properties.checks);
  assert.ok(!responseCycleResponseSchema('viability').properties.subproblems);
});

test('model output cannot author ready, runtime state, host receipts or child completion', () => {
  for (const kind of ['inference', 'plan', 'think', 'respond', 'viability']) {
    const f = fixture(kind);
    for (const key of ['ready', 'done', 'status', 'sources', 'effectReceipts', 'provenance']) assert.throws(() => parseResponseCycleResponse({ ...f.payload, [key]: true }, kind), { code: 'RESPONSE_CYCLE_INVALID' });
  }
  const f = fixture('plan'); f.payload.subproblems = [{ ...subproblem(), state: 'completed' }];
  assert.throws(() => parseResponseCycleResponse(f.payload, 'plan'), { code: 'RESPONSE_CYCLE_INVALID' });
  f.payload.subproblems = []; f.payload.steps[0].done = true;
  assert.throws(() => parseResponseCycleResponse(f.payload, 'plan'), { code: 'RESPONSE_CYCLE_INVALID' });
});

test('recorded essential unknowns permit analysis but hold operational dispatch', () => {
  const f = fixture('viability'); f.payload.requirements = [fact({ resolution: 'unknown', value: '', sourceIds: [], question: 'What is the missing essential fact?' })];
  const result = f.evaluate(); assert.equal(result.state, 'awaiting_input'); assert.equal(result.analysisReady, true); assert.equal(result.dispatchReady, false);
  f.payload.requirements[0].checkedSourceIds = [];
  const unchecked = f.evaluate();
  assert.equal(unchecked.analysisReady, true);
  assert.equal(unchecked.dispatchReady, false);
  assert.equal(unchecked.viability.state, 'needs_evidence');
  assert.deepEqual(f.payload.requirements[0].checkedSourceIds, []);
  assert.equal(unchecked.unresolvedChecks.length, 1);
});

test('unknown feasibility can flow into inference and Plan without becoming dispatch authority', () => {
  for (const kind of ['inference', 'plan']) {
    const f = fixture(kind); f.context.prerequisites[0].dispatchReady = false;
    if (kind === 'inference') f.context.prerequisites[0].state = 'awaiting_input';
    const result = f.evaluate(); assert.equal(result.state, 'ready'); assert.equal(result.analysisReady, true); assert.equal(result.dispatchReady, false);
  }
});

test('source changes, removals, additions and provenance revisions invalidate captured findings', () => {
  for (const kind of ['viability', 'inference', 'plan', 'think', 'respond']) {
    const f = fixture(kind), record = f.record();
    for (const sources of [f.sources.map(item => item.id === 'evidence' ? { ...item, text: 'Changed evidence.' } : item), f.sources.filter(item => item.id !== 'evidence'), [...f.sources, source('new-fact', 'A new consequential source.')], f.sources.map(item => item.id === 'evidence' ? { ...item, provenance: { kind: 'changed-origin' } } : item)]) {
      const result = f.evaluate(record, { sources }); assert.equal(result.state, 'stale', kind); assert.equal(result.analysisReady, false); assert.equal(result.dispatchReady, false);
    }
  }
});

test('new downstream response records do not by themselves stale earlier stages', () => {
  const f = fixture('plan'), record = f.record();
  const sources = [...f.sources, { ...source('response:downstream', 'Later response.', 'response'), responseId: 'downstream' }];
  assert.equal(f.evaluate(record, { sources }).state, 'ready');
});

test('prerequisite state and exact response identity are checked by the host', () => {
  const f = fixture('plan');
  assert.equal(f.evaluate(f.record(), { prerequisites: [] }).state, 'blocked');
  assert.equal(f.evaluate(f.record(), { prerequisites: [{ ...f.context.prerequisites[0], analysisReady: false, state: 'failed' }] }).state, 'blocked');
  assert.equal(f.evaluate(f.record(), { prerequisites: [{ ...f.context.prerequisites[0], responseId: 'new-version' }] }).state, 'stale');
  assert.equal(f.evaluate(f.record(), { nodeRevision: 2 }).state, 'stale');
  const changed = f.sources.map(item => item.kind === 'response' ? { ...item, text: 'Altered prerequisite body.' } : item);
  assert.equal(f.evaluate(f.record(), { sources: changed }).state, 'stale');
});

test('actual captured input records can bind a prerequisite without another prose source', () => {
  const f = fixture('plan'); f.sources.splice(f.sources.findIndex(item => item.kind === 'response'), 1);
  const record = f.record(); record.inputs = [{ nodeId: 'inference-node', responseId: 'previous', responseRevision: 1 }];
  assert.equal(f.evaluate(record).state, 'ready'); record.inputs[0].responseRevision = 2;
  assert.equal(f.evaluate(record).state, 'stale');
});

test('invalid evidence references and unsupported required checks cannot pass', () => {
  const f = fixture('inference'); f.payload.inferences[0].sourceIds = ['invented-source'];
  assert.equal(f.evaluate().state, 'needs_evidence');
  f.payload.inferences[0].sourceIds = ['evidence']; f.payload.checks[0].sourceIds = [];
  assert.equal(f.evaluate().state, 'needs_evidence');
  f.payload.checks[0].sourceIds = ['evidence']; f.payload.checks[0].assessment = 'not_applicable';
  assert.equal(f.evaluate().state, 'needs_evidence');
  f.payload.checks[0].assessment = 'supported'; f.payload.grounding = [];
  assert.equal(f.evaluate().state, 'needs_evidence');
});

test('Plan revisions reject hidden execution state, missing coverage, foreign edges and cycles', () => {
  const valid = plan(), snapshot = clone(valid); assert.deepEqual(validatePlanRevision(valid), valid); assert.deepEqual(valid, snapshot);
  assert.throws(() => validatePlanRevision({ ...valid, continue: true }), { code: 'RESPONSE_CYCLE_INVALID' });
  for (const modify of [value => value.acceptanceCriteria.push(criterion('uncovered')), value => value.steps[0].dependsOn.push('missing'), value => value.steps[0].dependsOn.push('inspect'), value => value.steps[0].criterionIds.push('other'), value => value.steps[0].status = 'complete']) {
    const value = clone(valid); modify(value); assert.throws(() => validatePlanRevision(value), { code: 'RESPONSE_CYCLE_INVALID' });
  }
  const cycle = clone(valid); cycle.steps.push({ ...cycle.steps[0], id: 'second', dependsOn: ['inspect'] }); cycle.steps[0].dependsOn = ['second'];
  assert.throws(() => validatePlanRevision(cycle), /acyclic/);
});

test('independent planned branches remain legal and all criteria stay covered', () => {
  const value = plan(); value.acceptanceCriteria.push(criterion('independent'));
  value.steps.push({ id: 'parallel', label: 'Independent useful work', description: 'Work that does not need the other branch.', dependsOn: [], criterionIds: ['independent'], sourceIds: ['evidence'] });
  value.steps.push({ id: 'combine', label: 'Combine actual outputs', description: 'Combine both after their results are available.', dependsOn: ['inspect', 'parallel'], criterionIds: ['answer', 'independent'], sourceIds: ['evidence'] });
  assert.deepEqual(validatePlanRevision(value).steps[1].dependsOn, []);
});

test('a child Plan cannot replace parent-requested criteria with easier completion conditions', () => {
  const f = fixture('plan'); f.context.requiredAcceptanceCriteria = [criterion()];
  assert.equal(f.evaluate().state, 'ready');
  f.payload.acceptanceCriteria[0].label = 'A clearer descriptive label';
  assert.equal(f.evaluate().state, 'ready');
  f.payload.acceptanceCriteria[0].description = 'Return any response, whether or not the required detail was resolved.';
  assert.equal(f.evaluate().state, 'needs_evidence');
  f.payload.acceptanceCriteria[0] = criterion(); f.context.requiredAcceptanceCriteria = [criterion('missing')];
  assert.equal(f.evaluate().state, 'needs_evidence');
  f.context.requiredAcceptanceCriteria = [criterion('answer', 'effect')];
  assert.equal(f.evaluate().state, 'needs_evidence');
});

test('required recursive requests wait for actual host children and respect finite budgets', () => {
  const f = fixture('inference'); f.payload.subproblems = [subproblem()];
  assert.equal(f.evaluate().state, 'waiting_children');
  for (const recursion of [{ depth: 4, cycleCount: 1 }, { depth: 1, cycleCount: 24 }, { depth: 0, cycleCount: 1, maxDepth: 99 }, { depth: -1, cycleCount: 1 }]) assert.equal(f.evaluate(f.record(), { recursion }).state, 'budget_exceeded');
  f.payload.subproblems[0].required = false;
  assert.equal(f.evaluate().state, 'ready');
  assert.equal(f.evaluate(f.record(), { recursion: { depth: 4, cycleCount: 1 } }).state, 'budget_exceeded');
});

test('only current terminal required child results can be aggregated into a parent', () => {
  const f = fixture('inference'), childSource = { ...source('response:child-final', 'The child returned the bounded detail.', 'response'), responseId: 'child-final' };
  f.sources.push(childSource); f.payload.subproblems = [subproblem()];
  const child = { key: 'details', cycleId: 'child-cycle', state: 'running', required: true, outcome: 'unresolved', sourceId: childSource.id, request: subproblem() };
  f.context.children = [child]; assert.equal(f.evaluate().state, 'waiting_children');
  child.state = 'completed'; child.outcome = 'satisfied'; child.dispatchReady = true; assert.equal(f.evaluate().state, 'needs_evidence');
  f.payload.childResults = [{ key: 'details', sourceId: childSource.id, summary: 'The bounded detail is available.', usedFor: 'It resolves the parent dependency.' }];
  assert.equal(f.evaluate().state, 'ready'); assert.equal(f.evaluate().dispatchReady, true);
  child.sourceId = 'response:new-child-final'; assert.equal(f.evaluate().state, 'needs_evidence');
});

test('a satisfactory child answer cannot erase its host-known unresolved essential prerequisite', () => {
  const f = fixture('plan'), childSource = { ...source('response:child-answer', 'The child supplied a useful bounded answer.', 'response'), responseId: 'child-answer' };
  f.sources.push(childSource); f.context.children = [{ key: 'details', required: true, state: 'completed', outcome: 'satisfied', dispatchReady: false, sourceId: childSource.id }];
  f.payload.childResults = [{ key: 'details', sourceId: childSource.id, summary: 'A useful answer is available, but its operational prerequisite remains unresolved.', usedFor: 'Use the analysis while retaining the actual prerequisite.' }];
  const result = f.evaluate(); assert.equal(result.state, 'ready'); assert.equal(result.analysisReady, true); assert.equal(result.dispatchReady, false);
  delete f.context.children[0].dispatchReady;
  assert.equal(f.evaluate().dispatchReady, false, 'absent host readiness cannot be inferred from model outcome');
});

test('host-required children cannot be downgraded by model omission or optional labels', () => {
  const f = fixture('plan'); f.context.children = [{ key: 'required-check', required: true, state: 'running' }];
  assert.equal(f.evaluate().state, 'waiting_children');
  f.payload.subproblems = [subproblem('required-check', false)];
  assert.equal(f.evaluate().state, 'waiting_children');
});

test('reusing a subproblem key with changed intent invalidates its child binding', () => {
  const f = fixture('plan'); f.payload.subproblems = [subproblem()];
  f.context.children = [{ key: 'details', required: true, state: 'running', request: { ...subproblem(), objective: 'A different older question.' } }];
  assert.equal(f.evaluate().state, 'stale');
});

test('terminal failed or incomplete child findings can be reported without dispatch success', () => {
  const f = fixture('think'), childSource = { ...source('response:failed-child', 'The host recorded that the child could not determine the detail.', 'response'), responseId: 'failed-child' };
  f.sources.push(childSource); f.context.children = [{ key: 'details', required: true, state: 'failed', outcome: 'unresolved', sourceId: childSource.id }];
  f.payload.childResults = [{ key: 'details', sourceId: childSource.id, summary: 'The child did not establish the detail.', usedFor: 'The final answer must disclose this limit.' }];
  let result = f.evaluate(); assert.equal(result.state, 'ready'); assert.equal(result.dispatchReady, false); assert.equal(result.childFailures[0].state, 'failed');
  f.context.children[0].state = 'completed'; result = f.evaluate(); assert.equal(result.state, 'ready'); assert.equal(result.dispatchReady, false);
});

test('Think and Respond cannot silently run before host execution has a disposition', () => {
  for (const kind of ['think', 'respond']) {
    const f = fixture(kind);
    for (const execution of [undefined, {}, { required: true, state: 'running' }, { required: true, state: 'not_started' }]) assert.equal(f.evaluate(f.record(), { execution }).state, 'awaiting_execution');
    for (const execution of [{ required: false }, { required: true, state: 'completed' }, { required: true, state: 'failed' }, { required: true, state: 'unknown' }]) assert.equal(f.evaluate(f.record(), { execution }).state, 'ready');
  }
});

test('Think assesses exactly the current plan criteria rather than inventing completion', () => {
  const f = fixture('think');
  f.context.acceptanceCriteria.push(criterion('newly-added'));
  assert.equal(f.evaluate().state, 'needs_evidence');
  f.context.acceptanceCriteria.pop(); f.payload.criterionResults[0].criterionId = 'foreign';
  assert.equal(f.evaluate().state, 'needs_evidence');
  f.payload.criterionResults[0].criterionId = 'answer'; f.payload.criterionResults[0].assessment = 'uncertain'; f.payload.criterionResults[0].sourceIds = [];
  const result = f.evaluate(); assert.equal(result.state, 'ready'); assert.equal(result.outcome, 'unresolved');
});

test('a successful tool call without a matching observed effect cannot satisfy an effect criterion', () => {
  const f = fixture('think', { effects: true });
  const receiptSource = source('receipt:effect', 'The requested actual effect was observed.', 'effect_receipt'); f.sources.push(receiptSource);
  f.payload.criterionResults[0].sourceIds = ['receipt:effect']; f.payload.criterionResults[0].receiptIds = ['effect-a'];
  const receipt = { id: 'effect-a', criterionIds: ['answer'], state: 'succeeded', effectVerified: false, sourceId: 'receipt:effect' }; f.context.effectReceipts = [receipt];
  assert.equal(f.evaluate().state, 'needs_evidence'); receipt.effectVerified = true;
  assert.equal(f.evaluate().state, 'ready');
  receipt.criterionIds = ['another']; assert.equal(f.evaluate().state, 'needs_evidence'); receipt.criterionIds = ['answer']; receipt.state = 'unknown';
  assert.equal(f.evaluate().state, 'needs_evidence');
});

test('a truthful partial final response is deliverable and exposes its limitations in the answer', () => {
  const f = fixture('respond'); f.context.criterionResults[0].assessment = 'uncertain';
  f.payload.values.answer = 'The evidence is incomplete. The required fact remains unknown.';
  f.payload.coverage[0] = { criterionId: 'answer', disposition: 'unresolved', sourceIds: ['evidence'], responseExcerpt: 'The evidence is incomplete.', limitation: 'The required fact remains unknown.' };
  let result = f.evaluate(); assert.equal(result.state, 'ready'); assert.equal(result.outcome, 'unresolved');
  f.payload.coverage[0].disposition = 'addressed'; result = f.evaluate(); assert.equal(result.state, 'needs_evidence');
  f.payload.coverage[0].disposition = 'unresolved'; f.payload.values.answer = 'The evidence is incomplete.';
  assert.equal(f.evaluate().state, 'needs_evidence');
});

test('final coverage needs exact answer excerpts, every criterion and current effect receipts', () => {
  const f = fixture('respond'); f.payload.coverage[0].responseExcerpt = 'A claim absent from the answer.';
  assert.equal(f.evaluate().state, 'needs_evidence');
  f.payload.coverage = []; assert.equal(f.evaluate().state, 'needs_evidence');
  const effect = fixture('respond', { effects: true });
  assert.equal(effect.evaluate().state, 'needs_evidence');
  const receiptSource = source('receipt:effect', 'The actual outcome was observed.', 'effect_receipt'); effect.sources.push(receiptSource);
  effect.context.criterionResults[0].receiptIds = ['effect-a']; effect.payload.coverage[0].sourceIds = ['receipt:effect'];
  effect.context.effectReceipts = [{ id: 'effect-a', criterionIds: ['answer'], state: 'succeeded', effectVerified: true, sourceId: 'receipt:effect' }];
  assert.equal(effect.evaluate().state, 'ready');
});

test('invalid attempts to waive an applicable effect check are rejected by host criteria', () => {
  const f = fixture('think', { effects: true });
  f.payload.criterionResults[0].assessment = 'uncertain'; f.payload.criterionResults[0].sourceIds = [];
  f.payload.checks.find(item => item.id === 'effects_verified').assessment = 'not_applicable';
  assert.equal(f.evaluate().state, 'needs_evidence');
});

test('bounded parser rejects duplicate structural IDs and oversized payloads', () => {
  const f = fixture('inference'); f.payload.inferences.push(clone(f.payload.inferences[0]));
  assert.throws(() => parseResponseCycleResponse(f.payload, 'inference'), { code: 'RESPONSE_CYCLE_INVALID' });
  assert.throws(() => parseResponseCycleResponse('x'.repeat(RESPONSE_CYCLE_LIMITS.responseChars + 1), 'plan'), { code: 'RESPONSE_CYCLE_INVALID' });
  const g = fixture('plan'); g.payload.steps[0].description = 'x'.repeat(4001);
  assert.throws(() => parseResponseCycleResponse(g.payload, 'plan'), { code: 'RESPONSE_CYCLE_INVALID' });
});

const accuracy = overrides => ({ mode: 'exact', tolerance: '', decisionThreshold: 'At least 5 seats.', evidenceNeeded: 'The supplied fictional capacities.', consequence: 'The selected room would not meet the stated requirement.', unknownPolicy: 'block', stopWhen: 'The supplied capacities have been compared with 5 and the arithmetic checked.', ...overrides });

test('accuracy remains optional on legacy findings while strict wire output declares a nullable complete contract', () => {
  assert.equal(validateTaskAccuracy(undefined), undefined); assert.equal(validateTaskAccuracy(null), undefined);
  for (const mode of ['missing', 'null', 'explicit']) {
    const p = plan(), requirement = fact();
    if (mode !== 'missing') { p.acceptanceCriteria[0].accuracy = mode === 'null' ? null : accuracy(); requirement.accuracy = mode === 'null' ? null : accuracy(); }
    const parsed = validatePlanRevision(p), requirements = validateViabilityRequirements([requirement]);
    assert.deepEqual(parsed.acceptanceCriteria[0].accuracy, mode === 'explicit' ? accuracy() : undefined);
    assert.deepEqual(requirements[0].accuracy, mode === 'explicit' ? accuracy() : undefined);
  }
  const planSchema = responseCycleResponseSchema('plan').properties.acceptanceCriteria.items;
  const factSchema = responseCycleResponseSchema('viability').properties.requirements.items;
  for (const schema of [planSchema, factSchema]) { assert.ok(schema.required.includes('accuracy')); assert.deepEqual(schema.properties.accuracy, taskAccuracySchema()); }
  assert.deepEqual(taskAccuracySchema().anyOf[1], { type: 'null' });
});

test('accuracy refuses fabricated defaults, vague confidence fields and estimates with no tolerance', () => {
  assert.deepEqual(validateTaskAccuracy(accuracy()), accuracy());
  assert.throws(() => validateTaskAccuracy({ ...accuracy(), confidence: 0.99 }), /declared task accuracy fields/);
  const missing = accuracy(); delete missing.stopWhen; assert.throws(() => validateTaskAccuracy(missing), /declared task accuracy fields/);
  assert.throws(() => validateTaskAccuracy(accuracy({ mode: 'bounded_estimate' })), /Accuracy tolerance/);
  for (const key of ['evidenceNeeded', 'consequence', 'stopWhen']) assert.throws(() => validateTaskAccuracy(accuracy({ [key]: '' })), /bounded text/);
  assert.equal(validateTaskAccuracy(accuracy({ mode: 'qualitative', decisionThreshold: '' })).tolerance, '');
});

test('exact deduction from stipulated room capacities needs no invented external-world check', () => {
  const f = fixture('viability');
  f.sources[0].text = 'Fictional North seats 4, South seats 6; choose a free room that seats at least 5. Both are free.';
  f.sources[1].text = 'Given capacities: North 4; South 6. Both cost zero.';
  f.payload.requirements = [fact({ label: 'Capacity meets the supplied cutoff', resolution: 'inference', inferable: true,
    value: 'South: 6 >= 5. North: 4 < 5. Difference: 2 seats.', rationale: 'Exact arithmetic on the stipulated facts resolves the choice.', accuracy: accuracy() })];
  const result = f.evaluate(); assert.equal(result.state, 'ready'); assert.equal(result.dispatchReady, true); assert.deepEqual(result.viability.blockingFacts, []);
  for (const stage of RESPONSE_CYCLE_STAGES) {
    const instructions = responseCycleInstructions(stage.kind); assert.match(instructions, /fictional or stipulated premises/); assert.match(instructions, /No decision-changing unknown/); assert.match(instructions, /Stop additional checking/);
  }
});

test('an unresolved exact eligibility boundary stays blocked despite a nearby numerical range', () => {
  const f = fixture('viability'); f.sources[1].text = 'The requirement is age at least 18; the available record establishes only age between 17 and 19.';
  f.payload.requirements = [fact({ label: 'Age eligibility', resolution: 'unknown', value: '', sourceIds: [], question: 'What is the verified age at the eligibility date?',
    accuracy: accuracy({ decisionThreshold: 'Age >= 18 at the eligibility date.', evidenceNeeded: 'An age record sufficient to resolve the cutoff.', consequence: 'A mistaken eligibility decision would violate the stated requirement.', stopWhen: 'The available record resolves which side of 18 the age falls on.' }) })];
  const result = f.evaluate(); assert.equal(result.state, 'awaiting_input'); assert.equal(result.dispatchReady, false); assert.equal(result.viability.blockingFacts.length, 1);
});

test('a supported bounded comparison is sufficient without exact point estimates or further facts', () => {
  const f = fixture('viability'); f.sources[0].text = 'Compare which option is broadly cheaper using these supplied ranges; no exact quote is needed.';
  f.sources[1].text = 'Option A is 40–60 units; option B is 180–220 units.';
  f.payload.requirements = [fact({ label: 'Broad cost comparison', resolution: 'inference', inferable: true,
    value: 'Option A is cheaper throughout the supplied ranges; exact final costs remain unknown.', rationale: 'Even the upper bound of A is below the lower bound of B.',
    accuracy: accuracy({ mode: 'bounded_estimate', tolerance: 'Use the supplied 40–60 and 180–220 ranges; no exact point quote is required.', decisionThreshold: 'A upper bound < B lower bound.', evidenceNeeded: 'The two supplied cost ranges.', consequence: 'A wrong ordering would change the preliminary recommendation.', unknownPolicy: 'range', stopWhen: 'The cost ranges do not overlap, so further precision cannot change the requested ordering.' }) })];
  assert.equal(f.evaluate().state, 'ready'); assert.equal(f.evaluate().dispatchReady, true);
  f.payload.requirements[0].sourceIds = []; assert.equal(f.evaluate().state, 'needs_evidence', 'A range policy does not manufacture evidence.');
  f.payload.requirements[0].sourceIds = ['evidence']; f.payload.requirements[0].resolution = 'unknown'; f.payload.requirements[0].question = 'Which range is supported?';
  assert.equal(f.evaluate().state, 'awaiting_input', 'Permission to use ranges cannot silently turn an unknown finding into a resolved one.');
});

test('child Plans preserve the parent accuracy target and changed child targets invalidate old bindings', () => {
  const f = fixture('plan'), target = accuracy();
  f.context.requiredAcceptanceCriteria = [{ ...criterion(), accuracy: target }];
  assert.equal(f.evaluate().state, 'needs_evidence');
  f.payload.acceptanceCriteria[0].accuracy = clone(target); assert.equal(f.evaluate().state, 'ready');
  f.payload.acceptanceCriteria[0].accuracy.unknownPolicy = 'assumption'; assert.equal(f.evaluate().state, 'needs_evidence');
  f.payload.acceptanceCriteria[0].accuracy = { ...target, stopWhen: 'Stop without checking the cutoff.' }; assert.equal(f.evaluate().state, 'needs_evidence');
  const nested = fixture('inference'); nested.payload.subproblems = [{ ...subproblem('details', false), acceptanceCriteria: [{ ...criterion('detail'), accuracy: target }] }];
  nested.context.children = [{ key: 'details', state: 'pending', required: false, request: clone(nested.payload.subproblems[0]) }];
  assert.equal(nested.evaluate().state, 'ready');
  nested.payload.subproblems[0].acceptanceCriteria[0].accuracy.stopWhen = 'A newly edited stopping condition.';
  assert.equal(nested.evaluate().state, 'stale');
});

test('editing a saved Plan accuracy target invalidates captured later-stage evidence', () => {
  const f = fixture('think'), target = accuracy();
  f.context.acceptanceCriteria[0].accuracy = target;
  const previous = f.sources.find(item => item.kind === 'response'); previous.text = JSON.stringify({ acceptanceCriteria: f.context.acceptanceCriteria });
  const recorded = f.record(); assert.equal(f.evaluate(recorded).state, 'ready');
  f.context.acceptanceCriteria[0].accuracy.stopWhen = 'Check a changed task boundary.';
  previous.text = JSON.stringify({ acceptanceCriteria: f.context.acceptanceCriteria });
  assert.equal(f.evaluate(recorded).state, 'stale');
});

test('an explicit accuracy target cannot be waived by a contradictory omission finding', () => {
  const f = fixture('viability');
  f.payload.requirements = [fact({ resolution: 'omission', value: '', omissionAllowed: true, accuracy: accuracy(), rationale: 'The model proposed leaving this fact out.' })];
  assert.equal(f.evaluate().state, 'needs_evidence');
  f.payload.requirements[0].accuracy.unknownPolicy = 'omit';
  assert.equal(f.evaluate().state, 'ready');
});
