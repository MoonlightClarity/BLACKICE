// Final outcome review can also provide structured feedback to the worker.
// Both modes retain the independent completion gate. This is not user steering
// (no change in authority, instructions, or authorization).
export function outcomeReviewFeedbackMode(value){
 if(value!==undefined&&!['gate-only','gate-and-steer'].includes(value))
  throw Object.assign(Error('Choose outcomeReviewFeedback gate-only or gate-and-steer.'),{status:400,code:'OUTCOME_REVIEW_FEEDBACK_INVALID'});
 return value;
}
const fields=['decision','summary','remaining','nextAction','reason','evidenceRefs','metadataOnlyRefs','blockers','concerns','outcomeChecks','verificationMethod','citationBindings','reviewValidation'];
export function outcomeReviewFeedback(assessment,records,{bindings=[]}={}){
 const result=Object.fromEntries(fields.filter(key=>assessment?.[key]!==undefined).map(key=>[key,structuredClone(assessment[key])]));
 const ids=new Set([...(Array.isArray(assessment?.evidenceRefs)?assessment.evidenceRefs:[]),
  ...(Array.isArray(assessment?.blockers)?assessment.blockers:[]).flatMap(row=>Array.isArray(row?.evidenceRefs)?row.evidenceRefs:[])]);
 const byId=new Map(bindings.filter(row=>row?.evidenceId).map(row=>[row.evidenceId,row]));
 result.admittedEvidence=(Array.isArray(records)?records:[]).filter(row=>ids.has(row.id)).map(row=>{
  const binding=byId.get(row.id);
  return {id:row.id,source:row.source,tool:row.tool,action:row.action,
   ...(row.callId?{callId:row.callId}:{}),...(row.success!==undefined?{success:row.success}:{}),
   ...(row.receiptId?{receiptId:row.receiptId}:{}),
   ...(binding?{directoryReceiptId:binding.receiptId,actionId:binding.actionId||binding.linkedByActionId||null,
    ...(binding.reviewOnly?{reviewOnly:true}:{})}:{})};
 });
 return {source:'independent-outcome-review',authority:'none',verified:false,
  meaning:'An independent assessment of admitted evidence, not new user direction or proof of an external effect. The final completion gate remains in force.',...result};
}
