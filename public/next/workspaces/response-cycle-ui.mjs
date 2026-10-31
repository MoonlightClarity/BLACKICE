import { stableId } from '../core/dom.mjs';
import { RESPONSE_CYCLE_STAGES } from '../../response-cycle-model.mjs';
import { chatOptionChoices, validateChatOptions } from '../chat/options-model.mjs';

export const CYCLE_STAGES = Object.freeze([
  ['feasibility', 'Feasibility'], ['inference', 'Inference'], ['plan', 'Plan'], ['think', 'Think'], ['respond', 'Respond']
]);
const clone = value => structuredClone(value);
const brief = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 240);
export function stageOutputSummary(node) {
  const field = ({ viability: ['feasiblePath', 'Plausible route'], inference: ['interpretation', 'Interpretation'], plan: ['approach', 'Proposed approach'], think: ['decision', 'Evaluation'], respond: ['answer', 'Answer'] })[node.kind];
  return field && node.response?.values?.[field[0]] ? { label: field[1], text: brief(node.response.values[field[0]]) } : null;
}
export function cycleForNode(document, node) {
  return (document.cycles || []).find(cycle => cycle.id === node.id || Object.values(cycle.stageNodeIds || {}).includes(node.id));
}
export function cycleModelSelection(ctx, document, cycle, state) {
  let owner = cycle, profile = null, legacyLocked = false;
  const seen = new Set();
  while (owner && !seen.has(owner.id)) {
    seen.add(owner.id);
    const stages = new Set(Object.values(owner.stageNodeIds || {}));
    legacyLocked ||= Boolean(owner.linkedRunId) || (document.attempts || []).some(attempt => stages.has(attempt.nodeId));
    if (owner.executionProfile) { profile = owner.executionProfile; break; }
    owner = (document.cycles || []).find(item => item.id === owner.parentCycleId);
  }
  const legacyProfile = document.viability?.executionProfile || document.responseCycle?.executionProfile || null;
  if (!profile && legacyLocked) profile = legacyProfile;
  const observed = ctx.getStatus?.() || {}, defaults = { ...ctx.runtimeDefaults, ...observed.runtimeSettings };
  const status = { ...observed, defaultModel: observed.defaultModel || ctx.runtimeDefaults?.defaultModel };
  state.cycleModelDrafts ||= new Map();
  if (profile) state.cycleModelDrafts.set(cycle.id, { model: profile.model, effort: profile.effort, serviceTier: profile.serviceTier });
  else if (!state.cycleModelDrafts.has(cycle.id)) state.cycleModelDrafts.set(cycle.id, {
    model: legacyProfile?.model || 'default', effort: legacyProfile?.effort || defaults.defaultEffort || 'default', serviceTier: legacyProfile?.serviceTier || defaults.defaultServiceTier || 'default'
  });
  return { status, selected: state.cycleModelDrafts.get(cycle.id), bound: Boolean(profile) };
}
export function cycleModelRunFields(ctx, document, cycle, state) {
  const { status, selected } = cycleModelSelection(ctx, document, cycle, state);
  const value = validateChatOptions(status, selected);
  if (value.model !== selected.model) throw Error('Choose an available model with a supported identifier. The saved model was not changed.');
  return { model: value.model, effort: value.effort, serviceTier: value.serviceTier };
}
export function cycleStageRows(document, cycle) {
  return CYCLE_STAGES.map(([id, label], index) => {
    const node = document.nodes.find(item => item.id === cycle.stageNodeIds?.[id]);
    return { id, label, number: index + 1, node, state: node?.readiness?.state || 'empty' };
  });
}
export function cycleStateLabel(value) {
  return ({ paused_after_plan: 'Plan ready · paused', waiting_children: 'Working on child questions', completed: 'Cycle completed',
    running: 'Cycle running', failed: 'Cycle needs attention', cancelled: 'Cycle stopped', awaiting_input: 'Waiting for essential facts',
    needs_evidence: 'Source recovery needed', stale: 'Inputs changed', draft: 'Ready to start', idle: 'Ready to start' })[value] || String(value || 'Ready to start').replaceAll('_', ' ');
}
export function planPayload(response) {
  const keys = ['values', 'grounding', 'openQuestions', 'challengeResponses', 'acceptanceCriteria', 'steps', 'subproblems', 'checks', 'childResults'];
  return Object.fromEntries(keys.filter(key => Object.hasOwn(response || {}, key)).map(key => [key, clone(response[key])]));
}
const accuracyModes = [['exact', 'Exact'], ['bounded_estimate', 'Bounded estimate'], ['qualitative', 'Qualitative']];
const uncertaintyPolicies = [['block', 'Resolve before proceeding'], ['assumption', 'Allow a stated, supported assumption'], ['range', 'Allow a supported range'], ['omit', 'Allow an explicit omission']];
export function renderAccuracyTargets(ctx, parent, items, heading = 'Saved accuracy targets') {
  const targets = (items || []).filter(item => item.accuracy); if (!targets.length) return;
  const section = ctx.add(parent, 'section', '', 'pb-inspector-section pb-accuracy-targets');
  ctx.add(section, 'h4', heading);
  ctx.add(section, 'p', 'These targets define the accuracy and checking the task needs.', 'pb-help');
  for (const item of targets) {
    const target = item.accuracy, row = ctx.add(section, 'article', '', 'pb-cycle-finding'); row.dataset.accuracyTarget = item.id;
    ctx.add(row, 'h5', item.label || 'Required outcome');
    ctx.add(row, 'p', 'Accuracy: ' + (accuracyModes.find(([value]) => value === target.mode)?.[1] || target.mode), 'pb-response-value');
    for (const [key, label] of [['tolerance', 'Acceptable tolerance or range'], ['decisionThreshold', 'Decision threshold'], ['evidenceNeeded', 'Evidence needed'], ['consequence', 'Consequence of being wrong']]) {
      if (target[key]) ctx.add(row, 'p', label + ': ' + target[key], 'pb-help');
    }
    ctx.add(row, 'p', 'Unresolved uncertainty: ' + (uncertaintyPolicies.find(([value]) => value === target.unknownPolicy)?.[1] || target.unknownPolicy), 'pb-help');
    const stop = ctx.add(row, 'p', 'Stop checking when: ' + target.stopWhen, 'pb-response-value'); stop.dataset.accuracyStop = item.id;
  }
}
export function renderStageFindings(ctx, parent, document, node, cycle) {
  const response = node.response; if (!response) return;
  const { add, button, showSource } = ctx, stage = RESPONSE_CYCLE_STAGES.find(item => item.kind === node.kind);
  const plan = document.nodes.find(item => item.id === cycle?.stageNodeIds?.plan)?.response;
  const criterionLabel = id => plan?.acceptanceCriteria?.find(item => item.id === id)?.label || 'Criterion not available';
  const sources = (holder, ids) => {
    const row = add(holder, 'div', '', 'pb-actions');
    for (const id of [...new Set(ids || [])]) {
      const source = (document.sources || []).find(item => item.id === id);
      if (source) button(row, source.title || 'Recorded evidence', () => showSource?.(id), 'pb-quiet');
      else add(row, 'small', 'Referenced evidence is unavailable.');
    }
  };
  if (response.checks?.length) {
    const section = add(parent, 'details', '', 'pb-inspector-section pb-cycle-checks'); section.open = true;
    add(section, 'summary', 'Recorded checks · ' + response.checks.length);
    for (const finding of response.checks) {
      const row = add(section, 'article', '', 'pb-cycle-finding');
      add(row, 'h5', stage?.checks.find(item => item.id === finding.id)?.label || 'Stage check');
      add(row, 'p', 'Assessment: ' + String(finding.assessment || 'unresolved').replaceAll('_', ' '), 'pb-help');
      add(row, 'p', finding.note || '', 'pb-response-value'); sources(row, finding.sourceIds);
    }
  }
  if (response.inferences?.length) {
    const section = add(parent, 'section', '', 'pb-inspector-section'); add(section, 'h4', 'Claims and their basis');
    for (const finding of response.inferences) { const row = add(section, 'article', '', 'pb-cycle-finding'); add(row, 'h5', finding.claim); add(row, 'p', 'Basis: ' + finding.basis, 'pb-help'); add(row, 'p', finding.limitation, 'pb-response-value'); sources(row, finding.sourceIds); }
  }
  for (const [key, heading] of [['criterionResults', 'Acceptance results'], ['coverage', 'Final answer coverage']]) if (response[key]?.length) {
    const section = add(parent, 'section', '', 'pb-inspector-section'); add(section, 'h4', heading);
    for (const finding of response[key]) {
      const row = add(section, 'article', '', 'pb-cycle-finding'); add(row, 'h5', criterionLabel(finding.criterionId));
      add(row, 'p', (finding.assessment ? 'Assessment: ' + finding.assessment : 'Coverage: ' + finding.disposition), 'pb-help');
      if (finding.rationale) add(row, 'p', finding.rationale, 'pb-response-value');
      if (finding.responseExcerpt) add(row, 'blockquote', finding.responseExcerpt, 'pb-response-value');
      if (finding.limitation) add(row, 'p', finding.limitation, 'pb-help'); sources(row, finding.sourceIds);
      if (finding.receiptIds?.length) { const provenance = add(row, 'details', '', 'pb-history'); add(provenance, 'summary', 'Effect receipt provenance · ' + finding.receiptIds.length); for (const id of finding.receiptIds) add(provenance, 'p', id, 'pb-provenance'); }
    }
  }
  if (response.subproblems?.length || response.childResults?.length) {
    const section = add(parent, 'section', '', 'pb-inspector-section'); add(section, 'h4', 'Child questions and returned findings');
    for (const subproblem of response.subproblems || []) { const row = add(section, 'article', '', 'pb-cycle-finding'); add(row, 'h5', subproblem.title); add(row, 'p', subproblem.objective); add(row, 'p', (subproblem.required ? 'Required contribution. ' : 'Optional contribution. ') + subproblem.reason, 'pb-help'); sources(row, subproblem.sourceIds); renderAccuracyTargets(ctx, row, subproblem.acceptanceCriteria, 'Child accuracy targets'); }
    for (const result of response.childResults || []) { const row = add(section, 'article', '', 'pb-cycle-finding'); add(row, 'h5', response.subproblems?.find(item => item.key === result.key)?.title || 'Returned child finding'); add(row, 'p', result.summary, 'pb-response-value'); add(row, 'p', result.usedFor, 'pb-help'); sources(row, [result.sourceId]); }
  }
}

