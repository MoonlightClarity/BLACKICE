import {createDirectoryToolContract} from './task-action-directory-tool-contract.mjs';
import {createHash} from 'node:crypto';
import {doneChecksSchema,checkResultsSchema,validateDoneChecks,refineDoneChecks,checkDoneResults,projectDoneChecks} from './directory-done-checklist.mjs';

const fail=(code,message)=>Object.assign(Error(message),{code,status:409});
const observeOutcomes=['objective-met','partial'];
const blockerKinds=['prerequisite-unavailable','search-limit-reached','no-viable-route','unresolved-effect'];
const copy=value=>structuredClone(value);
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(value);
const text=(value,max=1200)=>typeof value==='string'&&value.trim()&&value.length<=max;
const qualifyStatuses=['verified','unmet','unknown'];
const checkIdSchema={type:'string',minLength:1,maxLength:48,pattern:'^[A-Za-z0-9_-]+$',description:'Short ID using only letters, digits, underscore or hyphen; for example fully_remote.'};
const qualifyingSchema={type:'object',additionalProperties:false,required:['minQualifyingCount','requiredChecks'],properties:{minQualifyingCount:{type:'integer',minimum:1,maximum:16,description:'Required lower bound only. Do not use this field for a cap such as up to N.'},requiredChecks:{type:'array',minItems:1,maxItems:8,uniqueItems:true,items:checkIdSchema}}};
const candidateRowsSchema={type:'array',minItems:0,maxItems:16,description:'For a qualifying contract, give distinct candidates and their source reads. For partial with no candidate checked, omit candidateRows or use []; objective-met needs qualifying rows.',items:{type:'object',additionalProperties:false,required:['id','sourceReceipt','checks'],properties:{id:checkIdSchema,sourceReceipt:{type:'string',maxLength:80},checks:{type:'array',minItems:1,maxItems:8,items:{type:'object',additionalProperties:false,required:['id','status'],properties:{id:checkIdSchema,status:{type:'string',enum:qualifyStatuses}}}}}}};
const maxQualifyingRows=16,maxRequiredChecks=8;
const boundedKey=value=>id(value)&&value.length<=48;
// Start mandatory enforcement on explicitly capped discovery, not on questions,
// requests quoting another search, or unrelated actions.
const cappedDiscovery=value=>/^\s*(?:please\s+)?(?:find|search for|identify|locate|research)\s+(?:up to|no more than|at most)\s+(?:[1-9]\d*|one|two|three|four|five|six|seven|eight|nine|ten)\b/i.test(value);
const doneChecklistError=message=>fail('DIRECTORY_DONE_CHECKLIST',message+' No changes were made.');
export const DIRECTORY_DONE_CHECKLIST_INSTRUCTIONS="Use doneChecks for observable conditions of the requested result. Capped discovery requires a checklist. requestQuote ties an explicit requirement to the user's exact text; advisory:true marks an optional preference. refine changes pending checks with a reason. A check backed by requestQuote stays in the plan; choose another route when needed. For each required leaf and request-backed parent, checkResults records yes or no. Yes requires the exact successful receipt cited in receipts. Missing or false required results leave the action open.";
function qualifyingContractIssue(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['minQualifyingCount','requiredChecks'].includes(key)))return 'contract-shape';
 if(!Number.isInteger(value.minQualifyingCount)||value.minQualifyingCount<1||value.minQualifyingCount>maxQualifyingRows)return 'count-range';
 if(!Array.isArray(value.requiredChecks)||value.requiredChecks.length<1||value.requiredChecks.length>maxRequiredChecks)return 'check-count';
 if(!value.requiredChecks.every(boundedKey))return 'check-id';
 if(new Set(value.requiredChecks).size!==value.requiredChecks.length)return 'duplicate-check';
 return null;
}
const validQualifyingContract=value=>qualifyingContractIssue(value)===null;
const qualifyingIssueMessages={
 'contract-shape':'Set qualifying to an object with only minQualifyingCount and requiredChecks.',
 'count-range':'Set qualifying.minQualifyingCount to an integer from 1 to 16.',
 'check-count':'Set qualifying.requiredChecks to an array of 1 to 8 hard-condition IDs.',
 'check-id':'Use 1-48 letters, digits, underscores, or hyphens per qualifying.requiredChecks ID (example: fully_remote).',
 'duplicate-check':'Use each qualifying.requiredChecks ID once.'
};
function validateQualifyingContract(value){
 const issue=qualifyingContractIssue(value);
 if(issue)throw Object.assign(fail('DIRECTORY_QUALIFICATION',qualifyingIssueMessages[issue]+' No changes were made.'),{qualifyingIssue:issue});
}
const searchScopeSchema={type:'array',minItems:1,maxItems:24,description:'Only for a finite search: exact planned URLs or absolute file paths. Required to report an exhausted search with an unmet minimum.',items:{type:'object',additionalProperties:false,required:['tool','locator'],properties:{tool:{type:'string',enum:['relay_browser','relay_workspace']},locator:{type:'string',minLength:1,maxLength:2048}}}};
function searchSourceKey(taskId,tool,locator){
 if(typeof locator!=='string'||!locator.trim()||locator.length>8192)return null;
 let source;
 if(tool==='relay_browser'){
  try{const url=new URL(locator);if(!['https:','http:'].includes(url.protocol)||url.username||url.password)return null;
   url.hash='';for(const key of [...url.searchParams.keys()])if(/^utm_/i.test(key)||['fbclid','gclid'].includes(key.toLowerCase()))url.searchParams.delete(key);
   url.searchParams.sort();source=url.href;
  }catch{return null;}
 }else if(tool==='relay_workspace'){
  source=/^[a-z]:[\\/]/i.test(locator)?locator.replaceAll('\\','/').toLowerCase():locator;
 }else return null;
 return createHash('sha256').update(taskId+'\0'+tool+'\0'+source).digest('hex');
}
function scopeKeys(scope,taskId){
 if(!Array.isArray(scope)||scope.length<1||scope.length>24)return null;
 const keys=scope.map(row=>row&&Object.keys(row).length===2&&text(row.locator,2048)&&
  (row.tool!=='relay_workspace'||/^(?:[a-z]:[\\/]|\/|\\\\)/i.test(row.locator))&&searchSourceKey(taskId,row.tool,row.locator));
 return keys.every(Boolean)&&new Set(keys).size===keys.length?keys:null;
}
function returnedSourceKey(call,result,taskId){
 if(result?.success!==true||call?.namespace||!['relay_browser','relay_workspace'].includes(call?.name))return null;
 let args,value;try{args=typeof call.arguments==='string'?JSON.parse(call.arguments):call.arguments;
  const encoded=result.contentItems?.find(item=>item?.type==='inputText')?.text;
  if(typeof encoded!=='string'||encoded.length>1024*1024)return null;
  value=JSON.parse(encoded);
 }catch{return null;}
 if(call.name==='relay_browser'&&['open','navigate','read','snapshot'].includes(args?.action)&&typeof value?.url==='string'&&
  typeof value.documentId==='string'&&Array.isArray(value.frames)&&value.frames.length&&!value.navigationError&&!value.protectedContent)
  return searchSourceKey(taskId,call.name,value.url);
 if(call.name==='relay_workspace'&&args?.action==='read')return searchSourceKey(taskId,call.name,value?.path);
 return null;
}
function qualifyRows(rows,contract,cited,sourceKeys,runId,nodeId){
 const reject=message=>{throw fail('DIRECTORY_QUALIFICATION',message+' The action stays focused; preserve existing evidence and continue the next check.');};
 if(!Array.isArray(rows)||!rows.length||rows.length>maxQualifyingRows)reject('Supply 1-'+maxQualifyingRows+' candidate rows for the declared verification contract.');
 const receiptMap=new Map(cited.map(r=>[r.id,r])),candidates=new Set(),sources=new Set();
 let count=0;
 for(const row of rows){
  if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).length!==3||!boundedKey(row.id)||!id(row.sourceReceipt)||
   !Array.isArray(row.checks)||row.checks.length!==contract.requiredChecks.length)reject('Each candidate needs an ID, a current source receipt, and exactly the declared checks.');
  const candidate=row.id.toLowerCase(),receipt=receiptMap.get(row.sourceReceipt),source=sourceKeys.get(row.sourceReceipt);
  if(candidates.has(candidate))reject('Candidate IDs must be distinct.');
  if(!receipt||receipt.runId!==runId||receipt.nodeId!==nodeId||receipt.success!==true||!source)reject('Each candidate needs a cited successful source-read receipt from this run and node.');
  if(sources.has(source))reject('Candidate source reads must be distinct; repeating the same source does not count as a new candidate.');
  const checks=new Set();let verified=true;
  for(const check of row.checks){
   if(!check||typeof check!=='object'||Array.isArray(check)||Object.keys(check).length!==2||
    !contract.requiredChecks.includes(check.id)||checks.has(check.id)||!qualifyStatuses.includes(check.status))reject('Use each declared check exactly once with status verified, unmet, or unknown.');
   checks.add(check.id);if(check.status!=='verified')verified=false;
  }
  candidates.add(candidate);sources.add(source);if(verified)count++;
 }
 return count;
}

