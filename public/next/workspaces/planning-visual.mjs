import { text } from '../core/dom.mjs';
import { buildWorkflowMapModel } from '../../workflow-map.mjs';
import { projectViewModel } from '../../project-view-model.mjs';

const note = step => String(step.note || '');

/** Drafts keep a full revision, never a metadata-only catalog row. */
export function createPlanningDraft(plan) {
  if (!Array.isArray(plan?.steps)) throw Error('Load the saved plan before editing it.');
  return { base: plan, latest: plan, goal: String(plan.goal || ''), notes: new Map(plan.steps.map(step => [step.id, note(step)])), revisit: null, detachedNotes: [], error: '' };
}

export function planningDraftDirty(draft) {
  return Boolean(draft.revisit) || draft.goal !== String(draft.base.goal || '') || draft.base.steps.some(step => (draft.notes.get(step.id) || '') !== note(step));
}

export function planningDraftOperations(draft) {
  const operations = [];
  if (draft.revisit) {
    if (!draft.base.steps.some(step => step.id === draft.revisit.stepId)) throw Error('The step to revisit is no longer in this plan. Review the saved version.');
    const reason = String(draft.revisit.reason || '').trim();
    if (!reason || reason.length > 1000) throw Error('Explain why this step needs revisiting in 1 to 1,000 characters.');
    // Archive the saved attempt before applying a revised procedure to it.
    operations.push({ type: 'revisit', stepId: draft.revisit.stepId, reason });
  }
  if (draft.goal.trim() !== String(draft.base.goal || '')) operations.push({ type: 'metadata', patch: { goal: draft.goal.trim() } });
  for (const step of draft.base.steps) if ((draft.notes.get(step.id) || '') !== note(step)) operations.push({ type: 'update', stepId: step.id, patch: { note: draft.notes.get(step.id) || '' } });
  return operations;
}

export function acceptPlanningSnapshot(draft, plan) {
  if (!Array.isArray(plan?.steps) || plan.taskId !== draft.base.taskId || plan.revision < draft.latest.revision) return draft;
  if (!planningDraftDirty(draft)) return { ...createPlanningDraft(plan), detachedNotes: draft.detachedNotes, error: draft.error };
  return { ...draft, latest: plan };
}

/** Explicit rebase preserves edits by saved step ID and retains removed notes. */
export function rebasePlanningDraft(draft) {
  const previous = draft.base, latest = draft.latest, old = new Map(previous.steps.map(step => [step.id, step])), ids = new Set(latest.steps.map(step => step.id));
  const detachedNotes = [...draft.detachedNotes];
  for (const step of previous.steps) if (!ids.has(step.id) && (draft.notes.get(step.id) || '') !== note(step)) {
    detachedNotes.push({ id: step.id, title: step.title || step.id, note: draft.notes.get(step.id) || '' });
  }
  const removedRevisit = draft.revisit && !ids.has(draft.revisit.stepId);
  if (removedRevisit) detachedNotes.push({ id: draft.revisit.stepId, title: old.get(draft.revisit.stepId)?.title || draft.revisit.stepId, note: 'Revisit requested: ' + draft.revisit.reason });
  return {
    ...draft, base: latest,
    goal: draft.goal === String(previous.goal || '') ? String(latest.goal || '') : draft.goal,
    notes: new Map(latest.steps.map(step => [step.id, old.has(step.id) && (draft.notes.get(step.id) || '') !== note(old.get(step.id)) ? draft.notes.get(step.id) || '' : note(step)])),
    revisit: removedRevisit ? null : draft.revisit,
    detachedNotes, error: 'Draft kept. Save explicitly to apply it to the latest revision.',
  };
}

/** A delayed receipt cannot consume text typed after its submitted version. */
export function commitPlanningDraft(draft, saved, submitted) {
  const latest = draft.latest.revision > saved.revision ? draft.latest : saved;
  return {
    ...draft, base: saved, latest,
    goal: draft.goal === submitted.goal ? String(saved.goal || '') : draft.goal,
    notes: new Map(saved.steps.map(step => [step.id, draft.notes.get(step.id) === submitted.notes.get(step.id) ? note(step) : draft.notes.get(step.id) ?? note(step)])),
    revisit: JSON.stringify(draft.revisit) === JSON.stringify(submitted.revisit) ? null : draft.revisit,
    error: 'Saved revision ' + saved.revision + '.',
  };
}

/** Real project dependencies and reviewed receipts; no synthetic schedule dates. */
export function projectVisualModel(project) {
  const graph = buildWorkflowMapModel({ kind: 'project', project }), tracking = projectViewModel(project);
  return { ...graph, tracking, progress: project.summary?.progress || { total: tracking.total, completed: tracking.reviewed, percent: tracking.percent }, milestones: project.summary?.milestones || tracking.milestones };
}

// BLACKICE intelligence planning (bundled into registered visual module until next restart)
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

const add = (parent, tag, value = '', className = '') => text(parent, value, tag, className);
const button = (parent, label, action, className = '') => {
  const node = add(parent, 'button', label, className);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
};
const fields = Object.freeze([
  { key: 'name', label: 'Assessment title', hint: 'e.g. Emerging vendor concentration risk', max: 160, required: true, rows: 1 },
  { key: 'decision', label: 'Decision to inform', hint: 'What action or choice will this analysis support?', max: 1200, required: true, rows: 2 },
  { key: 'question', label: 'Priority intelligence question (PIR / KIQ)', hint: 'The answerable question that matters for that decision', max: 1200, required: true, rows: 2 },
  { key: 'scope', label: 'Scope, actors and time horizon', hint: 'Geographic, organizational and temporal boundaries', max: 1400, rows: 2 },
  { key: 'hypotheses', label: 'Initial competing hypotheses and assumptions', hint: 'Plausible alternatives and what evidence could refute them', max: 2800, rows: 3 },
  { key: 'collection', label: 'Collection priorities and intelligence gaps', hint: 'Sources, EEIs, unknowns and information needed to discriminate between hypotheses', max: 2800, rows: 3 },
  { key: 'product', label: 'Intelligence product and audience', hint: 'Brief, estimate, risk assessment, profile or indications-and-warning note', max: 1200, rows: 2 },
  { key: 'cwd', label: 'Working folder', hint: 'Absolute folder path for source material and outputs', max: 32760, required: true, rows: 1 }
]);

function phaseList(parent, plan = null) {
  const list = add(parent, 'ol', '', 'next-intel-phase-list');
  for (const [index, stage] of INTELLIGENCE_STAGES.entries()) {
    const item = add(list, 'li', '', 'next-intel-phase');
    add(item, 'span', String(index + 1).padStart(2, '0'), 'next-intel-phase-number');
    const body = add(item, 'div', '', 'next-intel-phase-copy');
    add(body, 'strong', stage.name);
    add(body, 'span', stage.focus, 'next-help');
    if (plan) {
      const state = plan.tasks?.find(task => task.id === stage.id)?.status || 'pending';
      const flag = add(item, 'span', state.replaceAll('_', ' '), 'next-status-pill');
      flag.dataset.state = state;
    }
  }
  return list;
}

