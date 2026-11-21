// Optional assessment audit, not a new task contract or completion certificate.
const text={type:'string',maxLength:400},refs={type:'array',maxItems:6,items:{type:'string',maxLength:200}};
export const OUTCOME_CHECKS_SCHEMA={type:'array',maxItems:6,description:'Optional grouped original-outcome/API checks, separate from resolved review concerns. Non-exhaustive; absence or uncertainty is not a blocker.',items:{type:'object',additionalProperties:false,
 required:['obligation','basis','contractQuote','contractRefs','resultRefs','disposition','material','reason'],
 properties:{obligation:text,basis:{type:'string',enum:['user-request','existing-interface','authorized-change','uncertain']},contractQuote:text,contractRefs:refs,resultRefs:refs,
 disposition:{type:'string',enum:['supported','contradicted','unresolved','not-applicable']},material:{type:'boolean'},reason:text}}};
const clip=v=>typeof v==='string'?v.slice(0,400):'';
const fold=v=>String(v).replace(/\s+/g,' ').trim();
function sourceText(value,depth=0){
 if(depth>10||value==null)return '';
 if(typeof value==='string'){
  let extra='';if(depth<3)try{const parsed=JSON.parse(value);if(typeof parsed==='object')extra=sourceText(parsed,depth+1);}catch{}
  return value+'\n'+extra;
 }
 if(Array.isArray(value))return value.map(v=>sourceText(v,depth+1)).join('\n');
 if(typeof value==='object')return Object.values(value).map(v=>sourceText(v,depth+1)).join('\n');
 return '';
}
export function normalizeOutcomeChecks(raw,snapshot,{resolveRef=x=>x,admittedRefs=[],metadataOnlyRefs=[]}={}){
 if(!Array.isArray(raw))return [];
 const metadata=new Set(metadataOnlyRefs),admitted=new Set(admittedRefs.filter(x=>x!=='candidate'&&!metadata.has(x)));
 const records=new Map((snapshot.evidence?.records||[]).map(row=>[row.id,row]));
 const bind=(raw,allowRequest)=>Array.isArray(raw)?[...new Set(raw.slice(0,6).filter(x=>typeof x==='string').map(resolveRef).filter(ref=>admitted.has(ref)&&(allowRequest||ref!=='user-request')))]:[];
 return raw.slice(0,6).filter(row=>row&&typeof row==='object'&&!Array.isArray(row)).map(row=>{
  const contractRefs=bind(row.contractRefs,true),resultRefs=bind(row.resultRefs,false),contractQuote=clip(row.contractQuote);
  const basis=['user-request','existing-interface','authorized-change'].includes(row.basis)?row.basis:'uncertain';
  const candidates=contractRefs.filter(ref=>basis==='existing-interface'?ref!=='user-request':ref==='user-request');
  const contractQuoteFound=Boolean(contractQuote.trim()&&candidates.some(ref=>fold(ref==='user-request'?sourceText({request:snapshot.request,directions:snapshot.directions}):sourceText(records.get(ref)?.result||records.get(ref)?.excerpt)).includes(fold(contractQuote))));
  return {obligation:clip(row.obligation),basis,contractQuote,contractRefs,resultRefs,
   disposition:['supported','contradicted','unresolved','not-applicable'].includes(row.disposition)?row.disposition:'unresolved',
   material:row.material===true,reason:clip(row.reason),contractQuoteFound,
   source:'model-outcome-interpretation-with-admitted-references',authority:'none',verified:false};
 });
}
export function outcomeAssessmentConflicts(rows){
 return rows.filter(row=>row.material&&row.disposition==='contradicted'&&
  ['user-request','existing-interface'].includes(row.basis)&&row.contractQuoteFound&&row.resultRefs.length)
  .map(row=>({obligation:row.obligation,reason:row.reason,contractRefs:row.contractRefs,resultRefs:row.resultRefs}));
}
export const OUTCOME_RECONCILIATION_INSTRUCTIONS = "Check the requested result against current artifacts and observed receipts. For an interface change, check the affected return shape, failure behavior and saved state. Use the smallest check that resolves a material question. Optional outcomeChecks records at most six grouped findings, with contractRefs, resultRefs and the relevant contractQuote. Use authorized-change for a requested interface change, unresolved when evidence is missing, and contradicted for an observed mismatch. A missing optional record is not a blocker.";