// A blocked prerequisite closes dependent work without marking it performed.
// Only pending nodes are derived; active work and unresolved effects still need handling.
function dependencyBlocks(actions){
 const byId=new Map(actions.map(a=>[a.id,a])),memo=new Map();
 function roots(id){
  if(memo.has(id))return memo.get(id);
  const action=byId.get(id),set=new Set();
  memo.set(id,set);
  if(action?.state==='blocked')set.add(id);
  else if(action?.state==='pending')for(const parent of action.dependsOn)for(const root of roots(parent))set.add(root);
  return set;
 }
 return actions.filter(action=>action.state==='pending').flatMap(action=>{const blockedBy=[...roots(action.id)];return blockedBy.length?[{id:action.id,blockedBy}]:[];});
}
// A persisted interrupted observation is not evidence and cannot complete a step,
 // but it is not an uncertain effect. Older unbound observation receipts used
 // canLinkRead instead of a dedicated host classification.
const unresolvedEffect=r=>r.state==='unknown'&&r.observationOnly!==true&&r.canLinkRead!==true;
const readyActions=s=>s.actions.filter(a=>a.state==='pending'&&!s.actions.some(x=>x.id===s.focus&&x.state==='active')&&!s.receipts.some(r=>r.actionId===a.id&&unresolvedEffect(r))&&a.dependsOn.every(d=>s.actions.find(x=>x.id===d)?.state==='observed')).map(a=>a.id);
function currentActionChoices(s) {
 const choices={taskId:s.taskId,actionRevision:s.actionRevision,focus:s.focus,ready:readyActions(s),
  actions:s.actions.map(({id,objective,state})=>({id,objective,state}))};
 return '\nCurrent Directory choices (same task): '+JSON.stringify(choices)
  +'\nChoose an exact existing ID whose objective matches the work. If matching work is missing, use relay_directory_action with action "plan" to add it. Use action "read" for current details.';
}
function actionRejection(code,message,s,a,unmet=[]) {
 const ready=readyActions(s);
 return Object.assign(fail(code,message+(ready.length?' Ready next actions: '+ready.join(', ')+'.':' No pending action is ready.')), {actionState:a.state,unmetDependencyCount:unmet.length,readyActionCount:ready.length});
}