export function renderIntelligenceLanding(parent, onCreate) {
  const hero = add(parent, 'section', '', 'next-intel-landing');
  add(hero, 'span', 'INTELLIGENCE CYCLE', 'next-intel-kicker');
  add(hero, 'h2', 'Begin with the question, not a task list.');
  add(hero, 'p', 'Frame the decision requirement, identify what must be known, test competing explanations and define what the assessment must deliver.');
  button(hero, 'Create intelligence assessment', onCreate, 'next-primary');
  const section = add(parent, 'section', '', 'next-intel-landing-stages');
  add(section, 'h3', 'Analytic planning framework');
  phaseList(section);
}

export function renderIntelligenceOverview(parent, plan, { onEdit, onCopy } = {}) {
  const draft = intelligenceProjectDraft(plan);
  const section = add(parent, 'section', '', 'next-intel-brief');
  add(section, 'span', 'PRIORITY INTELLIGENCE REQUIREMENT', 'next-intel-kicker');
  add(section, 'h3', draft.question || 'Define the priority intelligence question');
  if (draft.decision) add(section, 'p', 'Decision supported: ' + draft.decision, 'next-intel-decision');
  const facts = add(section, 'div', '', 'next-intel-brief-grid');
  for (const [heading, value] of [
    ['Scope / horizon', draft.scope], ['Competing hypotheses', draft.hypotheses],
    ['Collection / gaps', draft.collection], ['Product / audience', draft.product]
  ]) {
    const card = add(facts, 'div', '', 'next-intel-fact');
    add(card, 'h4', heading);
    add(card, 'p', value || 'To be defined', value ? '' : 'next-help');
  }
  const flow = add(section, 'details', '', 'next-intel-flow');
  const summary = add(flow, 'summary', 'Analytic sequence and status');
  summary.setAttribute('aria-label', 'Expand intelligence cycle and status');
  phaseList(flow, plan);
  const actions = add(section, 'div', '', 'next-row next-intel-actions');
  if (intelligenceProjectEditable(plan)) button(actions, 'Edit intelligence requirement', onEdit);
  else button(actions, 'Create revised assessment', onCopy);
  add(actions, 'span', 'The intelligence plan is saved. Agents run only when you start the project.', 'next-help');
  return section;
}

export function renderIntelligenceComposer({ parent, project = null, defaultCwd = '', onSave, onCancel }) {
  parent.replaceChildren();
  const isRevision = Boolean(project), canUpdate = project && intelligenceProjectEditable(project);
  const values = intelligenceProjectDraft(project, defaultCwd);
  const shell = add(parent, 'section', '', 'next-intel-composer');
  add(shell, 'span', 'ANALYTIC MISSION DESIGN', 'next-intel-kicker');
  add(shell, 'h2', canUpdate ? 'Revise intelligence requirement' : isRevision ? 'Create a revised assessment' : 'New intelligence assessment');
  add(shell, 'p', 'Plan the intelligence product before assigning collection or analysis. A saved plan is a draft; it does not start an agent.', 'next-help');
  const form = add(shell, 'form', '', 'next-intel-form');
  form.id = 'next-intelligence-form';
  const sections = [
    { heading: '01 / Direction', description: 'Who needs to decide what, and which question must be answered?', keys: ['name', 'decision', 'question', 'scope'] },
    { heading: '02 / Analytic design', description: 'Define alternatives, collection requirements and the intended product.', keys: ['hypotheses', 'collection', 'product', 'cwd'] }
  ];
  const inputs = new Map();
  for (const block of sections) {
    const group = add(form, 'section', '', 'next-intel-form-section');
    add(group, 'h3', block.heading);
    add(group, 'p', block.description, 'next-help');
    const grid = add(group, 'div', '', 'next-intel-form-grid');
    for (const key of block.keys) {
      const field = fields.find(field => field.key === key);
      const label = add(grid, 'label', field.label, 'next-label next-intel-label');
      const input = add(label, field.rows === 1 ? 'input' : 'textarea', '', 'next-field');
      input.name = key;
      if (field.rows !== 1) input.rows = field.rows;
      input.placeholder = field.hint;
      input.maxLength = field.max;
      input.required = Boolean(field.required);
      input.value = values[key];
      input.autocomplete = 'off';
      inputs.set(key, input);
    }
  }
  const framework = add(form, 'details', '', 'next-intel-flow next-intel-template');
  add(framework, 'summary', 'Review the six-stage intelligence workflow');
  phaseList(framework);
  const actions = add(form, 'div', '', 'next-row next-intel-actions');
  const submit = add(actions, 'button', canUpdate ? 'Save revised requirement' : 'Save intelligence assessment', 'next-primary');
  submit.id = 'next-intelligence-save';
  submit.type = 'submit';
  button(actions, 'Cancel', onCancel);
  const receipt = add(form, 'p', '', 'next-help'); receipt.id = 'next-intelligence-receipt'; receipt.setAttribute('role', 'status');
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submit.disabled) return;
    const current = Object.fromEntries([...inputs].map(([key, input]) => [key, input.value]));
    submit.disabled = true;
    receipt.textContent = 'Saving intelligence assessment…';
    try {
      await onSave(current, canUpdate ? project : null);
      receipt.textContent = 'Intelligence assessment saved.';
    } catch (cause) {
      receipt.textContent = String(cause?.message || cause);
      receipt.setAttribute('role', 'alert');
    } finally { submit.disabled = false; }
  });
  inputs.get('name')?.focus?.({ preventScroll: true });
  return shell;
}

// BLACKICE intelligence text-to-map projection; bundled into the registered visual module.
/**
 * BLACKICE intelligence text v1.
 * The Markdown document is canonical. This parser projects entities and explicit
 * references into a visual graph; no conclusions or links are inferred.
 */
export const INTEL_TEXT_HEADER = '# Intelligence Assessment';
export const INTEL_TEXT_FORMAT = 'BLACKICE-INTEL/1';
export const INTEL_MAP_LANES = Object.freeze([
  { id: 'requirements', label: 'Requirements', prefix: 'REQ', hint: 'Essential information needs' },
  { id: 'hypotheses', label: 'Hypotheses', prefix: 'HYP', hint: 'Competing explanations' },
  { id: 'collection', label: 'Collection', prefix: 'COL', hint: 'Information needs and collection tasks' },
  { id: 'analysis', label: 'Analysis', prefix: 'ANL', hint: 'Questions, comparisons and evidence tests' },
  { id: 'technical', label: 'Technical Methods', prefix: 'TEC', hint: 'Executable procedures and tool checks, not judgments' },
  { id: 'evidence', label: 'Evidence', prefix: 'EVD', hint: 'Attributed observations, not automatic tool results' },
  { id: 'judgments', label: 'Judgments', prefix: 'JDG', hint: 'Supported assessments' }
]);

