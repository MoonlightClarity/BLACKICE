const fail=(code,message)=>Object.assign(Error(message),{code,status:409});
const copy=value=>structuredClone(value);
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(value);
const text=(value,max=1200)=>typeof value==='string'&&value.trim()&&value.length<=max;
export const ACTION_DIRECTORY_INSTRUCTIONS=`DIRECTORY ACTION EXECUTION\nMaintain this task's action outline with relay_directory_action. Before ordinary work, plan bounded concrete actions and focus one ready action. Tool attempts and returns are recorded by the host. Observe an action using exact returned receipt IDs and a concise outcome claim; a tool return is activity evidence, not independent verification of your claim. Unknown attempts must remain unresolved, never assume absence or replay. Dependencies become ready after receipt-backed observations. New user directions supersede assumptions; stop immediately on cancellation. Do not mark work from final prose. Read the ledger after a conflict. This is current-task state only, never general memory.`;
export const ACTION_DIRECTORY_TOOL={type:'function',name:'relay_directory_action',description:'Read and coordinate this task action outline. Plan, focus, observe or block concrete work. Host receipts remain distinct from agent-authored outcome claims.',inputSchema:{type:'object',additionalProperties:false,required:['action'],properties:{action:{type:'string',enum:['read','plan','focus','observe','block']},revision:{type:'integer',minimum:0},actions:{type:'array',minItems:1,maxItems:24,items:{type:'object',additionalProperties:false,required:['id','objective','dependsOn'],properties:{id:{type:'string'},objective:{type:'string',maxLength:1200},dependsOn:{type:'array',maxItems:24,items:{type:'string'}}}}},id:{type:'string'},claim:{type:'string',maxLength:1200},receipts:{type:'array',maxItems:32,items:{type:'string'}}}}};
/** New task-owned state. No legacy roots, shared memory, raw outputs or automatic replay. */
export class TaskActionDirectory {
 constructor({taskId,objective,snapshot,persist=async()=>{},now=()=>new Date().toISOString()}){
  if(!id(taskId)||!text(objective,8000))throw fail('DIRECTORY_SCOPE','A task identity and explicit objective are required.');
  if(snapshot&&(snapshot.version!==1||snapshot.taskId!==taskId))throw fail('DIRECTORY_SCOPE','Directory belongs to another task or format.');
  this.state=copy(snapshot||{version:1,taskId,objective,revision:0,focus:null,actions:[],receipts:[],nextReceipt:1});this.persist=persist;this.now=now;this.queue=Promise.resolve();
 }
 read(){const s=copy(this.state);s.ready=s.actions.filter(a=>a.state==='pending'&&a.dependsOn.every(d=>s.actions.find(a=>a.id===d)?.state==='observed')).map(a=>a.id);s.policy='Outcome claims are agent-authored; host receipts establish only handler activity. Unknown effects are not safe to replay.';return s;}
 async transaction(fn){const work=this.queue.catch(()=>{}).then(async()=>{const next=copy(this.state);const result=fn(next);next.revision++;await this.persist(copy(next));this.state=next;return result===undefined?this.read():result;});this.queue=work;return work;}
 async edit(input,{authority='agent'}={}){return this.transaction(s=>{
  if(input.revision!==s.revision)throw fail('DIRECTORY_CHANGED','Read the current Directory revision before editing.');
  if(input.action==='plan'){
   if(!Array.isArray(input.actions)||!input.actions.length||input.actions.length>24)throw fail('DIRECTORY_PLAN','Use 1–24 concrete actions.');
   const seen=new Set();const proposed=input.actions.map(a=>{if(!id(a.id)||seen.has(a.id)||!text(a.objective)||!Array.isArray(a.dependsOn)||a.dependsOn.length>24||a.dependsOn.some(x=>!id(x)))throw fail('DIRECTORY_PLAN','Invalid or duplicate action.');seen.add(a.id);return{id:a.id,objective:a.objective,dependsOn:[...new Set(a.dependsOn)],state:'pending',authority};});
   const visit=(a,path=new Set())=>{if(path.has(a.id))throw fail('DIRECTORY_CYCLE','Action dependencies must not cycle.');for(const dependency of a.dependsOn){const parent=proposed.find(a=>a.id===dependency);if(!parent)throw fail('DIRECTORY_DEPENDENCY','Dependency is absent.');visit(parent,new Set([...path,a.id]));}};proposed.forEach(a=>visit(a));
   for(const old of s.actions.filter(a=>a.state!=='pending')){const replacement=proposed.find(a=>a.id===old.id);if(!replacement||replacement.objective!==old.objective||JSON.stringify(replacement.dependsOn)!==JSON.stringify(old.dependsOn))throw fail('DIRECTORY_RECORDED_ACTION','Retain attempted actions and their scope; add a new action for changed work.');Object.assign(replacement,old);}s.actions=proposed;return;
  }
  const a=s.actions.find(a=>a.id===input.id);if(!a)throw fail('DIRECTORY_ACTION','Choose an existing action.');
  if(input.action==='focus'){
   if(s.receipts.some(r=>r.state==='unknown'))throw fail('DIRECTORY_UNKNOWN','An attempt has no observed return. Inspect its effects before continuing; do not replay.');
   if(!['pending','active'].includes(a.state)||!a.dependsOn.every(d=>s.actions.find(x=>x.id===d)?.state==='observed'))throw fail('DIRECTORY_NOT_READY','Action dependencies are not observed.');
   if(s.focus&&s.focus!==a.id&&s.actions.find(x=>x.id===s.focus)?.state==='active')throw fail('DIRECTORY_ACTIVE','Observe or block the current action before switching.');a.state='active';s.focus=a.id;return;
  }
  if(input.action==='observe'){
   if(a.state!=='active'||s.focus!==a.id||!text(input.claim)||!Array.isArray(input.receipts)||!input.receipts.length||input.receipts.length>32)throw fail('DIRECTORY_OBSERVATION','Supply a concise outcome claim and exact host receipts for the active action.');
   if(s.receipts.some(r=>r.actionId===a.id&&r.state==='unknown'))throw fail('DIRECTORY_UNKNOWN','This action has an unresolved attempt.');
   if(input.receipts.some(reference=>!s.receipts.some(r=>r.id===reference&&r.actionId===a.id&&r.state==='returned')))throw fail('DIRECTORY_EVIDENCE','Use returned host receipts belonging to this action.');
   a.state='observed';a.observation={authority,claim:input.claim,receipts:[...new Set(input.receipts)]};s.focus=null;return;
  }
  if(input.action==='block'){if(!text(input.claim))throw fail('DIRECTORY_REASON','Record why this action is blocked.');a.state='blocked';a.observation={authority,claim:input.claim,receipts:[]};if(s.focus===a.id)s.focus=null;return;}
  throw fail('DIRECTORY_ACTION','Unsupported Directory edit.');
 });}
 async execute(call,dispatch,{runId,nodeId,signal}={}){
  if(signal?.aborted)throw signal.reason||fail('ABORT_ERR','Cancelled.');
  if(!id(runId)||!id(nodeId)||!id(call?.name))throw fail('DIRECTORY_CALL','Exact host call identity is required.');
  let receiptId;
  await this.transaction(s=>{const a=s.actions.find(a=>a.id===s.focus);if(!a||a.state!=='active')throw fail('DIRECTORY_FOCUS','Focus a ready action before ordinary work.');if(s.receipts.some(r=>r.state==='unknown'))throw fail('DIRECTORY_UNKNOWN','Prior attempt is unresolved; no tool was dispatched.');if(s.receipts.length>=256)throw fail('DIRECTORY_CAPACITY','This bounded action ledger is full; preserve it rather than discard evidence.');receiptId='receipt-'+s.nextReceipt++;s.receipts.push({id:receiptId,taskId:s.taskId,runId,nodeId,actionId:a.id,tool:call.name,state:'unknown',at:this.now()});});
  let result;try{if(signal?.aborted)throw signal.reason||fail('ABORT_ERR','Cancelled.');result=await dispatch(call);}catch(error){await this.transaction(s=>{const receipt=s.receipts.find(r=>r.id===receiptId);receipt.threw=true;receipt.code=id(error?.code)?error.code:null;});throw error;}
  await this.transaction(s=>{const receipt=s.receipts.find(r=>r.id===receiptId);receipt.state='returned';receipt.success=typeof result?.success==='boolean'?result.success:null;receipt.returnedAt=this.now();});return{result,receiptId,directory:this.read()};
 }
 async handle(args){return args.action==='read'?this.read():this.edit(args);}
 finalStatus(){const s=this.read();return{ready:s.actions.length>0&&s.actions.every(a=>['observed','blocked'].includes(a.state))&&!s.receipts.some(r=>r.state==='unknown'),pending:s.actions.filter(a=>['pending','active'].includes(a.state)).map(a=>a.id),unknown:s.receipts.filter(r=>r.state==='unknown').map(r=>r.id),outcomeVerification:'not inferred from final response'};}
}
