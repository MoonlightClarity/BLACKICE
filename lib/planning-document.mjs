import { USER_COST_DECISION_SCHEMA, evaluateUserCostDecision, assertUserCostChoice } from '../public/user-cost-decision.mjs';
import { USER_AGENCY_GUIDANCE, USER_AGENCY_CHECKPOINT_SCHEMA, evaluateUserAgencyCheckpoint } from '../public/planning-user-agency.mjs';
import { PLAN_CONTRACT_SCHEMA, isPlanContractTask } from '../public/planning-contract-model.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = (message, code = 'PLANNING_DOCUMENT_INVALID', status = 400) => Object.assign(new Error(message), { code, status });
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value);
const copy = value => structuredClone(value);
export const PLANNING_DOCUMENT_OPERATIONS = new Set(['assess_decision', 'agency_checkpoint']);
export const PLANNING_DOCUMENT_LIMITS = Object.freeze({ decisionInputChars: 40_000, decisionAssessmentsChars: 160_000 });
const fields = {
  assess_decision: ['type', 'decisionId', 'input', 'selectedOptionId'],
  agency_checkpoint: ['type', 'userAgency'],
};

/** This is a document contract: no provider, worker, execution permit or run is admitted. */
export function externalPlanningContract({ includeSchemas = false, state } = {}) {
  if (isPlanContractTask(state)) return {
    version: 2, taskSchemaVersion: 14, purpose: 'Edit the same saved intent contract used by the current task.',
    tool: 'blackice_edit_plan', modelExecution: false,
    edit: { operation: 'replace_contract', required: ['contract'], soleOperation: true, expectedRevision: state.revision,
      note: 'Copy and revise the saved intent contract, omitting its host planEpoch. Preserve unrelated work. A material edit updates the plan; it does not execute work, acknowledge provider delivery, or author operation receipts and outcomes.' },
    ...(includeSchemas ? { contractSchema: copy(PLAN_CONTRACT_SCHEMA) } : {}),
  };
  return {
    version: 1,
    purpose: 'Act for the user and improve their outcome while honoring their actual constraints.',
    guidance: USER_AGENCY_GUIDANCE,
    tool: 'blackice_edit_plan',
    modelExecution: false,
    canonicalEdit: { taskSchemaVersion: 14, operation: 'replace_contract', required: ['contract'], soleOperation: true, note: 'For an existing canonical work-item plan, use its exact saved revision and intent contract without host planEpoch. Legacy plans retain their declared graph operations.' },
    create: { expectedRevision: 0, operation: 'create', required: ['goal', 'steps'], optional: ['plan', 'userAgency'], soleOperation: true, existingTask: 'conflict; reread and reconcile' },
    assessDecision: { operation: 'assess_decision', required: ['decisionId', 'input'], optional: ['selectedOptionId'], savedAt: 'decisionAssessments', limits: { ...PLANNING_DOCUMENT_LIMITS }, authority: 'BLACKICE recomputes costs; a selectedOptionId must match its recommendation. Unknown estimates never automatically require asking.' },
    agencyCheckpoint: { operation: 'agency_checkpoint', required: ['userAgency'], savedAt: 'userAgency', computedAt: 'userAgencyEvaluation' },
    ...(includeSchemas ? { decisionInputSchema: copy(USER_COST_DECISION_SCHEMA), userAgencySchema: copy(USER_AGENCY_CHECKPOINT_SCHEMA) } : {}),
  };
}

