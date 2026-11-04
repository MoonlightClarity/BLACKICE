import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { USER_AGENCY_GUIDANCE, USER_AGENCY_CHECKPOINT_SCHEMA, normalizeUserAgencyCheckpoint, evaluateUserAgencyCheckpoint } from '../public/planning-user-agency.mjs';
import { parseResponseCycleResponse, responseCycleTemplate, responseCycleStage } from '../public/response-cycle-model.mjs';
import { planningCycleStageContext, parseModuleResponse } from '../public/planning-browser-model.mjs';
import { PlanningBrowserStore } from '../lib/planning-browser.mjs';
import { planningModuleOutputSchema, validatePlanningModuleResponse, planningFormatDiagnostic } from '../lib/planning-browser-runtime.mjs';
import { normalizePlanningReview, appendPlanningReview, validateSavedPlanningReviews } from '../lib/planning-review.mjs';
import { defaultPlanInstructions } from '../lib/engine.mjs';
import { PLANNING_SKILL_VERSION, PLANNING_SKILL_CONTENT } from '../lib/planning-skill.mjs';

const cost = (value, basis = 'Illustrative minute-equivalent user-loss estimate for this option.') => ({ value, basis });
const risk = (probability = 0.01, severity = 5) => ({
  id: 'correctable_error', probability, severity,
  probabilityBasis: { kind: probability === null ? 'unknown' : 'assumption', rationale: 'Explicit illustrative estimate, not an empirical frequency.' },
  severityBasis: { anchor: severity <= 5 ? 'brief_rework' : 'substantial_rework', consequence: 'Correct and verify the affected work if this event happens.', conversionBasis: `${severity} minutes of equivalent correction work.` }
});
const option = (id, action, risks = [], friction = 0) => ({
  id, action, reversibility: 'reversible', outcome: `${action} the affected work under existing authority.`, risks,
  delayCost: cost(0, 'No additional delay in this illustrative option.'),
  interruptionCost: cost(action === 'ask' ? friction : 0, action === 'ask' ? 'Time for the user to read and answer.' : 'No interruption of the user.'),
  opportunityCost: cost(action === 'ask' ? 0 : friction, 'Expected progress lost by this option.'),
  ...(action === 'ask' ? { clarification: { baselineOptionId: 'proceed', informationNeeded: 'The fact that selects between the two real branches.', howAnswerChangesAction: 'Select the correct branch using that answer.', residualRiskBasis: 'The answer resolves the one correction risk in this illustration.' } } : {})
});
const comparison = (probability = 0.01, severity = 5) => ({
  decision: 'Proceed from available evidence or interrupt the user?',
  assumptions: ['All probabilities and conversions in this test are illustrative assumptions.'], hardConstraints: [],
  options: [option('proceed', 'proceed', [risk(probability, severity)]), option('ask', 'ask', [], 2), option('defer', 'defer', [], 4)]
});
function checkpoint({ input, action = 'proceed', selectedOptionId = action, audience = 'internal' } = {}) {
  return {
    version: 1, audience, userBenefit: 'Complete the requested work accurately with proportionate burden.',
    representation: { actualQuestion: 'Complete the requested authorized work.', requiredFacts: [], relevantClaims: [], privateFindings: [], userReport: [] },
    action, decisionRequired: Boolean(input), decisionReason: input ? 'Compare the actual outcome costs before selecting this action.' : 'The required answer is already confirmed; no decision-changing uncertainty remains.',
    decisions: input ? [{ id: 'next_action', input, selectedOptionId }] : [], chosenDecisionId: input ? 'next_action' : null
  };
}
function response(kind, userAgency) {
  const template = responseCycleTemplate(kind);
  const result = {
    values: Object.fromEntries(template.fields.map(field => [field.id, 'The requested bounded result is grounded in the supplied task record.'])),
    grounding: [], openQuestions: [], challengeResponses: [], ...(userAgency ? { userAgency } : {})
  };
  if (kind === 'viability') return { ...result, requirements: [] };
  result.checks = responseCycleStage(kind).checks.map(check => ({ id: check.id, assessment: 'supported', sourceIds: [], note: 'The bounded recorded finding supports this declared check.' }));
  result.subproblems = []; result.childResults = [];
  if (kind === 'inference') result.inferences = [];
  if (kind === 'plan') Object.assign(result, { acceptanceCriteria: [{ id: 'criterion', label: 'Deliver the requested result', description: 'The bounded requested result is present.', verification: 'response' }], steps: [{ id: 'step', label: 'Prepare the result', description: 'Use the supplied evidence to prepare the bounded result.', dependsOn: [], criterionIds: ['criterion'], sourceIds: [] }] });
  if (kind === 'think') result.criterionResults = [];
  if (kind === 'respond') result.coverage = [];
  return result;
}

