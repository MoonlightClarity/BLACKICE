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
  'Decompose recursively BEFORE attempting work. A goal, phase, or compound action is a group, not an executable leaf. Split it into the smallest meaningful operations: one concrete target, one operation or bounded reasoning question, one expected output and one observable completion check per leaf. Research, implement and test are groups until their actual operations are exposed. Do not hide reading, deciding, changing and checking inside one generic action or batch unrelated operations inside a shell command. A single tool call that reads one file, applies one exact patch or runs one cohesive test is one operation; arbitrary keystrokes are not useful planning units.',
  'Reasoning-only work obeys the same decomposition. Before accepting a leaf, ask whether its procedure contains independently reportable calculations, candidate assessments, condition checks or a later selection using those results. IF it does, make it a group and recursively expose those substeps before thinking through their answers. A leaf called compare all options, evaluate every constraint and choose the best bundles multiple operations even when the arithmetic is easy or the final answer is short. For a finite comparison, save each candidate assessment and each consequential independent check as its own leaf where applicable, then a separate selection using the recorded findings. One direct calculation or one direct comparison of already established values may remain atomic. Do not silently perform the whole problem under the label reasoning. Hierarchy follows actual parentId relationships, so groups and their substeps render as 1, 1.1, 1.1.1 rather than a flat phase list.',
  'Work chronologically, one leaf at a time: PLAN -> THINK/INSPECT/ACT -> RECORD THE FINDING -> RETURN TO PLANNING -> THINK AGAIN -> CONTINUE OR RESPOND. Mark exactly one eligible leaf active before doing it. Returning to Planning after the work is a required decision, including reasoning-only tasks; changing the plan is conditional on what was learned. Reasoning can return to any earlier step, and the cycle can repeat as often as the actual work needs. Expand or replace remaining work as evidence becomes available, and save those changes before attempting the affected operation. Unknown future details call for a specific discovery or reasoning leaf, not an invented detailed future. Record concise decisions and observations; keep private reasoning private.',
  'Use only capabilities declared by the active relay_task catalog. The operation, structured branch, plan.facts, revisit and reconciliation instructions below apply to schema 9 and later, including schema 10; an older catalog must use its declared planning fields and edits without inventing those newer fields or operations.',
  'For schema 10 and later, make the post-work return explicit with relay_task action:"review", expectedRevision and review:{decision:"continue"|"respond"|"blocked",summary:"what the actual findings mean for the goal and remaining work",nextStepId:"the saved next leaf, only when continuing"}. First record the preceding leaf\'s actual outcome. IF another question, operation or check remains, refine or revisit the relevant work, review with continue and execute that next leaf. ELIF an actual blocker prevents useful further work, review with blocked and preserve the unresolved dispositions. ELSE review with respond and then think through and compose the final answer from the supported findings. A done status, read, initial plan or generic completion claim is not this reassessment. Do not fabricate a plan change when the current plan is sound. A later operation, changed plan/facts or accepted user direction makes the review stale; return to Planning again before finishing. The runtime continues a premature final within the same task, preserving actual effects; it does not ask the user to restart the loop.',
  'For schema 9 and later, give each action operation:{kind:"tool",tool:"relay_workspace",action:"read",target:"the exact input file"} or operation:{kind:"reasoning",target:"the one question or comparison"}. Use the actual attached tool and its action, not the example verbatim. A reasoning leaf does not dispatch operational tools. After each tool result, reconcile that leaf with actual evidence or a blocker before any further operational call; put a separate inspection/check in its own next leaf when needed. Planning read/edit/step operations remain available throughout and do not need their own recursive planning.',
  'For schema 9 and later, treat the work tree as a Python-like algorithm. When a material user policy or observed condition selects among results, targets, parameters or next actions, save that decision as a choice group with a structured IF/ELIF/ELSE branch and evidence-backed facts before using the selected result or acting on a path. Choosing different values for the same subsequent write is still a conditional decision: choice children can record the selected result, followed by one shared output action. A reasoning leaf may compare the inputs, but conditional prose in its note or evidence does not replace the executable branch. Use only the alternatives and operators the task actually needs; a deterministic atomic request can remain one action. A choice branch is {if:expression,then:"first_path",elif:[{if:expression,then:"second_path"}],else:"fallback_path"}. Conditions are tested in order; only the first true path runs, and an unknown earlier test prevents fallthrough. Expressions recursively support and, or, not, boolean xor, and comparisons ==, !=, <, <=, >, >=, in, not in, is, is not through {compare:{left:{fact:"count"},op:">=",right:{value:3}}}. Parentheses are expressed by nesting. Identity comparisons concern None and Boolean values; incompatible types are unresolved rather than silently false. Keep the actual compound operators over observed constituent values; do not replace a multi-input policy with a model-computed eligibility/readiness fact. Source-reported Boolean flags and direct binary observations remain valid facts. Refreshed input facts reevaluate the same branch rule; preserve earlier affected attempts through revisit.',
  'For schema 9 and later, plan.facts records {id,value,evidence} for observations. Values may be booleans, numbers, strings or lists of scalar values. A null value normally means unknown; known:true with null means observed None, and known:false explicitly marks a value unknown. Known facts need their actual basis. Unknown is not false, and NOT unknown remains unknown. Gather the missing observation before selecting a path that depends on it. Record a changed observation and revisit the earlier affected decision when necessary. Do not turn ordinary preferences or absent evidence into hard gates.',
  'Return to an earlier step whenever thinking, new evidence or a failed check calls for it. For schema 9 and later, when repeated observations change the same live decision, first save the actual current outcome, then use edit operations:[{type:"revisit",stepId:"earlier_step",reason:"what changed and why this work needs reassessment"}] on that earlier decision before updating its affected facts and acting on the revised path. Do not hide a changed decision by only appending a generic reconcile step or overwriting earlier evidence. Revisit opens another attempt, preserves dated earlier results, and invalidates dependent work for review. Revisit a parent to reopen its subtree; refine the affected remaining work before proceeding. Distinct requested snapshot assessments can retain their separate decisions and artifacts: a later authoritative assessment does not make an accurate earlier snapshot false or require repeating it. Reassess existing read/write results from their receipts and actual effects; revisit does not automatically replay them or undo a file change, submission or other effect. Reconcile uncertain effects before deciding whether repetition is appropriate.',
  'For schema 9 and later, if an operation was interrupted and its effect is uncertain, first record the uncertainty as the original leaf\'s blocker, then plan and perform one read-only observation. Complete that observation with evidence and reconciliation:{callId:the_original_call_id,outcome:"confirmed"|"absent",evidence:the_actual_observation}. Use the task-unique callId from planning.sequence or the unresolved-dispatch receipt, not the provider session call ID. Confirmed means the effect was found; absent means it was checked and not found. Leave the original requested action honestly blocked if it did not succeed; explicitly revisit it before a new attempt. A successful observation tool alone does not resolve the original effect.',
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
const sameWork = (left, right) => Boolean(left) && workFields.every(key => clean(left[key]) === clean(right[key])) && JSON.stringify(left.operation) === JSON.stringify(right.operation);
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
export function validatePlanningOutline(planned, { mode, previous = {}, source = 'agent', scopeStepId, schemaVersion } = {}) {
  if (planningModeOf(mode) !== 'on' || source === 'human') return planned;
  const prior = new Map((previous.steps || []).map(step => [step.id, step]));
  const owned = ownedIds(planned.steps || [], scopeStepId);
  const actions = (planned.steps || []).filter(isAction);
  if (actions.filter(step => step.status === 'active').length > 1)
    throw fail('Planning On executes one concrete action at a time. Reconcile the current active leaf before activating another, including independent branches.', 'TASK_PLAN_ONE_ACTIVE_REQUIRED');
  const completed = actions.filter(step => step.status === 'done' && prior.get(step.id)?.status !== 'done' && (!owned || owned.has(step.id)));
  if (completed.length > 1)
    throw fail('Record one action outcome at a time. Each leaf needs its own observed result before the plan advances.', 'TASK_PLAN_ONE_OUTCOME_REQUIRED');
  if (schemaVersion >= 9) for (const old of previous.steps || []) {
    if (isAction(old) && (terminal(old) || old.pastAttempts?.length) && (!owned || owned.has(old.id)) && !actions.some(step => step.id === old.id))
      throw fail('Preserve earlier action "' + old.id + '" and its chronological results. Revisit it to change the remaining work; do not remove its history.', 'TASK_PLAN_HISTORY_REQUIRED');
  }
  for (const step of (planned.steps || []).filter(isAction)) {
    if (owned && !owned.has(step.id)) continue;
    const old = prior.get(step.id);
    if (schemaVersion >= 9 && terminal(old) && !terminal(step) && (step.attempt || 1) <= (old.attempt || 1))
      throw fail('Use the revisit edit to reopen "' + step.id + '" with a reason and preserve its earlier result.', 'TASK_PLAN_REVISIT_REQUIRED');
    // Preserve earlier completed work without manufacturing new procedures.
    if (terminal(old) && terminal(step) && old.status === step.status && sameWork(old, step)) continue;
    // An unrelated edit must not force legacy open work to invent a method.
    // Selecting it as active or completing it requires the current contract.
    if (old && !terminal(old) && !terminal(step) && sameWork(old, step) && (old.status === step.status || step.status === 'blocked')) continue;
    if (step.status === 'skipped') continue; // The plan store requires the actual skip reason.
    if (schemaVersion >= 9 && !step.operation)
      throw fail('Decompose action "' + step.id + '" into one executable operation before attempting it. Supply operation:{kind:"tool",tool,action,target} or operation:{kind:"reasoning",target}, with its concrete target, result, note and doneWhen.', 'TASK_PLAN_ATOMIC_OPERATION_REQUIRED');
    const missing = ['result', 'note', 'doneWhen'].filter(key => !clean(step[key]));
    if (missing.length) throw fail('Planning On needs a prospective work product, concrete procedure and observable completion check for action "' + step.id + '". Supply ' + missing.join(', ') + '. One precise action is valid; more steps or more words do not satisfy this requirement.', 'TASK_PLAN_DEPTH_REQUIRED');
    const procedure = comparable(step.note);
    if ([step.title, step.result, step.doneWhen].some(value => comparable(value) === procedure))
      throw fail('Action "' + step.id + '" repeats its label, result or completion criterion as its procedure. Record the actual task-specific operation or comparison in note.', 'TASK_PLAN_DEPTH_REQUIRED');
    if (step.status === 'done') {
      if (schemaVersion >= 9 && old?.status !== 'active' && old?.status !== 'done')
        throw fail('Activate the one eligible leaf "' + step.id + '" before performing and completing it. A pending outline is not executed work.', 'TASK_PLAN_ACTIVE_REQUIRED');
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
