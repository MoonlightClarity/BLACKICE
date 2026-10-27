/** A bounded, prospective source inquiry. Runtime ordering is not a reasoning certificate. */
import {createHash} from 'node:crypto';
import {tradecraftTaskFrame} from './tradecraft-planning.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const now = () => new Date().toISOString();
export function actualUserContext(run) {
  return {
    currentUserRequest: {source:'current-user-request', runId:run.userRequestRunId || run.id, at:run.userRequestAt || run.createdAt, text:run.input},
    priorUserRequests: (run.priorUserRequests || []).filter(row => row.source === 'user-request'),
    acceptedDirections: (run.events || []).filter(event => event.data?.type === 'steer' && event.data.accepted === true)
      .map((event,index) => ({source:'accepted-user-direction', runId:run.id, at:event.at, messageIndex:index,
        key:run.id + ':steer:' + (event.at || index) + ':' + createHash('sha256').update(event.data.text).digest('hex').slice(0,12), text:event.data.text}))
  };
}
export function inquiryUserFingerprint(context) {
  // Retry carries actual accepted directions into priorUserRequests. Deduplicate
  // the same provenance entry, never two distinct human messages with equal text.
  const rows = new Map();
  for (const row of context.priorUserRequests || []) rows.set(row.key || row.runId, row);
  const current = context.currentUserRequest;
  rows.set(current.runId, {...current, messageIndex:-1});
  for (const row of context.acceptedDirections || []) rows.set(row.key, row);
  const time = row => Date.parse(row.at) || 0;
  return hash([...rows.entries()].sort(([,a],[,b]) => time(a)-time(b) || (a.messageIndex ?? -1)-(b.messageIndex ?? -1))
    .map(([key,row]) => ({key,text:row.text})));
}
export function inquiryEligible({mode, enabled, toolsAvailable, scoped, schemaVersion, task, documentContext}) {
  if (mode !== 'maximal' || !enabled || !toolsAvailable || scoped || schemaVersion < 6) return false;
  const frame = tradecraftTaskFrame(task);
  // Bounded presentation/mechanical requests do not acquire an extra model turn.
  if (documentContext?.explicitShort || /\b(?:briefly|quickly|one[ -]sentence|just summarize|formatting only|typos? only|grammar only|proofread|calculate|convert|sort alphabetically)\b/i.test(task)) return false;
  return frame.analytical || frame.decisionSpecified || Boolean(documentContext);
}
export function inquiryTaskView(receipt, scopeStepId) {
  if (!receipt) return receipt;
  return {...receipt, contentItems:receipt.contentItems.map(item => {
    if (item.type !== 'inputText') return item;
    let state; try { state = JSON.parse(item.text); } catch { return item; }
    if (state?.code === 'TASK_PLAN_NOT_READY') return {...item, text:JSON.stringify({code:state.code,
      message:'The assigned scope has an unmet saved prerequisite. Read the current assigned scope before continuing.',
      taskId:state.taskId, revision:state.revision, scopeStepId:state.scopeStepId,
      dependencies:(state.dependencies || []).map(row => ({id:row.id}))})};
    if (!Array.isArray(state?.steps) || !state.taskId) return item;
    const ids = new Set([scopeStepId]);
    for (let changed = true; changed;) {
      changed = false;
      for (const step of state.steps) if (ids.has(step.parentId) && !ids.has(step.id)) { ids.add(step.id); changed = true; }
    }
    // Keep real revision/ownership for atomic edits, without the old coordinator's
    // goal, checkpoint, preferred conclusions, artifacts or self-rated audits.
    const projected = {taskId:state.taskId, revision:state.revision, schemaVersion:state.schemaVersion,
      plan:state.plan && {version:state.plan.version, detail:state.plan.detail},
      steps:state.steps.filter(step => ids.has(step.id)),
      execution:state.execution && {...state.execution, nodes:Object.fromEntries(Object.entries(state.execution.nodes || {}).filter(([,binding]) => ids.has(binding.scopeStepId)))},
      view:'assigned-prospective-inquiry-only'};
    return {...item, text:JSON.stringify(projected)};
  })};
}
export const INQUIRY_ASSIGNMENT = 'Independently investigate the actual user question before the coordinator begins its answer. Start by reading your assigned live work and recording the material questions and prospective comparison or discriminating criteria before collecting source evidence. Refine your own scope as inspection reveals consequential relationships; retain separate findings for questions with different evidence or consequences. Inspect the full relevant source, not a coordinator draft or prior assistant conclusions, preferred answer or self-rated audit. Hold the actual goal, audience and constraints fixed when comparing the strongest feasible alternatives; explanatory alternatives need different observable predictions. Provisional hypotheses are revisable, not a selected winner to justify. Report the substantive findings, locators, actual gains/losses and conditions that change the conclusion. Do not force a winner or an action the user did not request. Your result is working evidence for the coordinator to adjudicate, not a final user response or a quality certificate.';

