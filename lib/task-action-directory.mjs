const fail=(code,message)=>Object.assign(Error(message),{code,status:409});
const copy=value=>structuredClone(value);
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(value);
const text=(value,max=1200)=>typeof value==='string'&&value.trim()&&value.length<=max;

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
export const ACTION_DIRECTORY_INSTRUCTIONS=`DIRECTORY ACTION EXECUTION\nThe host binds your mutations to the last action snapshot issued to this agent. Do not calculate revision numbers; the optional echoed revision field is not used for model mutations. When a human changes the action outline, read Directory again before changing or executing it.\nMaintain this task's action outline with relay_directory_action. The outline can start small; add the next pending steps after discovery until the user's requested outcome is delivered or genuinely blocked. A plan replaces pending steps only; you can omit active or recorded steps and the host preserves them unchanged. Depend on their exact existing IDs as needed. Before a tool action that may change external state, plan bounded concrete actions and focus one ready action. Read-only discovery can start before focus. Tool attempts and returns are recorded by the host. Observe the focused action using exact returned receipt IDs and a concise outcome claim. You can cite successful, unassigned read-only receipts from this same turn if they support the claim; you do not need to repeat those reads. A tool return is activity evidence, not independent verification of your claim. Unknown attempts must remain unresolved, never assume absence or replay. Dependencies become ready after receipt-backed observations. If a prerequisite is blocked, dependent actions are not done and cannot run as planned. Add an independent alternative when it could advance the user's goal; otherwise report what was blocked and what was not done. New user directions supersede assumptions; stop immediately on cancellation. Do not mark work from final prose. Read the ledger after a conflict. This is current-task state only, never general memory.`;
export const ACTION_DIRECTORY_TOOL={type:'function',name:'relay_directory_action',description:'Read and coordinate this task action outline. Plan, focus, observe or block concrete work. Host receipts remain distinct from agent-authored outcome claims.',inputSchema:{type:'object',additionalProperties:false,required:['action'],properties:{action:{type:'string',enum:['read','plan','focus','observe','block']},revision:{type:'integer',minimum:0},actions:{type:'array',minItems:1,maxItems:24,items:{type:'object',additionalProperties:false,required:['id','objective','dependsOn'],properties:{id:{type:'string'},objective:{type:'string',maxLength:1200},reason:{type:'string',maxLength:1200},sourceRefs:{type:'array',maxItems:32,items:{type:'string'}},dependsOn:{type:'array',maxItems:24,items:{type:'string'}}}}},id:{type:'string'},claim:{type:'string',maxLength:1200},receipts:{type:'array',maxItems:32,items:{type:'string'}}}}};
/** New task-owned state. No legacy roots, shared memory, raw outputs or automatic replay. */
export class TaskActionDirectory {
 constructor({taskId,objective,snapshot,persist=async()=>{},now=()=>new Date().toISOString(),admitRecovery=()=>false}){
  if(!id(taskId)||!text(objective,8000))throw fail('DIRECTORY_SCOPE','A task identity and explicit objective are required.');
  if(snapshot&&(snapshot.version!==1||snapshot.taskId!==taskId))throw fail('DIRECTORY_SCOPE','Directory belongs to another task or format.');
  if(snapshot&&((snapshot.actionRevision!==undefined&&(!Number.isSafeInteger(snapshot.actionRevision)||snapshot.actionRevision<0||snapshot.actionRevision>snapshot.revision))||!Number.isSafeInteger(snapshot.revision)||snapshot.revision<0||!Array.isArray(snapshot.actions)||snapshot.actions.length>24||!Array.isArray(snapshot.receipts)||snapshot.receipts.length>256||!Number.isSafeInteger(snapshot.nextReceipt)||snapshot.nextReceipt<1||snapshot.actions.some(a=>!id(a.id)||!text(a.objective)||!Array.isArray(a.dependsOn)||!['pending','active','observed','blocked'].includes(a.state))||new Set(snapshot.actions.map(a=>a.id)).size!==snapshot.actions.length||snapshot.receipts.some(r=>r.taskId!==taskId||!id(r.id)||r.actionId!==null&&!snapshot.actions.some(a=>a.id===r.actionId)||r.linkedByActionId!==undefined&&(r.actionId!==null||r.canLinkRead!==true||r.state!=='returned'||r.success!==true||!snapshot.actions.some(a=>a.id===r.linkedByActionId))||!['unknown','returned'].includes(r.state))||new Set(snapshot.receipts.map(r=>r.id)).size!==snapshot.receipts.length))throw fail('DIRECTORY_CORRUPT','Saved action Directory is invalid; preserve it for recovery.');
  this.state=copy(snapshot?{...snapshot,actionRevision:snapshot.actionRevision??snapshot.revision}:{version:1,taskId,objective,revision:0,actionRevision:0,focus:null,actions:[],receipts:[],nextReceipt:1});this.persist=persist;this.now=now;this.admitRecovery=admitRecovery;this.queue=Promise.resolve();
 }
 read(){const s=copy(this.state);s.ready=s.actions.filter(a=>a.state==='pending'&&a.dependsOn.every(d=>s.actions.find(a=>a.id===d)?.state==='observed')).map(a=>a.id);s.dependencyBlocked=dependencyBlocks(s.actions);s.policy='Outcome claims are agent-authored; host receipts establish only handler activity. Unknown effects are not safe to replay.';return s;}
 async transaction(fn,{actionEdit=false}={}){const work=this.queue.catch(()=>{}).then(async()=>{const next=copy(this.state);const result=fn(next);next.revision++;if(actionEdit)next.actionRevision++;await this.persist(copy(next));this.state=next;return result===undefined?this.read():result;});this.queue=work.then(()=>{},error=>{if(![400,404,409].includes(error.status))throw error;});this.queue.catch(()=>{});return work;}
 async edit(input,{authority='agent',admit=()=>{},expectedActionRevision,runId,nodeId}={}){return this.transaction(s=>{admit();
  if(expectedActionRevision!==undefined?expectedActionRevision!==s.actionRevision:input.revision!==s.revision)throw Object.assign(fail('DIRECTORY_CHANGED','Read the current Directory revision before editing.'),{comparisonRevision:s.revision,comparisonActionRevision:s.actionRevision});
  if(input.action==='plan'){
   if(!Array.isArray(input.actions)||!input.actions.length||input.actions.length>24)throw fail('DIRECTORY_PLAN','Use 1–24 concrete actions.');
   const seen=new Set();const proposed=input.actions.map(a=>{if(!id(a.id)||seen.has(a.id)||!text(a.objective)||!Array.isArray(a.dependsOn)||a.dependsOn.length>24||a.dependsOn.some(x=>!id(x)))throw fail('DIRECTORY_PLAN','Invalid or duplicate action.');if(a.reason!==undefined&&!text(a.reason)||a.sourceRefs!==undefined&&(!Array.isArray(a.sourceRefs)||a.sourceRefs.length>32||a.sourceRefs.some(ref=>!s.receipts.some(r=>r.id===ref))))throw fail('DIRECTORY_SOURCE','Use a bounded reason and exact same-task host receipt references.');seen.add(a.id);return{id:a.id,objective:a.objective,...(a.reason?{reason:a.reason}:{}),...(a.sourceRefs?{sourceRefs:[...new Set(a.sourceRefs)]}:{}),dependsOn:[...new Set(a.dependsOn)],state:'pending',authority};});
   const recorded=s.actions.filter(a=>a.state!=='pending');
   const protectedIds=new Set(recorded.map(a=>a.id));
   for(const old of recorded){
    const replacement=proposed.find(a=>a.id===old.id);
    if(replacement&&(replacement.objective!==old.objective||JSON.stringify(replacement.dependsOn)!==JSON.stringify(old.dependsOn)))
     throw fail('DIRECTORY_RECORDED_ACTION','Action '+old.id+' has recorded work and cannot be rewritten. Submit the new pending actions with new IDs; omit the recorded row and it will be preserved.');
   }
   // Plans replace pending work, not the history. Keep original record order and provenance.
   const combined=[...recorded,...proposed.filter(a=>!protectedIds.has(a.id))];
   if(combined.length>24)throw fail('DIRECTORY_PLAN','The outline can hold 24 actions including recorded work. Keep the next steps focused.');
   const visit=(a,path=new Set())=>{if(path.has(a.id))throw fail('DIRECTORY_CYCLE','Action dependencies must not cycle.');for(const dependency of a.dependsOn){const parent=combined.find(a=>a.id===dependency);if(!parent)throw fail('DIRECTORY_DEPENDENCY','Dependency is absent.');visit(parent,new Set([...path,a.id]));}};combined.forEach(a=>visit(a));
   s.actions=combined;if(s.steering)s.steering.requiresReplan=false;return;
  }
  if(input.action==='planningChoice'){if(!id(input.moduleId)||!text(input.reason)||!s.actions.some(a=>a.id===input.focus)||!Array.isArray(input.sourceRefs)||input.sourceRefs.some(ref=>!s.receipts.some(r=>r.id===ref)))throw fail('DIRECTORY_CHOICE','Choose an existing action with a bounded reason and exact task receipts.');s.planningChoice={moduleId:input.moduleId,focus:input.focus,reason:input.reason,sourceRefs:[...new Set(input.sourceRefs)],authority};return;}
  const a=s.actions.find(a=>a.id===input.id);if(!a)throw fail('DIRECTORY_ACTION','Choose an existing action.');
  if(input.action==='focus'){
   if(s.receipts.some(r=>r.actionId===a.id&&r.state==='unknown'))throw fail('DIRECTORY_UNKNOWN','This action has an unresolved attempt. It cannot be replayed; block it and continue independent work.');
   if(!['pending','active'].includes(a.state)||!a.dependsOn.every(d=>s.actions.find(x=>x.id===d)?.state==='observed'))throw fail('DIRECTORY_NOT_READY','Action dependencies are not observed.');
   if(s.focus&&s.focus!==a.id&&s.actions.find(x=>x.id===s.focus)?.state==='active')throw fail('DIRECTORY_ACTIVE','Observe or block the current action before switching.');a.state='active';s.focus=a.id;return;
  }
  if(input.action==='observe'){
   if(a.state!=='active'||s.focus!==a.id)throw fail('DIRECTORY_OBSERVATION','This action is not focused. Focus it before recording the observation.');
   if(!text(input.claim)||!Array.isArray(input.receipts)||!input.receipts.length||input.receipts.length>32)throw fail('DIRECTORY_OBSERVATION','Supply a concise outcome claim and exact host receipts for the active action.');
   if(s.receipts.some(r=>r.actionId===a.id&&r.state==='unknown'))throw fail('DIRECTORY_UNKNOWN','This action has an unresolved attempt.');
   const cited=[...new Set(input.receipts)].map(reference=>s.receipts.find(r=>r.id===reference));
   const linkable=r=>r?.actionId===null&&r.canLinkRead===true&&!r.linkedByActionId&&r.success===true&&id(runId)&&r.runId===runId&&id(nodeId)&&r.nodeId===nodeId;
   if(cited.some(r=>r?.state!=='returned'||r.actionId!==a.id&&!linkable(r)))throw fail('DIRECTORY_EVIDENCE','Use returned receipts for this action, or successful unassigned read-only receipts from this turn. Do not repeat a possible external action to obtain a receipt.');
   // Keep original action attribution immutable. The later association is explicit.
   for(const receipt of cited)if(linkable(receipt))receipt.linkedByActionId=a.id;
   a.state='observed';a.observation={authority,claim:input.claim,receipts:[...new Set(input.receipts)]};s.focus=null;return;
  }
  if(input.action==='block'){if(!text(input.claim))throw fail('DIRECTORY_REASON','To block this action, supply the claim field with a concise, actual reason. A missing input is not a blocker until checked if a discovery tool is available.');a.state='blocked';a.observation={authority,claim:input.claim,receipts:[]};if(s.focus===a.id)s.focus=null;return;}
  throw fail('DIRECTORY_ACTION','Unsupported Directory edit.');
 },{actionEdit:true});}
 async execute(call,dispatch,{runId,nodeId,signal,recoveryFor,observationOnly=false,admit=()=>{},expectedRevision,expectedActionRevision,trace}={}){
  if(signal?.aborted)throw signal.reason||fail('ABORT_ERR','Cancelled.');
  if(!id(runId)||!id(nodeId)||!id(call?.name))throw fail('DIRECTORY_CALL','Exact host call identity is required.');
  let receiptId,startRevision,gate;const report=value=>{try{trace?.(value);}catch{}};
  await this.transaction(s=>{admit();startRevision=s.revision;gate={boundActionRevision:expectedActionRevision??null,actualActionRevision:s.actionRevision,actualRevision:s.revision,focusId:s.focus,callClass:observationOnly?'observation':'effect'};const reject=(code,message)=>{report({...gate,phase:'gate',decision:'reject',code});throw fail(code,message);};const bound=expectedActionRevision!==undefined?expectedActionRevision===s.actionRevision:expectedRevision===undefined||expectedRevision===s.revision;if(!observationOnly&&!bound)reject('DIRECTORY_CHANGED','User or another owner changed the action outline. Read it before another effect.');const a=bound?s.actions.find(a=>a.id===s.focus):null;gate.receiptActionId=a?.id||null;if(!observationOnly&&(!a||a.state!=='active'))reject('DIRECTORY_FOCUS','Focus a ready action before ordinary work.');const unknown=s.receipts.filter(r=>r.actionId===a?.id&&r.state==='unknown');if(!observationOnly&&unknown.length&&!(typeof recoveryFor==='string'&&unknown.some(r=>r.id===recoveryFor)&&this.admitRecovery(call,{taskId:s.taskId,runId,nodeId,receipt:copy(unknown.find(r=>r.id===recoveryFor))})===true))reject('DIRECTORY_UNKNOWN','Prior attempt is unresolved; only host-classified recovery observations may run for this action.');if(s.receipts.length>=256)reject('DIRECTORY_CAPACITY','This bounded action ledger is full; preserve it rather than discard evidence.');receiptId='receipt-'+s.nextReceipt++;s.receipts.push({id:receiptId,taskId:s.taskId,runId,nodeId,actionId:a?.id||null,tool:call.name,...(observationOnly&&bound&&!a?{canLinkRead:true}:{}),...(recoveryFor?{recoveryFor}:{}),state:'unknown',at:this.now()});report({...gate,phase:'gate',decision:'allow',receiptId});});report({...gate,phase:'reserved',receiptId,reservationRevision:startRevision+1});
  let result,dispatchStarted=false;try{admit();if(signal?.aborted)throw signal.reason||fail('ABORT_ERR','Cancelled.');dispatchStarted=true;report({...gate,phase:'dispatch',receiptId});result=await dispatch(call);}catch(error){report({...gate,phase:'threw',receiptId,dispatchStarted,code:id(error?.code)?error.code:null});await this.transaction(s=>{const receipt=s.receipts.find(r=>r.id===receiptId);receipt.threw=true;receipt.code=id(error?.code)?error.code:null;});throw error;}
  await this.transaction(s=>{const receipt=s.receipts.find(r=>r.id===receiptId);receipt.state='returned';receipt.success=typeof result?.success==='boolean'?result.success:null;receipt.returnedAt=this.now();});report({...gate,phase:'returned',receiptId,success:typeof result?.success==='boolean'?result.success:null});return{result,receiptId,startRevision,canLinkRead:result?.success===true&&this.state.receipts.find(r=>r.id===receiptId)?.canLinkRead===true,directory:this.read()};
 }
 async steer({runId,admit=()=>{}}){return this.transaction(s=>{admit();const current=s.actions.find(a=>a.id===s.focus);if(current?.state==='active'){current.state='blocked';current.observation={authority:'human',claim:'New user direction supersedes this focus. Replan before continuing it.',receipts:[]};}s.focus=null;s.steering={authority:'human',source:'run-steer',runId,at:this.now(),requiresReplan:true};},{actionEdit:true});}
 async handle(args,options){options?.admit?.();return args.action==='read'?this.read():this.edit(args,options);}
 finalStatus({trace,planRepairRequired=false}={}){
  const s=this.read(), blocked=s.actions.filter(a=>a.state==='blocked').map(a=>a.id), derived=new Set(s.dependencyBlocked.map(a=>a.id));
  const pending=s.actions.filter(a=>a.state==='active'||a.state==='pending'&&!derived.has(a.id)).map(a=>a.id);
  const unknown=s.receipts.filter(r=>r.state==='unknown').map(r=>r.id);
  const reason=s.steering?.requiresReplan?'replan-required':planRepairRequired?'plan-repair-required':!s.actions.length?'no-actions':unknown.length?'unknown-effects':pending.length?'pending-actions':blocked.length?'blocked-paths':'ready';
  // "ready" is permission to report, never a claim that the task was achieved.
  const result={ready:reason==='ready'||reason==='blocked-paths',reason,pending,blocked,dependencyBlocked:s.dependencyBlocked,unknown,outcomeVerification:'not inferred from final response'};
  try{trace?.({revision:s.revision,actionRevision:s.actionRevision,ready:result.ready,actionCount:s.actions.length,pendingCount:pending.length,blockedCount:blocked.length,dependencyBlockedCount:s.dependencyBlocked.length,unknownCount:unknown.length,requiresReplan:s.steering?.requiresReplan===true,reason});}catch{}
  return result;
 }
}
