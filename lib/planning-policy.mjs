import { isPlanningMode, normalizePlanningMode, planningModeDetail } from '../public/planning-mode.mjs';
export { selectPlanningEffort } from '../public/planning-mode.mjs';

const fail = (message, code = 'PLANNING_MODE_INVALID') => Object.assign(new Error(message), { status: 400, code });

// On/Off is the runtime ontology. Auto and Maximal are input-only aliases.
export function planningModeOf(value) {
  if (value === undefined) return undefined;
  if (!isPlanningMode(value)) throw fail('Choose On or Off task planning.');
  return normalizePlanningMode(value);
}

export function savedPlanningMode(run) {
  return planningModeOf(run.planningMode) ?? planningModeOf(run.workflow?.settings?.planningMode) ?? 'on';
}

// On applies the strongest substantive discipline. An old compact/balanced
// presentation hint cannot silently weaken it. Model effort is independent.
export function planningDetail(mode, legacyDetail) {
  planningModeOf(mode);
  return planningModeDetail(mode, legacyDetail);
}

export const PLANNING_DEPTH_INSTRUCTIONS = [
  '\nPLANNING ON: FULL SUBSTANTIVE DELIBERATION',
  'Planning On means maximal substantive planning, not merely calling the planning tool. Carry the material questions through to a useful answer. A short requested response changes presentation, not the work needed to support it. A truly atomic task may use one fully specified action; do not invent stages, alternatives, uncertainty or work to make it look deep.',
  'The initial plan commits to useful work, not an untested conclusion. A familiar workflow is a candidate method. Leave a consequential framing, diagnosis or remedy open until the relevant evidence supports it; keep dependent work conditional. Preserve accepted user choices and established facts. Inspect the material that can change the direction, then refine the remaining work. Existing evidence or a clear bounded request can justify immediate execution.',
  'Before new work, use result for the work product or desired operational state, not a predicted analytical finding. Put the concrete procedure in note and the observable completion criterion in doneWhen. For an uncertain judgment, specify the comparison or discriminating observation, with a criterion that permits confirmation, refutation or a bounded unresolved finding. Complete the inquiry when that work has been performed, not only when a favored answer wins. A negative diagnosis can finish an inquiry, not an unachieved repair or delivery. Research, analyze and verify are activity labels, not procedures; source collection alone does not complete an analytical action.',
  'At a material choice, produce a bounded piece of the actual task: instantiate the current approach and the strongest feasible alternative as actual wording, designs, allocations, predictions or other task-relevant outputs. Use the same user goal, conditions and relevant evidence for each. Record the candidates or link their real artifacts, and compare the consequential difference. Naming broad versus focused or listing generic advantages is not performing the comparison. No extra file is required when concise candidate outputs fit in the work record.',
  'Preserve the user outcome during that comparison. Evidence strength, ease of measurement, conventional presentation and ease of execution are considerations, not substitute goals. A recommendation to narrow, remove or compress something needs a concrete incremental gain that warrants the lost value; compare an actual before and after. An inferred audience or projected benefit remains an assumption. If that assumption determines the choice, keep the relevant branch visible or perform the smallest useful discriminating check.',
  'Think through the mechanism from evidence to consequence, the strongest relevant rival, and what observation would change the action. Apply that test to the actual available material. A named test, a promised future check, a plausible slogan or a confidence label is not an applied result. Existing evidence may settle the choice; do not manufacture a reversal or investigate uncertainty that cannot change it.',
  'Complete a saved action with relay_task action:"step", status:"done", stepId, the current expectedRevision, and evidence containing the actual finding, checks against doneWhen and material limits. result remains the expected output, note the planned procedure, and doneWhen the completion criterion; omit these fields when unchanged. Put completed findings in evidence, not result. If correcting only a completion payload, do not repeat work and checks already performed under the saved definition. If the question or test changes, save the revised unfinished work before claiming its result. Preserve prior evidence rather than retrofitting the original criterion to the eventual answer. A blocked or unresolved result can be useful; report it honestly and continue independent authorized work.',
  'These checks make the work inspectable. They do not certify hidden reasoning, semantic correctness or real-world success. No minimum token count, elapsed time, number of steps, named method or extra model pass establishes depth. Stop after the useful result and consequential checks are complete.'
].join('\n');

