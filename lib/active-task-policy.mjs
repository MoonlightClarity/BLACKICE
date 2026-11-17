import { planningOntologyInstructions, PLANNING_ONTOLOGY_MODULES } from '../public/planning-module-policy.mjs';

// Effective admitted run state, never mutable app defaults or model-supplied policy.
// Returned only by actual read operations; not injected into prompts or schemas.
export function activeTaskPolicy(run) {
  const planningOntology = run?.planningOntology ? structuredClone(run.planningOntology) : null;
  return {
    source: 'admitted-run',
    runId: run?.id || null,
    planningMode: run?.planningMode || 'off',
    planningOntology,
    enabledModules: PLANNING_ONTOLOGY_MODULES.filter(({id})=>id!=='subagents'&&planningOntology?.modules?.[id]===true).map(({id})=>id),
    disabledModules: PLANNING_ONTOLOGY_MODULES.filter(({id})=>id!=='subagents'&&planningOntology?.modules?.[id]!==true).map(({id})=>id),
    instructions: planningOntology ? planningOntologyInstructions(planningOntology)
      : 'All Planning method modules are Off for this admitted run. No modular policy was admitted. Do not enable defaults implicitly. Ordinary tools and delegation retain their own availability and permissions.',
  };
}
