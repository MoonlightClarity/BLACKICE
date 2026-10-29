import { normalizeTaskPlan, TASK_PLAN_LIMITS } from './task-plan.mjs';
import { validateMethodCatalog } from './method-catalog.mjs';
import { CATALYST_METHODS } from './catalyst-methods.mjs';
import { DOCUMENT_ANALYSIS_STAGES } from './document-analysis-policy.mjs';

// BLACKICE's original, small process vocabulary. Types describe work; they do
// not grant tools, select a model, or create a second execution engine.
const type = (kind, id, name, description) => ({ id, kind, name, description, origin: 'builtin', revision: 1, createdAt: null, updatedAt: null });
export const BUILTIN_TASK_TYPES = Object.freeze([
  type('task', 'general', 'General task', 'Produce a concrete result with explicit checks.'),
  type('task', 'research', 'Research', 'Find and evaluate information to answer a focused question.'),
  type('task', 'analysis', 'Analysis', 'Inspect evidence or data and explain what it supports.'),
  type('task', 'decision', 'Decision', 'Compare alternatives against stated criteria and uncertainty.'),
  type('task', 'software', 'Software', 'Investigate, implement and test a bounded software change.'),
  type('task', 'writing', 'Writing', 'Create a document for a defined reader and purpose.'),
  type('task', 'planning', 'Planning', 'Turn an outcome into an inspectable sequence of work.')
]);
export const BUILTIN_STEP_TYPES = Object.freeze([
  type('step', 'scope', 'Define the scope', 'Establish the goal, constraints and observable success conditions.'),
  type('step', 'collect', 'Gather material', 'Find relevant inputs and record their source and limitations.'),
  type('step', 'analyze', 'Analyze', 'Develop findings from the available material and test assumptions.'),
  type('step', 'decide', 'Choose an approach', 'Make a reasoned choice with alternatives and tradeoffs visible.'),
  type('step', 'create', 'Create or change', 'Produce the requested artifact or bounded change.'),
  type('step', 'check', 'Check the result', 'Inspect the actual result against specific criteria.'),
  // Optional analytic techniques, not required stages or a prescribed order.
  type('step', 'assumption_check', 'Key assumptions check', 'Identify a necessary premise, test its basis and what would overturn it; revisit when the assessment changes.'),
  type('step', 'information_quality', 'Information quality', 'Assess evidence provenance, independence, missingness and what remains unverified.'),
  type('step', 'competing_hypotheses', 'Competing explanations', 'Compare evidence against all plausible explanations, emphasizing disconfirming and discriminating observations.'),
  type('step', 'contrarian_review', 'Contrarian challenge', 'Challenge the leading interpretation using a credible rival and its strongest evidence.'),
  type('step', 'outside_in', 'Outside-in perspective', 'Examine relevant external forces and contextual factors without inventing them.'),
  type('step', 'indicators', 'Indicators and signposts', 'Identify observations that would distinguish explanations as new information emerges.'),
  type('step', 'decision_test', 'Action assumption test', 'Connect any proposed intervention to the user decision, pivotal assumption, evidence, feasibility, mechanism and observable result.'),
  type('step', 'handoff', 'Prepare the handoff', 'Make the result easy to use, with evidence and unresolved issues.'),
  // Analytic questions and judgments are distinct from collecting data or
  // executing a procedure. Neither lane inherits completion from the other.
  type('step', 'analytic_question', 'Analytical question', 'State a material uncertainty whose answer could change the finding, decision or action.'),
  type('step', 'hypothesis_test', 'Hypothesis test', 'Compare discriminating predictions of competing explanations using recorded evidence.'),
  type('step', 'evidence_evaluation', 'Evidence evaluation', 'Evaluate provenance, independence, contradictions and claim-relevant support.'),
  type('step', 'analytic_comparison', 'Analytical comparison', 'Compare serious alternatives at common scope and relevant criteria.'),
  type('step', 'analytic_judgment', 'Analytical judgment', 'State an inference bounded by evidence, rivals, uncertainty and change indicators.'),
  type('step', 'technical_method', 'Technical method', 'Specify a reproducible information-gathering or execution procedure, inputs and limitations.'),
  type('step', 'technical_operation', 'Technical operation', 'Execute a real tool action and record its observed result; no analytical conclusion is implied.'),
  type('step', 'technical_verification', 'Technical verification', 'Check actual output, state and execution effects without treating technical success as evidentiary proof.'),
  ...DOCUMENT_ANALYSIS_STAGES.map(stage => type('step', stage.stepType, stage.label, stage.intent))
]);
const input = (id, label, description, required = false) => ({ id, label, description, required });
const step = (id, title, type, instructions, inputs, result, checks) => ({ id, title, type, instructions, inputs, result, checks });
const method = (id, name, description, taskType, inputs, steps) => ({ id, revision: 1, origin: 'builtin', verification: 'unverified', name, description, taskType, inputs, steps, createdAt: null, updatedAt: null });
export const BUILTIN_METHODS = Object.freeze([
  method('research-brief', 'Research a question', 'Move from a focused question to a sourced brief with visible evidence gaps.', 'research', [input('materials', 'Starting material', 'Relevant links, local documents or known sources.'), input('audience', 'Reader and constraints', 'Who will use the answer, required date range and useful format.')], [
    step('scope', 'Define the question and evidence needs', 'scope', 'Write a brief research scope in the working folder. Translate the goal into answerable questions, state constraints, and specify what evidence would answer each question.', ['Project goal', 'Starting material', 'Reader and constraints'], 'A saved research scope with questions and evidence requirements.', ['The scope identifies the question, intended reader and boundaries.', 'Each question has a concrete evidence requirement and unresolved assumptions are listed.']),
    step('gather', 'Collect and assess sources', 'collect', 'Gather relevant material using the available authorized tools. Prefer direct sources. Save a source list with dates, location, relevance and limitations; record inaccessible material explicitly.', ['Reviewed research scope', 'Starting material'], 'A source register and evidence notes in the working folder.', ['Material claims in the evidence notes identify their source.', 'Source dates, relevance and material gaps are recorded without treating inaccessible sources as read.']),
    step('synthesize', 'Write the brief', 'analyze', 'Answer the scoped questions using the saved evidence. Separate observations, interpretation and uncertainty. Save a concise brief and source references in the working folder.', ['Reviewed source register', 'Reviewed research scope'], 'A sourced research brief that answers the questions.', ['Each scoped question has an answer or an explicit evidence gap.', 'The brief cites supporting material and explains contradictions and uncertainty.']),
    step('handoff', 'Prepare a usable handoff', 'handoff', 'Inspect the brief and references, check that the saved files are accessible, and produce a short handoff with file locations, key findings and limitations.', ['Reviewed research brief'], 'A handoff with the result files and remaining questions.', ['The handoff identifies the actual saved deliverable and its main findings.', 'Remaining evidence gaps and useful follow-up questions are stated.'])
  ]),
  method('compare-options', 'Compare options and recommend', 'Make a decision traceable to criteria, evidence and tradeoffs.', 'decision', [input('options', 'Options', 'The alternatives to compare, one per line.', true), input('constraints', 'Decision constraints', 'Budget, timing, required features or other nonnegotiable conditions.')], [
    step('criteria', 'Define decision criteria', 'scope', 'Save the decision context, alternatives, constraints and measurable criteria. Explain the relative importance of the criteria without inventing stakeholder preferences.', ['Project goal', 'Options', 'Decision constraints'], 'A decision brief with criteria and explicit assumptions.', ['Every supplied option and constraint is represented.', 'The criteria are comparable and assumed preferences are labeled.']),
    step('compare', 'Compare the evidence', 'analyze', 'Gather the available evidence for each option and build a comparison table against the agreed criteria. Cite sources or local records and mark unknown values.', ['Reviewed decision brief'], 'An evidence-backed comparison table.', ['Every option is compared against the same criteria.', 'Unknown values and evidence sources are visible.']),
    step('recommend', 'Make the recommendation', 'decide', 'Save a recommendation that follows from the comparison. Explain the strongest alternative, tradeoffs and what new information would change the decision.', ['Reviewed comparison table'], 'A recommendation with alternatives and decision triggers.', ['The recommendation follows the documented criteria and evidence.', 'Tradeoffs, uncertainty and conditions that would change the recommendation are explicit.'])
  ]),
  method('software-feature', 'Build a software change', 'Scope, implement and check a feature in the existing project.', 'software', [input('requirements', 'Requirements', 'Expected behavior, examples and constraints.'), input('area', 'Relevant code or files', 'Paths or components to inspect first.')], [
    step('inspect', 'Inspect the current behavior', 'scope', 'Read the relevant code, existing checks and project instructions. Save a bounded implementation plan describing the required behavior, affected components and meaningful validation.', ['Project goal', 'Requirements', 'Relevant code or files'], 'An implementation plan grounded in the current source.', ['The plan identifies the current behavior and specific desired change.', 'The proposed checks cover the changed behavior and material compatibility risks.']),
    step('implement', 'Implement the change', 'create', 'Implement the scoped change using the existing project conventions. Keep unrelated work intact. Run the meaningful checks from the plan and record actual results.', ['Reviewed implementation plan'], 'The implemented change with focused checks.', ['The resulting behavior matches the scoped requirements.', 'Relevant checks were run and their results or concrete blockers are recorded.']),
    step('validate', 'Check the integrated result', 'check', 'Exercise the integrated user or API path and inspect the resulting changes. Resolve concrete defects within the saved scope, then save a validation report.', ['Reviewed implementation and checks'], 'An integration validation report.', ['The main changed flow is exercised end to end using the available environment.', 'The validation report distinguishes passing checks, limitations and remaining defects.']),
    step('handoff', 'Explain the change', 'handoff', 'Prepare a handoff describing the changed behavior, relevant files, actual validation and remaining limits. Follow the project instructions for any requested delivery action.', ['Reviewed change and validation report'], 'A clear change handoff.', ['The handoff states what changed and how to use it.', 'Validation claims match recorded checks and unresolved limits are visible.'])
  ]),
  method('debug-repair', 'Find and fix a defect', 'Reproduce a problem, locate its cause and verify the repair.', 'software', [input('symptom', 'Observed problem', 'Error, reproduction steps or observed versus expected behavior.', true)], [
    step('reproduce', 'Establish the failure', 'collect', 'Reproduce the reported issue if possible. Save exact steps, the observed result and expected behavior. If reproduction is unavailable, identify the specific missing condition and inspect the available evidence.', ['Project goal', 'Observed problem'], 'A reproducible failure case or a precise evidence report.', ['The report identifies expected and observed behavior.', 'The reproduction or unavailable condition is supported by actual observations.']),
    step('cause', 'Identify the cause', 'analyze', 'Trace the failure through the relevant code or system behavior. Save the supported cause and a bounded repair plan; distinguish evidence from hypotheses.', ['Reviewed failure case'], 'A cause analysis and repair plan.', ['The proposed cause is tied to the recorded failure evidence.', 'The repair plan names the affected behavior and a check that would detect regression.']),
    step('repair', 'Repair and verify', 'create', 'Apply the bounded repair and run the reproduction plus meaningful regression checks. Record the results and any remaining limitation.', ['Reviewed cause analysis and repair plan'], 'A repaired result and verification report.', ['The original failure case is rechecked after the repair.', 'Relevant regression checks and any remaining failures are reported accurately.'])
  ]),
  method('evidence-analysis', 'Test an explanation', 'Compare an explanation with alternatives and diagnostic evidence.', 'analysis', [input('claim', 'Explanation to examine', 'The claim, hypothesis or assumption to test.', true), input('evidence', 'Available evidence', 'Documents, observations or data locations.')], [
    step('alternatives', 'Define alternatives', 'scope', 'Save the explanation being examined and plausible alternatives. Specify what observations would distinguish them and which assumptions matter.', ['Project goal', 'Explanation to examine'], 'An explicit set of explanations and discriminating questions.', ['The original explanation and plausible alternatives are represented fairly.', 'The analysis identifies evidence that could distinguish the alternatives.']),
    step('assess', 'Assess support and contradictions', 'analyze', 'Compare the available evidence against each explanation. Record sources, contradictions, absent evidence and dependencies between sources.', ['Reviewed explanations', 'Available evidence'], 'An evidence comparison with uncertainty visible.', ['Evidence is linked to its source and compared across the explanations.', 'Contradictions, missing observations and source dependencies are explicit.']),
    step('conclude', 'State a bounded conclusion', 'decide', 'Save the conclusion justified by the evidence, remaining uncertainty, and observations that would lead to a revision.', ['Reviewed evidence comparison'], 'A reasoned conclusion and reassessment conditions.', ['The conclusion follows the saved evidence comparison.', 'Unresolved uncertainty and conditions for changing the conclusion are stated.'])
  ]),
  method('data-analysis', 'Analyze a dataset', 'Inspect data quality before drawing reproducible conclusions.', 'analysis', [input('dataset', 'Dataset location', 'A local path or authorized source for the data.', true), input('questions', 'Analysis questions', 'Specific comparisons, measures or outcomes to investigate.')], [
    step('inspect', 'Inspect the data and question', 'collect', 'Read the data and identify its shape, units, provenance, missing values and limitations. Save the analysis questions and a data-quality note.', ['Project goal', 'Dataset location', 'Analysis questions'], 'A dataset profile and scoped questions.', ['The profile reports observed structure, units and material quality issues.', 'The scoped questions can be investigated with the available data or their gaps are identified.']),
    step('analyze', 'Run a reproducible analysis', 'analyze', 'Perform the scoped analysis with suitable tools. Preserve code or calculations, assumptions and resulting tables or charts in the working folder.', ['Reviewed dataset profile'], 'Reproducible calculations and results.', ['The saved calculations can be traced to the supplied data.', 'Assumptions, transformations and significant limitations are documented.']),
    step('report', 'Explain the findings', 'handoff', 'Check the outputs against the saved calculations and write a report answering the scoped questions. Separate observed patterns from causal claims and uncertainty.', ['Reviewed calculations and results'], 'A checked analysis report and source artifacts.', ['The report answers the scoped questions with the recorded results.', 'Charts or tables use clear labels and the conclusions respect the data limitations.'])
  ]),
  method('document-draft', 'Write and refine a document', 'Create a useful document from purpose, source material and a review pass.', 'writing', [input('reader', 'Reader and purpose', 'Who needs the document and what it should help them do.', true), input('materials', 'Source material', 'Facts, notes, references or files to draw on.')], [
    step('outline', 'Plan the document', 'scope', 'Save an outline grounded in the goal, reader and source material. Identify the necessary claims, structure, format and missing information.', ['Project goal', 'Reader and purpose', 'Source material'], 'An outline and source plan.', ['The outline is suited to the intended reader and purpose.', 'Required claims and any missing information are identified.']),
    step('draft', 'Write the draft', 'create', 'Write the document using the reviewed outline. Support factual claims with the supplied or verified material, and preserve the requested format.', ['Reviewed outline and source plan'], 'A complete saved draft.', ['The draft covers the reviewed outline and intended purpose.', 'Material factual claims have support or are clearly marked as unresolved.']),
    step('refine', 'Refine and hand off', 'check', 'Review clarity, consistency, factual support and formatting. Make the needed revisions and provide the saved document with a concise handoff.', ['Reviewed draft'], 'A refined document and handoff.', ['The saved document has been checked for consistency, support and readable formatting.', 'The handoff identifies the actual deliverable and any unresolved content.'])
  ]),
  method('delivery-plan', 'Plan a substantial goal', 'Turn an outcome into bounded work, dependencies and milestones.', 'planning', [input('constraints', 'Resources and constraints', 'People, tools, deadlines, dependencies or limits.')], [
    step('outcome', 'Define the outcome', 'scope', 'Save the desired outcome, boundaries, known constraints and observable success conditions. Identify what is known and what still needs an answer.', ['Project goal', 'Resources and constraints'], 'An outcome brief.', ['The outcome and success conditions are concrete.', 'Boundaries, constraints and unresolved questions are visible.']),
    step('decompose', 'Break down the work', 'analyze', 'Prepare an ordered plan of bounded tasks. Describe each task input, result, check and dependencies. Include milestones and clearly labeled ownership assumptions.', ['Reviewed outcome brief'], 'A detailed delivery plan in the working folder.', ['Each planned task has a defined result and checkable success conditions.', 'Dependencies and milestones cover the outcome without circular ordering.']),
    step('review', 'Check the plan and next action', 'check', 'Review the plan for missing prerequisites, ambiguous results and timing or access constraints. Save a refined plan with a clear next action. Do not execute the planned downstream work in this planning task.', ['Reviewed delivery plan'], 'A reviewed plan ready for an explicit execution decision.', ['The refined plan addresses missing prerequisites and material risks.', 'The next action is explicit and downstream execution has not been claimed from planning alone.'])
  ]),
  ...CATALYST_METHODS
]);

