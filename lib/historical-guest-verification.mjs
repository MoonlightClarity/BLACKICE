import {createHash} from 'node:crypto';

const fail=message=>Object.assign(new Error(message),{code:'WORKBENCH_EFFECT_VERIFICATION_INVALID',status:409});
const plain=value=>Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype);
export const verificationHash=value=>createHash('sha256').update(value).digest('hex');
export const verificationScriptHash=script=>verificationHash(Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(script,'utf8')]));
export const verificationCanonical=value=>JSON.stringify(value,(_key,item)=>plain(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const primitive=value=>value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)||typeof value==='string'&&value.length<=4000;

/** These comparisons attest captured observations, never ordinary job completion. */
export function evaluateWorkbenchAssertions(observations,assertions,criterionIds){
  if(!plain(observations)||!Array.isArray(assertions)||assertions.length<1||assertions.length>16||!Array.isArray(criterionIds))throw fail('Use a bounded object of observations and declared criterion assertions.');
  const results=assertions.map(assertion=>{
    if(!plain(assertion)||Object.keys(assertion).some(key=>!['criterionId','path','operator','expected'].includes(key))||!criterionIds.includes(assertion.criterionId)||typeof assertion.path!=='string'||assertion.path.length>240||!['equals','notEmpty','includes'].includes(assertion.operator))throw fail('A verification assertion must name a current effect criterion and supported comparison.');
    const parts=assertion.path.split('.');
    if(parts.length>8||parts.some(part=>!/^[A-Za-z0-9_-]{1,80}$/.test(part)||['__proto__','prototype','constructor'].includes(part)))throw fail('Use bounded own-property observation paths.');
    if(Object.hasOwn(assertion,'expected')&&!primitive(assertion.expected)||assertion.operator!=='notEmpty'&&!Object.hasOwn(assertion,'expected')||assertion.operator==='includes'&&(typeof assertion.expected!=='string'||!assertion.expected))throw fail('The assertion needs a bounded primitive expected value.');
    let actual=observations;
    for(const part of parts){if(!plain(actual)||!Object.hasOwn(actual,part))throw fail('A declared observation is absent from the captured result.');actual=actual[part];}
    if(!primitive(actual))throw fail('Compare a captured primitive observation, not an object or executable expression.');
    const passed=assertion.operator==='equals'?Object.is(actual,assertion.expected):assertion.operator==='notEmpty'?typeof actual==='string'&&Boolean(actual.trim()):typeof actual==='string'&&actual.includes(assertion.expected);
    return {...assertion,actual,passed};
  });
  if(results.some(item=>!item.passed))throw fail('The captured observations did not pass every declared criterion assertion.');
  return results;
}

/** Called only by the trusted job coordinator after its live ownership/identity fence. */
export function validateWorkbenchVerification(record,context){
  if(!plain(record)||record.status!=='completed'||record.exitCode!==0||record.childrenStopped!==true||!/^[a-f0-9]{32}$/.test(record.jobId||'')||!/^[A-Za-z0-9_-]{1,80}$/.test(record.requestId||''))throw fail('Only a completed contained verification job can supply observed-effect evidence.');
  if(verificationCanonical(record.planRef)!==verificationCanonical(context.planRef))throw fail('The verification belongs to a different adopted plan.');
  if(typeof record.script!=='string'||!record.script.trim()||record.script.length>24000||record.script.includes('\0')||record.scriptSha256!==verificationScriptHash(record.script))throw fail('The verification script does not match its captured UTF-8 BOM body hash.');
  if(typeof record.stdout!=='string'||Buffer.byteLength(record.stdout,'utf8')>32768||!record.stdout.trim())throw fail('The verification needs bounded captured JSON output.');
  let observations;try{observations=JSON.parse(record.stdout);}catch{throw fail('Verification stdout must contain one strict JSON object.');}
  if(record.observations!==undefined&&verificationCanonical(record.observations)!==verificationCanonical(observations))throw fail('The declared observations differ from captured stdout.');
  if(!/^[a-f0-9]{32}$/.test(record.agentId||'')||!Number.isSafeInteger(record.guestSessionId)||record.guestSessionId<1||!Number.isSafeInteger(record.ownerRevision)||record.ownerRevision<0||typeof record.guestName!=='string'||!record.guestName.trim()||record.guestName.length>240||!Number.isFinite(Date.parse(record.finishedAt)))throw fail('Verification evidence requires its exact guest, owner revision and terminal time.');
  const assertions=evaluateWorkbenchAssertions(observations,record.assertions,context.criterionIds);
  const criterionIds=[...new Set(assertions.map(item=>item.criterionId))];
  if(record.criterionIds!==undefined&&(!Array.isArray(record.criterionIds)||verificationCanonical([...record.criterionIds].sort())!==verificationCanonical([...criterionIds].sort())))throw fail('Effect receipts may cover only criteria with passed observed assertions.');
  return {version:1,jobId:record.jobId,requestId:record.requestId,planRef:context.planRef,script:record.script,scriptEncoding:'utf8-bom',scriptSha256:record.scriptSha256,
    stdout:record.stdout,stdoutSha256:verificationHash(record.stdout),observations,assertions,criterionIds,
    guestName:record.guestName,guestSessionId:record.guestSessionId,agentId:record.agentId,ownerRevision:record.ownerRevision,
    status:'completed',exitCode:0,childrenStopped:true,finishedAt:record.finishedAt};
}

export function assertWorkbenchVerificationBinding(record,binding){
  if(!plain(binding)||binding.version!==1||binding.status!=='declared')throw fail('This run has no immutable pre-dispatch verification declaration for the job.');
  for(const key of ['jobId','requestId','planRef','script','scriptSha256','criterionIds','assertions','agentId','guestName','guestSessionId','ownerRevision']){
    if(verificationCanonical(binding[key])!==verificationCanonical(record[key]))throw fail('The captured verification differs from its pre-dispatch host declaration.');
  }
  // The durable pre-dispatch declaration proves order. Guest and host clocks
  // are different observations and are not required to be synchronized.
  if(!Number.isFinite(Date.parse(binding.declaredAt)))throw fail('The host verification declaration has no recorded time.');
  return {declaredAt:binding.declaredAt,timeoutMs:binding.timeoutMs,bindingSha256:verificationHash(verificationCanonical(binding))};
}

/** Host-only handback observations; no guest execution or invented script result. */
export function validateWorkbenchControlVerification(record,context,currentControl){
  if(!plain(record)||!/^[a-f0-9]{32}$/.test(record.verificationId||'')||!/^[A-Za-z0-9_-]{1,80}$/.test(record.requestId||'')||verificationCanonical(record.planRef)!==verificationCanonical(context.planRef)||!Number.isFinite(Date.parse(record.observedAt)))throw fail('Host-control verification needs its current adopted plan and stable observation identity.');
  if(!plain(record.control)||Object.keys(record.control).some(key=>!['owner','revision','authorizedReturn','featuresRestored'].includes(key))||record.control.owner!=='user'||!Number.isSafeInteger(record.control.revision)||record.control.revision<0||record.control.authorizedReturn!==true||record.control.featuresRestored!==true||verificationCanonical(record.control)!==verificationCanonical(currentControl))throw fail('The authorized human control and feature restoration have not been observed at this exact revision.');
  if(!Array.isArray(record.assertions)||record.assertions.some(item=>!['control.owner','control.revision','control.authorizedReturn','control.featuresRestored'].includes(item?.path)))throw fail('Host-control assertions may inspect only actual ownership and restoration metadata.');
  const assertions=evaluateWorkbenchAssertions({control:currentControl},record.assertions,context.criterionIds),criterionIds=[...new Set(assertions.map(item=>item.criterionId))];
  if(!Array.isArray(record.criterionIds)||verificationCanonical([...record.criterionIds].sort())!==verificationCanonical([...criterionIds].sort()))throw fail('Control receipts cover only their declared observed criterion assertions.');
  return {version:1,kind:'host-control-state',verificationId:record.verificationId,requestId:record.requestId,planRef:context.planRef,control:currentControl,observedAt:record.observedAt,assertions,criterionIds};
}
