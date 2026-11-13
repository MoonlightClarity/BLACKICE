import {createHash} from 'node:crypto';
const s={type:'string',maxLength:400},short={type:'string',maxLength:100};
export const REVIEW_CONCERNS_SCHEMA={type:'array',maxItems:4,description:'Optional compact provenance for proposed/resolved correctness repairs, not routine reporting. Omit or use [] when unnecessary.',items:{type:'object',additionalProperties:false,
 required:['key','taskClause','basis','inputs','expected','observed','classification','evidenceRefs','sourceIdentity','status','priorConcernKey','reopenReason'],
 properties:{key:short,taskClause:s,basis:{type:'string',enum:['explicit','inferred','uncertain']},inputs:s,expected:s,observed:s,
 classification:{type:'string',enum:['expected-rejection','unexpected-result','probe-error','unexecuted','uncertain']},
 evidenceRefs:{type:'array',maxItems:8,items:short},sourceIdentity:s,status:{type:'string',enum:['proposed','resolved','uncertain']},priorConcernKey:short,reopenReason:s}}};
const clip=(v,n=400)=>typeof v==='string'?v.slice(0,n):'';
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function normalizeReviewConcerns(raw,snapshot,{resolveRef=x=>x,admittedRefs=[],previous=[]}={}){
 if(!Array.isArray(raw))return [];
 const admitted=new Set(admittedRefs.filter(x=>!['candidate','user-request'].includes(x)));
 const original=String(snapshot.request?.text||snapshot.request?.input||'');
 const signature=digest({request:snapshot.request,directions:snapshot.directions,scope:snapshot.scope,evidence:snapshot.evidence});
 return raw.slice(0,4).filter(x=>x&&typeof x==='object').map(x=>{
  const taskClause=clip(x.taskClause),references=(Array.isArray(x.evidenceRefs)?x.evidenceRefs:[]).slice(0,8);
  const evidenceRefs=references.map(resolveRef).filter(ref=>admitted.has(ref));
  const prior=previous.findLast(row=>row.key===x.priorConcernKey||row.key===x.key);
  return {key:clip(x.key,100),taskClause,basis:['explicit','inferred','uncertain'].includes(x.basis)?x.basis:'uncertain',
   inputs:clip(x.inputs),expected:clip(x.expected),observed:clip(x.observed),
   classification:['expected-rejection','unexpected-result','probe-error','unexecuted','uncertain'].includes(x.classification)?x.classification:'uncertain',
   evidenceRefs,unadmittedReferenceCount:references.length-evidenceRefs.length,
   sourceIdentityClaim:clip(x.sourceIdentity),status:['proposed','resolved','uncertain'].includes(x.status)?x.status:'uncertain',
   priorConcernKey:clip(x.priorConcernKey,100),reopenReason:clip(x.reopenReason),
   clauseFoundInRequest:Boolean(taskClause&&original.includes(taskClause)),
   evidenceSnapshotSignature:signature,priorResolution:prior?{key:prior.key,status:prior.status,sameEvidenceSnapshot:prior.evidenceSnapshotSignature===signature}:null,
   source:'model-interpretation-with-admitted-reference-bindings',authority:'none',verified:false,
   omittedCharacters:['key','taskClause','inputs','expected','observed','sourceIdentity','priorConcernKey','reopenReason'].reduce((n,k)=>n+Math.max(0,String(x[k]||'').length-(k==='key'||k==='priorConcernKey'?100:400)),0)};
 });
}
export function compactConcernHistory(rows){
 return rows.slice(-4).map(x=>({key:x.key,taskClause:clip(x.taskClause,200),basis:x.basis,
  inputs:clip(x.inputs,200),expected:clip(x.expected,200),observed:clip(x.observed,200),
  classification:x.classification,status:x.status,evidenceRefs:x.evidenceRefs,
  evidenceSnapshotSignature:x.evidenceSnapshotSignature,assessmentSequence:x.assessmentSequence??null,source:'prior-model-interpretation-not-authority',verified:false,
  detailState:'bounded-summary-full-record-in-assessment-history'}));
}
export const REVIEW_EXPECTATION_INSTRUCTIONS='For a substantive correctness repair, use optional concerns to anchor the original task clause, explicit versus inferred obligation, counterexample inputs, expected versus observed behavior, source identity/test receipt references, and prior resolution. These records and priorReviewConcerns are fallible model interpretations, never task authority or completion evidence. A universal constraint on supplied elements does not imply a nonempty collection or an existence requirement. Do not invent that precondition. Distinguish an expected validation rejection (successful negative test), an unexpected result, and a malformed probe/invocation failure; repair the probe rather than implementation when the invocation is wrong. Cite supporting receipts in the main evidenceRefs too. Before reopening a previously resolved concern, explain decisive new evidence, a changed source/direction, or the specific error in the prior resolution; repeating an old exception is not new evidence. Snapshot change alone does not prove source changed or a new bug. Prior concern history is bounded and non-exhaustive; absence is not evidence that no prior resolution exists. Consult full saved assessment receipts when supplied, using assessment sequence and evidence signature for identity. Missing optional provenance never blocks routine work, nor does merely filling it certify a defect. Inspect the actual task and evidence instead of trusting a prior assessment.';