const displayReceiptId=value=>typeof value==='string'&&/^receipt-[1-9]\d{0,15}$/.test(value);
const linkableRead=(r,actionId,runId,nodeId)=>r?.actionId===null&&r.canLinkRead===true&&(!r.linkedByActionId||r.linkedByActionId===actionId)&&r.success===true&&id(runId)&&r.runId===runId&&id(nodeId)&&r.nodeId===nodeId;
function evidenceRejection(code,s,action,refs,eligible,runId,nodeId) {
 const byId=new Map(s.receipts.map(r=>[r.id,r]));
 const bad=refs.filter(ref=>!eligible(byId.get(ref)));
 const details=bad.slice(0,6).map(ref=>{
  const r=byId.get(ref), label=displayReceiptId(ref)?ref:'invalid receipt ID';
  if(!r)return label+': absent';
  if(r.actionId&&r.actionId!==action.id)return label+': assigned to another action';
  if(r.linkedByActionId&&r.linkedByActionId!==action.id)return label+': already used by another action';
  if(r.state!=='returned')return label+': no returned result';
  if(r.runId!==runId||r.nodeId!==nodeId)return label+': from another run or node';
  return label+': not an eligible read-only result';
 });
 if(bad.length>details.length)details.push((bad.length-details.length)+' more rejected');
 const allowed=s.receipts.filter(r=>eligible(r)&&displayReceiptId(r.id)).slice(-8).map(r=>r.id);
 return fail(code,'Current focus: '+(s.focus||'none')+'. Rejected receipts: '+details.join('; ')
  +'. Recent eligible receipt IDs: '+(allowed.length?allowed.join(', '):'none')
  +'. Use returned receipts for this action or eligible successful unassigned read-only receipts from this run and node. Do not repeat a possible external action to obtain a receipt.');
}

