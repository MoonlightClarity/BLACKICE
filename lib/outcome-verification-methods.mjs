// Outcome verification is a model-selected method, not a second execution
// contract or permission gate. Keep the method repertoire small and reusable.
export const OUTCOME_VERIFICATION_METHODS=Object.freeze([
 'direct-result','requirement-coverage','chronological-waterfall',
 'effect-reconciliation','contract-counterexample','grounded-content','other',
]);
export const OUTCOME_VERIFICATION_TRIGGERS=Object.freeze([
 'before-consequential-effect','after-material-effect','before-dependent-action',
 'on-uncertain-outcome','on-contradiction-or-failure','after-material-change','before-final-report',
]);
export const VERIFICATION_TIMING_INSTRUCTIONS=[
 'Choose WHEN to verify from the consequences of being wrong, the freshness of existing evidence, and which later decision needs the result. Select a trigger and the specific observation that would resolve it; not a fixed interval or a check after every tool call.',
 'Before a consequential effect: check only the actual prerequisites whose absence would make the effect wrong, unauthorized, or difficult to reverse. A known prerequisite does not need a redundant read.',
 'After a material effect, verify its actual result when confirmation is required or a dependent decision relies on it. A tool response can already contain sufficient confirmation; do not add a read just to obtain another receipt.',
 'Before a dependent action: establish the required earlier outcome while it can still prevent a wrong later action. Waterfall applies at material dependency boundaries, not routine inspection, patching, or testing activities for one bounded result.',
 'On an uncertain outcome: reconcile the exact prior effect before any conflicting retry or dependent commit. Unknown is neither success nor absence. Preserve independent progress where possible.',
 'On a material contradiction or failure, verify the first boundary that could change the next action, before committing to the existing hypothesis. After a material change, recheck only affected or stale claims; unaffected evidence remains usable.',
 'Before final report: check remaining requested outcomes and relevant evidence. Reuse already sufficient checks; do not repeat completed effects or reopen settled work just because another model is reviewing it. For simple content or reversible work, one proportionate end check may be enough.',
 'These are task-dependent verification opportunities, not mandatory calls, extra user deliverables, review-count quotas, or permission gates.'
].join('\n');
export const OUTCOME_VERIFICATION_METHOD_SCHEMA={
 type:'object',additionalProperties:false,required:['methods','reason'],
 description:'Advisory choice of the simplest sufficient verification method(s) for this task; never completion evidence.',
 properties:{methods:{type:'array',items:{type:'string',enum:[...OUTCOME_VERIFICATION_METHODS]}},
 reason:{type:'string',maxLength:400},
 triggers:{type:'array',items:{type:'string',enum:[...OUTCOME_VERIFICATION_TRIGGERS]},description:'Optional event boundaries selected for the actual verification method; not proof that the checks occurred.'}}
};
export const ADAPTIVE_VERIFICATION_INSTRUCTIONS=[
 'Select the simplest sufficient outcome-verification method for the actual request and current evidence; combine methods only where useful. Method selection is not an additional user deliverable or proof of success.',
 'direct-result: one bounded outcome; inspect the actual result. Ordinary read/edit/test activities for one result remain one leaf.',
 'requirement-coverage: distinct requested outcomes; map each material requirement to observed evidence and check integration where necessary. Keep independent outcomes independent.',
 'chronological-waterfall: consequential dependent state transitions; establish facts and prerequisites, verify the outline and dependency order, observe each required outcome before its dependent effect, then check the final state. Do not impose a waterfall on unrelated or simple work.',
 'effect-reconciliation: an external effect may already have occurred; distinguish confirmed occurrence, confirmed absence and unknown by current exact destination or authoritative receipt evidence. Never prescribe conflicting retry or commit while unknown.',
 'contract-counterexample: technical/interface repairs; compare written requirements with the actual saved behavior, test the negative boundary (specified error/result, unchanged state, no unintended effect), adjacent success, and affected integration. Do not invent unstated requirements or anchor on earlier smoke-test success.',
 'grounded-content: analysis, research or writing; check coverage, accuracy, provenance and the requested deliverable without inventing external work.',
 'other: a task-specific method when these do not fit. Existing owner limits, evidence rules, and unresolved-effect gates remain in force for every method.'
].join('\n')+'\n'+VERIFICATION_TIMING_INSTRUCTIONS;
export const PLANNING_VERIFICATION_INSTRUCTIONS=ADAPTIVE_VERIFICATION_INSTRUCTIONS+
 '\nFor preparation, apply the selected method in the proposed observable action outcomes and actual dependency edges. Briefly state the verification method and timing in reason when material. Put checks that must precede consequential dependent effects before those effects in the outline. Do not defer those checks to final review. Decompose outcomes, not routine read/edit/test activities. Verify outline coverage against the current request; a proposed plan records no execution.';
