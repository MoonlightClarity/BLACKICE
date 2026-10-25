const member = (id, name, role, prompt, x, y, model, assignment) => ({ id, type: 'agent', name, role, prompt, x, y, model, effort: 'default', assignment });
const text = (value, label, max = 1000) => { if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`${label} needs nonempty text of at most ${max} characters.`); return value.trim(); };

export function swarmAssignments({ members = 3, pattern = 'research' } = {}) {
  const count = Number(members); if (!Number.isSafeInteger(count) || count < 1) throw new Error('Choose a positive whole number of specialists.');
  if (count > 99) throw new Error('A shared swarm supports at most 99 specialists: each worker and coordinator needs an ownership branch and action within the 200-step saved plan.');
  const research = [
    ['Evidence', 'Researcher', 'Investigate the original task using actual sources and workspace tools. Gather evidence and distinguish assumptions.', 'A sourced evidence record with relevant findings and precise uncertainties.', 'The central claims have inspected sources, with unsupported assumptions called out.'],
    ['Independent challenge', 'Critic', 'Independently investigate the task. Seek counterexamples, missing evidence and failure modes.', 'A concrete challenge to the proposed approach, supported by actual evidence.', 'The highest-impact failure modes and counterexamples have been investigated and explained.'],
    ['Practical approach', 'Strategist', 'Investigate practical options, constraints and execution steps for the original task.', 'A practical recommendation with prerequisites, tradeoffs and actionable steps.', 'The recommended approach accounts for observed constraints and the original goal.'],
    ['Cross-check', 'Fact checker', 'Independently verify the task premises and likely conclusions using actual tools.', 'A cross-check of material claims and any unresolved uncertainties.', 'Material claims are traced to inspected evidence and remaining uncertainty is explicit.'],
  ];
  const delivery = [
    ['Implement the change', 'Implementation owner', 'Implement the workspace changes requested by the original task. Inspect relevant files first, preserve unrelated work, and coordinate overlapping work with other specialists.', 'The requested implementation, changed-file list, and results of focused checks.', 'The requested behavior is implemented within the assigned scope and checked with real evidence; any limits are reported.'],
    ['Verification strategy', 'Verifier', 'Independently inspect requirements and relevant workspace behavior. Design concrete checks and investigate critical failure modes. Read existing evidence; do not claim a concurrently changing implementation has passed until it was actually checked.', 'Focused verification cases and an independent assessment of likely failures.', 'The key behaviors, failure paths and acceptance criteria have concrete reproducible checks.'],
    ['Integration review', 'Integrator', 'Inspect dependency boundaries, interfaces and compatibility constraints for the original task. Investigate integration risks and coordinate changes with the relevant specialists.', 'A concise integration review with exact interfaces, prerequisites and risks.', 'The affected interfaces and practical integration constraints have been inspected.'],
    ['User experience', 'Product reviewer', 'Inspect how the task affects the person using the product. Identify concrete usability requirements and edge cases.', 'An evidence-based usability review and acceptance criteria.', 'The important user flows and edge cases have been inspected and described.'],
  ];
  const set = pattern === 'delivery' ? delivery : research;
  return Array.from({ length: count }, (_, index) => {
    const [title, role, scope, result, doneWhen] = set[index % set.length], repeat = Math.floor(index / set.length);
    return { id: `specialist-${index + 1}`, name: repeat ? `${title} ${repeat + 1}` : title, role, scope: repeat && index % set.length === 0 && pattern === 'delivery' ? 'Independently investigate the implementation approach and address a distinct risk or improvement, coordinating overlapping work with the other specialists.' : scope, inputs: ['Original task and supplied context', 'Relevant workspace files and sources'], result, doneWhen };
  });
}