/** UI actions share the host's revision-bound cycle API; reading renders no work. */
export function renderCycleControls(ctx, parent, document, cycle, state, { stages = false, planEditor = !stages } = {}) {
  const { add, button, select, chooseNode, mutate, render } = ctx;
  const node = document.nodes.find(item => item.id === cycle.id), plan = document.nodes.find(item => item.id === cycle.stageNodeIds?.plan);
  const section = add(parent, 'section', '', 'pb-inspector-section pb-cycle-controls'); section.dataset.cycleId = cycle.id;
  add(section, 'h4', cycle.title || 'Response cycle');
  add(section, 'p', cycleStateLabel(cycle.state), 'pb-cycle-state');
  if (cycle.objective) add(section, 'p', cycle.objective, 'pb-help');
  if (cycle.summary) add(section, 'p', brief(cycle.summary), 'pb-response-value');
  const rows = cycleStageRows(document, cycle);
  add(section, 'p', rows.filter(row => row.node?.response).length + ' of 5 stages have a recorded response.', 'pb-help');
  renderAccuracyTargets(ctx, section, plan?.response?.acceptanceCriteria || cycle.acceptanceCriteria);
  if (stages) {
    const list = add(section, 'div', '', 'pb-cycle-stages');
    for (const row of rows) {
      const control = button(list, '', () => row.node && chooseNode(row.node.id), 'pb-cycle-stage'); control.disabled = !row.node;
      control.dataset.cycleStage = row.id;
      add(control, 'strong', row.number + '. ' + row.label);
      add(control, 'span', row.node?.title || 'Stage not available');
      add(control, 'small', row.state === 'ready' ? 'Response ready' : row.state.replaceAll('_', ' '));
      const summary = row.node && stageOutputSummary(row.node);
      if (summary) add(control, 'small', summary.label + ': ' + summary.text);
      else if (row.node?.prompt) add(control, 'small', brief(row.node.prompt));
    }
  }
  const pendingKey = 'cycle:' + cycle.id, pending = state.pending.has(pendingKey);
  const active = ['running', 'waiting_children', 'cancelling'].includes(cycle.state);
  const selection = cycleModelSelection(ctx, document, cycle, state), choices = chatOptionChoices(selection.status, selection.selected);
  const modelFields = add(section, 'div', '', 'pb-form-grid pb-cycle-model');
  const modelLocked = selection.bound || pending || active || Boolean(plan?.response && ['paused_after_plan', 'stale', 'needs_review'].includes(cycle.state));
  const modelChoice = (label, key, items, dataKey) => {
    const options = [...items];
    if (!options.some(item => item.id === selection.selected[key])) options.push({ id: selection.selected[key], label: selection.selected[key] || 'Not recorded', disabled: true });
    const control = select(modelFields, label, options.map(item => [item.id, item.label]), selection.selected[key]);
    control.dataset[dataKey] = cycle.id; control.dataset.fieldKey = 'cycle-model:' + cycle.id + ':' + key;
    control.disabled = modelLocked;
    for (const option of control.children) option.disabled = options.find(item => item.id === option.value)?.disabled === true;
    control.addEventListener('change', () => {
      if (control.disabled) return;
      selection.selected[key] = control.value;
      if (key === 'model') {
        const next = chatOptionChoices(selection.status, selection.selected);
        if (!next.efforts.some(item => item.id === selection.selected.effort && !item.disabled)) selection.selected.effort = 'default';
        if (!next.tiers.some(item => item.id === selection.selected.serviceTier && !item.disabled)) selection.selected.serviceTier = 'default';
      }
      render();
    });
    return control;
  };
  modelChoice('Model', 'model', choices.models, 'cycleModel');
  modelChoice('Reasoning effort', 'effort', choices.efforts, 'cycleEffort');
  modelChoice('Speed', 'serviceTier', choices.tiers, 'cycleServiceTier');
  add(section, 'p', selection.bound
    ? 'These model settings are saved for this cycle and its child cycles. Create a new independent cycle to choose different settings.'
    : 'Run saves these model settings for this cycle and its child cycles. The application default stays unchanged.', 'pb-help');
  state.cycleModes ||= new Map();
  const mode = select(section, 'Execution', [['automatic', 'Automatic'], ['plan_only', 'Plan only']], state.cycleModes.get(cycle.id) || cycle.planningExecutionMode || 'automatic');
  mode.dataset.cycleMode = cycle.id; mode.disabled = pending || active || cycle.state === 'paused_after_plan';
  const modeHelp = add(section, 'p', '', 'pb-help');
  const explainMode = () => { modeHelp.textContent = mode.value === 'plan_only' ? 'Plan only pauses after the saved Plan. You or a supervising model can edit it, then explicitly continue from its current revision.' : 'Automatic continues through the five stages and their required child cycles.'; };
  mode.addEventListener('change', () => { state.cycleModes.set(cycle.id, mode.value); explainMode(); }); explainMode();
  const submit = (action, body) => {
    state.cycleSubmissions ||= new Map();
    const fingerprint = JSON.stringify(body), key = cycle.id + ':' + action;
    let submission = state.cycleSubmissions.get(key);
    if (submission?.fingerprint !== fingerprint) { submission = { fingerprint, clientRequestId: stableId('cycle_' + action) }; state.cycleSubmissions.set(key, submission); }
    return mutate(document.id, pendingKey, '/api/planning-browser/requests/' + encodeURIComponent(document.id) + '/cycles/' + encodeURIComponent(cycle.id) + '/' + action, 'POST', { ...body, clientRequestId: submission.clientRequestId });
  };
  const actions = add(section, 'div', '', 'pb-actions');
  if (cycle.state === 'paused_after_plan') {
    const next = button(actions, 'Continue from this plan', () => {
      if (state.cyclePlanDrafts?.get(cycle.id)?.dirty || !plan?.response) return;
      void submit('continue', { expectedRequestRevision: document.revision, expectedCycleRevision: node.revision, expectedPlanRevision: plan.revision, expectedPlanResponseId: plan.response.id });
    }, 'pb-primary'); next.dataset.cycleContinue = cycle.id;
    next.disabled = pending || !plan?.response || Boolean(state.cyclePlanDrafts?.get(cycle.id)?.dirty);
    add(section, 'p', 'Inspect or edit the Plan below. Continue uses the exact saved plan revision shown here.', 'pb-help');
  } else {
    const run = button(actions, 'Run cycle', () => {
      try { void submit('run', { expectedRequestRevision: document.revision, expectedCycleRevision: node.revision, planningExecutionMode: mode.value, ...cycleModelRunFields(ctx, document, cycle, state) }); }
      catch (error) { state.error = error.message; render(); }
    }, 'pb-primary');
    run.dataset.cycleRun = cycle.id; run.disabled = pending || active;
  }
  if (plan?.response && (planEditor || stages && cycle.state === 'paused_after_plan')) renderPlanEditor({ ...ctx, submit }, parent, document, cycle, plan, state);
  return section;
}

