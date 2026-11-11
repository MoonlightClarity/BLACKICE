import { stableId } from '../core/dom.mjs';
import { RESPONSE_CYCLE_STAGES,responseCycleStages } from '../../response-cycle-model.mjs';
import { CONTRACT_EFFECTS, PLAN_CONTRACT_LIMITS, normalizePlanContract, validatePlanContractFeasibility } from '../../planning-contract-model.mjs';
import { mergePlanningContractDraft, newPlanningContractWorkItem, removePlanningContractWorkItem, setPlanningOperationScopes, planningResourceLines, PLANNING_OPERATION_LABELS } from '../../planning-workspace-model.mjs';
import { chatOptionChoices, validateChatOptions } from '../chat/options-model.mjs';

export const CYCLE_STAGES = Object.freeze(RESPONSE_CYCLE_STAGES.map(stage=>Object.freeze([stage.id,stage.label])));
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
  return responseCycleStages(cycle).map(({id,label}, index) => {
    const node = document.nodes.find(item => item.id === cycle.stageNodeIds?.[id]);
    return { id, label, number: index + 1, node, state: node?.executionStatus || node?.readiness?.state || 'empty' };
  });
}
export function cycleStateLabel(value, executionStatus) {
  if (executionStatus) return ({ running: 'Cycle running', queued: 'Cycle queued', stopping: 'Cycle stopping', repairing: 'Repairing response', unknown: 'Execution status unknown' })[executionStatus] || executionStatus;
  return ({ paused_after_plan: 'Plan ready · paused', waiting_children: 'Working on child questions', completed: 'Cycle completed',
    running: 'Cycle running', failed: 'Cycle needs attention', cancelled: 'Cycle stopped', awaiting_input: 'Waiting for essential facts',
    blocked:'A resource prerequisite blocks affected work',needs_evidence: 'Source recovery needed', stale: 'Inputs changed', draft: 'Ready to start', idle: 'Ready to start' })[value] || String(value || 'Ready to start').replaceAll('_', ' ');
}
export function planPayload(response) {
  const keys = ['values', 'grounding', 'openQuestions', 'challengeResponses', 'subproblems', 'checks', 'childResults', 'userAgency',
    ...(response?.contract ? ['contract'] : ['acceptanceCriteria', 'steps'])];
  return Object.fromEntries(keys.filter(key => Object.hasOwn(response || {}, key)).map(key => [key, clone(response[key])]));
}

function rebasePlanDraft(draft, previous, response) {
  const latest = planPayload(response);
  if (Boolean(previous.contract) !== Boolean(latest.contract)) throw Error('The saved Plan format changed. Reload it after preserving your local edits.');
  if (!latest.contract) return;
  const merged = mergePlanningContractDraft(previous.contract, draft.plan.contract, latest.contract);
  const values = clone(latest.values || {});
  for (const key of new Set([...Object.keys(previous.values || {}), ...Object.keys(draft.plan.values || {})])) {
    if (JSON.stringify(previous.values?.[key]) !== JSON.stringify(draft.plan.values?.[key])) {
      if (Object.hasOwn(draft.plan.values || {}, key)) values[key] = clone(draft.plan.values[key]); else delete values[key];
    }
  }
  draft.plan = { ...latest, values, contract: merged.contract };
  draft.original = latest;
  draft.detached = [...(draft.detached || []), ...merged.detached];
  draft.dirty = JSON.stringify(draft.plan) !== JSON.stringify(latest);
}

