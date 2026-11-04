import { responseCycleStage } from '../public/response-cycle-model.mjs';

// Synthetic model output for the current Inference -> Viability readiness pipeline.
// This fixture cannot claim actual effects; callers separately verify real workflow outcomes.
export function fixtureDeploymentReadiness(captured, details = 'The isolated fixture has an executable local workflow and no missing user prerequisite.') {
  const kind = captured?.module?.kind;
  if (!['inference', 'viability'].includes(kind)) throw new Error('Unexpected readiness stage: ' + kind);
  const fields = captured.template.fields;
  const task = captured.sources.find(source => source.id === 'viability:task');
  if (!task?.text?.trim()) throw new Error('The readiness fixture requires captured task evidence.');
  const sourceId = task.id;
  const result = {
    values: Object.fromEntries(fields.map(field => [field.id, field.label + ': ' + details])),
    grounding: fields.filter(field => field.grounding === 'required').map(field => ({ field: field.id, sourceId })),
    openQuestions: [],
    challengeResponses: [],
    userAgency: {
      version: 1,
      audience: 'internal',
      userBenefit: 'Check the saved fixture deployment readiness without starting operational work.',
      representation: {
        actualQuestion: 'Can the isolated fixture deployment proceed with the captured task and workflow?',
        requiredFacts: ['The captured task supplies the bounded purpose and permitted actions.'],
        relevantClaims: [details],
        privateFindings: [],
        userReport: []
      },
      action: 'proceed',
      decisionRequired: false,
      decisionReason: 'The isolated readiness fixture has a clear task, an executable local workflow and no decision-changing uncertainty.',
      decisions: [],
      chosenDecisionId: null
    }
  };
  if (kind === 'viability') return { ...result, requirements: [] };
  return {
    ...result,
    checks: responseCycleStage('inference', { pipelineVersion: captured.cycle?.pipelineVersion }).checks.map(check => ({
      id: check.id, assessment: 'supported', sourceIds: [sourceId],
      note: 'The captured fixture task supplies the bounded purpose and permitted actions.'
    })),
    subproblems: [], childResults: [], inferences: []
  };
}