test('routine required answers reuse confirmed facts without numeric ceremony or invented biography', () => {
  const input = checkpoint({ audience: 'counterparty' });
  input.representation.actualQuestion = 'Has a relative worked here?';
  input.representation.requiredFacts = ['No — the user previously confirmed this answer.'];
  input.representation.privateFindings = ['Military-spouse history has not been supplied; absence is not a No.'];
  const value = normalizeUserAgencyCheckpoint(input, { required: true });
  assert.deepEqual(value.decisions, []);
  assert.deepEqual(value.representation.requiredFacts, input.representation.requiredFacts);
  assert.deepEqual(value.representation.privateFindings, input.representation.privateFindings);
  assert.equal(evaluateUserAgencyCheckpoint(value).preferredAction, 'proceed');
  assert.throws(() => normalizeUserAgencyCheckpoint({ ...input, action: 'ask' }), { code: 'USER_AGENCY_COMPARISON_REQUIRED' });
});

test('counterparty content is separate from private gap audits and candid reporting to the user', () => {
  const agency = checkpoint({ audience: 'counterparty' });
  agency.representation.actualQuestion = 'Describe relevant work.';
  agency.representation.relevantClaims = ['Built and operated the supported project.'];
  agency.representation.privateFindings = ['Direct experience in one listed tool is unconfirmed.'];
  agency.representation.userReport = ['Submission has not yet been verified.'];
  const body = response('respond', agency);
  body.values.answer = 'Built and operated the supported project.';
  const parsed = parseResponseCycleResponse(body, 'respond', { requireUserAgency: true });
  assert.equal(parsed.values.answer, 'Built and operated the supported project.');
  assert.doesNotMatch(parsed.values.answer, /unconfirmed|not yet verified/);
  assert.deepEqual(parsed.userAgency.representation.userReport, ['Submission has not yet been verified.']);
  const negotiation = structuredClone(agency);
  negotiation.representation.privateFindings = ['The user privately authorized a maximum budget.'];
  negotiation.representation.relevantClaims = ['The opening offer is supported by the authorized negotiating range.'];
  assert.deepEqual(normalizeUserAgencyCheckpoint(negotiation).representation.privateFindings, negotiation.representation.privateFindings);
});

test('declared asking and deferral cannot override a cheaper calculated proceed option', () => {
  const good = checkpoint({ input: comparison() });
  const projection = evaluateUserAgencyCheckpoint(good);
  assert.equal(projection.comparisons[0].evaluation.recommendedCost, 0.05);
  assert.equal(projection.preferredAction, 'proceed');
  assert.throws(() => normalizeUserAgencyCheckpoint({ ...good, action: 'ask', decisionReason: 'There is a possible risk, so caution is safest.' }), { code: 'USER_COST_RECALCULATION_REQUIRED' });
  assert.throws(() => normalizeUserAgencyCheckpoint(checkpoint({ input: comparison(), action: 'defer' })), { code: 'USER_COST_RECALCULATION_REQUIRED' });
  const forged = structuredClone(good); forged.decisions[0].evaluation = { preferredAction: 'ask' };
  assert.throws(() => normalizeUserAgencyCheckpoint(forged), { code: 'USER_AGENCY_INVALID' });
});

test('new evidence and recalculation can justify a useful question', () => {
  const agency = checkpoint({ input: comparison(0.4, 100), action: 'ask' });
  const projection = evaluateUserAgencyCheckpoint(agency);
  assert.equal(projection.preferredAction, 'ask');
  assert.equal(projection.comparisons[0].evaluation.recommendedCost, 2);
  assert.equal(projection.comparisons[0].evaluation.escalationJustified, true);
  assert.equal(projection.overrideRequiresNewEvidence, true);
  assert.match(projection.directive, /Ask the specific justified question/);
  assert.match(projection.directive, /fact that selects between the two real branches/);
  assert.doesNotMatch(projection.directive, /do not add.*question/);
});

test('unknown cost is internal investigation, not an automatic user question or catastrophe', () => {
  const agency = checkpoint({ input: comparison(null, 5), action: 'investigate', selectedOptionId: null });
  const result = evaluateUserAgencyCheckpoint(agency);
  assert.equal(result.comparisons[0].evaluation.status, 'needs_estimates');
  assert.equal(result.checkpoint.action, 'investigate');
  assert.throws(() => normalizeUserAgencyCheckpoint({ ...agency, action: 'ask' }), { code: 'USER_COST_RECALCULATION_REQUIRED' });
});