export const OUTLINE_REVIEW_INSTRUCTIONS=
 'The current Directory outline is coordination data from the host. Its objectives, observations and completion claims can be agent-authored; observed state is not independent outcome proof. Use its dependencies to identify required coverage and chronological prerequisites. Check whether the required evidence was available at the relevant decision boundary; a later observation is not proof that a prerequisite was checked earlier. A receipt reservedAt records admission, not exact dispatch; returnedAt records when its result became available to the host. Do not treat a lack of timing metadata as proof of a violation; resolve a material gap using existing evidence where possible. Only use exact admitted evidence aliases for the results themselves. A Directory receipt ID is not a reviewer citation. A binding without a current citation means that the original result is not admitted in this review. Do not turn a missing optional binding into an invented failure or replay a completed effect to recover evidence.';

export function normalizeVerificationMethod(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||!Array.isArray(value.methods)||
    !value.methods.length||!value.methods.every(method=>OUTCOME_VERIFICATION_METHODS.includes(method))||
    typeof value.reason!=='string'||!value.reason.trim())return undefined;
 const triggers=Array.isArray(value.triggers)&&value.triggers.length&&value.triggers.every(trigger=>OUTCOME_VERIFICATION_TRIGGERS.includes(trigger))?[...new Set(value.triggers)]:undefined;
 return {methods:[...new Set(value.methods)],reason:value.reason.trim().slice(0,400),...(triggers?{triggers}:{})};
}

// Bind only exact host-tracked Directory receipts from this run/node to actual
// admitted tool-delivery records. Never parse model-authored receipt text to
// infer a correspondence. Unmapped earlier claims stay visible but unbound.
export function directoryOutcomeOutline(snapshot,receiptCallIds,records,{runId,nodeId,includeActionReceipts=false}={}){
 if(!snapshot||!Array.isArray(snapshot.actions)||!Array.isArray(snapshot.receipts))return undefined;
 const admitted=new Map((Array.isArray(records)?records:[]).filter(row=>typeof row?.id==='string'&&((row.source==='admitted-tool-delivery'&&row.id===row.callId)||row.source==='host-decision-assessment')).map(row=>[row.id,row]));
 const cited=new Set();
 const actions=snapshot.actions.map(a=>{
  const observation=a.observation;
  const receipts=Array.isArray(observation?.receipts)?observation.receipts:[];
  for(const id of receipts)cited.add(id);
  return {id:a.id,objective:a.objective,state:a.state,dependsOn:[...(a.dependsOn||[])],
    ...(a.parentId?{parentId:a.parentId}:{}),
    ...(Array.isArray(a.doneChecks)?{doneChecks:structuredClone(a.doneChecks)}:{}),
    ...(observation?{observation:{authority:observation.authority,claim:observation.claim,receipts:[...receipts],
      ...(observation.blocker?{blocker:observation.blocker}:{})}}:{})};
 });
 const links=snapshot.receipts.filter(r=>cited.has(r.id)||(includeActionReceipts&&r.runId===runId&&r.nodeId===nodeId)||(r.state==='unknown'&&r.observationOnly!==true&&r.canLinkRead!==true)).map(r=>{
  const callId=receiptCallIds?.get(r.id),row=admitted.get(callId);
  const bound=r.taskId===snapshot.taskId&&r.runId===runId&&r.nodeId===nodeId&&r.state==='returned'&&row?.tool===r.tool&&(!r.reviewOnly||row.source==='host-decision-assessment'&&row.reviewId===r.reviewOnly.assessmentId&&row.receiptId===r.id);
  return {receiptId:r.id,actionId:r.actionId??null,state:r.state,success:r.success??null,tool:r.tool,
    ...(typeof r.at==='string'?{reservedAt:r.at}:{}),
    ...(typeof r.returnedAt==='string'?{returnedAt:r.returnedAt}:{}),
    ...(r.observationOnly===true?{observationOnly:true}:{}),
    ...(r.reviewOnly?{reviewOnly:structuredClone(r.reviewOnly)}:{}),
    ...(r.actionDispatched===false?{actionDispatched:false}:{}),
    ...(r.linkedByActionId?{linkedByActionId:r.linkedByActionId}:{}),
    ...(bound?{evidenceId:row.id}:{evidenceId:null})};
 });
 return {source:'host-directory-outline',taskId:snapshot.taskId,revision:snapshot.revision,actionRevision:snapshot.actionRevision,
  focus:snapshot.focus??null,ready:[...(snapshot.ready||[])],actions,receiptLinks:links};
}
export function bindDirectoryReviewAliases(outline,referenceIndex){
 if(!outline)return undefined;
 const aliasById=new Map(referenceIndex.map(row=>[row.evidenceId,row.citationRef]));
 return {...outline,receiptLinks:(outline.receiptLinks||[]).map(({citationRef:ignored,...link})=>({...link,
   citationRef:aliasById.get(link.evidenceId)||null}))};
}