/** Extract only the extra document operations, leaving the canonical graph editor intact. */
export function applyPlanningDocumentOperations(state, value, options = {}) {
  if (!object(value) || Object.keys(value).some(key => key !== 'operations') || !Array.isArray(value.operations) || !value.operations.length || value.operations.length > 100)
    throw fail('Supply from 1 to 100 plan edit operations.');
  const operations = [], next = copy(state);
  for (const operation of value.operations) {
    if (!object(operation) || !PLANNING_DOCUMENT_OPERATIONS.has(operation.type)) { operations.push(operation); continue; }
    if (options.scopeStepId) throw fail('A scoped worker cannot replace the shared user-agency decision.', 'TASK_PLAN_OWNERSHIP', 403);
    if (Object.keys(operation).some(key => !fields[operation.type].includes(key))) throw fail('Use only the declared fields for ' + operation.type + '.');
    if (operation.type === 'agency_checkpoint') {
      const evaluated = evaluateUserAgencyCheckpoint(operation.userAgency, { required: true });
      next.userAgency = copy(evaluated.checkpoint);
      next.userAgencyEvaluation = copy(evaluated);
      continue;
    }
    if (!identifier(operation.decisionId)) throw fail('Use a stable decisionId of at most 120 identifier characters.');
    const selectedOptionId = operation.selectedOptionId ?? null;
    if (selectedOptionId !== null && !identifier(selectedOptionId)) throw fail('Choose the saved option identifier or omit selectedOptionId.');
    const serializedInput = JSON.stringify(operation.input);
    if (!serializedInput || serializedInput.length > PLANNING_DOCUMENT_LIMITS.decisionInputChars) throw fail('A decision input must fit within 40,000 JSON characters. Keep the concrete options and material evidence concise.', 'PLANNING_DECISION_LIMIT', 413);
    const evaluation = selectedOptionId === null ? evaluateUserCostDecision(operation.input) : assertUserCostChoice(operation.input, selectedOptionId);
    const assessment = {
      id: operation.decisionId, input: copy(operation.input), selectedOptionId, evaluation: copy(evaluation),
      updatedAt: new Date().toISOString(),
      author: { source: options.source || 'agent', ...(options.actor ? { actor: copy(options.actor) } : {}) },
    };
    const assessments = Array.isArray(next.decisionAssessments) ? [...next.decisionAssessments] : [];
    const index = assessments.findIndex(item => item.id === assessment.id);
    if (index < 0) assessments.push(assessment); else assessments[index] = assessment;
    if (assessments.length > 32) throw fail('Keep at most 32 current decision assessments; revise a stable decisionId when its evidence changes.', 'TASK_STATE_LIMIT', 413);
    if (JSON.stringify(assessments).length > PLANNING_DOCUMENT_LIMITS.decisionAssessmentsChars) throw fail('Current decision inputs and computed assessments exceed 160,000 JSON characters. Shorten the current assessments while preserving material evidence; earlier revisions remain in history.', 'PLANNING_DECISION_LIMIT', 413);
    next.decisionAssessments = assessments;
  }
  return { state: next, operations };
}

/** Recalculate projections from authored inputs, never from caller-supplied totals. */
export function projectPlanningDocument(state) {
  const result = copy(state);
  if (result.userAgency !== undefined) result.userAgencyEvaluation = evaluateUserAgencyCheckpoint(result.userAgency, { required: true });
  if (result.decisionAssessments !== undefined) result.decisionAssessments = result.decisionAssessments.map(item => ({
    ...item,
    evaluation: item.selectedOptionId == null ? evaluateUserCostDecision(item.input) : assertUserCostChoice(item.input, item.selectedOptionId),
  }));
  return result;
}

export function validateSavedPlanningDocument(state) {
  if (state.standalonePlan !== undefined) {
    const item = state.standalonePlan;
    if (!object(item) || item.version !== 1 || item.kind !== 'standalone' || !object(item.createdBy) ||
        !['external-agent', 'human'].includes(item.createdBy.source) || !identifier(item.createdBy.actor?.id) ||
        !['external-agent', 'human-client'].includes(item.createdBy.actor?.type))
      throw fail('Saved standalone planning metadata is damaged.', 'TASK_STATE_DAMAGED', 500);
  }
  if (state.decisionAssessments !== undefined) {
    if (!Array.isArray(state.decisionAssessments) || state.decisionAssessments.length > 32 ||
        new Set(state.decisionAssessments.map(item => item?.id)).size !== state.decisionAssessments.length ||
        state.decisionAssessments.some(item => !object(item) || !identifier(item.id) || item.selectedOptionId !== null && !identifier(item.selectedOptionId)))
      throw fail('Saved user-cost assessments are damaged.', 'TASK_STATE_DAMAGED', 500);
  }
  if (state.userAgency !== undefined || state.decisionAssessments !== undefined) {
    try { projectPlanningDocument(state); }
    catch { throw fail('Saved user-agency decision inputs are damaged. Existing files were preserved.', 'TASK_STATE_DAMAGED', 500); }
  }
}