const clean = value => typeof value === 'string' ? value.trim() : '';
const comparable = value => clean(value).toLocaleLowerCase().replace(/\s+/g, ' ');
const workFields = ['result', 'note', 'doneWhen'];
const sameWork = (left, right) => Boolean(left) && workFields.every(key => clean(left[key]) === clean(right[key]));
const isAction = step => (step.kind || 'action') === 'action';
const terminal = step => ['done', 'skipped'].includes(step?.status);
export function isProspectivePlanningAction(step) {
  if (!step || !isAction(step) || terminal(step)) return false;
  if (['result', 'note', 'doneWhen'].some(key => !clean(step[key]))) return false;
  return ![step.title, step.result, step.doneWhen].some(value => comparable(value) === comparable(step.note));
}

function ownedIds(steps, root) {
  if (!root) return null;
  const owned = new Set([root]);
  for (let changed = true; changed;) {
    changed = false;
    for (const step of steps) if (owned.has(step.parentId) && !owned.has(step.id)) {
      owned.add(step.id); changed = true;
    }
  }
  return owned;
}

/**
 * Verifiable work-record requirements, not a semantic depth score.
 * Automatic On enforcement applies to agent work, never retroactively to
 * historical completions or to a person's independent plan edits.
 */
export function validatePlanningOutline(planned, { mode, previous = {}, source = 'agent', scopeStepId } = {}) {
  if (planningModeOf(mode) !== 'on' || source === 'human') return planned;
  const prior = new Map((previous.steps || []).map(step => [step.id, step]));
  const owned = ownedIds(planned.steps || [], scopeStepId);
  for (const step of (planned.steps || []).filter(isAction)) {
    if (owned && !owned.has(step.id)) continue;
    const old = prior.get(step.id);
    // Preserve earlier completed work without manufacturing new procedures.
    if (terminal(old) && terminal(step) && old.status === step.status && sameWork(old, step)) continue;
    // An unrelated edit must not force legacy open work to invent a method.
    // Selecting it as active or completing it requires the current contract.
    if (old && !terminal(old) && !terminal(step) && sameWork(old, step) && (old.status === step.status || step.status === 'blocked')) continue;
    if (step.status === 'skipped') continue; // The plan store requires the actual skip reason.
    const missing = ['result', 'note', 'doneWhen'].filter(key => !clean(step[key]));
    if (missing.length) throw fail('Planning On needs a prospective work product, concrete procedure and observable completion check for action "' + step.id + '". Supply ' + missing.join(', ') + '. One precise action is valid; more steps or more words do not satisfy this requirement.', 'TASK_PLAN_DEPTH_REQUIRED');
    const procedure = comparable(step.note);
    if ([step.title, step.result, step.doneWhen].some(value => comparable(value) === procedure))
      throw fail('Action "' + step.id + '" repeats its label, result or completion criterion as its procedure. Record the actual task-specific operation or comparison in note.', 'TASK_PLAN_DEPTH_REQUIRED');
    if (step.status === 'done') {
      if (!old || !sameWork(old, step) || !clean(old.note) || !clean(old.result)) {
        const missingPrior = workFields.filter(key => !clean(old?.[key]));
        if (missingPrior.length)
          throw fail('Completion was not saved for action "' + step.id + '": no prospective definition was saved for ' + missingPrior.join(', ') + '. Save result (expected output), note (planned procedure) and doneWhen (completion criterion) while the action is unfinished, then perform that work and record its actual findings in evidence. Do not create or rewrite the test in the same edit that declares it done.', 'TASK_PLAN_PROSPECTIVE_REQUIRED');
        const changed = workFields.filter(key => clean(old[key]) !== clean(step[key]));
        throw fail('Completion was not saved for action "' + step.id + '": prospective fields changed: ' + changed.join(', ') + '. result is the expected output, note the planned procedure, and doneWhen the completion criterion. Put actual findings and checks in evidence, not result. To report work already performed under the saved definition, preserve result, note and doneWhen (omit them from the step call) and retry status:"done" with evidence using the current expectedRevision. Do not repeat completed work solely to correct this payload. If you intend to change the promised output, procedure or criterion, save the revised unfinished action before performing and completing that revised work.', 'TASK_PLAN_PROSPECTIVE_REQUIRED');
      }
      const evidence = comparable(step.evidence);
      if ([step.title, step.result, step.note, step.doneWhen].some(value => comparable(value) === evidence))
        throw fail('Completion evidence for "' + step.id + '" repeats the planned work. Record the actual finding or checked outcome and its material limits.', 'TASK_PLAN_OBSERVATION_REQUIRED');
    }
  }
  if (planned.plan) planned.plan.detail = 'detailed';
  return planned;
}
