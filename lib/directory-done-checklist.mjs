// The runtime verifies the checklist shape and receipt binding, not the
// semantic truth of an agent's claim about what a returned result proves.
const key = /^[a-zA-Z0-9_-]{1,48}$/;
const validKey = value => typeof value === 'string' && key.test(value);
const fail = message => Object.assign(new Error(message), {code:'DIRECTORY_DONE_CHECKLIST', status:409});
const invalid = detail => fail(detail+' No changes were made; keep the action open and take the next useful check.');
export const doneChecksSchema = {type:'array',minItems:1,maxItems:24,items:{
  type:'object',additionalProperties:false,required:['id','check'],properties:{
    id:{type:'string',pattern:key.source},
    check:{type:'string',minLength:1,maxLength:320,description:'An observable yes/no question about the requested result, not an activity tally.'},
    parentId:{type:'string',pattern:key.source,description:'Optional existing check whose outcome requires this child.'},
    requestQuote:{type:'string',minLength:3,maxLength:320,description:'Verbatim short text from the current request for an explicit user requirement. The agent cannot retire this check.'},
    advisory:{type:'boolean',description:'True for an optional preference or proposal that must not gate completion. Do not combine with requestQuote.'},
  }
}};
export const checkResultsSchema = {type:'array',maxItems:24,items:{
  type:'object',additionalProperties:false,required:['id','yes'],properties:{
    id:{type:'string',pattern:key.source},yes:{type:'boolean'},
    receipt:{type:'string',maxLength:80,description:'Required for Yes. An exact returned receipt also cited in receipts.'},
  }
}};
const normalize=value=>value.trim().replace(/\s+/g,' ');
export function validateDoneChecks(items,{requestText}={}) {
  if (!Array.isArray(items)||items.length<1||items.length>24) throw invalid('Provide 1–24 completion checks.');
  const byId=new Map();
  for(const item of items){
    if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).some(k=>!['id','check','parentId','requestQuote','advisory'].includes(k))||
       !validKey(item.id)||byId.has(item.id)||typeof item.check!=='string'||!item.check.trim()||item.check.length>320||
       item.parentId!==undefined&&!validKey(item.parentId)) throw invalid('Each check needs a unique short ID, an observable question, and an optional parent ID.');
    if(item.advisory!==undefined&&typeof item.advisory!=='boolean')throw invalid('Advisory must be true or false.');
    if(item.requestQuote!==undefined&&(item.advisory===true||typeof item.requestQuote!=='string'||normalize(item.requestQuote).length<3||item.requestQuote.length>320||
       typeof requestText==='string'&&!normalize(requestText).includes(normalize(item.requestQuote))))
      throw invalid('A required request quote must match verbatim text in the current task and cannot be advisory.');
    byId.set(item.id,item);
  }
  if(items.every(item=>item.advisory===true))throw invalid('Keep at least one non-advisory outcome check; optional checks do not establish completion.');
  for(const item of items){
    const seen=new Set([item.id]);let parent=item.parentId;
    while(parent!==undefined){
      if(seen.has(parent)||!byId.has(parent)||seen.size>=8) throw invalid('Checklist parents must exist, with no cycles and at most 8 levels.');
      if(byId.get(parent).advisory===true&&item.advisory!==true)throw invalid('A required check cannot be hidden under an advisory parent.');
      seen.add(parent);parent=byId.get(parent).parentId;
    }
  }
  return items.map(item=>({...item}));
}
export function refineDoneChecks(prior,added=[],drop=[],reason,alternatives=[],{authority,requestText}={}) {
  if(!Array.isArray(added)||!Array.isArray(drop)||(!added.length&&!drop.length)||drop.length>24||
     typeof reason!=='string'||!reason.trim()||reason.length>1200)
    throw invalid('Supply checks to add or retire and a specific reason for the change.');
  const ids=new Set(prior.map(item=>item.id)), retired=new Set(drop);
  if(drop.length!==retired.size||drop.some(id=>!ids.has(id)))throw invalid('Retire only distinct existing check IDs.');
  if(!Array.isArray(alternatives)||alternatives.length>8||alternatives.some(value=>typeof value!=='string'||!value.trim()||value.length>320)||
     drop.length&&!alternatives.length)throw invalid('Before retiring a check, list the specific alternatives considered and why they do not preserve it.');
  // Retiring a parent retires its subtree. Additions cannot reuse an ID from
  // this revision, and the caller also checks IDs retired previously.
  for(let i=0;i<prior.length;i++)for(const item of prior)if(retired.has(item.parentId))retired.add(item.id);
  if(authority!=='human'&&prior.some(item=>item.requestQuote&&retired.has(item.id)))
    throw invalid('This retirement would remove a check tied to the user request. Keep the requirement; replace the route or report it unmet.');
  if(added.some(item=>!item||ids.has(item.id)))throw invalid('Use new check IDs; do not overwrite an existing check.');
  // Validate new quotes against the current request; old explicit directions
  // retain their provenance if authenticated steering has since changed scope.
  if(typeof requestText==='string'&&added.some(item=>typeof item.requestQuote==='string'&&!normalize(requestText).includes(normalize(item.requestQuote))))
    throw invalid('A required request quote must match verbatim text in the current task.');
  return {checks:validateDoneChecks([...prior.filter(item=>!retired.has(item.id)),...added]),
    retired:prior.filter(item=>retired.has(item.id))};
}
export function checkDoneResults(items,results,cited,complete,{runId,nodeId}={}) {
  const parents=new Set(items.filter(item=>item.advisory!==true).map(item=>item.parentId).filter(Boolean));
  const directlyChecked=items.filter(item=>!parents.has(item.id)||item.requestQuote||item.advisory===true);
  const eligible=new Set(directlyChecked.map(item=>item.id));
  const submitted=results??[];
  if(!Array.isArray(submitted)||submitted.length>24) throw invalid('Supply up to 24 leaf check results.');
  const receipts=new Map(cited.map(receipt=>[receipt.id,receipt]));
  const seen=new Set(),yes=new Set();
  for(const result of submitted){
    if(!result||typeof result!=='object'||Array.isArray(result)||Object.keys(result).some(k=>!['id','yes','receipt'].includes(k))||
       !eligible.has(result.id)||seen.has(result.id)||typeof result.yes!=='boolean') throw invalid('Report each leaf and each request-backed check at most once with true (Yes) or false (No); other parent results are computed.');
    seen.add(result.id);
    const receipt=receipts.get(result.receipt);
    if((result.yes||result.receipt!==undefined)&&(!receipt||runId&&receipt.runId!==runId||nodeId&&receipt.nodeId!==nodeId||result.yes&&receipt.success!==true))
      throw invalid('Check '+result.id+' needs its exact cited, successful receipt from this run and node for Yes.');
    if(result.yes)yes.add(result.id);
  }
  const missing=directlyChecked.filter(item=>item.advisory!==true&&!yes.has(item.id)).map(item=>item.id);
  if(complete&&missing.length)throw invalid('These checks are still No or unreported: '+missing.join(', ')+'.');
  return submitted.map(result=>({...result}));
}
export function projectDoneChecks(items,recorded) {
  const latest=new Map(recorded.map(result=>[result.id,result]));
  const children=new Map();
  for(const check of items)if(check.parentId!==undefined&&check.advisory!==true){
    if(!children.has(check.parentId))children.set(check.parentId,[]);
    children.get(check.parentId).push(check.id);
  }
  const explicit=new Set(items.filter(item=>item.requestQuote).map(item=>item.id));
  const rollup=id=>(!children.has(id)||explicit.has(id)?latest.get(id)?.yes===true:true)&&
    (!children.has(id)||children.get(id).every(rollup));
  return items.map(item=>({
    id:item.id,yes:rollup(item.id),
    ...(latest.get(item.id)?.receipt?{receipt:latest.get(item.id).receipt}:{}),
  }));
}