/** Workers progress within saved scopes before the final integration owner runs. */
export function createSwarmWorkflow({ id, name = 'Specialist swarm', cwd = '', model = 'default', members = 3, pattern = 'research', assignments } = {}) {
  const defaults = swarmAssignments({ members, pattern }), count = defaults.length;
  if (assignments !== undefined && (!Array.isArray(assignments) || assignments.length !== count)) throw new Error('Supply one assignment for every specialist.');
  const scoped = defaults.map((entry, index) => {
    const supplied = assignments?.[index]; if (!supplied) return entry;
    if(typeof supplied!=='object'||Array.isArray(supplied))throw new Error('Supply a concrete assignment for every specialist.');
    const values = { ...entry, ...supplied, id: entry.id, name: entry.name, role: entry.role };
    values.scope = text(values.scope, `${entry.name} scope`, 3000); values.result = text(values.result, `${entry.name} expected result`); values.doneWhen = text(values.doneWhen, `${entry.name} done criterion`);
    if (!Array.isArray(values.inputs) || values.inputs.length > 200) throw new Error('Use at most 200 required inputs per specialist.');
    values.inputs = values.inputs.map(value => text(value, `${entry.name} input`, 1000)); return values;
  });
  const workers = scoped.map((entry, index) => {
    // UI identity belongs to the worker node. Other saved assignment metadata is
    // retained without changing the worker's ordinary runtime capabilities.
    const {id:workerId,name:workerName,role:workerRole,...metadata}=entry;
    const assignment=structuredClone(metadata);
    const prompt = `Work within this saved assignment.\nScope: ${assignment.scope}\nRequired inputs:\n${assignment.inputs.map(value => `- ${value}`).join('\n')}\nExpected result: ${assignment.result}\nDone when: ${assignment.doneWhen}\nStart when your actual prerequisites are satisfied. You do not need a coordinator message to inspect inputs, refine your own plan, or carry out assigned work. Record the steps and progress inside your owned branch. Do not replace siblings or the shared task objective. Report missing inputs as specific blockers, with what is needed. Final external actions and their receipts belong to the coordinator.`;
    return member(workerId, workerName, workerRole, prompt, 340, 40 + index * 190, model, assignment);
  });
  const assignment = { scope: 'Integrate the specialist handoffs into the original requested result. Resolve conflicts, verify the final outcome, and own any explicitly authorized external action and its receipt.', inputs: workers.map(worker => `Completed handoff from ${worker.name}`), result: 'The integrated answer or deliverable with actual verification and any external-action receipts.', doneWhen: 'The original request is satisfied, important claims and deliverables are checked, and material limits are stated.' };
  const owner = member('coordinator', pattern === 'delivery' ? 'Integrate & verify' : 'Synthesize & verify', 'Swarm coordinator', `Read every specialist result and inspect the actual workspace. ${pattern === 'delivery' ? 'Integrate their completed implementation, make necessary integration changes, and verify the original requested behavior.' : 'Resolve disagreement using actual evidence and answer the original task. Do not treat consensus as verification.'} Register real deliverables with relay_task. You own final external actions and receipts; perform only actions authorized by the original task. Workers progress in their own branches while you wait for their inputs. Reconcile saved evidence without replacing completed worker plans.`, 680, 150, model, assignment);
  return { id, name, description: `${count} independent specialists with explicit scopes and a final integration owner.`, version: 1, planning: { shared: true, coordinatorNodeId: 'coordinator' }, nodes: [{ id: 'input', type: 'input', name: 'Task', x: 40, y: 150 }, ...workers, owner, { id: 'output', type: 'output', name: 'Checked result', x: 1020, y: 150 }], edges: [...workers.map(node => ({ id: `in-${node.id}`, source: 'input', target: node.id })), ...workers.map(node => ({ id: `out-${node.id}`, source: node.id, target: owner.id })), { id: 'result', source: owner.id, target: 'output' }], settings: { cwd, maxParallel: count } };
}

/** Preview the same tree/DAG structure before a run has execution receipts. */
export function swarmWorkflowPlan(workflow) {
  const agents = (workflow?.nodes || []).filter(node => node.type === 'agent'), ids = new Set(agents.map(node => node.id)), steps = [];
  for (const node of agents) {
    const scopeStepId = `agent-${node.id}`, assignment = node.assignment || {};
    steps.push({ id: scopeStepId, title: node.name, kind: 'sequence', parentId: null, status: 'pending', dependsOn: (workflow.edges || []).filter(edge => edge.target === node.id && ids.has(edge.source)).map(edge => `agent-${edge.source}`), note: assignment.scope || node.prompt || '', result: assignment.result || '' });
    steps.push({ id: `${scopeStepId}-work`, title: assignment.result || node.name, kind: 'action', parentId: scopeStepId, status: 'pending', dependsOn: [], doneWhen: assignment.doneWhen || 'The assigned work has a checked result.', note: Array.isArray(assignment.inputs)&&assignment.inputs.length?'Required inputs:\n'+assignment.inputs.map(value=>'- '+value).join('\n'):'' });
  }
  return { taskId: `preview-${workflow.id || 'swarm'}`, revision: 0, goal: workflow.name || 'Specialist swarm', planVersion: 1, plan: { layout: 'parallel', detail: 'balanced', origin: 'runtime' }, steps };
}