export const METHOD_LIMITS = Object.freeze({ methods: 100, types: 100, steps: 50, outlineNodes: TASK_PLAN_LIMITS.nodes, outlineChars: TASK_PLAN_LIMITS.stateChars, inputs: 20, bytes: 8 * 1024 * 1024 });
const fail = message => Object.assign(new Error(message), { status: 400, code: 'METHOD_ERROR' });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export const methodText = (value, label, max, required = true) => {
  if (typeof value !== 'string' || value.includes('\0') || value.length > max || required && !value.trim()) throw fail(`${label} must be ${required ? 'nonempty ' : ''}text of at most ${max} characters.`);
  return value.trim();
};
export const methodId = (value, label = 'Identifier') => { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw fail(`${label} must contain 1 to 100 letters, numbers, underscores or hyphens.`); return value; };
const list = (value, label, min, max = 20, length = 1000) => {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw fail(`${label} needs ${min} to ${max} entries.`);
  const result = value.map(item => methodText(item, label, length)); if (new Set(result).size !== result.length) throw fail(`${label} must not contain duplicates.`); return result;
};
const knownFields = (value, allowed, label) => {
  const unknown = Object.keys(value).find(key => !allowed.includes(key));
  if (unknown) throw fail(`Unsupported ${label} field: ${unknown}.`);
};
const outlineStepFields = ['id', 'title', 'parentId', 'kind', 'dependsOn', 'condition', 'stepType', 'result', 'doneWhen', 'branch', 'operation'];
const outlineId = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value)) throw fail('An outline step ID must contain 1 to 120 letters, numbers, underscores or hyphens and begin with a letter or number.');
  return value;
};