const metaNames = new Map([
  ['format', 'format'], ['title', 'title'], ['decision', 'decision'],
  ['pir', 'pir'], ['priority intelligence question', 'pir'],
  ['scope', 'scope'], ['product', 'product'], ['working folder', 'cwd']
]);
const trim = value => String(value ?? '').trim();
const ID_PATTERN = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/;
const canonicalAttr = value => String(value).trim().toLowerCase().replace(/\s+/g, ' ');
const relations = Object.freeze([
  { kind: 'answers', on: 'hypotheses', field: 'answers', references: 'requirements', fromRef: true },
  { kind: 'answers', on: 'collection', field: 'answers', references: 'requirements', fromRef: true },
  { kind: 'tests', on: 'collection', field: 'tests', references: 'hypotheses', fromRef: true },
  { kind: 'examines', on: 'analysis', field: 'tests', references: 'hypotheses', fromRef: true },
  { kind: 'examines_evidence', on: 'analysis', field: 'based on', references: 'evidence', fromRef: true },
  { kind: 'requires_collection', on: 'analysis', field: 'requires', references: 'collection', fromRef: true },
  { kind: 'implements', on: 'technical', field: 'implements', references: 'collection', fromRef: true },
  { kind: 'used_for', on: 'technical', field: 'used for', references: 'analysis', fromRef: true },
  { kind: 'obtained_via', on: 'evidence', field: 'obtained via', references: 'technical', fromRef: true },
  { kind: 'supports', on: 'evidence', field: 'supports', references: 'hypotheses', fromRef: true },
  { kind: 'challenges', on: 'evidence', field: 'challenges', references: 'hypotheses', fromRef: true },
  { kind: 'collected', on: 'evidence', field: 'from', references: 'collection', fromRef: true },
  { kind: 'basis', on: 'judgments', field: 'based on', references: 'evidence', fromRef: true },
  { kind: 'reasoned_by', on: 'judgments', field: 'analysis', references: 'analysis', fromRef: true },
  { kind: 'evaluates', on: 'judgments', field: 'evaluates', references: 'hypotheses', fromRef: true }
]);
function refs(value) { return trim(value).split(/[,;]\s*/).map(value => trim(value).toUpperCase()).filter(Boolean); }
function issue(line, message) { return { line, message }; }
function isKnownSection(value) {
  return INTEL_MAP_LANES.find(lane => lane.label.toLowerCase() === String(value).trim().toLowerCase());
}

export function parseIntelligenceText(source, { requireBrief = false } = {}) {
  const text = String(source ?? '').replace(/\r\n/g, '\n');
  const lines = text.split('\n'), fields = { title: '', decision: '', pir: '', scope: '', product: '', cwd: '', format: '' };
  const entities = [], errors = [], warnings = [], byId = new Map();
  let section = null, node = null, sectionIsUnknown = false;
  if (lines[0]?.trim() !== INTEL_TEXT_HEADER) errors.push(issue(1, 'Start with "# Intelligence Assessment".'));
  for (let i = 1; i < lines.length; i++) {
    const value = lines[i], t = value.trim();
    if (!t || t.startsWith('<!--') || t.startsWith('-->')) continue;
    const h = /^##\s+(.+?)\s*$/.exec(value);
    if (h) {
      const known = isKnownSection(h[1]);
      section = known?.id || h[1];
      sectionIsUnknown = !known;
      if (sectionIsUnknown) warnings.push(issue(i + 1, 'Section "' + h[1] + '" is retained as text but has no map projection.'));
      node = null;
      continue;
    }
    if (!section) {
      const m = /^([A-Za-z ]+):\s*(.*)$/.exec(value);
      if (m) {
        const field = metaNames.get(canonicalAttr(m[1]));
        if (field) {
          if (fields[field]) errors.push(issue(i + 1, 'Duplicate "' + m[1] + '" field.'));
          fields[field] = m[2].trim();
        } else warnings.push(issue(i + 1, 'Unrecognized brief field "' + m[1] + '". Retained in text but not mapped.'));
      } else if (t !== INTEL_TEXT_HEADER && !t.startsWith('#')) warnings.push(issue(i + 1, 'This line is outside a recognized section.'));
      continue;
    }
    if (sectionIsUnknown) continue; // preserve additional analyst notes without erasing them
    const lane = INTEL_MAP_LANES.find(item => item.id === section);
    const entry = /^-\s+\[([^\]]+)\]\s+(.+)$/.exec(value);
    if (entry) {
      const id = trim(entry[1]).toUpperCase();
      if (!ID_PATTERN.test(id) || !id.startsWith(lane.prefix + '-')) {
        errors.push(issue(i + 1, 'Use an ID beginning with "' + lane.prefix + '-" (for example ' + lane.prefix + '-1).'));
      }
      if (byId.has(id)) errors.push(issue(i + 1, 'Duplicate entity ID ' + id + '.'));
      node = { id, kind: section, title: trim(entry[2]), attrs: {}, line: i + 1 };
      entities.push(node);
      if (!byId.has(id)) byId.set(id, node);
      continue;
    }
    const attribute = /^\s{2,}([A-Za-z][A-Za-z0-9 -]*):\s*(.*?)\s*$/.exec(value);
    if (attribute && node) {
      const key = canonicalAttr(attribute[1]);
      if (Object.hasOwn(node.attrs, key)) errors.push(issue(i + 1, 'Duplicate "' + attribute[1] + '" on ' + node.id + '.'));
      node.attrs[key] = trim(attribute[2]);
      continue;
    }
    if (/^\s{2,}\S/.test(value) && node) {
      node.title += ' ' + t; // human/LLM-wrapped labels without data loss
      continue;
    }
    if (t.startsWith('-') || t.startsWith('[')) errors.push(issue(i + 1, 'Start an entity with "- [' + lane.prefix + '-1] Description".'));
    else warnings.push(issue(i + 1, 'This line is not part of an entity; it remains in the text.'));
  }
  if (fields.format && fields.format !== INTEL_TEXT_FORMAT) errors.push(issue(2, 'Unsupported format. Use ' + INTEL_TEXT_FORMAT + '.'));
  if (requireBrief && !fields.format) errors.push(issue(2, 'Add Format: ' + INTEL_TEXT_FORMAT + ' so the saved model can be reopened exactly.'));
  const edges = [];
  for (const entity of entities) {
    for (const relation of relations.filter(relation => relation.on === entity.kind)) {
      const list = refs(entity.attrs[relation.field]);
      for (const reference of list) {
        const target = byId.get(reference);
        if (!target) { errors.push(issue(entity.line, entity.id + ' ' + relation.field + ' references missing ' + reference + '.')); continue; }
        if (target.kind !== relation.references) { errors.push(issue(entity.line, entity.id + ' ' + relation.field + ' expects ' + relation.references + ', not ' + target.kind + '.')); continue; }
        const from = relation.fromRef ? target.id : entity.id, to = relation.fromRef ? entity.id : target.id;
        if (!edges.some(edge => edge.from === from && edge.to === to && edge.kind === relation.kind)) edges.push({ from, to, kind: relation.kind, id: [relation.kind, from, to].join(':') });
      }
    }
  }
  if (requireBrief) {
    for (const field of ['title', 'decision', 'pir', 'cwd']) if (!fields[field]) errors.push(issue(0, 'Provide ' + ({ title: 'Title', decision: 'Decision', pir: 'PIR', cwd: 'Working folder' }[field]) + ' before saving.'));
    if (fields.title.length > 160) errors.push(issue(0, 'Assessment title must be 160 characters or fewer.'));
    if (text.length > 8000) errors.push(issue(0, 'Keep the complete text source at or below 8,000 characters for durable project storage.'));
  }
  if (entities.filter(item => item.kind === 'hypotheses').length === 1) warnings.push(issue(0, 'Consider at least one alternative hypothesis.'));
  if (!entities.some(item => item.kind === 'evidence')) warnings.push(issue(0, 'No evidence recorded. The map contains no verified observations.'));
  if (!entities.some(item => item.kind === 'judgments')) warnings.push(issue(0, 'No judgments yet. Do not treat a hypothesis as a conclusion.'));
  return { text, fields, entities, edges, errors, warnings, byId, valid: errors.length === 0 };
}

