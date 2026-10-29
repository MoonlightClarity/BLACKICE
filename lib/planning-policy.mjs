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
  'Plan backward from the user’s desired outcome. A plan is a revisable choice of actions under uncertainty, not a checklist for rejecting imperfect options. Assess what would actually produce success, the evidence that the person or approach can deliver it, and the likely benefit, cost, downside and opportunity cost of the next action. Preserve actual user constraints; treat third-party qualification language and conventional prerequisites as evidence to weigh, not automatic vetoes. A realistic ability to do the work can justify pursuing an opportunity despite missing stated credentials. Use qualitative, evidence-based likelihoods unless numerical estimates are supported; do not manufacture probabilities or impose a confidence threshold the user did not choose.',
  'The initial plan commits to useful work, not an untested conclusion. A familiar workflow is a candidate method. Leave a consequential framing, diagnosis or remedy open until the relevant evidence supports it; keep dependent work conditional. Preserve accepted user choices and established facts. Inspect the material that can change the direction, then refine the remaining work. Existing evidence or a clear bounded request can justify immediate execution.',
  'Before new work, use result for the work product or desired operational state, not a predicted analytical finding. Put the concrete procedure in note and the observable completion criterion in doneWhen. For an uncertain judgment, specify the comparison or discriminating observation, with a criterion that permits confirmation, refutation or a bounded unresolved finding. Complete the inquiry when that work has been performed, not only when a favored answer wins. A negative diagnosis can finish an inquiry, not an unachieved repair or delivery. Research, analyze and verify are activity labels, not procedures; source collection alone does not complete an analytical action.',
  'At a material choice, produce a bounded piece of the actual task: instantiate the current approach and the strongest feasible alternative as actual wording, designs, allocations, predictions or other task-relevant outputs. Use the same user goal, conditions and relevant evidence for each. Record the candidates or link their real artifacts, and compare the consequential difference. Naming broad versus focused or listing generic advantages is not performing the comparison. No extra file is required when concise candidate outputs fit in the work record.',
  'Represent the user’s interests in the actual choice, work product and next action. The evidence needed for a worthwhile application, proposal, reversible attempt or useful probe can be less than the evidence needed for a final commitment. Compare the value of trying, checking, waiting and losing the option. When an unknown cannot change the next action, continue; when it can and the check is worthwhile, resolve that specific unknown. Imperfect fit is not a failed outcome, and a negative finding about one credential is not a verdict on the person’s ability to do the work.',
  'Infer the desired direction and positioning from the whole relevant record, including the current user request, stated aims and framing. Use past work or subject matter as evidence and transferable capability rather than assuming it defines the destination; retain credible adjacent options without letting them displace the primary direction by default. When choosing among existing artifacts, compare their relevance, detail and audience fit; use a more detailed source for grounding without automatically sending it, and choose depth when the actual task requires it. Follow explicit user choices.',
  'For outward-facing work, decide what belongs in the answer before polishing its wording. Start with the actual question, the recipient’s relevant decision and the user’s objective; select the strongest supported evidence that advances them and make the connection explicit. The background record is evidence to draw from, not a disclosure checklist. Leave out true but unhelpful facts, weak self-ratings and limitation topics that the question does not require; do not invent a question about a gap to justify introducing it. Keep private assessment and negotiating limits distinct from what is sent. Answer material factual questions accurately, with the scope needed to avoid a misleading claim. Review the actual answer for useful content selection as well as truthful wording; calling it tailored or calibrated in a plan does not establish either.',
  'Carry the user-authorized outcome through ordinary steps needed to complete it. Infer routine, necessary intermediate actions from the requested end-to-end objective and do not add per-step reconfirmations for those actions. Preserve user constraints and actual host or service controls; the objective does not authorize unrelated actions.',
  'Distinguish mutually exclusive choices from independent additive actions. Compare alternatives before committing when the user requires a choice, an action would foreclose another, or a real prerequisite or material constraint makes comparison necessary. When useful actions can each advance the authorized goal independently, comparison can prioritize remaining work; it is not by itself a prerequisite for an already-ready action. Continue to honor actual dependencies, user-imposed ordering or limits, and checks needed for the action itself.',
  'Preserve the user outcome during that comparison. Evidence strength, ease of measurement, conventional presentation and ease of execution are considerations, not substitute goals. A recommendation to narrow, remove or compress something needs a concrete incremental gain that warrants the lost value; compare an actual before and after. An inferred audience or projected benefit remains an assumption. If that assumption determines the choice, keep the relevant branch visible or perform the smallest useful discriminating check.',
  'Think through the mechanism from evidence to consequence, the strongest relevant rival, and what observation would change the action. Apply that test to the actual available material. A named test, a promised future check, a plausible slogan or a confidence label is not an applied result. Existing evidence may settle the choice; do not manufacture a reversal or investigate uncertainty that cannot change it.',
  'Before reporting completion, reconcile the requested work and material options already encountered with their actual dispositions. Expose meaningful deferred, blocked and unreviewed work and why it remains; do not silently narrow the scope or turn a partial search into no matches. For an execution error, distinguish evidence that input was never dispatched from a possibly sent request. Refresh and recover the former; reconcile effects before retrying the latter. Keep independent ready work moving.',
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
