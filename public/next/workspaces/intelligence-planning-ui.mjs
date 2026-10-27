import { text } from '../core/dom.mjs';
import { INTELLIGENCE_STAGES, intelligenceProjectDraft, intelligenceProjectEditable } from './intelligence-planning-model.mjs';

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