function renderCanonicalPlanFields(ctx, form, contract, { cycleId, edit, dirty, render }) {
  const { add, button, input, select } = ctx;
  const choice = (holder, label, object, key, choices) => {
    const field = select(holder, label, choices, object[key]);
    field.dataset.fieldKey = 'cycle-plan:' + cycleId + ':' + object.id + ':' + key;
    field.addEventListener('change', () => { object[key] = field.value; dirty(); }); return field;
  };
  const optional = (holder, label, object, key) => {
    const field = edit(holder, label, object, key);
    field.addEventListener('input', () => { if (!field.value) delete object[key]; }); return field;
  };
  const choices = (holder, label, object, key, available) => {
    const group = add(holder, 'fieldset', '', 'pb-form'); add(group, 'legend', label);
    if (!available.length) add(group, 'p', 'No choices recorded.', 'pb-help');
    for (const [id, title] of available) {
      const line = add(group, 'label', '', 'pb-field'), check = add(line, 'input'); check.setAttribute('type', 'checkbox');
      check.checked = object[key].includes(id); check.dataset.fieldKey = 'cycle-plan:' + cycleId + ':' + object.id + ':' + key + ':' + id;
      add(line, 'span', title);
      check.addEventListener('change', () => { object[key] = check.checked ? [...new Set([...object[key], id])] : object[key].filter(value => value !== id); dirty(); });
    }
  };
  const intent = add(form, 'section', '', 'pb-inspector-section'); intent.dataset.canonicalPlan = cycleId;
  add(intent, 'h5', 'Execution contract');
  edit(intent, 'Task objective', contract, 'goal', { rows: 4, required: true }, 'contract');
  const criteria = add(intent, 'section', '', 'pb-inspector-section'); add(criteria, 'h5', 'Outcome criteria');
  for (const criterion of contract.criteria) {
    const row = add(criteria, 'div', '', 'pb-card'); row.dataset.contractCriterion = criterion.id;
    optional(row, 'Criterion label', criterion, 'label');
    edit(row, 'What needs to be established', criterion, 'description', { rows: 3, required: true });
    choice(row, 'Evidence needed', criterion, 'kind', [['observation', 'Observation'], ['source-coverage', 'Source coverage'], ['external-confirmation', 'External confirmation'], ['judgment', 'Judgment']]);
    optional(row, 'Resource scope', criterion, 'resourceKey');
    const count = input(row, 'Required count', criterion.targetCount ?? '', { help: 'Leave blank for one. Count distinct observed outcomes.' });
    count.setAttribute('type', 'number'); count.setAttribute('min', '1'); count.setAttribute('max', '1000'); count.setAttribute('step', '1');
    count.dataset.fieldKey = 'cycle-plan:' + cycleId + ':' + criterion.id + ':targetCount';
    count.addEventListener('input', () => { if (count.value === '') delete criterion.targetCount; else criterion.targetCount = Number(count.value); dirty(); });
    if (criterion.receiptBinding) {
      const binding = add(row, 'details', '', 'pb-history'); add(binding, 'summary', 'Saved confirmation matching');
      add(binding, 'pre', JSON.stringify(criterion.receiptBinding, null, 2), 'pb-provenance');
      button(binding, 'Clear saved confirmation matching', () => { delete criterion.receiptBinding; dirty(); render(); });
    }
    button(row, 'Remove criterion', () => {
      contract.criteria = contract.criteria.filter(item => item !== criterion);
      for (const item of contract.workItems) {
        item.criterionIds = item.criterionIds.filter(id => id !== criterion.id);
        for (const scope of item.operationScopes || []) if (scope.confirmationCriterionId === criterion.id) delete scope.confirmationCriterionId;
      }
      dirty(); render();
    });
  }
  const addCriterion = button(criteria, '+ Outcome criterion', () => { contract.criteria.push({ id: stableId('criterion'), kind: 'judgment', description: '' }); dirty(); render(); });
  addCriterion.disabled = contract.criteria.length >= PLAN_CONTRACT_LIMITS.criteria;
  const work = add(intent, 'section', '', 'pb-inspector-section'); add(work, 'h5', 'Work items and dependencies');
  for (const [index, item] of contract.workItems.entries()) {
    const row = add(work, 'details', '', 'pb-history'); row.open = !item.title; row.dataset.planWorkItem = item.id; row.dataset.disclosureKey = 'plan-work-item:' + item.id;
    add(row, 'summary', (index + 1) + '. ' + (item.title || 'New work item'));
    edit(row, 'Work item title', item, 'title', { required: true }); edit(row, 'Objective', item, 'objective', { rows: 3, required: true });
    edit(row, 'Owner', item, 'owner', { required: true });
    const confirmations = contract.criteria.filter(criterion => criterion.kind === 'external-confirmation');
    const scoped = scopes => { setPlanningOperationScopes(item, scopes); dirty(); };
    if (item.operationScopes) {
      const permissions = add(row, 'section', '', 'pb-form'); add(permissions, 'h6', 'Allowed work by target');
      for (const [scopeIndex, scope] of item.operationScopes.entries()) {
        const entry = add(permissions, 'fieldset', '', 'pb-form'); add(entry, 'legend', 'Permission ' + (scopeIndex + 1));
        const prefix = 'cycle-plan:' + cycleId + ':' + item.id + ':scope:' + scopeIndex;
        const effect = select(entry, 'Allowed operation', Object.entries(PLANNING_OPERATION_LABELS), scope.effect);
        effect.dataset.fieldKey = prefix + ':effect';
        effect.addEventListener('change', () => {
          scope.effect = effect.value;
          if (scope.effect !== 'commit') delete scope.confirmationCriterionId;
          scoped(item.operationScopes); render();
        });
        const targets = edit(entry, 'Targets · one per line', { id: item.id + '-scope-' + scopeIndex, targets: scope.resourceKeys.join('\n') }, 'targets', { rows: 2, required: true });
        targets.addEventListener('input', () => { scope.resourceKeys = planningResourceLines(targets.value); scoped(item.operationScopes); });
        if (scope.effect === 'commit') {
          const proof = select(entry, 'Confirmation needed', [['', 'Choose a confirmation'], ...confirmations.map(criterion => [criterion.id, criterion.label || criterion.description])], scope.confirmationCriterionId || '');
          proof.dataset.fieldKey = prefix + ':confirmation'; proof.required = true;
          proof.addEventListener('change', () => {
            if (proof.value) { scope.confirmationCriterionId = proof.value; item.criterionIds = [...new Set([...item.criterionIds, proof.value])]; }
            else delete scope.confirmationCriterionId;
            scoped(item.operationScopes); render();
          });
        }
        const remove = button(entry, 'Remove permission', () => { scoped(item.operationScopes.filter(other => other !== scope)); render(); });
        remove.disabled = item.operationScopes.length === 1;
      }
      const addPermission = button(permissions, 'Add permission', () => { scoped([...item.operationScopes, { effect: 'observe', resourceKeys: [] }]); render(); });
      addPermission.disabled = item.operationScopes.length >= PLAN_CONTRACT_LIMITS.operationScopes;
    } else {
      const resources = edit(row, 'Resources · one per line', { id: item.id, resourceKeys: item.resourceKeys.join('\n') }, 'resourceKeys', { rows: 3, required: true });
      resources.addEventListener('input', () => { item.resourceKeys = planningResourceLines(resources.value); });
      choices(row, 'Allowed work', item, 'effects', CONTRACT_EFFECTS.map(effect => [effect, { observe: 'Read and observe', interact: 'Interact', commit: 'Commit changes', opaque: 'Run opaque operations' }[effect]]));
      button(row, 'Set permissions by operation', () => {
        const owned = confirmations.filter(criterion => item.criterionIds.includes(criterion.id));
        scoped(item.effects.map(effect => ({ effect, resourceKeys: [...item.resourceKeys], ...(effect === 'commit' && owned.length === 1 ? { confirmationCriterionId: owned[0].id } : {}) })));
        render();
      });
    }
    choices(row, 'Waits for', item, 'dependsOn', contract.workItems.filter(other => other !== item).map(other => [other.id, other.title || 'Untitled work item']));
    choices(row, 'Outcome criteria', item, 'criterionIds', contract.criteria.map(criterion => [criterion.id, criterion.label || criterion.description || 'Untitled criterion']));
    button(row, 'Remove work item', () => { removePlanningContractWorkItem(contract, item.id); dirty(); render(); });
  }
  const addWork = button(work, '+ Work item', () => { const item = newPlanningContractWorkItem(contract, stableId('work')); item.owner = contract.workItems[0]?.owner || item.owner; contract.workItems.push(item); dirty(); render(); });
  addWork.disabled = contract.workItems.length >= PLAN_CONTRACT_LIMITS.workItems || !contract.criteria.length;
  const instructions = add(intent, 'section', '', 'pb-inspector-section'); add(instructions, 'h5', 'Instructions');
  for (const [index, instruction] of contract.instructions.entries()) {
    const row = add(instructions, 'div', '', 'pb-card'); row.dataset.contractInstruction = instruction.id;
    edit(row, 'Instruction ' + (index + 1), instruction, 'text', { rows: 3, required: true });
    choice(row, 'Handling', instruction, 'handling', [['preserve', 'Preserve requirement'], ['audit', 'Record audit findings']]);
    button(row, 'Remove instruction', () => { contract.instructions = contract.instructions.filter(item => item !== instruction); dirty(); render(); });
  }
  const addInstruction = button(instructions, '+ Instruction', () => { contract.instructions.push({ id: stableId('instruction'), text: '', handling: 'preserve' }); dirty(); render(); });
  addInstruction.disabled = contract.instructions.length >= PLAN_CONTRACT_LIMITS.instructions;
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
  const { add, button, showSource } = ctx, stage = responseCycleStages(cycle).find(item => item.kind === node.kind);
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
  add(section, 'p', cycleStateLabel(cycle.state, cycle.executionStatus), 'pb-cycle-state');
  if(cycle.pipelineVersion===1||cycle.legacyPipeline)add(section,'p','Historical Feasibility-first pipeline. Recorded results retain their original contract.','pb-help');
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
  add(section, 'p', 'Archived automatic pipeline. Saved results are read-only; create a current modular graph for new work.', 'pb-help');
  return section;
}