export const DIRECTORY_OPTION_PROGRESS="Search scope: use qualifying only for a required minimum, with minQualifyingCount and requiredChecks for hard conditions. For 'up to N', omit qualifying and record the cap and agreed scope in the objective.\nIf you have only a result list or snippet, open a promising source and read the decisive conditions before accepting or rejecting that option.\nWhile checking options, note records a failed option; observe with outcome partial keeps the action active. Check the next useful source. For qualifying, candidateRows contains distinct candidates, their source receipts, and verified/unmet/unknown checks. Unknown does not satisfy the minimum.\nUse objective-met when the active objective and its required checks are complete. A capped search can finish below its cap, including zero, after its agreed routes are checked; report count and coverage.\nFor a minimum within a finite scope, save searchScope before focusing, using exact URLs or absolute paths. search-limit-reached requires successful current reads for every declared source. A stale reference, failed click or elapsed-time estimate does not establish exhaustion. Host deadlines are enforced separately.\nSave usable source locators and the facts needed by the next action. After completion, choose from the returned ready actions.";
export const ACTION_DIRECTORY_INSTRUCTIONS="DIRECTORY ACTION EXECUTION\nUse relay_directory_action with its attached schema and latest returned snapshot. The host binds model changes to that snapshot; omit revision rather than calculating it. After a conflict or human edit, read again.\nplan saves pending actions with stable IDs and dependencies. It preserves active and recorded actions that you omit. Add the next work as discovery makes it clear.\nBefore a file change, form submission or message, plan and focus the action that makes that change. Reads and searches can run before focus. If a change was rejected before dispatch, focus its matching action and retry; keep successful earlier reads.\nnote records a failed option without closing the action. observe records a claim with returned receipt IDs: partial keeps it active; objective-met closes it and clears focus. Inspect the result before choosing objective-met. Finding a file establishes its location; reading it establishes its contents.\nUse receipts from the focused action or eligible successful unassigned reads from this run and node. Save source locators and findings that dependent work can retrieve. If an old locator no longer works, obtain a new task-owned read without discarding the earlier record.\nblock records why the whole action cannot proceed, with the observed blocker and receipts. Check the needed route first. If an earlier action may have run, record unresolved-effect and inspect its destination before repeating it. Continue independent ready actions."+'\n'+DIRECTORY_OPTION_PROGRESS+'\n'+DIRECTORY_DONE_CHECKLIST_INSTRUCTIONS;
const directoryToolContract=createDirectoryToolContract({type:'function',name:'relay_directory_action',description:'Read and coordinate this task action outline. Plan, focus, note a failed option without closing the action, observe partial progress or a fulfilled action with an explicit outcome, or block the action itself with a blocker classification. Host receipts remain distinct from agent-authored outcome claims. Include the action that delivers the requested result. If discovery is only an intermediate step, add and take the next useful authorized step rather than ending with a progress report.',inputSchema:{type:'object',additionalProperties:false,required:['action'],properties:{action:{type:'string',enum:['read','plan','focus','refine','note','observe','block']},outcome:{type:'string',enum:observeOutcomes,description:'Required for observe: partial saves evidence without closing the action or unblocking dependencies; objective-met is only for the whole active objective.'},blocker:{type:'string',enum:blockerKinds,description:'For block only: why the whole step cannot proceed. search-limit-reached means the preplanned finite search scope was read, not elapsed time; configured deadlines are enforced by the host.'},revision:{type:'integer',minimum:0,description:'Optional legacy echo. Model edits use the host-delivered snapshot; omit rather than calculating a revision.'},candidateRows:candidateRowsSchema,checkResults:checkResultsSchema,doneChecks:doneChecksSchema,dropCheckIds:{type:'array',maxItems:24,items:checkIdSchema},alternatives:{type:'array',maxItems:8,items:{type:'string',minLength:1,maxLength:320}},actions:{type:'array',minItems:1,maxItems:24,items:{type:'object',additionalProperties:false,required:['id','objective','dependsOn'],properties:{id:{type:'string'},objective:{type:'string',maxLength:1200},qualifying:qualifyingSchema,searchScope:searchScopeSchema,doneChecks:doneChecksSchema,reason:{type:'string',maxLength:1200},sourceRefs:{type:'array',maxItems:32,items:{type:'string'}},dependsOn:{type:'array',maxItems:24,items:{type:'string'}}}}},id:{type:'string'},claim:{type:'string',maxLength:1200},receipts:{type:'array',maxItems:32,items:{type:'string'}}}}});
export const ACTION_DIRECTORY_TOOL=directoryToolContract.tool;
/** New task-owned state. No legacy roots, shared memory, raw outputs or automatic replay. */
export class TaskActionDirectory {
 constructor({taskId,objective,snapshot,persist=async()=>{},now=()=>new Date().toISOString(),admitRecovery=()=>false}){
  if(!id(taskId)||!text(objective,8000))throw fail('DIRECTORY_SCOPE','A task identity and explicit objective are required.');
  if(snapshot&&(snapshot.version!==1||snapshot.taskId!==taskId))throw fail('DIRECTORY_SCOPE','Directory belongs to another task or format.');
  if(snapshot&&((snapshot.actionRevision!==undefined&&(!Number.isSafeInteger(snapshot.actionRevision)||snapshot.actionRevision<0||snapshot.actionRevision>snapshot.revision))||!Number.isSafeInteger(snapshot.revision)||snapshot.revision<0||!Array.isArray(snapshot.actions)||snapshot.actions.length>24||!Array.isArray(snapshot.receipts)||snapshot.receipts.length>256||!Number.isSafeInteger(snapshot.nextReceipt)||snapshot.nextReceipt<1||snapshot.actions.some(a=>!id(a.id)||!text(a.objective)||!Array.isArray(a.dependsOn)||!['pending','active','observed','blocked'].includes(a.state)||a.qualifying!==undefined&&!validQualifyingContract(a.qualifying))||new Set(snapshot.actions.map(a=>a.id)).size!==snapshot.actions.length||snapshot.receipts.some(r=>r.taskId!==taskId||!id(r.id)||r.actionId!==null&&!snapshot.actions.some(a=>a.id===r.actionId)||r.linkedByActionId!==undefined&&(r.actionId!==null||r.canLinkRead!==true||r.state!=='returned'||r.success!==true||!snapshot.actions.some(a=>a.id===r.linkedByActionId))||!['unknown','returned'].includes(r.state))||new Set(snapshot.receipts.map(r=>r.id)).size!==snapshot.receipts.length))throw fail('DIRECTORY_CORRUPT','Saved action Directory is invalid; preserve it for recovery.');
  if(snapshot&&snapshot.actions.some(action=>action.searchScope!==undefined&&!scopeKeys(action.searchScope,taskId)))throw fail('DIRECTORY_CORRUPT','Saved finite search scope is invalid; preserve it for recovery.');
  if(snapshot)for(const action of snapshot.actions)if(action.doneChecks!==undefined){
    try{validateDoneChecks(action.doneChecks);}catch{throw fail('DIRECTORY_CORRUPT','Saved completion checklist is invalid; preserve it for recovery.');}
  }
  this.state=copy(snapshot?{...snapshot,actionRevision:snapshot.actionRevision??snapshot.revision}:{version:1,taskId,objective,revision:0,actionRevision:0,focus:null,actions:[],receipts:[],nextReceipt:1});this.persist=persist;this.now=now;this.admitRecovery=admitRecovery;this.queue=Promise.resolve();this.sourceKeys=new Map();
 }
 read(){const s=copy(this.state);s.ready=readyActions(s);s.dependencyBlocked=dependencyBlocks(s.actions);for(const action of s.actions)if(action.doneChecks)action.doneCheckStatus=projectDoneChecks(action.doneChecks,[...(action.notes||[]).flatMap(note=>note.checkResults||[]),...(action.observation?.checkResults||[])]);s.policy='Outcome claims are agent-authored; host receipts establish only handler activity. Unknown effects are not safe to replay.';return s;}
 /** Bounded provider view; the full task ledger remains available via action read. */
 promptView() {
  const state=this.read(), recentCompleted=new Set(state.actions.filter(a=>a.state==='observed'||a.state==='blocked').slice(-3).map(a=>a.id));
  const actions=state.actions.map(a=>{
   if(a.state==='active'||a.state==='pending'||recentCompleted.has(a.id)){
    const notes=a.notes||[];
    return {...a,...(notes.length>2?{notes:notes.slice(-2),deferredNoteCount:notes.length-2}:{})};
   }
   return {
    id:a.id,objective:a.objective,dependsOn:a.dependsOn,state:a.state,authority:a.authority,
    ...(a.sourceRefs?{sourceRefs:a.sourceRefs}:{}),
    ...(a.qualifying?{qualifying:a.qualifying}:{}),
    ...(a.doneChecks?.some(c=>c.requestQuote)?{requestChecks:a.doneChecks.filter(c=>c.requestQuote).map(c=>({id:c.id,check:c.check,requestQuote:c.requestQuote,advisory:c.advisory===true}))}:{}),
    ...(a.searchScope?{searchScopeCount:a.searchScope.length}:{}),
    ...(a.observation?{observation:{authority:a.observation.authority,claim:a.observation.claim,
      ...(a.observation.blocker?{blocker:a.observation.blocker}:{}),
      ...(Number.isInteger(a.observation.qualification?.count)?{verifiedQualifyingCount:a.observation.qualification.count}:{}),
      receipts:a.observation.receipts||[]}}:{}),
   };
  });
  const retained=new Map();
  for(const receipt of state.receipts)if(receipt.state==='unknown')retained.set(receipt.id,receipt);
  for(const receipt of state.receipts.slice(-8))retained.set(receipt.id,receipt);
  const receipts=[...retained.values()];
  return {version:state.version,taskId:state.taskId,objective:state.objective,revision:state.revision,
   actionRevision:state.actionRevision,focus:state.focus,actions,ready:state.ready,
   dependencyBlocked:state.dependencyBlocked,receipts,deferredReceiptCount:state.receipts.length-receipts.length,
   view:'bounded-active-context',
   retrieval:'Call relay_directory_action read for the full preserved task ledger when older notes or receipts are needed.',
   policy:state.policy};
 }
 async transaction(fn,{actionEdit=false}={}){const work=this.queue.catch(()=>{}).then(async()=>{const next=copy(this.state);const result=fn(next);next.revision++;if(actionEdit)next.actionRevision++;await this.persist(copy(next));this.state=next;return result===undefined?this.read():result;});this.queue=work.then(()=>{},error=>{if(![400,404,409].includes(error.status))throw error;});this.queue.catch(()=>{});return work;}
 async edit(input,{authority='agent',admit=()=>{},expectedActionRevision,runId,nodeId}={}){return this.transaction(s=>{admit();
  if(expectedActionRevision!==undefined?expectedActionRevision!==s.actionRevision:input.revision!==s.revision)throw Object.assign(fail('DIRECTORY_CHANGED','Read the current Directory revision before editing.'),{comparisonRevision:s.revision,comparisonActionRevision:s.actionRevision});
  if(input.action==='plan'){
   if(!Array.isArray(input.actions)||!input.actions.length||input.actions.length>24)throw fail('DIRECTORY_PLAN','Use 1–24 concrete actions.');
   const seen=new Set();const proposed=input.actions.map(a=>{if(!id(a.id)||seen.has(a.id)||!text(a.objective)||!Array.isArray(a.dependsOn)||a.dependsOn.length>24||a.dependsOn.some(x=>!id(x)))throw fail('DIRECTORY_PLAN','Invalid or duplicate action.');if(a.reason!==undefined&&!text(a.reason)||a.sourceRefs!==undefined&&(!Array.isArray(a.sourceRefs)||a.sourceRefs.length>32||a.sourceRefs.some(ref=>!s.receipts.some(r=>r.id===ref))))throw fail('DIRECTORY_SOURCE','Use a bounded reason and exact same-task host receipt references.');if(a.qualifying!==undefined)validateQualifyingContract(a.qualifying);if(a.searchScope!==undefined&&!scopeKeys(a.searchScope,s.taskId))throw fail('DIRECTORY_SEARCH_SCOPE','Set searchScope to 1-24 distinct exact URLs or absolute paths for the planned finite search.');const doneChecks=a.doneChecks===undefined?undefined:validateDoneChecks(a.doneChecks,{requestText:s.objective});seen.add(a.id);return{id:a.id,objective:a.objective,...(a.reason?{reason:a.reason}:{}),...(a.sourceRefs?{sourceRefs:[...new Set(a.sourceRefs)]}:{}),dependsOn:[...new Set(a.dependsOn)],...(doneChecks?{doneChecks}:{}),...(a.searchScope?{searchScope:copy(a.searchScope)}:{}),...(a.qualifying!==undefined?{qualifying:{minQualifyingCount:a.qualifying.minQualifyingCount,requiredChecks:[...a.qualifying.requiredChecks].sort()}}:{}),state:'pending',authority};});
   const recorded=s.actions.filter(a=>a.state!=='pending');
   const protectedIds=new Set(recorded.map(a=>a.id));
   for(const old of recorded){
    const replacement=proposed.find(a=>a.id===old.id);
    if(replacement&&(replacement.objective!==old.objective||JSON.stringify(replacement.dependsOn)!==JSON.stringify(old.dependsOn)||JSON.stringify(replacement.qualifying)!==JSON.stringify(old.qualifying)||replacement.searchScope!==undefined&&JSON.stringify(replacement.searchScope)!==JSON.stringify(old.searchScope)||replacement.doneChecks!==undefined&&JSON.stringify(replacement.doneChecks)!==JSON.stringify(old.doneChecks)))
     throw fail('DIRECTORY_RECORDED_ACTION','Action '+old.id+' has recorded work and cannot be rewritten. Submit the new pending actions with new IDs; omit the recorded row and it will be preserved.');
   }
   if(authority!=='human'&&!s.steering?.requiresReplan)for(const old of s.actions.filter(a=>a.state==='pending')){
    const carried=proposed.find(a=>a.id===old.id)?.doneChecks||[];
    if(old.doneChecks?.some(check=>check.requestQuote&&!carried.some(next=>next.id===check.id&&next.check===check.check&&next.requestQuote===check.requestQuote)))
     throw doneChecklistError('A pending action carries an explicit request check. Keep it in the revised plan; change its route, not the request.');
   }
   // Plans replace pending work, not the history. Keep original record order and provenance.
   const combined=[...recorded,...proposed.filter(a=>!protectedIds.has(a.id))];
   if(combined.length>24)throw fail('DIRECTORY_PLAN','The outline can hold 24 actions including recorded work. Keep the next steps focused.');
   const visit=(a,path=new Set())=>{if(path.has(a.id))throw fail('DIRECTORY_CYCLE','Action dependencies must not cycle.');for(const dependency of a.dependsOn){const parent=combined.find(a=>a.id===dependency);if(!parent)throw fail('DIRECTORY_DEPENDENCY','Dependency is absent.');visit(parent,new Set([...path,a.id]));}};combined.forEach(a=>visit(a));
   s.actions=combined;if(s.steering)s.steering.requiresReplan=false;return;
  }
  if(input.action==='planningChoice'){if(!id(input.moduleId)||!text(input.reason)||!s.actions.some(a=>a.id===input.focus)||!Array.isArray(input.sourceRefs)||input.sourceRefs.some(ref=>!s.receipts.some(r=>r.id===ref)))throw fail('DIRECTORY_CHOICE','Choose an existing action with a bounded reason and exact task receipts.');s.planningChoice={moduleId:input.moduleId,focus:input.focus,reason:input.reason,sourceRefs:[...new Set(input.sourceRefs)],authority};return;}
  const a=s.actions.find(a=>a.id===input.id);if(!a)throw fail('DIRECTORY_ACTION','Choose an existing action.'+currentActionChoices(s));
  if(input.action==='focus'){
   if(s.receipts.some(r=>r.actionId===a.id&&unresolvedEffect(r)))throw fail('DIRECTORY_UNKNOWN','This action has an unresolved attempt. It cannot be replayed; block it and continue independent work.');
   if(!['pending','active'].includes(a.state))throw actionRejection('DIRECTORY_ACTION_CLOSED','Action '+a.id+' is already '+a.state+'; it cannot be focused again.',s,a);
   const unmet=a.dependsOn.filter(d=>s.actions.find(x=>x.id===d)?.state!=='observed');
   if(unmet.length)throw actionRejection('DIRECTORY_NOT_READY','Action '+a.id+' is waiting on '+unmet.join(', ')+'.',s,a,unmet);
   if(s.focus&&s.focus!==a.id&&s.actions.find(x=>x.id===s.focus)?.state==='active')throw fail('DIRECTORY_ACTIVE','Current focus: '+s.focus+'. Observe or block that action before switching.');a.state='active';s.focus=a.id;return;
  }
  if(input.action==='refine'){
   if(a.state!=='active'||s.focus!==a.id)throw doneChecklistError('Focus the action before refining its checklist.');
   const history=a.checklistRevisions||=[];
   if(history.length>=24)throw doneChecklistError('The checklist revision limit was reached; preserve this action and plan a separate next action if needed.');
   const added=input.doneChecks;
   const retiredIds=new Set(history.flatMap(entry=>entry.retired.map(item=>item.id)));
   const next=refineDoneChecks(a.doneChecks||[],added,input.dropCheckIds,input.claim,input.alternatives,{authority,requestText:s.objective});
   if(added?.some(item=>retiredIds.has(item.id)))throw doneChecklistError('Use a new ID rather than reusing a retired check ID.');
   a.doneChecks=next.checks;
   a.checklistRevisions=[...history,{authority,reason:input.claim,added:added||[],retired:next.retired,alternatives:input.alternatives||[]}];
   return;
  }
  if(input.action==='observe'||input.action==='note'){
   const noting=input.action==='note'||input.outcome==='partial';
   if(a.state!=='active'||s.focus!==a.id)throw actionRejection('DIRECTORY_OBSERVATION',a.state==='observed'||a.state==='blocked'?'Action '+a.id+' is already '+a.state+'. Preserve that record; add a follow-up only if work remains.':'Action '+a.id+' is not focused. Focus it before recording the observation.',s,a);
   if(!text(input.claim)||!Array.isArray(input.receipts)||!input.receipts.length||input.receipts.length>32)throw fail('DIRECTORY_OBSERVATION','Supply a concise outcome claim and exact host receipts for the active action.');
   if(s.receipts.some(r=>r.actionId===a.id&&unresolvedEffect(r)))throw fail('DIRECTORY_UNKNOWN','This action has an unresolved attempt.');
   const refs=[...new Set(input.receipts)];
   const cited=refs.map(reference=>s.receipts.find(r=>r.id===reference));
   const linkable=r=>linkableRead(r,a.id,runId,nodeId);
   const eligible=r=>r?.state==='returned'&&(r.actionId===a.id||linkable(r));
   if(cited.some(r=>!eligible(r)))throw evidenceRejection('DIRECTORY_EVIDENCE',s,a,refs,eligible,runId,nodeId);
   if(authority==='agent'&&runId&&!s.steering&&cappedDiscovery(s.objective)&&!a.doneChecks?.some(check=>check.requestQuote)&&input.action==='observe'&&!noting)
    throw doneChecklistError('The current request is a capped discovery task. Use refine to add a check with an exact request quote, and record remaining useful search routes before marking it done.');
   if(input.checkResults!==undefined&&!a.doneChecks)throw doneChecklistError('Set the action checklist before reporting check results.');
   const checkResults=a.doneChecks?checkDoneResults(a.doneChecks,input.checkResults,cited,!noting,{runId,nodeId}):undefined;
   let qualification;
   if(a.qualifying&&input.action==='observe'){
    const rows=input.candidateRows;
    const emptyPartial=noting&&(rows===undefined||Array.isArray(rows)&&rows.length===0);
    const count=emptyPartial?0:qualifyRows(rows,a.qualifying,cited,this.sourceKeys,runId,nodeId);
    if(!noting&&count<a.qualifying.minQualifyingCount)throw Object.assign(fail('DIRECTORY_QUALIFICATION',count+' candidates have every required check verified; '+a.qualifying.minQualifyingCount+' needed. The action stays focused. Record partial evidence or continue; use a specific block only when the actual search limit or route warrants it.'),{qualifyingCount:count,requiredQualifyingCount:a.qualifying.minQualifyingCount});
    qualification={count,candidateRows:emptyPartial?[]:copy(rows)};
   }
   if(noting){
    const notes=a.notes||=[];
    const used=new Set(notes.flatMap(note=>note.receipts));
    if(notes.length>=24||cited.every(r=>used.has(r.id)))throw fail('DIRECTORY_NOTE','Use new evidence for a progress note. Continue the focused action; do not repeat earlier notes.');
    notes.push({authority,claim:input.claim,receipts:cited.map(r=>r.id),...(qualification?{qualification}:{}),...(checkResults?{checkResults}:{})});
   }
   // Keep original action attribution immutable. The later association is explicit.
   for(const receipt of cited)if(linkable(receipt))receipt.linkedByActionId=a.id;
   if(noting)return;
   a.state='observed';a.observation={authority,claim:input.claim,receipts:[...new Set(input.receipts)],...(qualification?{qualification}:{}),...(checkResults?{checkResults}:{})};s.focus=null;return;
  }
  if(input.action==='block'){
   if(!text(input.claim))throw fail('DIRECTORY_REASON','Say which input, permission, or route you checked and what prevented this step.');
   let cited=[];
   if(authority==='agent'&&runId){
    if(!['pending','active'].includes(a.state))throw actionRejection('DIRECTORY_ACTION_CLOSED','Preserve the recorded disposition of '+a.id+'.',s,a);
    if(!blockerKinds.includes(input.blocker))throw fail('DIRECTORY_BLOCKER','Name why the whole step cannot proceed. If only one option failed, record a note and try another.');
    if(input.blocker==='unresolved-effect'){
     cited=s.receipts.filter(r=>r.actionId===a.id&&unresolvedEffect(r));
     if(!cited.length)throw fail('DIRECTORY_BLOCKER','No unresolved effect is recorded for this step. Check the result before deciding what to do next.');
    }else{
     if(a.state!=='active'||s.focus!==a.id)throw actionRejection('DIRECTORY_BLOCKER','Focus this ready step first. If you already found or read the needed input, use its returned receipt to record what you found and take the next ready step.',s,a);
     const refs=input.receipts===undefined?[]:input.receipts;
     if(!Array.isArray(refs)||refs.length>32)throw fail('DIRECTORY_BLOCKER','Cite at most 32 exact receipts for the checks you made.');
     const uniqueRefs=[...new Set(refs)];
     cited=uniqueRefs.map(ref=>s.receipts.find(r=>r.id===ref));
     const eligible=r=>r?.runId===runId&&r.nodeId===nodeId&&r.state==='returned'&&(r.actionId===a.id||(r.actionId===null&&r.canLinkRead===true&&(!r.linkedByActionId||r.linkedByActionId===a.id)));
     if(cited.some(r=>!eligible(r)))throw evidenceRejection('DIRECTORY_BLOCKER',s,a,uniqueRefs,eligible,runId,nodeId);
     if(input.blocker==='search-limit-reached'){
      const scope=scopeKeys(a.searchScope,s.taskId);
      if(!scope)throw fail('DIRECTORY_SEARCH_SCOPE','No finite source scope was recorded before this action started. A failed option or model-estimated cutoff does not end the search. Keep the action open and take the next useful step.');
      const covered=new Set(cited.filter(r=>r.success===true).map(r=>this.sourceKeys.get(r.id)));
      const missing=scope.flatMap((key,index)=>covered.has(key)?[]:[index+1]);
      if(missing.length)throw fail('DIRECTORY_SEARCH_SCOPE','Successful source reads are missing for planned source numbers '+missing.join(', ')+'. No block was recorded; continue the next source check.');
     }
     if(input.blocker==='prerequisite-unavailable'&&!cited.length)throw fail('DIRECTORY_BLOCKER','Cite the tool result that shows the input is unavailable. A successful check that found the needed input belongs under observe, not block.');
    }
   }
   a.state='blocked';a.observation={authority,claim:input.claim,receipts:cited.map(r=>r.id),...(blockerKinds.includes(input.blocker)?{blocker:input.blocker}:{})};if(s.focus===a.id)s.focus=null;return;
  }
  throw fail('DIRECTORY_ACTION','Unsupported Directory edit.');
 },{actionEdit:true});}
 async execute(call,dispatch,{runId,nodeId,signal,recoveryFor,observationOnly=false,admit=()=>{},expectedRevision,expectedActionRevision,trace}={}){
  if(signal?.aborted)throw signal.reason||fail('ABORT_ERR','Cancelled.');
  if(!id(runId)||!id(nodeId)||!id(call?.name))throw fail('DIRECTORY_CALL','Exact host call identity is required.');
  let receiptId,startRevision,gate;const report=value=>{try{trace?.(value);}catch{}};
  await this.transaction(s=>{admit();startRevision=s.revision;gate={boundActionRevision:expectedActionRevision??null,actualActionRevision:s.actionRevision,actualRevision:s.revision,focusId:s.focus,callClass:observationOnly?'observation':'effect'};const reject=(code,message)=>{report({...gate,phase:'gate',decision:'reject',code});throw Object.assign(fail(code,message),{actionDispatched:false});};const bound=expectedActionRevision!==undefined?expectedActionRevision===s.actionRevision:expectedRevision===undefined||expectedRevision===s.revision;if(!observationOnly&&!bound)reject('DIRECTORY_CHANGED','User or another owner changed the action outline. Read it before another effect.');const a=bound?s.actions.find(a=>a.id===s.focus):null;gate.receiptActionId=a?.id||null;if(!observationOnly&&(!a||a.state!=='active'))reject('DIRECTORY_FOCUS','This tool call did not run. Use relay_directory_action to plan the matching action if it is missing. Focus that step with relay_directory_action using action \"focus\" and its id before retrying this tool call. Keep earlier successful reads.'+currentActionChoices(s));const unknown=s.receipts.filter(r=>r.actionId===a?.id&&unresolvedEffect(r));if(!observationOnly&&unknown.length&&!(typeof recoveryFor==='string'&&unknown.some(r=>r.id===recoveryFor)&&this.admitRecovery(call,{taskId:s.taskId,runId,nodeId,receipt:copy(unknown.find(r=>r.id===recoveryFor))})===true))reject('DIRECTORY_UNKNOWN','Prior attempt is unresolved; only host-classified recovery observations may run for this action.');if(s.receipts.length>=256)reject('DIRECTORY_CAPACITY','This bounded action ledger is full; preserve it rather than discard evidence.');receiptId='receipt-'+s.nextReceipt++;s.receipts.push({id:receiptId,taskId:s.taskId,runId,nodeId,actionId:a?.id||null,tool:call.name,...(observationOnly?{observationOnly:true}:{}),...(observationOnly&&bound&&!a?{canLinkRead:true}:{}),...(recoveryFor?{recoveryFor}:{}),state:'unknown',at:this.now()});report({...gate,phase:'gate',decision:'allow',receiptId});});report({...gate,phase:'reserved',receiptId,reservationRevision:startRevision+1});
  let result,dispatchStarted=false;try{admit();if(signal?.aborted)throw signal.reason||fail('ABORT_ERR','Cancelled.');dispatchStarted=true;report({...gate,phase:'dispatch',receiptId});result=await dispatch(call);}catch(error){
   // Entering a handler is not proof of dispatch. Only explicit host proof (or an unentered handler) clears uncertainty.
   const notDispatched=!dispatchStarted||error?.actionDispatched===false;
   const code=id(error?.code)?error.code:null;
   await this.transaction(s=>{const receipt=s.receipts.find(r=>r.id===receiptId);receipt.threw=true;receipt.code=code;if(notDispatched){receipt.state='returned';receipt.success=false;receipt.actionDispatched=false;receipt.returnedAt=this.now();}});
   report({...gate,phase:'threw',receiptId,dispatchStarted,...(notDispatched?{actionDispatched:false,success:false}:{}),code});
   throw error;
  }
  await this.transaction(s=>{const receipt=s.receipts.find(r=>r.id===receiptId);receipt.state='returned';receipt.success=typeof result?.success==='boolean'?result.success:null;receipt.returnedAt=this.now();});
  const source=observationOnly?returnedSourceKey(call,result,this.state.taskId):null;if(source)this.sourceKeys.set(receiptId,source);
  report({...gate,phase:'returned',receiptId,success:typeof result?.success==='boolean'?result.success:null});return{result,receiptId,startRevision,canLinkRead:result?.success===true&&this.state.receipts.find(r=>r.id===receiptId)?.canLinkRead===true,directory:this.read()};
 }
 async steer({runId,admit=()=>{}}){return this.transaction(s=>{admit();const current=s.actions.find(a=>a.id===s.focus);if(current?.state==='active'){current.state='blocked';current.observation={authority:'human',claim:'New user direction supersedes this focus. Replan before continuing it.',receipts:[]};}s.focus=null;s.steering={authority:'human',source:'run-steer',runId,at:this.now(),requiresReplan:true};},{actionEdit:true});}
 async handleModelTool(args,options){
  const selected=this.state.actions.find(action=>action.id===args?.id);
  const validated=directoryToolContract.parseModelArguments(args,{qualifyingAction:Boolean(selected?.qualifying)});
  return this.handle(validated,options);
 }
 async handle(args,options){options?.admit?.();if(args.action==='observe'&&!observeOutcomes.includes(args.outcome))throw fail('DIRECTORY_OUTCOME','Set observe outcome to partial if any condition or required count remains unmet; use objective-met only when the whole active objective is met. This call made no changes.');return args.action==='read'?this.read():this.edit(args,options);}
 finalStatus({trace,planRepairRequired=false}={}){
  const s=this.read(), blocked=s.actions.filter(a=>a.state==='blocked').map(a=>a.id), derived=new Set(s.dependencyBlocked.map(a=>a.id));
  const pending=s.actions.filter(a=>a.state==='active'||a.state==='pending'&&!derived.has(a.id)).map(a=>a.id);
  const unknown=s.receipts.filter(unresolvedEffect).map(r=>r.id);
  const reason=s.steering?.requiresReplan?'replan-required':planRepairRequired?'plan-repair-required':!s.actions.length?'no-actions':unknown.length?'unknown-effects':pending.length?'pending-actions':blocked.length?'blocked-paths':'ready';
  // "ready" is permission to report, never a claim that the task was achieved.
  const result={ready:reason==='ready'||reason==='blocked-paths',reason,pending,blocked,focus:s.focus,readyActions:s.ready,dependencyBlocked:s.dependencyBlocked,unknown,outcomeVerification:'not inferred from final response'};
  try{trace?.({revision:s.revision,actionRevision:s.actionRevision,ready:result.ready,actionCount:s.actions.length,pendingCount:pending.length,blockedCount:blocked.length,dependencyBlockedCount:s.dependencyBlocked.length,unknownCount:unknown.length,requiresReplan:s.steering?.requiresReplan===true,reason});}catch{}
  return result;
 }
}