function renderPlanEditor(ctx, parent, document, cycle, node, state) {
  const { add, button, input, select, fieldsFor, render, submit } = ctx;
  state.cyclePlanDrafts ||= new Map();
  let draft = state.cyclePlanDrafts.get(cycle.id);
  const changed = value => value.requestRevision !== document.revision || value.nodeRevision !== node.revision || value.responseId !== node.response?.id;
  if (!draft || !draft.dirty && changed(draft)) {
    draft = { plan: planPayload(node.response), requestRevision: document.revision, nodeRevision: node.revision, responseId: node.response.id, dirty: false };
    state.cyclePlanDrafts.set(cycle.id, draft);
  }
  const stale = changed(draft), pending = state.pending.has('cycle:' + cycle.id);
  const section = add(parent, 'section', '', 'pb-inspector-section pb-cycle-plan');
  add(section, 'h4', 'Edit the saved Plan');
  add(section, 'p', 'Plan revision ' + node.revision + ' · Changes are saved separately from Continue.', 'pb-help');
  const dirty = () => { draft.dirty = true; for (const control of parent.querySelectorAll('[data-cycle-continue]')) control.disabled = true; };
  if (stale) {
    add(section, 'p', 'The plan or its inputs changed. Your edits are preserved. Review the current version before saving.', 'pb-note');
    button(section, 'Reload saved plan', () => { state.cyclePlanDrafts.delete(cycle.id); render(); });
    button(section, 'Keep edits on current revision', () => { draft.requestRevision = document.revision; draft.nodeRevision = node.revision; draft.responseId = node.response.id; render(); });
  }
  const form = add(section, 'form', '', 'pb-form'); form.dataset.cyclePlanForm = cycle.id; form.inert = pending;
  const edit = (holder, label, object, key, options = {}, ownerId = object.id || 'values') => {
    const field = input(holder, label, object[key] || '', options); field.dataset.fieldKey = 'cycle-plan:' + cycle.id + ':' + ownerId + ':' + key;
    field.addEventListener('input', () => { object[key] = field.value; dirty(); }); return field;
  };
  draft.plan.values ||= {};
  for (const field of fieldsFor(node)) edit(form, field.label, draft.plan.values, field.id, { rows: 3, required: field.required, help: field.description || field.prompt });
  const checklist = (holder, label, choices, selected, save) => {
    let values = [...selected];
    const detail = add(holder, 'details', '', 'pb-history'); add(detail, 'summary', label);
    if (!choices.length) add(detail, 'p', 'No choices recorded.', 'pb-help');
    for (const [id, title] of choices) {
      const line = add(detail, 'label', '', 'pb-field'), check = add(line, 'input'); check.setAttribute('type', 'checkbox'); check.checked = selected.includes(id); add(line, 'span', title);
      check.addEventListener('change', () => { values = check.checked ? [...new Set([...values, id])] : values.filter(value => value !== id); save([...values]); dirty(); });
    }
  };
  draft.plan.acceptanceCriteria ||= []; draft.plan.steps ||= [];
  const criteria = add(form, 'section', '', 'pb-inspector-section'); add(criteria, 'h5', 'Acceptance criteria');
  for (const criterion of draft.plan.acceptanceCriteria) {
    const row = add(criteria, 'div', '', 'pb-card'); row.dataset.planCriterion = criterion.id;
    edit(row, 'Criterion', criterion, 'label', { required: true }); edit(row, 'What must be established', criterion, 'description', { rows: 2, required: true });
    const verification = select(row, 'How it is verified', [['response', 'Recorded response'], ['evidence', 'Source evidence'], ['effect', 'Observed action result']], criterion.verification);
    verification.addEventListener('change', () => { criterion.verification = verification.value; dirty(); });
    if (criterion.accuracy) {
      const accuracy = criterion.accuracy, target = add(row, 'details', '', 'pb-history'); target.open = true; target.dataset.accuracyEditor = criterion.id;
      add(target, 'summary', 'Accuracy target');
      const mode = select(target, 'Precision needed', accuracyModes, accuracy.mode); mode.dataset.accuracyMode = criterion.id;
      const tolerance = edit(target, 'Acceptable tolerance or range', accuracy, 'tolerance', { rows: 2, required: accuracy.mode === 'bounded_estimate', help: 'For an estimate, describe a range or error bound sufficient for this decision.' }, criterion.id + ':accuracy');
      mode.addEventListener('change', () => { accuracy.mode = mode.value; tolerance.required = accuracy.mode === 'bounded_estimate'; dirty(); });
      edit(target, 'Decision threshold', accuracy, 'decisionThreshold', { rows: 2, help: 'An exact cutoff or boundary if one changes the decision; otherwise leave blank.' }, criterion.id + ':accuracy');
      edit(target, 'Evidence needed', accuracy, 'evidenceNeeded', { rows: 2, required: true }, criterion.id + ':accuracy');
      edit(target, 'Consequence of being wrong', accuracy, 'consequence', { rows: 2, required: true }, criterion.id + ':accuracy');
      const uncertainty = select(target, 'Unresolved uncertainty', uncertaintyPolicies, accuracy.unknownPolicy); uncertainty.dataset.accuracyUnknownPolicy = criterion.id;
      uncertainty.addEventListener('change', () => { accuracy.unknownPolicy = uncertainty.value; dirty(); });
      edit(target, 'Stop checking when', accuracy, 'stopWhen', { rows: 2, required: true, help: 'Define when further evidence cannot change the outcome or satisfy an unmet real constraint.' }, criterion.id + ':accuracy');
      const remove = button(target, 'Remove accuracy target', () => { delete criterion.accuracy; dirty(); render(); }); remove.dataset.accuracyRemove = criterion.id;
    } else {
      const set = button(row, 'Set accuracy target', () => { criterion.accuracy = { mode: 'exact', tolerance: '', decisionThreshold: '', evidenceNeeded: '', consequence: '', unknownPolicy: 'block', stopWhen: '' }; dirty(); render(); }); set.dataset.accuracyAdd = criterion.id;
    }
    button(row, 'Remove criterion', () => { draft.plan.acceptanceCriteria = draft.plan.acceptanceCriteria.filter(item => item !== criterion); for (const step of draft.plan.steps) step.criterionIds = step.criterionIds.filter(id => id !== criterion.id); dirty(); render(); });
  }
  button(criteria, '+ Acceptance criterion', () => { draft.plan.acceptanceCriteria.push({ id: stableId('criterion'), label: '', description: '', verification: 'response' }); dirty(); render(); });
  const steps = add(form, 'section', '', 'pb-inspector-section'); add(steps, 'h5', 'Planned steps and dependencies');
  for (const [index, step] of draft.plan.steps.entries()) {
    const row = add(steps, 'details', '', 'pb-history'); row.open = !step.label; row.dataset.planStep = step.id; row.dataset.disclosureKey = 'plan-step:' + step.id; add(row, 'summary', (index + 1) + '. ' + (step.label || 'New step'));
    edit(row, 'Step', step, 'label', { required: true }); edit(row, 'What this step contributes', step, 'description', { rows: 2, required: true });
    checklist(row, 'Depends on', draft.plan.steps.filter(item => item !== step).map(item => [item.id, item.label || 'Untitled step']), step.dependsOn, values => { step.dependsOn = values; });
    checklist(row, 'Establishes criteria', draft.plan.acceptanceCriteria.map(item => [item.id, item.label || 'Untitled criterion']), step.criterionIds, values => { step.criterionIds = values; });
    checklist(row, 'Recorded sources', (document.sources || []).map(item => [item.id, item.title || 'Recorded source']), step.sourceIds, values => { step.sourceIds = values; });
    button(row, 'Remove step', () => { draft.plan.steps = draft.plan.steps.filter(item => item !== step); for (const item of draft.plan.steps) item.dependsOn = item.dependsOn.filter(id => id !== step.id); dirty(); render(); });
  }
  button(steps, '+ Planned step', () => { draft.plan.steps.push({ id: stableId('step'), label: '', description: '', dependsOn: [], criterionIds: [], sourceIds: [] }); dirty(); render(); });
  const save = add(form, 'button', 'Save plan', 'pb-primary'); save.setAttribute('type', 'submit'); save.dataset.cyclePlanSave = cycle.id; save.disabled = pending || stale;
  form.addEventListener('submit', event => {
    event.preventDefault(); if (pending || stale || !draft.dirty) return;
    const submitted = JSON.stringify(draft.plan);
    void submit('plan', { expectedRequestRevision: document.revision, expectedCycleRevision: document.nodes.find(item => item.id === cycle.id).revision, expectedPlanRevision: draft.nodeRevision, expectedPlanResponseId: draft.responseId, plan: clone(draft.plan) }).then(() => {
      if (JSON.stringify(draft.plan) === submitted && state.document?.nodes.find(item => item.id === node.id)?.response?.id !== draft.responseId) state.cyclePlanDrafts.delete(cycle.id);
      render();
    });
  });
}
