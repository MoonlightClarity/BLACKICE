// Preserve task-level quantifiers across file/package boundaries. This is an
// attention index, not a semantic classifier, coverage proof, or completion gate.
export function directoryRequirementScope(ledger,assignedIds=[]){
 const assigned=new Set(assignedIds);
 return (ledger?.requirements||[]).filter(row=>assigned.has(row.id)||/\b(?:all|every|each|any)\b/i.test(row.statement||''))
  .map(row=>({id:row.id,statement:row.statement,
   assigned:assigned.has(row.id),
   scope:/\b(?:all|every|each|any)\b/i.test(row.statement||'')?'cross-operation-candidate':'assigned',
   applicability:'unassessed',source:'task-requirement-ledger',selection:'lexical-quantifier-candidate-not-exhaustive'}));
}
export function directoryRequirementScopeIndex(ledger,assignedIds=[]){
 const rows=directoryRequirementScope(ledger,assignedIds);
 return {detailsField:'requirementScope',items:rows.length,crossOperationCandidates:rows.filter(x=>x.scope==='cross-operation-candidate').length,source:'run-ledger-snapshot',applicability:'unassessed',coverageClaim:false};
}
export const DIRECTORY_SCOPE_INSTRUCTIONS='The requirementScope field may be an exact saved reference; read relevant saved clauses with the provided context tool rather than treating offloaded details as absent. This is a run-ledger snapshot, not a refreshed effective contract: apply later authoritative task corrections over this index. Requirement scope is a non-exhaustive lexical attention index, not evidence of success or failure. Task text may quote other parties or describe only a local operation; candidate presence does not make it a global invariant or new authority. For each cross-operation candidate, inspect the public operations owned by this work item, including read-only/query paths, and assess applicability from the original task and source rather than assuming another file owns the whole invariant. Preserve the original quantifier; a check in one operation does not establish it in all operations. Distinguish explicit constraints from reasonable inferred API invariants and genuinely ambiguous scope. Do not invent a mandatory behavior from a quantifier alone. Record relevant operations, interpretation, and observed checks or uncertainty in the finding. Use a small targeted negative/boundary check when it materially resolves scope; do not rerun completed effects or require a formal coverage-map deliverable.';
