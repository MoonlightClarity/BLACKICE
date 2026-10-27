/** A projection of recorded Planning work, not another execution engine.
 * A successful operation never implies that an analytical claim is supported.
 * Only authored stepType, dependsOn and artifactIds create typed relationships.
 */
export const PLANNING_ONTOLOGY_VERSION = 1;

const analytical = [
  ['analytic_question', 'Analytical question'],
  ['hypothesis_test', 'Hypothesis test'],
  ['evidence_evaluation', 'Evidence evaluation'],
  ['analytic_comparison', 'Analytical comparison'],
  ['analytic_judgment', 'Analytical judgment'],
  ['assumption_check', 'Assumption test'],
  ['information_quality', 'Information quality'],
  ['competing_hypotheses', 'Competing explanations'],
  ['contrarian_review', 'Contrarian challenge'],
  ['outside_in', 'Outside-in assessment'],
  ['indicators', 'Indicators'],
  ['decision_test', 'Decision test'],
  ['analyze', 'Analysis'],
  ['decide', 'Decision'],
];
const technical = [
  ['technical_method', 'Technical method'],
  ['technical_operation', 'Technical operation'],
  ['technical_verification', 'Technical verification'],
  ['collect', 'Collection'],
  ['create', 'Creation'],
];
const types = new Map([...analytical.map(([id, label]) => [id, { domain: 'analytical', label }]),
  ...technical.map(([id, label]) => [id, { domain: 'technical', label }])]);

export const PLANNING_ONTOLOGY = Object.freeze({
  version: PLANNING_ONTOLOGY_VERSION,
  domains: Object.freeze(['analytical', 'technical', 'unclassified']),
  analytical: Object.freeze(analytical.map(([id, label]) => Object.freeze({ id, label }))),
  technical: Object.freeze(technical.map(([id, label]) => Object.freeze({ id, label }))),
  relations: Object.freeze([
    'depends_on', 'contains', 'links_artifact'
  ]),
  meaning: 'Tasks and observations are separate. A completed technical action is not evidence for an analytical conclusion unless the analyst supplies and evaluates that evidence.'
});

export function projectPlanningOntology(saved = {}) {
  const steps = Array.isArray(saved.steps) ? saved.steps : [];
  const nodes = steps.filter(step => step && typeof step.id === 'string'
    && (step.kind || 'action') === 'action').map(step => {
    const type = types.get(step.stepType) || null;
    return {
      id: step.id, title: String(step.title || step.id), stepType: step.stepType || null,
      domain: type?.domain || 'unclassified', label: type?.label || 'Unclassified work',
      status: step.status || 'pending', result: step.result || null,
      doneWhen: step.doneWhen || null, evidence: step.evidence || null,
      dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn : [],
      artifactIds: Array.isArray(step.artifactIds) ? step.artifactIds : [],
    };
  });
  const allIds = new Set(steps.map(step => step?.id).filter(Boolean));
  const edges = [];
  for (const step of steps) {
    if (!step || !allIds.has(step.id)) continue;
    if (step.parentId && allIds.has(step.parentId))
      edges.push({ kind: 'contains', from: step.parentId, to: step.id });
    for (const dependency of step.dependsOn || []) if (allIds.has(dependency))
      edges.push({ kind: 'depends_on', from: step.id, to: dependency });
    for (const artifactId of step.artifactIds || [])
      edges.push({ kind: 'links_artifact', from: step.id, to: artifactId });
  }
  const lanes = Object.fromEntries(PLANNING_ONTOLOGY.domains.map(domain =>
    [domain, nodes.filter(node => node.domain === domain)]));
  return { version: PLANNING_ONTOLOGY_VERSION, nodes, edges, lanes,
    note: 'Only recorded step types and explicit saved relationships are shown. A tool receipt, checked box, or operational success does not establish an analytical judgment.' };
}
