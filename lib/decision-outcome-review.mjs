// An independent review is an optional observation at an exact decision
// boundary. It is not a permission, effect, or substitute for direct checks.
import {createHash} from 'node:crypto';
import {OUTCOME_VERIFICATION_TRIGGERS} from './outcome-verification-methods.mjs';
const triggers=OUTCOME_VERIFICATION_TRIGGERS.filter(x=>x!=='before-final-report');
export const DECISION_REVIEW_TOOL={type:'function',name:'relay_outcome_review',
 description:'Request an independent read-only assessment of a material decision using the current task evidence. Use only when an independent judgment could change the next consequential action; direct verification and routine reversible work need no separate reviewer. The result is advice, not authorization, effect confirmation, or task completion.',
 inputSchema:{type:'object',additionalProperties:false,required:['action','trigger','actionId','proposal'],
  properties:{action:{type:'string',enum:['assess']},trigger:{type:'string',enum:triggers},
   actionId:{type:'string',description:'Exact existing Directory action whose outcome or next step is at issue.'},
   proposal:{type:'string',description:'Specific proposed next action or material outcome and the decision uncertainty to check.'}}}};
export const DECISION_REVIEW_INSTRUCTIONS='When an independent assessment could materially change a consequential decision, use relay_outcome_review at the actual boundary, not after the dependent effect has already occurred. Inspect relevant facts first. Use a direct check instead when its result resolves the question; do not invoke this reviewer for routine read/edit/test, for every tool result, or for final-report review (which the host already provides). The response is advisory and does not grant authority. Resolve concrete evidence gaps with task tools; keep independent work moving. Do not repeat an unchanged review request. A returned review-only receipt proves that this scoped assessment occurred, not that the proposed operation occurred. If the outline explicitly has an assessment step, record this receipt for that step before focusing the dependent action. A rejected focus is not permission to run a dependent effect under the previous action.';

const plain=x=>x&&typeof x==='object'&&!Array.isArray(x);
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const reply=(value,success=true,code)=>({success,actionDispatched:false,...(code?{code}:{}),
 contentItems:[{type:'inputText',text:JSON.stringify({...value,authority:'none',effectDispatched:false,verified:false})}]});
export function parseDecisionReviewArguments(args){
 if(!plain(args)||Object.keys(args).some(k=>!['action','trigger','actionId','proposal'].includes(k))||
    args.action!=='assess'||!triggers.includes(args.trigger)||typeof args.actionId!=='string'||
    !/^[A-Za-z0-9_-]{1,100}$/.test(args.actionId)||typeof args.proposal!=='string'||!args.proposal.trim())
  return null;
 return {trigger:args.trigger,actionId:args.actionId,proposal:args.proposal.trim()};
}
/** Same-snapshot/same-proposal requests share one review. A review result
 * never becomes new operational evidence; changed evidence can be reassessed. */
export function createDecisionReview({snapshot,assess,admit}){
 const cache=new Map();
 return async(args,{signal}={})=>{
  const boundary=parseDecisionReviewArguments(args);
  if(!boundary)return reply({status:'invalid',message:'Use assess, a listed trigger, an exact Directory action ID, and a concrete proposed decision.'},false,'OUTCOME_BOUNDARY_ARGUMENTS');
  admit(signal);
  const current=snapshot(),outline=current.directoryOutline;
  const action=outline?.actions.find(a=>a.id===boundary.actionId);
  if(!action)return reply({status:'invalid',message:'Choose an existing action from the current Directory outline.'},false,'OUTCOME_BOUNDARY_ACTION');
  const identity=hash({state:current.evidenceFingerprint,actionRevision:outline.actionRevision,boundary});
  if(!cache.has(identity)){
   const pending=(async()=>{
    const result=await assess({...current,decisionBoundary:boundary,candidate:{output:boundary.proposal,signal}});
    return {result,assessmentId:identity,assessedAt:new Date().toISOString()};
   })();
   cache.set(identity,pending);
   pending.catch(()=>{if(cache.get(identity)===pending)cache.delete(identity);});
  }
  const {result,assessmentId,assessedAt}=await cache.get(identity);
  admit(signal);
  const latest=snapshot();
  if(latest.evidenceFingerprint!==current.evidenceFingerprint||latest.directoryOutline?.actionRevision!==outline.actionRevision)
   return reply({status:'stale',message:'Task evidence or outline changed during review. Use the latest state; the earlier judgment is not applicable.'},false,'OUTCOME_BOUNDARY_STALE');
  const status=result?.decision==='respond'?'supported':result?.decision==='unreviewed'||!result?'unreviewed':'needs-check';
  return reply({status,boundary,assessmentId,assessedAt,actionRevision:outline.actionRevision,evidenceFingerprint:current.evidenceFingerprint,summary:result?.summary||'No supported independent assessment is available.',
   nextAction:result?.nextAction||'',remaining:result?.remaining||[],reason:result?.reason||null,
   evidenceRefs:result?.evidenceRefs||[],...(result?.verificationMethod?{verificationMethod:result.verificationMethod}:{}),
   meaning:'Advisory assessment of this decision only. Use current receipts and existing authorization; this is not verification or permission to execute.'});
 };
}