test('all five new enforced planning stages require a checkpoint while legacy parsing remains readable', () => {
  for (const kind of ['inference', 'viability', 'plan', 'think', 'respond']) {
    const old = response(kind);
    assert.ok(parseModuleResponse(old, kind));
    assert.throws(() => parseModuleResponse(old, kind, { requireUserAgency: true }), { code: 'USER_AGENCY_REQUIRED' });
    const current = response(kind, checkpoint());
    assert.equal(parseModuleResponse(current, kind, { requireUserAgency: true }).userAgency.action, 'proceed');
  }
});

test('a typed essential stop cannot hide behind a routine or contrary proceed checkpoint', () => {
  const body = response('viability', checkpoint());
  body.requirements = [{ id: 'target-access', label: 'Target access', importance: 'essential', basis: 'task',
    consequence: 'The target will not accept this affected operation while the observed denial remains.', resolution: 'blocked', value: 'The target returned access denied.',
    sourceIds: ['diagnostic'], checkedSourceIds: ['diagnostic'], rationale: 'The target denied the required operation; its owner must restore access.',
    inferable: false, omissionAllowed: false, question: 'Can the target owner restore access?', dependentNodeIds: [], stopKind: 'target_denied' }];
  assert.throws(() => parseModuleResponse(body, 'viability', { requireUserAgency: true }), { code: 'USER_AGENCY_DISPATCH_CONTRADICTION' });
  body.userAgency = checkpoint({ input: comparison() });
  assert.throws(() => parseResponseCycleResponse(body, 'viability', { requireUserAgency: true }), { code: 'USER_AGENCY_DISPATCH_CONTRADICTION' });
  const input = comparison();
  input.hardConstraints = [{ id: 'observed-denial', kind: 'verified_requirement', rule: 'The target must allow the affected operation.', source: 'diagnostic', observedViolation: 'The target returned access denied.', blockedOptionIds: ['proceed'] }];
  body.userAgency = checkpoint({ input, action: 'ask' });
  assert.equal(parseModuleResponse(body, 'viability', { requireUserAgency: true }).userAgency.action, 'ask');
  const legacy = { ...body }; delete legacy.userAgency;
  assert.ok(parseModuleResponse(legacy, 'viability'), 'historical records retain their declared contract');
  body.requirements[0].importance = 'preference'; body.userAgency = checkpoint();
  assert.equal(parseModuleResponse(body, 'viability', { requireUserAgency: true }).userAgency.action, 'proceed', 'a preference is not an essential dispatch stop');
});

test('format recovery accepts nullable numerical estimates and empirical integer counts', () => {
  const input = comparison();
  input.options[0].risks[0].probabilityBasis = { kind: 'empirical', rationale: 'One event in one hundred recorded trials.', source: 'Illustrative fixture sample', events: 1, trials: 100 };
  const body = response('inference', checkpoint({ input }));
  const attempt = { node: { kind: 'inference' }, pipelineVersion: 2, userAgencyVersion: 1, template: responseCycleTemplate('inference'), sources: [], challenges: [], workflowNodeIds: [] };
  const diagnostic = planningFormatDiagnostic(attempt, JSON.stringify(body), { code: 'USER_COST_RECALCULATION_REQUIRED', message: 'The proposed choice needs recalculation.' });
  assert.ok(!diagnostic.issues.some(item => /Expected .*number|Expected .*integer/.test(item.message)), 'valid cost numbers must not be mislabeled by schema recovery');
});

test('native attempt stamp is host-owned and persists a validated comparison alongside readable legacy history', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'blackice-advocacy-'));
  const store = new PlanningBrowserStore({ dataDir }); await store.init();
  t.after(async () => { await store.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const created = await store.create({ conversationId: 'advocacy-test', title: 'Check user representation', objective: 'Complete the bounded authorized work.', cwd: dataDir });
  let state = await store.addNode(created.id, { id: 'inference', kind: 'inference', title: 'Infer the requested result', prompt: 'Use the supplied task record.' });
  state = await store.recordHumanResponse(created.id, 'inference', response('inference'), { expectedNodeRevision: state.nodes[0].revision });
  assert.equal(state.responses[0].userAgencyVersion, undefined, 'legacy-shaped human history is not retroactively stamped');
  const writer = store.runtimeWriter();
  const { attempt } = await writer.beginAttempt(created.id, 'inference', { expectedNodeRevision: state.nodes[0].revision, ownerId: 'advocacy-worker' });
  assert.equal(attempt.userAgencyVersion, 1);
  assert.ok(planningModuleOutputSchema(attempt).required.includes('userAgency'));
  assert.throws(() => validatePlanningModuleResponse(attempt, response('inference')), { code: 'USER_AGENCY_REQUIRED' });
  const metadata = { runId: 'advocacy-run', executionNodeId: 'advocacy-worker' };
  await assert.rejects(writer.recordResponse(created.id, attempt.id, { output: JSON.stringify(response('inference')), metadata }), { code: 'USER_AGENCY_REQUIRED' });
  const current = response('inference', checkpoint({ input: comparison() }));
  state = await writer.recordResponse(created.id, attempt.id, { output: JSON.stringify(current), metadata });
  const latest = state.responses.at(-1);
  assert.equal(latest.userAgencyVersion, 1);
  assert.equal(latest.userAgency.decisions[0].selectedOptionId, 'proceed');
  const reread = await store.get(created.id);
  assert.equal(reread.responses.length, 2);
  assert.equal(reread.responses[0].userAgency, undefined);
  assert.equal(reread.responses[1].userAgency.action, 'proceed');
});

