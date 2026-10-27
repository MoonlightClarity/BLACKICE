/**
 * Intelligence-analysis project template, separate from the generic task planner.
 * These are draft project DAGs: saving never starts agents.
 */
export const INTELLIGENCE_TAG = 'intelligence-analysis';
export const INTELLIGENCE_STAGES = Object.freeze([
  {
    id: 'intel-requirement',
    name: 'Requirements',
    title: 'Frame the intelligence requirement',
    focus: 'Decision, PIR, key intelligence questions and scope',
    result: 'Decision brief with a priority intelligence requirement (PIR), key intelligence questions and essential elements of information (EEIs).',
    instructions: 'Identify the decision this assessment must inform, the intended consumer and timeline. Refine the priority intelligence requirement into answerable key questions and EEIs. Separate established facts, assumptions and unknowns; state what is outside scope.',
    acceptanceCriteria: [
      'The decision, priority intelligence requirement and assessment horizon are explicit.',
      'Key intelligence questions and EEIs can guide subsequent collection.'
    ]
  },
  {
    id: 'intel-hypotheses',
    name: 'Hypotheses',
    title: 'Develop competing hypotheses',
    focus: 'Alternatives, assumptions, indicators and disconfirmation',
    result: 'Hypothesis register with alternative explanations, diagnostic indicators and falsification tests.',
    instructions: 'Develop at least two plausible competing hypotheses and a reasonable null/alternative explanation when appropriate. Record assumptions, expected indicators, disconfirming observations and what evidence would discriminate between alternatives. Do not treat the first plausible explanation as established.',
    acceptanceCriteria: [
      'Plausible competing hypotheses and their assumptions are documented.',
      'Each hypothesis includes diagnostic or disconfirming indicators.'
    ],
    dependsOn: ['intel-requirement']
  },
  {
    id: 'intel-collection',
    name: 'Collection',
    title: 'Prioritize collection and sources',
    focus: 'EEI coverage, source targets, access, gaps and provenance',
    result: 'Collection matrix linking EEIs to source targets, collection priorities and remaining gaps.',
    instructions: 'Map each EEI and hypothesis discriminator to information sources and collection methods. Prioritize timeliness and diagnostic value. Record provenance, access limitations, missing information and follow-up requests. Do not substitute repeated reporting for independent corroboration.',
    acceptanceCriteria: [
      'Each priority EEI has a source target or a documented collection gap.',
      'The collection plan distinguishes provenance, availability, relevance and timeliness.'
    ],
    dependsOn: ['intel-hypotheses']
  },
  {
    id: 'intel-validation',
    name: 'Evaluation',
    title: 'Evaluate and reconcile evidence',
    focus: 'Credibility, reliability, corroboration and contradictions',
    result: 'Evidence matrix with source appraisal, corroboration, contradictions and unresolved gaps.',
    instructions: 'Assess source credibility separately from information reliability, with timestamps and traceable provenance. Identify dependency between sources, corroborating and conflicting reporting, missing information and reasonable alternative interpretations. Mark unsupported claims instead of silently filling gaps.',
    acceptanceCriteria: [
      'Key claims are linked to attributable evidence and evaluated for reliability.',
      'Contradictions, source dependencies and unresolved information gaps are visible.'
    ],
    dependsOn: ['intel-collection']
  },
  {
    id: 'intel-synthesis',
    name: 'Analysis',
    title: 'Test hypotheses and form judgments',
    focus: 'ACH, diagnostic evidence, confidence and uncertainty',
    result: 'Structured assessment of competing hypotheses, key judgments and confidence rationale.',
    instructions: 'Use a structured comparison such as Analysis of Competing Hypotheses (ACH) where appropriate. Weigh disconfirming evidence and alternative explanations, not only supporting examples. Separate evidence from inference; state confidence levels with rationale, critical assumptions, and what information could change each judgment.',
    acceptanceCriteria: [
      'Key judgments have explicit evidence, alternative explanations and confidence rationales.',
      'Contradictory or disconfirming information is considered without being suppressed.'
    ],
    dependsOn: ['intel-validation']
  },
  {
    id: 'intel-product',
    name: 'Assessment',
    title: 'Produce and disseminate the assessment',
    focus: 'BLUF, judgments, sourcing, implications and indicators',
    result: 'Decision-focused intelligence product with BLUF, key judgments, confidence, sourcing, gaps and warning indicators.',
    instructions: 'Create a concise bottom-line-up-front assessment for the decision-maker. Include sourced key judgments, confidence and uncertainties, meaningful dissent or alternatives, implications, outstanding collection priorities and indicators for updating the assessment. Distinguish observed facts from analytic judgments.',
    acceptanceCriteria: [
      'The intelligence product directly answers the priority question and informs the decision.',
      'Confidence, sources, caveats, intelligence gaps and update indicators are explicit.'
    ],
    dependsOn: ['intel-synthesis']
  }
]);