export function intelligenceStarterText({ cwd = '', title = '', decision = '', pir = '', scope = '', product = '' } = {}) {
  return [
    '# Intelligence Assessment', 'Format: BLACKICE-INTEL/1',
    'Title: ' + trim(title), 'Decision: ' + trim(decision), 'PIR: ' + trim(pir),
    'Scope: ' + trim(scope), 'Product: ' + trim(product), 'Working folder: ' + trim(cwd),
    '',
    '## Requirements',
    '- [REQ-1] DRAFT - state an essential information requirement',
    '  Priority: high',
    '',
    '## Hypotheses',
    '- [HYP-1] DRAFT - first plausible explanation',
    '  Answers: REQ-1',
    '  Indicators: Identify observations expected if true',
    '  Disconfirm: Identify observations that would weaken it',
    '- [HYP-2] DRAFT - competing alternative explanation',
    '  Answers: REQ-1',
    '  Indicators: Identify observations expected if true',
    '  Disconfirm: Identify observations that would weaken it',
    '',
    '## Collection',
    '- [COL-1] DRAFT - locate evidence that distinguishes the hypotheses',
    '  Answers: REQ-1',
    '  Tests: HYP-1, HYP-2',
    '  Source: Sources to be identified',
    '',
    '## Analysis',
    '',
    '## Technical Methods',
    '',
    '## Evidence',
    '',
    '## Judgments',
    ''
  ].join('\n');
}

export function intelligenceTextFromProject(project, cwd = '') {
  if (!project) return intelligenceStarterText({ cwd });
  const stored = String(project.context || '').replace(/\r\n/g, '\n');
  // Preserve older or incomplete text-native documents verbatim so the analyst can repair them.
  if (stored.startsWith(INTEL_TEXT_HEADER + '\n')) return stored;
  // Read-only compatibility projection for previously saved form-based plans.
  // Preserve the entire original context below an unparsed heading.
  const legacy = intelligenceProjectDraft(project);
  const base = intelligenceStarterText({ title: legacy.name || project.name, decision: legacy.decision, pir: legacy.question, scope: legacy.scope, product: legacy.product, cwd: project.cwd || cwd });
  const lines = base.split('\n');
  const hypotheses = trim(legacy.hypotheses), collection = trim(legacy.collection);
  if (hypotheses) lines.splice(lines.indexOf('## Collection'), 0, '- [HYP-3] DRAFT - ' + hypotheses.replace(/\s+/g, ' ').slice(0, 380), '');
  if (collection) lines.splice(lines.indexOf('## Analysis'), 0, '- [COL-2] DRAFT - ' + collection.replace(/\s+/g, ' ').slice(0, 380), '');
  if (stored) lines.push('## Previous saved background', stored, '');
  return lines.join('\n');
}

// Draft placeholders describe potential questions; they are not completed work
// and must not silently become executable project tasks.
const authoredEntity = node => !/^DRAFT(?:\s|\s*[-—:]|$)/i.test(node.title);
const taskIdentity = id => 'intel-' + id.toLowerCase();
const methodBrief = entity => [
  entity.title,
  ...[['Tool', 'tool'], ['Procedure', 'procedure'], ['Output', 'output'], ['Verify', 'verify']]
    .filter(([, field]) => entity.attrs[field])
    .map(([label, field]) => label + ': ' + entity.attrs[field])
].join('\n');

/** Convert only analyst-authored operations and analytical passes into an
 * executable project DAG. Ontology references, observations and judgments are
 * never manufactured by completing a technical task. */