export async function appendInquiryScope({store, taskId, runId, nodeId, stepId, signal, publish}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const state = await store.get(taskId, {signal});
    if (state.steps.some(step => step.id === stepId)) return stepId;
    try {
      // Completed history keeps its order. Put prospective work before the
      // unfinished sequence so an unrelated old pending action cannot block it.
      const firstRoot = state.steps.find(step => !step.parentId && !['done','skipped'].includes(step.status));
      const next = await store.editPlan(taskId, {operations:[{type:'add', ...(firstRoot ? {beforeId:firstRoot.id} : {}), step:{id:stepId, kind:'action', parentId:null,
        title:'Independent prospective inquiry into the actual question', status:'pending',
        note:'Refine material subquestions and criteria before inspecting evidence or choosing a conclusion.',
        result:'Source-based comparisons and findings for the coordinator to assess.',
        doneWhen:'The assigned inquiry has recorded its actual findings, evidence and consequential unresolved questions.'}}]},
      {expectedRevision:state.revision, runId, nodeId, signal, source:'runtime'});
      publish(next); return stepId;
    } catch (error) { if (error.code !== 'TASK_STATE_CONFLICT' || attempt === 3) throw error; }
  }
}

export async function runProspectiveInquiry({run, nodeId, sources, previous, persist, publish, appendScope, execute, getContext, signal}) {
  const state = run.nodes[nodeId], userFingerprint = inquiryUserFingerprint(getContext());
  const sourceFingerprint = hash(sources.map(source => ({id:source.id, sha256:source.sha256})).sort((a,b) => a.id.localeCompare(b.id)));
  const immutable = sources.every(source => /^[a-f0-9]{64}$/.test(source.sha256 || ''))
    && !/https?:\/\//i.test(JSON.stringify(getContext()));
  const matches = previous?.userFingerprint === userFingerprint && previous?.sourceFingerprint === sourceFingerprint;
  const sameFinishedTask = (previous?.finishedUserFingerprint || previous?.userFingerprint) === userFingerprint && previous?.sourceFingerprint === sourceFingerprint;
  if (previous && ['opening','running'].includes(previous.status)) {
    state.inquiry = {...structuredClone(previous), status:'uncertain', recoveredFromRunId:run.retryOf,
      error:'The earlier inquiry has no settled runtime receipt. It has not been replayed.'};
    publish(); await persist(); return state.inquiry;
  }
  if (previous?.status === 'completed' && !previous.stale && previous.immutableSources && immutable && matches) {
    state.inquiry = {...structuredClone(previous), reusedFromRunId:run.retryOf};
    publish(); await persist(); return state.inquiry;
  }
  // A failed/cancelled attempt is evidence of a failed attempt, not a reason to
  // silently pay for it again on recovery of the same accepted task.
  if (previous && sameFinishedTask && ['failed','cancelled','uncertain'].includes(previous.status)) {
    state.inquiry = {...structuredClone(previous), recoveredFromRunId:run.retryOf};
    publish(); await persist(); return state.inquiry;
  }
  const id = 'inquiry_' + run.id.replaceAll('-','').slice(0,24) + '_' + hash(nodeId).slice(0,8);
  state.inquiry = {version:1, id, status:'opening', intent:INQUIRY_ASSIGNMENT, createdAt:now(),
    userFingerprint, sourceFingerprint, immutableSources:immutable, mutableSources:false};
  publish(); await persist(); // Durable intent precedes plan edits and the provider call.
  try {
    state.inquiry.stepId = await appendScope(id);
    publish(); await persist();
    if (signal.aborted) throw Object.assign(Error('Inquiry stopped.'), {name:'AbortError'});
    const result = await execute({id, stepId:state.inquiry.stepId, prompt:INQUIRY_ASSIGNMENT, readOnly:true});
    Object.assign(state.inquiry, result, {id, finishedAt:now(),
      finishedUserFingerprint:inquiryUserFingerprint(getContext()),
      stale:state.inquiry.userFingerprint !== inquiryUserFingerprint(getContext()),
      immutableSources:immutable && !state.inquiry.mutableSources});
  } catch (error) {
    Object.assign(state.inquiry, {status:signal.aborted || error.name === 'AbortError' ? 'cancelled' : 'failed',
      error:String(error.message || error).slice(0,1000), finishedAt:now(), finishedUserFingerprint:inquiryUserFingerprint(getContext())});
  }
  publish(); await persist(); return state.inquiry;
}

export function inquiryContext(record, userContext) {
  const receipt = record.stale ? {...record, output:undefined, withheld:'User direction changed during the inquiry. Do not reuse its old comparison under the new goal.'} : record;
  return '\n\nACTUAL USER CONTEXT AT COORDINATOR START\n' + JSON.stringify(userContext)
    + '\n\nPRE-COORDINATOR INQUIRY (actual independent working receipt, not a user preference or correctness certificate)\n'
    + JSON.stringify(receipt) + '\nAdjudicate these fallible findings against the actual sources and current user goal. Preserve the recorded inquiry and other human or completed work; extend the live plan with your remaining substantive questions. A failed or stale inquiry does not establish an answer.\n';
}