const HEADINGS = Object.freeze({
  decision: 'Decision to inform',
  question: 'Priority intelligence question',
  scope: 'Scope and time horizon',
  product: 'Intelligence product and audience',
  hypotheses: 'Competing hypotheses and assumptions',
  collection: 'Collection priorities and intelligence gaps'
});
const OBJECTIVE_FIELDS = ['decision', 'question', 'scope', 'product'];
const CONTEXT_FIELDS = ['hypotheses', 'collection'];
const clean = value => String(value ?? '').trim();
const sectionText = (fields, draft) => fields.map(field => '## ' + HEADINGS[field] + '\n' + clean(draft[field])).join('\n\n');

function readSections(value) {
  const output = {};
  let key = null;
  for (const line of String(value ?? '').split(/\r?\n/)) {
    const header = Object.entries(HEADINGS).find(([, label]) => line.trim() === '## ' + label);
    if (header) { key = header[0]; output[key] = ''; continue; }
    if (key) output[key] += (output[key] ? '\n' : '') + line;
  }
  return Object.fromEntries(Object.entries(output).map(([key, value]) => [key, value.trim()]));
}

export function isIntelligenceProject(project) {
  return Array.isArray(project?.tags) && project.tags.includes(INTELLIGENCE_TAG);
}

export function intelligenceProjectEditable(project) {
  return Boolean(project && ['draft', 'paused', 'needs_attention'].includes(project.status)
    && (project.tasks || []).every(task => !(task.attempts || []).length));
}

export function intelligenceProjectDraft(project = null, defaultCwd = '') {
  const objective = readSections(project?.objective), context = readSections(project?.context);
  return {
    name: clean(project?.name),
    decision: objective.decision || '',
    question: objective.question || '',
    scope: objective.scope || '',
    product: objective.product || '',
    hypotheses: context.hypotheses || '',
    collection: context.collection || '',
    cwd: clean(project?.cwd || defaultCwd)
  };
}

export function buildIntelligenceProject(draft, original = null) {
  const fields = Object.fromEntries(Object.keys(HEADINGS).map(key => [key, clean(draft?.[key])]));
  const name = clean(draft?.name), cwd = clean(draft?.cwd);
  if (!name || name.length > 160) throw Error('Give this intelligence assessment a title (up to 160 characters).');
  if (!fields.decision) throw Error('Describe the decision this intelligence will inform.');
  if (!fields.question) throw Error('State the priority intelligence question.');
  if (!cwd) throw Error('Choose the working folder for this assessment.');
  const objective = sectionText(OBJECTIVE_FIELDS, fields), context = sectionText(CONTEXT_FIELDS, fields);
  if (objective.length > 8000 || context.length > 8000) throw Error('Shorten the assessment brief to fit the saved project.');
  const tasks = INTELLIGENCE_STAGES.map(stage => ({
    id: stage.id,
    title: stage.title,
    instructions: stage.instructions,
    result: stage.result,
    acceptanceCriteria: [...stage.acceptanceCriteria],
    dependsOn: [...(stage.dependsOn || [])],
    stepType: 'analysis'
  }));
  return {
    name, cwd, objective, context, tasks,
    tags: [...new Set([...(original?.tags || []), INTELLIGENCE_TAG])]
  };
}