export function intelligenceProjectTasks(parsed) {
  if (!parsed?.valid) throw Error('Save only a valid intelligence ontology.');
  const real = parsed.entities.filter(authoredEntity);
  const collect = real.filter(node => node.kind === 'collection');
  const analysis = real.filter(node => node.kind === 'analysis');
  const technical = real.filter(node => node.kind === 'technical');
  const judgments = real.filter(node => node.kind === 'judgments');
  const analysisIds = new Set(analysis.map(node => node.id));
  const collectionIds = new Set(collect.map(node => node.id));
  const linkedTech = new Set();
  const tasks = [];
  // Methods implementing a collection objective belong to that objective's
  // procedure rather than creating a duplicate second execution task.
  for (const item of collect) {
    const implementedBy = technical.filter(node => refs(node.attrs.implements).includes(item.id));
    for (const method of implementedBy) linkedTech.add(method.id);
    const methodText = implementedBy.length ? implementedBy.map(method => method.id + ': ' + methodBrief(method)).join('\n') : 'Method not yet specified. Choose based on actual source availability and constraints.';
    tasks.push({
      id: taskIdentity(item.id), title: 'Collect: ' + item.title, stepType: 'collect',
      instructions: 'Information need: ' + item.title + '\nExplicit source: ' + (item.attrs.source || 'Not specified') + '\nAnswers: ' + (item.attrs.answers || 'Unspecified') + '\nDiscriminates: ' + (item.attrs.tests || 'Unspecified') + '\nTechnical methods:\n' + methodText + '\nReport actual attribution, source quality, unavailable information and collection limits. Do not assert a hypothesis from tool success.',
      result: 'An attributed collection result or an explicit information gap for ' + item.id + '.',
      acceptanceCriteria: [
        'The requested information is either attributable to actual source material or explicitly unavailable.',
        'Material provenance, reliability limitations and unresolved gaps are recorded without inferring a judgment.'
      ],
      dependsOn: []
    });
  }
  for (const item of technical.filter(node => !linkedTech.has(node.id))) tasks.push({
    id: taskIdentity(item.id), title: 'Execute method: ' + item.title, stepType: 'technical_method',
    instructions: methodBrief(item) + '\nExecute only authorized real operations. Record actual output, errors, checks and limits. An operational success does not establish any analytical finding.',
    result: 'An observed technical result, output or blocker for ' + item.id + '.',
    acceptanceCriteria: [
      'The actual procedure result or concrete blocker is recorded, rather than assumed.',
      'Outputs and checks are distinguishable from analytical evidence and judgments.'
    ],
    dependsOn: []
  });
  for (const item of analysis) {
    const required = refs(item.attrs.requires).filter(id => collectionIds.has(id));
    tasks.push({
      id: taskIdentity(item.id), title: 'Analyze: ' + item.title, stepType: 'analysis',
      instructions: 'Analytical question: ' + item.title + '\nTests: ' + (item.attrs.tests || 'Not specified') + '\nEvidence to examine: ' + (item.attrs['based on'] || 'Not specified') + '\nCompare plausible interpretations against discriminating observations and competing evidence. Separate established facts, hypotheses, operational outputs, and unsupported claims; make a bounded finding or record why the inquiry remains open.',
      result: 'A supported or explicitly unresolved analytical finding for ' + item.id + '.',
      acceptanceCriteria: [
        'Relevant alternatives and what the observed evidence does or does not distinguish are recorded.',
        'The finding, limitations and information that might change it are explicit; executing a tool alone is insufficient.'
      ],
      dependsOn: required.map(taskIdentity)
    });
  }
  if (!analysis.length) tasks.push({
    id: 'intel-core-inquiry',
    title: 'Assess the priority intelligence question',
    stepType: 'analysis',
    instructions: 'Priority intelligence question: ' + parsed.fields.pir + '\nDecision to inform: ' + parsed.fields.decision + '\nDevelop or refine the material subquestions from the actual requirement and evidence. Record plausible alternatives and discriminating observations, separate technical collection from analytical judgment, and report unanswered questions explicitly. Do not automatically infer a conclusion from completed collection.',
    result: 'A supported assessment, or a bounded explanation of why this requirement remains unresolved.',
    acceptanceCriteria: [
      'The assessment directly addresses the recorded priority question or identifies the precise unresolved discriminator.',
      'Evidence, interpretation, assumptions, alternatives and material limitations are distinguishable.'
    ],
    dependsOn: []
  });
  for (const item of judgments) {
    // Authored judgment text is a proposition to assess, not a finding already
    // established by the tool runs or by writing it into the ontology.
    const reasoning = refs(item.attrs.analysis).filter(id => analysisIds.has(id));
    tasks.push({
      id: taskIdentity(item.id),
      title: 'Evaluate judgment: ' + item.title,
      stepType: 'analysis',
      instructions: 'Proposed judgment for examination: ' + item.title
        + '\\nExplicit reasoning: ' + (item.attrs.analysis || 'No analytical pass linked')
        + '\\nClaimed evidentiary basis: ' + (item.attrs['based on'] || 'No evidence linked')
        + '\\nCompeting hypotheses: ' + (item.attrs.evaluates || 'Not specified')
        + '\\nAssess whether the recorded claim is justified at its actual scope. Read and appraise the original evidence, discriminate plausible alternatives and state confidence or unresolved gaps. Do not certify the claim because a preceding technical or analysis task was marked done.',
      result: 'A separately supported, qualified, revised or explicitly unresolved judgment about ' + item.id + '.',
      acceptanceCriteria: [
        'The judgment is linked to inspected, attributable evidence or explicitly remains unproven.',
        'The strongest relevant alternative, decisive uncertainty and conditions for revision are distinguished from successful tool operations.'
      ],
      dependsOn: reasoning.map(taskIdentity)
    });
  }
  if (tasks.length > 100) throw Error('The intelligence task graph exceeds 100 authored operations. Consolidate technical procedures without discarding distinct analytical questions.');
  return tasks;
}

export function intelligenceProjectFromText(source, previous = null) {
  const parsed = parseIntelligenceText(source, { requireBrief: true });
  if (!parsed.valid) throw Error(parsed.errors.map(item => (item.line ? 'Line ' + item.line + ': ' : '') + item.message).slice(0, 5).join(' | '));
  const f = parsed.fields;
  const skeleton = buildIntelligenceProject({
    name: f.title, decision: f.decision, question: f.pir, scope: f.scope, product: f.product,
    hypotheses: parsed.entities.filter(node => node.kind === 'hypotheses').map(node => node.title).join('; '),
    collection: parsed.entities.filter(node => node.kind === 'collection').map(node => node.title).join('; '),
    cwd: f.cwd
  }, previous);
  return { ...skeleton, tasks: intelligenceProjectTasks(parsed), context: parsed.text.trimEnd(), objective: [
    '## Decision to inform', f.decision, '',
    '## Priority intelligence question', f.pir, '',
    '## Scope and time horizon', f.scope, '',
    '## Intelligence product and audience', f.product
  ].join('\n') };
}

export function intelligenceMapGeometry(parsed, { availableWidth = 1550 } = {}) {
  // The ontology has more than five lanes. Prefer legible cards and horizontal
  // scrolling to compressing seven columns into unreadable cards.
  const left = 16, count = INTEL_MAP_LANES.length;
  const measured = Number(availableWidth);
  const minWidth = count * 176 + (count - 1) * 54 + 2 * left;
  const target = Math.max(minWidth, Math.floor(Number.isFinite(measured) && measured > 0 ? measured : 1550));
  const preferredGap = target >= 1450 ? 54 : target >= 1200 ? 36 : target >= 1050 ? 26 : 16;
  const colWidth = Math.min(232, Math.floor((target - 2 * left - (count - 1) * preferredGap) / count));
  const columnGap = Math.min(68, Math.max(preferredGap, Math.floor((target - 2 * left - count * colWidth) / (count - 1))));
  const width = 2 * left + count * colWidth + (count - 1) * columnGap;
  const top = 106, step = 142, nodeHeight = 112;
  const groups = INTEL_MAP_LANES.map((lane, index) => ({ ...lane, index, x: left + index * (colWidth + columnGap), nodes: parsed.entities.filter(n => n.kind === lane.id) }));
  const positions = new Map();
  for (const group of groups) for (const [i, entity] of group.nodes.entries()) positions.set(entity.id, { x: group.x, y: top + i * step, width: colWidth, height: nodeHeight });
  const height = Math.max(390, top + Math.max(1, ...groups.map(group => group.nodes.length)) * step + 60);
  return { width, height, colWidth, groups, positions, edges: parsed.edges.filter(edge => positions.has(edge.from) && positions.has(edge.to)) };
}