/** Reusable structure has no execution state or previously selected branch. */
export function validateMethodOutline(value, ontology) {
  if (!object(value)) throw fail('A method outline must be an object with layout and steps.');
  knownFields(value, ['layout', 'steps', 'branch', 'facts'], 'method outline');
  if (!['sequence', 'parallel', 'choice'].includes(value.layout)) throw fail('Method outline layout must be sequence, parallel or choice.');
  if (!Array.isArray(value.steps) || !value.steps.length || value.steps.length > METHOD_LIMITS.outlineNodes) throw fail(`A method outline needs 1 to ${METHOD_LIMITS.outlineNodes} nodes.`);
  for (const step of value.steps) {
    if (!object(step)) throw fail('Every method outline node must be an object.');
    knownFields(step, outlineStepFields, 'method outline node');
    outlineId(step.id);
    if (step.stepType !== undefined && ontology && !ontology.stepTypes.some(item => item.id === step.stepType)) throw fail('Choose a saved step type, or create the step type first.');
  }
  // Validate the complete hierarchy and dependencies with the live plan's own
  // semantics. Pending state exists only during validation and is not saved.
  if (value.facts !== undefined && (!Array.isArray(value.facts) || value.facts.some(fact => !object(fact) || fact.value !== null || fact.known === true || fact.evidence !== undefined))) throw fail('Reusable method facts are unresolved inputs, not observations from an earlier task. Use value:null and omit evidence.');
  const normalized = normalizeTaskPlan({ plan: { layout: value.layout, ...(value.branch ? { branch: value.branch } : {}), ...(value.facts ? { facts: value.facts } : {}) }, steps: value.steps }, { maxChars: METHOD_LIMITS.outlineChars });
  return { layout: normalized.plan.layout, ...(normalized.plan.branch ? { branch: normalized.plan.branch } : {}), ...(normalized.plan.facts?.length ? { facts: normalized.plan.facts } : {}), steps: normalized.steps.map(step => Object.fromEntries(outlineStepFields.filter(key => Object.hasOwn(step, key)).map(key => [key, structuredClone(step[key])]))) };
}