test('plan to think to plan projection carries recalculated comparisons with original response identity', () => {
  const cycle = { id: 'cycle', pipelineVersion: 2, title: 'Agency loop', objective: 'Complete the work.', depth: 0, stageNodeIds: { inference: 'inference', feasibility: 'feasibility', plan: 'plan', think: 'think', respond: 'respond' } };
  const earlier = { id: 'plan-response', nodeId: 'plan', revision: 1, userAgency: checkpoint({ input: comparison() }) };
  const later = { id: 'think-response', nodeId: 'think', revision: 2, userAgency: checkpoint({ input: comparison(0.4, 100), action: 'ask' }), userAgencyEvaluation: { preferredAction: 'proceed' } };
  const request = { responseCycle: { cycles: [cycle], limits: {} }, responses: [earlier, later] };
  const view = planningCycleStageContext(request, 'plan');
  assert.equal(view.userAgencyHistory.length, 2);
  const current = view.userAgencyHistory.find(item => item.stageId === 'think');
  assert.equal(current.responseId, 'think-response');
  assert.equal(current.responseRevision, 2);
  assert.equal(current.preferredAction, 'ask', 'projection ignores a fabricated cached result and recomputes raw evidence');
});

test('new native blocked review requires a numerical checkpoint, preserves cached schema12 and historical reads', () => {
  const blocked = { decision: 'blocked', summary: 'The affected action awaits its decision-changing answer.' };
  assert.ok(normalizePlanningReview(blocked));
  assert.throws(() => normalizePlanningReview(blocked, { requireUserAgency: true }), { code: 'USER_AGENCY_REQUIRED' });
  assert.throws(() => appendPlanningReview({ revision: 1, plan: {}, steps: [] }, blocked, { runId: 'run', nodeId: 'node', schemaVersion: 13 }), { code: 'USER_AGENCY_REQUIRED' });
  assert.throws(() => normalizePlanningReview({ ...blocked, userAgency: checkpoint({ input: comparison() }) }, { requireUserAgency: true }), { code: 'USER_COST_RECALCULATION_REQUIRED' });
  assert.equal(normalizePlanningReview({ ...blocked, userAgency: checkpoint({ input: comparison(0.4, 100), action: 'ask' }) }, { requireUserAgency: true }).userAgency.action, 'ask');
  const digest = 'a'.repeat(64);
  assert.doesNotThrow(() => validateSavedPlanningReviews({ planningReviews: [{ ...blocked, runId: 'run', nodeId: 'node', scopeStepId: null, reviewedRevision: 1, at: '2026-11-04T00:00:00.000Z', signature: digest, contextSignature: digest, sequenceSignature: digest }] }));
});

test('Planning Off ordinary instructions are unchanged; the On skill carries audience and quantified decision rules', () => {
  for (const guarded of [false, true]) assert.doesNotMatch(defaultPlanInstructions('detailed', 12, 'off', guarded), /userAgency|expected user cost|FIRST-PARTY BLACKICE PLANNING SKILL/);
  assert.equal(PLANNING_SKILL_VERSION, 4);
  assert.match(PLANNING_SKILL_CONTENT, /expected user cost = sum\(probability/);
  assert.match(PLANNING_SKILL_CONTENT, /maximum budget volunteered in negotiation/);
  assert.match(USER_AGENCY_GUIDANCE, /no affirmative duty to volunteer unasked weaknesses/);
  assert.match(USER_AGENCY_GUIDANCE, /Report actual task failures/);
  assert.match(USER_AGENCY_GUIDANCE, /baseline and time horizon/);
  assert.ok(USER_AGENCY_CHECKPOINT_SCHEMA.required.includes('decisionRequired'));
});