const intelMapAdd = (parent, tag, label = '', cls = '') => text(parent, label, tag, cls);
const intelMapButton = (parent, label, callback, cls = '') => {
  const element = intelMapAdd(parent, 'button', label, cls);
  element.type = 'button';
  element.addEventListener('click', callback);
  return element;
};
const INTEL_SVG_NS = 'http://www.w3.org/2000/svg';
const intelSvg = (parent, type, attributes = {}) => {
  const node = parent.ownerDocument.createElementNS(INTEL_SVG_NS, type);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  parent.appendChild(node);
  return node;
};
const intelMapLabels = {
  requirements: 'REQ', hypotheses: 'HYP', collection: 'COL', analysis: 'ANL', technical: 'TEC', evidence: 'EVD', judgments: 'JDG'
};
function intelMiniText(value, max = 95) {
  const text = String(value || '');
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}
function intelEdgeMeaning(edge) {
  const { from, to, kind } = edge;
  if (kind === 'answers') return to + ' addresses ' + from;
  if (kind === 'tests') return to + ' tests ' + from;
  if (kind === 'supports') return to + ' supports ' + from;
  if (kind === 'challenges') return to + ' challenges ' + from;
  if (kind === 'collected') return to + ' was collected through ' + from;
  if (kind === 'basis') return to + ' is based on ' + from;
  if (kind === 'evaluates') return to + ' evaluates ' + from;
  if (kind === 'examines') return to + ' examines ' + from;
  if (kind === 'examines_evidence') return to + ' considers evidence ' + from;
  if (kind === 'implements') return to + ' implements collection plan ' + from;
  if (kind === 'used_for') return to + ' is used for analytical pass ' + from;
  if (kind === 'obtained_via') return to + ' attributes collection method ' + from + ' (not automatically verified)';
  if (kind === 'reasoned_by') return to + ' records reasoning pass ' + from;
  return from + ' → ' + to + ' (' + kind + ')';
}
function intelPretty(key) { return key.replace(/\b\w/g, letter => letter.toUpperCase()); }