/** An action index for authoring, never a linear execution projection. */
export function methodStepsFromOutline(outline) {
  return outline.steps.filter(step => step.kind === 'action').map(step => ({ id: step.id, title: step.title, type: step.stepType ?? 'create', instructions: step.title, inputs: [], result: step.result ?? step.title, checks: [step.doneWhen] }));
}

/** Validate authored action detail separately so a retry can identify the same
 * save request without re-reading a task that may already have advanced. */
export function normalizeMethodSteps(value, { ontology, branched = false } = {}) {
  const maxSteps = branched ? METHOD_LIMITS.outlineNodes : METHOD_LIMITS.steps, stepIds = new Set();
  if (!Array.isArray(value) || !value.length || value.length > maxSteps) throw fail(branched ? `A method outline needs 1 to ${maxSteps} corresponding actions.` : 'Give the method one to 50 ordered steps.');
  return value.map((item, index) => {
    if (!object(item)) throw fail('Each method step must be an object.');
    knownFields(item, ['id', 'title', 'type', 'instructions', 'inputs', 'result', 'checks'], 'method step');
    const id = branched ? outlineId(item.id) : methodId(item.id ?? `step-${index + 1}`, 'Step ID'); if (stepIds.has(id)) throw fail('Method step IDs must be unique.'); stepIds.add(id);
    const type = methodId(item.type ?? 'create', 'Step type'); if (ontology && !ontology.stepTypes.some(entry => entry.id === type)) throw fail('Choose a saved step type, or create the step type first.');
    return { id, title: methodText(item.title, 'Step title', 300), type, instructions: methodText(item.instructions, 'Step instructions', 12000), inputs: list(item.inputs ?? [], 'Step inputs', 0), result: methodText(item.result, 'Expected step result', 2000), checks: list(item.checks, 'Step checks', 1) };
  });
}