function intelMapDiagram(container, parsed, selectedId, onSelect) {
  const containerWidth = container.getBoundingClientRect?.().width || container.clientWidth || 1210;
  const parentWidth = container.closest?.('.next-planning-detail')?.getBoundingClientRect?.().width || containerWidth;
  const viewportWidth = container.ownerDocument.defaultView?.innerWidth || containerWidth;
  const sidebarWidth = container.ownerDocument.querySelector?.('.next-planning-catalog')?.getBoundingClientRect?.().width || 300;
  const desktopBound = viewportWidth - sidebarWidth - 130;
  const availableWidth = Math.max(320, Math.floor(Math.min(containerWidth, parentWidth, desktopBound)) - 10);
  const geometry = intelligenceMapGeometry(parsed, { availableWidth });
  const viewport = intelMapAdd(container, 'div', '', 'next-intel-graph-scroll');
  viewport.id = 'next-intelligence-map';
  viewport.setAttribute('role', 'region');
  viewport.setAttribute('aria-label', 'Intelligence entities and explicit relationships');
  viewport.tabIndex = 0;
  const stage = intelMapAdd(viewport, 'div', '', 'next-intel-graph-stage');
  stage.style.width = geometry.width + 'px';
  stage.style.height = geometry.height + 'px';
  const related = new Set([selectedId]);
  for (const edge of geometry.edges) {
    if (edge.from === selectedId) related.add(edge.to);
    if (edge.to === selectedId) related.add(edge.from);
  }
  for (const group of geometry.groups) {
    const lane = intelMapAdd(stage, 'div', '', 'next-intel-graph-lane');
    lane.style.left = (group.x - 10) + 'px';
    lane.style.width = (geometry.colWidth + 20) + 'px';
    lane.style.height = (geometry.height - 20) + 'px';
    const head = intelMapAdd(lane, 'div', '', 'next-intel-graph-lane-header');
    intelMapAdd(head, 'span', group.label, 'next-intel-graph-lane-title');
    intelMapAdd(head, 'span', String(group.nodes.length).padStart(2, '0'), 'next-intel-graph-lane-count');
    intelMapAdd(lane, 'p', group.hint, 'next-help next-intel-lane-hint');
    if (!group.nodes.length) {
      const empty = intelMapAdd(lane, 'div', 'No ' + group.label.toLowerCase() + ' defined', 'next-intel-graph-empty');
      empty.style.top = '105px';
    }
  }
  const svg = intelSvg(stage, 'svg', { class: 'next-intel-graph-links', viewBox: '0 0 ' + geometry.width + ' ' + geometry.height, width: geometry.width, height: geometry.height, 'aria-hidden': true });
  const defs = intelSvg(svg, 'defs');
  const marker = intelSvg(defs, 'marker', { id: 'next-intel-graph-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
  intelSvg(marker, 'path', { d: 'M 0 1 L 10 5 L 0 9 z', fill: 'context-stroke' });
  for (const edge of geometry.edges) {
    const from = geometry.positions.get(edge.from), to = geometry.positions.get(edge.to);
    const x1 = from.x + from.width + 2, y1 = from.y + 46;
    const x2 = to.x - 3, y2 = to.y + 46;
    const bend = Math.max(36, (x2 - x1) / 2);
    const path = intelSvg(svg, 'path', {
      d: 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + bend) + ' ' + y1 + ' ' + (x2 - bend) + ' ' + y2 + ' ' + x2 + ' ' + y2,
      class: 'next-intel-graph-edge next-intel-graph-edge-' + edge.kind
        + (selectedId && edge.from !== selectedId && edge.to !== selectedId ? ' is-muted' : ''),
      'marker-end': 'url(#next-intel-graph-arrow)',
      'data-link': edge.id
    });
    const source = parsed.byId.get(edge.from), target = parsed.byId.get(edge.to);
    const title = intelSvg(path, 'title');
    title.textContent = intelEdgeMeaning(edge);
  }
  for (const entity of parsed.entities) {
    const where = geometry.positions.get(entity.id);
    const card = intelMapButton(stage, '', () => onSelect(entity.id), 'next-intel-graph-node');
    card.style.left = where.x + 'px';
    card.style.top = where.y + 'px';
    card.style.width = where.width + 'px';
    card.style.height = where.height + 'px';
    card.dataset.intelId = entity.id;
    card.dataset.intelKind = entity.kind;
    card.setAttribute('aria-pressed', String(selectedId === entity.id));
    card.setAttribute('aria-label', entity.id + ', ' + entity.title);
    if (selectedId === entity.id) card.classList.add('is-selected');
    else if (selectedId && !related.has(entity.id)) card.classList.add('is-muted');
    const eyebrow = intelMapAdd(card, 'span', '', 'next-intel-node-eyebrow');
    intelMapAdd(eyebrow, 'span', entity.id);
    intelMapAdd(eyebrow, 'span', intelMapLabels[entity.kind]);
    intelMapAdd(card, 'strong', intelMiniText(entity.title, 110), 'next-intel-node-title');
    const attribute = entity.attrs['confidence'] || entity.attrs['priority'] || entity.attrs['reliability'] || entity.attrs['source'] || entity.attrs['status'] || '';
    if (attribute) intelMapAdd(card, 'span', intelMiniText(attribute, 42), 'next-intel-node-caption');
  }
  return viewport;
}

function intelMapInspector(target, parsed, selectedId, onSelect, onJump) {
  target.replaceChildren();
  const node = parsed.byId.get(selectedId);
  if (!node) {
    intelMapAdd(target, 'span', 'ANALYTICAL INSPECTOR', 'next-intel-kicker');
    intelMapAdd(target, 'h3', 'Explore the assessment');
    intelMapAdd(target, 'p', 'Select a card to review its source text, references and analytic context.', 'next-help');
    return;
  }
  intelMapAdd(target, 'span', node.id + ' / ' + intelMapLabels[node.kind], 'next-intel-kicker');
  intelMapAdd(target, 'h3', node.title);
  const attrs = Object.entries(node.attrs);
  if (!attrs.length) intelMapAdd(target, 'p', 'No further attributes recorded.', 'next-help');
  for (const [key, value] of attrs) {
    const entry = intelMapAdd(target, 'div', '', 'next-intel-inspector-field');
    intelMapAdd(entry, 'strong', intelPretty(key));
    intelMapAdd(entry, 'p', value || 'Not yet specified', value ? '' : 'next-help');
  }
  const incoming = parsed.edges.filter(edge => edge.to === node.id || edge.from === node.id);
  if (incoming.length) {
    intelMapAdd(target, 'h4', 'Recorded relationships');
    const rows = intelMapAdd(target, 'div', '', 'next-intel-inspector-relations');
    for (const relation of incoming) {
      const other = relation.from === node.id ? relation.to : relation.from;
      const title = intelEdgeMeaning(relation);
      intelMapButton(rows, title, () => onSelect(other), 'next-intel-inspector-link');
    }
  }
  intelMapButton(target, 'Locate line ' + node.line + ' in source', () => onJump(node.line), 'next-intel-inspector-jump');
}

function intelMapDiagnostics(target, parsed, editable) {
  target.replaceChildren();
  const summary = intelMapAdd(target, 'p', parsed.entities.length + ' entities  ·  ' + parsed.edges.length + ' explicit links' + (parsed.errors.length ? '  ·  ' + parsed.errors.length + ' errors' : '') + (parsed.warnings.length ? '  ·  ' + parsed.warnings.length + ' notes' : ''), 'next-help');
  summary.classList.add('next-intel-graph-counts');
  if (parsed.errors.length) {
    const list = intelMapAdd(target, 'ul', '', 'next-intel-validation-errors');
    list.setAttribute('role', 'alert');
    for (const error of parsed.errors.slice(0, 7)) intelMapAdd(list, 'li', (error.line ? 'Line ' + error.line + ': ' : '') + error.message);
  } else if (editable) intelMapAdd(target, 'p', 'Map is derived from this source. Saving retains its text, with trailing blank lines trimmed.', 'next-help next-intel-source-success');
  if (parsed.warnings.length) {
    const hint = intelMapAdd(target, 'details', '', 'next-intel-warnings');
    intelMapAdd(hint, 'summary', 'Analytic caveats (' + parsed.warnings.length + ')');
    for (const warning of parsed.warnings.slice(0, 8)) intelMapAdd(hint, 'p', warning.message, 'next-help');
  }
}

/**
 * One source of truth, two projections. The source is never reconstructed from
 * the canvas. Selection is only a view interaction, not an automatic edit.
 */
export function renderIntelligenceMapWorkspace({
  parent, source, editable = false, project = null, onSave = async () => {},
  onCancel = () => {}, onEdit = () => {}
} = {}) {
  parent.replaceChildren();
  let current = String(source || ''), selectedId = null, mode = editable ? 'split' : 'map', busy = false;
  const shell = intelMapAdd(parent, 'section', '', 'next-intel-map-workspace');
  shell.id = 'next-intelligence-map-workspace';
  const header = intelMapAdd(shell, 'header', '', 'next-intel-map-head');
  const copy = intelMapAdd(header, 'div');
  intelMapAdd(copy, 'span', 'INTELLIGENCE MODEL / TEXT → MAP', 'next-intel-kicker');
  intelMapAdd(copy, 'h2', editable ? (project ? 'Revise the analytical model' : 'New analytical model') : (project?.name || 'Intelligence model'));
  intelMapAdd(copy, 'p', editable ? 'Write the model as structured Markdown. The diagram changes with the text.' : 'This diagram is a projection of the saved Markdown source. It does not infer new evidence or conclusions.', 'next-help');
  const toolbar = intelMapAdd(shell, 'nav', '', 'next-intel-map-toolbar');
  toolbar.setAttribute('aria-label', 'Intelligence model views');
  const viewButtons = new Map();
  const applyMode = nextMode => {
    mode = nextMode;
    for (const [value, node] of viewButtons) node.setAttribute('aria-pressed', String(mode === value));
    shell.dataset.mode = mode;
    graphPanel.hidden = mode === 'text';
    sourcePanel.hidden = mode === 'map';
    if (mode === 'source') shell.dataset.mode = 'text';
    if (mode === 'split') shell.dataset.mode = 'split';
    if (mode === 'map') shell.dataset.mode = 'map';
  };
  for (const [value, label] of [['map','Map'],['split','Map + source'],['source','Source']]) {
    const control = intelMapButton(toolbar, label, () => applyMode(value));
    control.setAttribute('aria-pressed', String(mode === value));
    viewButtons.set(value, control);
  }
  const copyButton = intelMapButton(toolbar, 'Copy LLM source', async () => {
    try {
      if (!globalThis.navigator?.clipboard?.writeText) throw Error('Clipboard write is not available.');
      await globalThis.navigator.clipboard.writeText(current);
      feedback.textContent = 'Exact source copied.';
    } catch {
      applyMode('source');
      editor.focus();
      editor.select();
      feedback.textContent = 'Source selected. Use Ctrl+C to copy.';
    }
  });
  copyButton.title = 'Copy the canonical text representation';
  const content = intelMapAdd(shell, 'div', '', 'next-intel-map-content');
  const graphPanel = intelMapAdd(content, 'section', '', 'next-intel-map-graph-pane');
  const sourcePanel = intelMapAdd(content, 'section', '', 'next-intel-map-source-pane');
  sourcePanel.id = 'next-intelligence-text-panel';
  const label = intelMapAdd(sourcePanel, 'label', 'CANONICAL MARKDOWN — LLM READ / WRITE', 'next-intel-source-label');
  const editor = intelMapAdd(label, 'textarea', '', 'next-intel-source-editor');
  editor.id = 'next-intelligence-source';
  editor.value = current;
  editor.readOnly = !editable;
  editor.spellcheck = false;
  editor.rows = 24;
  editor.maxLength = 8000;
  editor.setAttribute('aria-label', 'Canonical intelligence analysis plan source text');
  intelMapAdd(sourcePanel, 'p', 'Analytical entities: REQ, HYP, ANL, EVD, JDG. Technical work: COL, TEC. Use explicit IDs such as [ANL-1] and [TEC-1]. Link using Tests, Based on, Implements, Used for, Obtained via, Supports, Challenges, Evaluates, Analysis. Technical results do not establish analytical judgments.', 'next-help next-intel-source-help');
  const mapTop = intelMapAdd(graphPanel, 'div', '', 'next-intel-map-brief');
  const legend = intelMapAdd(graphPanel, 'div', '', 'next-intel-graph-legend');
  for (const [kind, label] of [['tests','Planned test'], ['supports','Supports'], ['challenges','Challenges'], ['basis','Evidence → judgment']]) {
    const entry = intelMapAdd(legend, 'span', '', 'next-intel-legend-item');
    const line = intelMapAdd(entry, 'i', '', 'next-intel-legend-line next-intel-graph-edge-' + kind);
    line.setAttribute('aria-hidden', 'true');
    intelMapAdd(entry, 'span', label);
  }
  const diagramArea = intelMapAdd(graphPanel, 'div', '', 'next-intel-map-diagram');
  const inspector = intelMapAdd(graphPanel, 'aside', '', 'next-intel-map-inspector');
  inspector.id = 'next-intelligence-inspector';
  inspector.setAttribute('aria-label', 'Selected intelligence entity');
  const diagnostics = intelMapAdd(shell, 'div', '', 'next-intel-map-diagnostics');
  const actions = intelMapAdd(shell, 'div', '', 'next-row next-intel-map-actions');
  let saveButton;
  if (editable) {
    saveButton = intelMapButton(actions, project ? 'Save intelligence model' : 'Save assessment draft', async () => {
      if (busy) return;
      const canonical = current.trimEnd();
      const parsed = parseIntelligenceText(canonical, { requireBrief: true });
      if (!parsed.valid) { refresh(); applyMode('split'); feedback.textContent = 'Resolve the text validation errors before saving.'; return; }
      busy = true; saveButton.disabled = true; feedback.textContent = 'Saving exact text source…';
      try { await onSave(canonical, project); current = canonical; editor.value = canonical; feedback.textContent = 'Canonical intelligence text saved.'; }
      catch (error) { feedback.textContent = error?.message || String(error); feedback.setAttribute('role', 'alert'); }
      finally { busy = false; saveButton.disabled = false; }
    }, 'next-primary');
    saveButton.id = 'next-intelligence-save';
    intelMapButton(actions, 'Cancel', onCancel);
  } else intelMapButton(actions, 'Edit underlying text', onEdit, 'next-primary');
  const feedback = intelMapAdd(actions, 'p', '', 'next-help');
  feedback.id = 'next-intelligence-receipt';
  feedback.setAttribute('role', 'status');

  const jumpToSource = line => {
    applyMode('split');
    const lines = editor.value.split('\n');
    const position = lines.slice(0, line - 1).reduce((total, value) => total + value.length + 1, 0);
    editor.focus();
    editor.setSelectionRange(position, position + (lines[line - 1] || '').length);
    const fraction = Math.max(0, (line - 3) / Math.max(1, lines.length));
    editor.scrollTop = fraction * Math.max(0, editor.scrollHeight - editor.clientHeight);
  };
  const choose = id => { selectedId = id; refresh(); };
  function refresh() {
    const parsed = parseIntelligenceText(current, { requireBrief: editable });
    if (!parsed.byId.has(selectedId)) selectedId = parsed.entities[0]?.id || null;
    const oldViewport = diagramArea.querySelector('.next-intel-graph-scroll');
    const left = oldViewport?.scrollLeft || 0, top = oldViewport?.scrollTop || 0;
    diagramArea.replaceChildren();
    mapTop.replaceChildren();
    const pir = intelMapAdd(mapTop, 'div', '', 'next-intel-pir-brief');
    intelMapAdd(pir, 'span', 'PRIORITY INTELLIGENCE REQUIREMENT', 'next-intel-kicker');
    intelMapAdd(pir, 'strong', parsed.fields.pir || 'State the priority intelligence question');
    const decision = intelMapAdd(mapTop, 'div', '', 'next-intel-decision-brief');
    intelMapAdd(decision, 'span', 'DECISION TO INFORM', 'next-intel-kicker');
    intelMapAdd(decision, 'p', parsed.fields.decision || 'Decision not yet specified');
    const viewport = intelMapDiagram(diagramArea, parsed, selectedId, choose);
    viewport.scrollLeft = left; viewport.scrollTop = top;
    intelMapInspector(inspector, parsed, selectedId, choose, jumpToSource);
    intelMapDiagnostics(diagnostics, parsed, editable);
    if (saveButton) saveButton.disabled = busy || !parsed.valid;
    feedback.textContent = current.length + '/8000 characters in canonical source';
  }
  editor.addEventListener('input', () => { current = editor.value; refresh(); });
  applyMode(mode);
  refresh();
  let lastWidth = Math.round(diagramArea.getBoundingClientRect?.().width || 0);
  const ViewResizeObserver = parent.ownerDocument.defaultView?.ResizeObserver;
  let resizeObserver = null;
  if (typeof ViewResizeObserver === 'function') {
    resizeObserver = new ViewResizeObserver(entries => {
      if (!shell.isConnected) { resizeObserver.disconnect(); return; }
      const width = Math.round(entries[0]?.contentRect?.width || diagramArea.clientWidth || 0);
      if (width && Math.abs(width - lastWidth) > 2) {
        lastWidth = width;
        refresh();
      }
    });
    resizeObserver.observe(diagramArea);
  }
  return { getSource: () => current, refresh, destroy: () => resizeObserver?.disconnect() };
}