export function validateMethodActionAlignment(outline, steps) {
  const actions = outline.steps.filter(step => step.kind === 'action');
  if (steps.length !== actions.length || steps.some((step, index) => step.id !== actions[index].id)) throw fail('Method steps must include every outline action in the same saved order. The outline determines branch execution.');
  for (const [index, action] of actions.entries()) {
    const step = steps[index];
    if (step.title !== action.title || action.stepType !== undefined && step.type !== action.stepType || action.result !== undefined && step.result !== action.result || !step.checks.includes(action.doneWhen)) throw fail(`Method action “${action.title}” must agree with its outline title, type, expected result and doneWhen check. Edit both together.`);
  }
  return steps;
}

export function validateMethod(value, ontology) {
  if (!object(value)) throw fail('A method definition is required.');
  const taskType = methodId(value.taskType ?? 'general', 'Task type');
  if (!ontology.taskTypes.some(item => item.id === taskType)) throw fail('Choose a saved task type, or create the task type first.');
  const outline = value.outline === undefined ? undefined : validateMethodOutline(value.outline, ontology);
  const inputIds = new Set();
  if (!Array.isArray(value.inputs ?? []) || (value.inputs ?? []).length > METHOD_LIMITS.inputs) throw fail('Use at most 20 method inputs.');
  const inputs = (value.inputs ?? []).map(item => {
    if (!object(item)) throw fail('Each method input must be an object.');
    knownFields(item, ['id', 'label', 'description', 'required'], 'method input');
    const id = methodId(item.id, 'Input ID'); if (inputIds.has(id)) throw fail('Method input IDs must be unique.'); inputIds.add(id);
    if (typeof (item.required ?? false) !== 'boolean') throw fail('An input required flag must be true or false.');
    return { id, label: methodText(item.label, 'Input label', 160), description: methodText(item.description ?? '', 'Input description', 1000, false), required: item.required ?? false };
  });
  const steps = normalizeMethodSteps(value.steps ?? (outline ? methodStepsFromOutline(outline) : undefined), { ontology, branched: Boolean(outline) });
  if (outline) validateMethodActionAlignment(outline, steps);
  return { name: methodText(value.name, 'Method name', 160), description: methodText(value.description ?? '', 'Method description', 2000, false), taskType, inputs, steps, ...(outline ? { outline } : {}), ...(value.catalog === undefined ? {} : { catalog: validateMethodCatalog(value.catalog) }) };
}
