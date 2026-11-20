import {EventEmitter} from 'node:events';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {conversationTitle} from '../public/task-title.mjs';
import {serializeConversationExport} from './conversation-export.mjs';
import {conversationSearchOptions,createConversationSearchDocument,searchConversationDocuments} from './conversation-search.mjs';
import {projectPlanningActivity,mergePlanningActivity} from '../public/next/chat/planning-timeline.mjs';
import {capturePlanningGuestObservationEvents} from './planning-review-observations.mjs';
import {archivedChatToolFailure} from '../public/next/chat/tool-failure.mjs';
import {retireTurnReceipts} from './retire-turn-receipts.mjs';

const validId=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(id);
const clone=value=>structuredClone(value);
const active=new Set(['queued','running','waiting']);
const missing=()=>Object.assign(new Error('Conversation not found.'),{status:404});
const recoveryError=()=>Object.assign(new Error('Conversation organization needs repair. Saved chats are preserved.'),{status:503,code:'CONVERSATION_STATE_DAMAGED'});
async function atomicWrite(io,file,text){
  const temporary=`${file}.${randomUUID()}.tmp`;
  try{const handle=await io.open(temporary,'wx',0o600);try{await handle.writeFile(text);await handle.sync();}finally{await handle.close();}await io.rename(temporary,file);}
  finally{await io.rm(temporary,{force:true}).catch(()=>{});}
}
const durableEvent=event=>{const data=event?.data||event;return ['message','steer'].includes(data?.type)||data?.type==='item'&&data.item?.type==='agentMessage';};
const planningEvent=event=>event?.data?.type==='task.state'||event?.data?.type==='planning.reassessment';
const guestObservationEvent=event=>{const data=event?.data;if(data?.type==='tool.result')return data.tool==='relay_workbench'&&['run_guest_script','guest_job'].includes(data.action);if(data?.type!=='item'||data.stage!=='completed'||data.item?.type!=='dynamicToolCall'||(data.item.tool||data.item.name)!=='relay_workbench')return false;let args=data.item.arguments;if(typeof args==='string')try{args=JSON.parse(args);}catch{return false;}return ['run_guest_script','guest_job'].includes(args?.action);};
const orderedEvents=events=>(Array.isArray(events)?events:[]).filter(event=>event&&typeof event==='object').map((event,index)=>Number.isFinite(event.timelineOrder)?event:{...event,timelineOrder:index});
const mergeEvents=(...lists)=>{const seen=new Map();for(const event of lists.flat()){if(!event||typeof event!=='object')continue;const data=event.data||event,key=JSON.stringify([event.at,event.nodeId,data.type,data.itemId||data.item?.id,data.text??data.item?.text,data.delta,data.action,data.state?.revision,data.review?.reviewedRevision,data.returnCount,data.reviewStatus,data.workerId]);const previous=seen.get(key);if(!previous)seen.set(key,event);else if(!Number.isFinite(previous.timelineOrder)&&Number.isFinite(event.timelineOrder))seen.set(key,{...previous,timelineOrder:event.timelineOrder});}return[...seen.values()].sort((a,b)=>(Date.parse(a.at)||0)-(Date.parse(b.at)||0)||(a.timelineOrder??0)-(b.timelineOrder??0));};

// A saved turn without a live engine owner cannot keep an execution lease after
// restart. Preserve its recorded work and report interruption, not a completed
// cancellation acknowledgement. The original archive bytes remain untouched.
function recoverUnownedTurn(run){
  if(!active.has(run.status)&&run.settled!==false)return run;
  const stopping=run.status==='cancelled',previousError=typeof run.error==='string'?run.error:run.error?.message;
  run.status='failed';run.settled=true;
  const notice=`BLACKICE restarted before this turn finished${stopping?' stopping':''}. Inspect the current state before continuing.`;
  run.error=previousError?`${previousError}\n${notice}`:notice;
  for(const node of Object.values(run.nodes))if(active.has(node.status))node.status='cancelled';
  return run;
}

/** A separate turn archive keeps conversations when the recent execution list rolls over. */
export class ConversationArchive extends EventEmitter {
  constructor({dataDir,engine,io=fs}){super();this.directory=path.join(dataDir,'conversations');this.stateFile=path.join(dataDir,'conversation-state.json');this.states={};this.transitions=new Map();this.engine=engine;this.io=io;this.entries=new Map();this.messages=new Map();this.planningActivity=new Map();this.planningStates=new Map();this.guestObservations=new Map();this.searchDocuments=new Map();this.retiredReceiptIds=new Set();this.chain=Promise.resolve();this.metadataRevision=0;this.error=null;this.stateError=null;this.stateWriteError=null;this.writeFailures=new Set();this.stateRecoveryRequired=false;this.recovered=false;this.closed=false;}
  async readStates(file){
    if((await this.io.stat(file)).size>8*1024*1024)throw recoveryError();
    const value=JSON.parse(await this.io.readFile(file,'utf8'));
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.entries(value).some(([id,item])=>!(validId(id)||/^folder:fld_[a-zA-Z0-9_-]{8,100}$/.test(id)&&item?.kind==='folder')||!['active','archived','deleted'].includes(item?.state)||item.title!==undefined&&(typeof item.title!=='string'||!item.title.trim()||item.title.length>120)||item.receiptPurgePending!==undefined&&(!validId(id)||item.state==='active'||!Array.isArray(item.receiptPurgePending)||item.receiptPurgePending.some(id=>!validId(id)))))throw recoveryError();
    return value;
  }
  async loadStates(){
    try{this.states=await this.readStates(this.stateFile);return;}
    catch(primaryError){
      let backupError;
      try{this.states=await this.readStates(this.stateFile+'.bak');}
      catch(error){backupError=error;}
      if(backupError){
        if(primaryError.code==='ENOENT'&&backupError.code==='ENOENT')return;
        this.stateRecoveryRequired=true;this.stateError=recoveryError().message;return;
      }
      this.recovered=true;
      try{
        if(primaryError.code!=='ENOENT')await this.io.copyFile(this.stateFile,`${this.stateFile}.corrupt-${randomUUID()}`);
        await atomicWrite(this.io,this.stateFile,JSON.stringify(this.states));
      }catch{this.stateError='Conversation organization was recovered, but could not be saved. Saved chats are preserved.';}
    }
  }
  async init(){
    await this.io.mkdir(this.directory,{recursive:true});
    await this.loadStates();
    this.metadataRevision=Object.values(this.states).reduce((max,item)=>Math.max(max,Number.isSafeInteger(item.revision)?item.revision:0),0);
    // A previously accepted operation may have been interrupted between
    // stores. Mask only its recorded IDs on boot; do not sweep old archives.
    for(const state of Object.values(this.states))for(const id of state.receiptPurgePending||[]){
      this.retiredReceiptIds.add(id);
      const live=this.engine.runs?.get?.(id);
      if(live)retireTurnReceipts(live);
    }
    const owned=new Set(this.engine.listRuns().map(run=>run.id));
    for(const file of await this.io.readdir(this.directory)){
      if(!file.endsWith('.json')||!validId(file.slice(0,-5)))continue;
      try{
        const run=await this.readFile(file.slice(0,-5));if(run.receiptDiagnosticsRemoved===true)this.retiredReceiptIds.add(run.id);this.remember(owned.has(run.id)?run:recoverUnownedTurn(run));this.messages.set(run.id,run.events||[]);
        if(owned.has(run.id)&&run.planningGuestObservationEvents)this.guestObservations.set(run.id,capturePlanningGuestObservationEvents(run));
        const activity=projectPlanningActivity(run);if(activity.length)this.planningActivity.set(run.id,activity);
        // An older archive's latest outline is not proof that its earlier
        // planning history was projected. Let live execution receipts backfill
        // that history unless a persisted cursor covers this exact revision.
        const projected=activity.length&&Array.isArray(run.planningActivity)&&run.planningActivity.length
          &&Number.isSafeInteger(run.planningActivityRevision)&&run.planningActivityRevision>0&&run.planningActivityRevision===run.taskState?.revision;
        if(owned.has(run.id)&&projected)this.planningStates.set(run.id,run.taskState);
      }
      catch(error){this.error=`Conversation archive needs attention: ${file}: ${error.message}`;}
    }
    for(const run of this.engine.listRuns())try{await this.capture(run);}catch{}
    this.listener=event=>{
      if(event.type==='run.updated'&&event.data?.id)this.capture(event.data).catch(()=>{});
      if(event.type==='agent.event'&&durableEvent(event)){
        const receipts=this.messages.get(event.runId)||[];receipts.push(clone(event));this.messages.set(event.runId,receipts);
        try{this.capture(this.engine.getRun(event.runId)).catch(()=>{});}catch{}
      }
      if(event.type==='agent.event'&&planningEvent(event))try{this.capture(this.engine.getRun(event.runId)).catch(()=>{});}catch{}
      // Capture complete linked guest settlements before a long operational
      // segment can evict them from the engine's bounded event ring.
      if(event.type==='agent.event'&&guestObservationEvent(event))try{this.capture(this.engine.getRun(event.runId)).catch(()=>{});}catch{}
    };
    this.engine.on('event',this.listener);return this;
  }
  status(){const error=this.stateError||this.stateWriteError||this.error||(this.writeFailures.size?'Some conversation changes could not be saved. Retry after checking available disk space.':null);return{healthy:!error,error,turns:this.entries.size,conversations:this.list('all').length,metadataRevision:this.metadataRevision,recovered:this.recovered,recoveryRequired:this.stateRecoveryRequired,stateRecoveryRequired:this.stateRecoveryRequired};}
  remember(run){this.engine.rememberClientRequest?.(run);this.entries.set(run.id,{id:run.id,taskId:run.taskId||null,parentRunId:run.parentRunId||null,...(validId(run.chatDisplayGroupId)?{chatDisplayGroupId:run.chatDisplayGroupId}:{}),createdAt:run.createdAt,updatedAt:run.updatedAt||run.createdAt,status:run.status,settled:run.settled,title:conversationTitle(run.input,{fallback:run.workflowName||'Conversation'})});this.searchDocuments.set(run.id,createConversationSearchDocument(run));}
  async readFile(id){
    if(!validId(id))throw missing();
    const file=path.join(this.directory,id+'.json'),info=await this.io.stat(file);
    if(info.size>32*1024*1024)throw Error('Saved conversation turn exceeds the supported32MiB limit.');
    const run=JSON.parse(await this.io.readFile(file,'utf8'));
    if(run.id!==id||!run.workflow?.nodes||!run.nodes||typeof run.input!=='string')throw Error('Invalid saved turn.');
    return run;
  }
  capture(value){
    if(this.closed)return Promise.resolve();
    const run=clone(value);
    // The large machine journal is never included in ordinary run snapshots
    // or pushed to the renderer. Archive it once when the run settles.
    const machineTrace=run.settled?this.engine.runs?.get?.(run.id)?.turnMachineTrace:undefined;
    if(machineTrace)run.turnMachineTrace=machineTrace;
    if(this.retiredReceiptIds.has(run.id)||run.receiptDiagnosticsRemoved===true)retireTurnReceipts(run);
    // Keep bounded original linked guest observations before message curation.
    // The ordinary recent-run snapshot remains the full execution history.
    const guestObservations=capturePlanningGuestObservationEvents(run,this.guestObservations.get(run.id));
    if(guestObservations){run.planningGuestObservationEvents=guestObservations;this.guestObservations.set(run.id,guestObservations);}else{delete run.planningGuestObservationEvents;this.guestObservations.delete(run.id);}
    run.events=orderedEvents(run.events);
    // Preserve chronological public planning receipts before the execution
    // trace rolls away. Full task snapshots and tool payloads stay out of this
    // activity history; the latest taskState remains the existing saved outline.
    const activity=mergePlanningActivity(this.planningActivity.get(run.id),projectPlanningActivity(run,{previousState:this.planningStates.get(run.id)}));
    if(activity.length){run.planningActivity=activity;this.planningActivity.set(run.id,activity);if(Number.isSafeInteger(run.taskState?.revision))run.planningActivityRevision=run.taskState.revision;}else{delete run.planningActivity;delete run.planningActivityRevision;}
    if(run.taskState){this.planningStates.delete(run.id);this.planningStates.set(run.id,run.taskState);while(this.planningStates.size>256)this.planningStates.delete(this.planningStates.keys().next().value);}
    // Save one display-only failure receipt. Raw messages, operation digests, and tool traces stay out of the archive.
    const toolFailure=archivedChatToolFailure(run);
    delete run.chatToolFailureReceipt;
    if(toolFailure)run.archivedToolFailure=toolFailure;else delete run.archivedToolFailure;
    // Tool traces remain in execution history. Conversation receipts retain actual messages.
    run.events=mergeEvents(this.messages.get(run.id)||[],(run.events||[]).filter(durableEvent));
    this.messages.set(run.id,clone(run.events));
    const text=JSON.stringify(run);if(Buffer.byteLength(text)>32*1024*1024){this.error='A conversation turn exceeded32MiB and was not archived.';this.emit('updated',this.status());return Promise.reject(Error(this.error));}
    const operation=async()=>{
      const file=path.join(this.directory,run.id+'.json');if(!validId(run.id))throw Error('Invalid conversation run ID.');
      let payload=text;
      if(this.retiredReceiptIds.has(run.id)){if(run.receiptDiagnosticsRemoved!==true)payload=JSON.stringify(retireTurnReceipts(run));}
      else if(run.directoryDiagnostics==='maximal'&&run.settled&&!run.turnMachineTrace&&this.entries.has(run.id)){
        // Continue/Retry can restore a public snapshot that intentionally did
        // not carry the journal; do not overwrite an existing local export.
        const prior=await this.readFile(run.id);
        if(prior.turnMachineTrace){run.turnMachineTrace=prior.turnMachineTrace;payload=JSON.stringify(run);}
      }
      if(Buffer.byteLength(payload)>32*1024*1024)throw Error('A conversation turn exceeded32MiB and was not archived.');
      await atomicWrite(this.io,file,payload);this.writeFailures.delete(run.id);this.remember(run);this.emit('updated',this.status());
    };
    this.chain=this.chain.catch(()=>{}).then(operation).catch(error=>{this.writeFailures.add(run.id);this.emit('updated',this.status());throw error;});return this.chain;
  }
  async get(id,{includeMachineTrace=false}={}){
    if(this.retiredReceiptIds.has(id))includeMachineTrace=false;
    try{const live=this.engine.getRun(id),witnesses=capturePlanningGuestObservationEvents(live,this.guestObservations.get(id));if(witnesses)live.planningGuestObservationEvents=witnesses;live.events=mergeEvents(this.messages.get(id)||[],orderedEvents(live.events));const activity=mergePlanningActivity(this.planningActivity.get(id),projectPlanningActivity(live,{previousState:this.planningStates.get(id)}));if(activity.length){live.planningActivity=activity;if(Number.isSafeInteger(live.taskState?.revision))live.planningActivityRevision=live.taskState.revision;}if(includeMachineTrace&&live.directoryDiagnostics==='maximal'){live.turnMachineTrace=this.engine.runs?.get?.(id)?.turnMachineTrace;if(!live.turnMachineTrace&&this.entries.has(id))live.turnMachineTrace=(await this.readFile(id)).turnMachineTrace;}return this.retiredReceiptIds.has(id)?retireTurnReceipts(live):live;}catch{}
    if(!this.entries.has(id))throw missing();
    const run=await this.readFile(id);
    if(!includeMachineTrace)delete run.turnMachineTrace;
    if(this.retiredReceiptIds.has(id))retireTurnReceipts(run);
    return recoverUnownedTurn(run);
  }
  async family(id){
    await this.chain.catch(()=>{});const selected=await this.get(id),taskId=selected.taskId||selected.id;
    // Family membership needs only lineage and ordering metadata. listRuns()
    // snapshots every transcript; leave that work to get() for the matching IDs.
    const live=this.engine.runs instanceof Map?[...this.engine.runs.values()].reverse():this.engine.listRuns();
    const all=new Map([...this.entries.values()].map(e=>[e.id,e]));
    for(const run of live)all.set(run.id,{id:run.id,taskId:run.taskId||run.id,parentRunId:run.parentRunId,createdAt:run.createdAt});
    // Older releases did not have taskId. Walk parent links to group their real conversations.
    const rootOf=item=>{let root=item,seen=new Set();while(root.parentRunId&&all.has(root.parentRunId)&&!seen.has(root.id)){seen.add(root.id);root=all.get(root.parentRunId);}return root.taskId||root.id;};
    const rootId=rootOf(all.get(id)||selected),ids=[...all.values()].filter(item=>(item.taskId===taskId&&taskId!==selected.id)||rootOf(item)===rootId).sort((a,b)=>Date.parse(a.createdAt)-Date.parse(b.createdAt)).map(item=>item.id);
    const runs=await Promise.all(ids.map(runId=>this.get(runId)));
    return{rootId,taskId:rootId,...(this.goalSummary(rootId)?{goal:this.goalSummary(rootId)}:{}),state:this.stateRecoveryRequired?'unknown':this.states[rootId]?.state||'active',title:this.states[rootId]?.title||this.entries.get(rootId)?.title||conversationTitle(runs[0]?.input,{fallback:'Conversation'}),runs,truncated:!this.status().healthy,recoveryRequired:this.stateRecoveryRequired};
  }
  /** Display metadata only. Do not replace family(), which is a task boundary
   * for Continue, Goal dispatch, browser ownership and saved execution state. */
  async displayGroup(id){
    if(!validId(id))throw missing();
    await this.chain.catch(()=>{});
    if(this.stateRecoveryRequired)throw recoveryError();
    const all=new Map(this.entries);
    for(const run of this.engine.runs?.values?.()||[])all.set(run.id,{id:run.id,taskId:run.taskId,parentRunId:run.parentRunId,chatDisplayGroupId:run.chatDisplayGroupId,createdAt:run.createdAt});
    const selected=all.get(id);if(!selected)throw missing();
    const taskOf=record=>{
      if(validId(record.taskId))return record.taskId;
      let current=record;const seen=new Set();
      while(current.parentRunId&&all.has(current.parentRunId)&&!seen.has(current.id)){seen.add(current.id);current=all.get(current.parentRunId);}
      return current.id;
    };
    const selectedTaskId=taskOf(selected), anchor=all.get(selectedTaskId);
    if(!anchor)throw missing();
    const groupOf=root=>validId(root.chatDisplayGroupId)?root.chatDisplayGroupId:root.id;
    const groupId=groupOf(anchor),state=this.states[selectedTaskId]?.state||'active';
    const tasks=[...all.values()].filter(root=>taskOf(root)===root.id&&groupOf(root)===groupId&&(this.states[root.id]?.state||'active')===state)
      .sort((a,b)=>Date.parse(a.createdAt)-Date.parse(b.createdAt)||a.id.localeCompare(b.id)).map(root=>root.id);
    return {groupId,selectedTaskId,state,taskIds:tasks};
  }
  rootIdFor(entry){let root=entry,seen=new Set();while(root.parentRunId&&this.entries.has(root.parentRunId)&&!seen.has(root.id)){seen.add(root.id);root=this.entries.get(root.parentRunId);}return root.taskId||root.id;}
  goalSummary(rootId){
    const goal=this.engine.goals?.view(rootId)||this.states[rootId]?.goal;if(!goal)return null;
    return Object.fromEntries(['id','revision','status','running','runStatus','turns','maxTurns','currentRunId'].filter(key=>goal[key]!==undefined).map(key=>[key,goal[key]]));
  }
  list(state='active'){
    if(!['active','archived','deleted','all'].includes(state))throw Error('Choose active, archived or deleted conversations.');
    if(this.stateRecoveryRequired&&state!=='all')throw recoveryError();
    const groups=new Map(),rootOf=entry=>this.rootIdFor(entry);
    for(const entry of [...this.entries.values()].sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt))){const rootId=rootOf(entry);if(!groups.has(rootId))groups.set(rootId,{...clone(entry),...(this.goalSummary(rootId)?{goal:this.goalSummary(rootId)}:{}),taskId:rootId,rootId,runId:entry.id,latestRunId:entry.id,title:this.states[rootId]?.title||this.entries.get(rootId)?.title||entry.title,state:this.stateRecoveryRequired?'unknown':this.states[rootId]?.state||'active'});}return[...groups.values()].filter(item=>state==='all'||item.state===state);
  }
  search(value={}){
    const options=conversationSearchOptions(value);
    // Unknown organization cannot safely distinguish saved chats from Trash.
    if(this.stateRecoveryRequired)throw recoveryError();
    const health=this.status(),result=searchConversationDocuments({summaries:this.list('all'),documents:this.searchDocuments,rootIdFor:id=>this.rootIdFor(this.entries.get(id)),options});
    return{...result,truncated:!health.healthy,recoveryRequired:false};
  }
  assertStateWritable(){if(this.stateRecoveryRequired)throw recoveryError();if(this.closed)throw Object.assign(Error('Conversation archive is closed.'),{status:503});}
  // Admission and reservation are synchronous; metadata I/O cannot admit a new
  // provider turn between the final activity check and durable retirement.
  assertRunAdmission(run){
    const rootId=this.rootIdFor(run);
    if(this.transitions.has(rootId)||['archived','deleted'].includes(this.states[rootId]?.state))
      throw Object.assign(Error('Restore this conversation and wait for its organization change before starting work.'),{status:409,code:'CONVERSATION_TRANSITION'});
  }
  retirementFamilies(rootIds){
    const all=new Map(this.entries);
    const live=this.engine.runs instanceof Map?[...this.engine.runs.values()]:this.engine.listRuns();
    for(const run of live)all.set(run.id,run);
    const rootOf=entry=>{let root=entry,seen=new Set();while(root.parentRunId&&all.has(root.parentRunId)&&!seen.has(root.id)){seen.add(root.id);root=all.get(root.parentRunId);}return root.taskId||root.id;};
    const families=new Map(rootIds.map(id=>[id,[]]));
    for(const entry of all.values())families.get(rootOf(entry))?.push(entry);
    return families;
  }
  assertRetirementIdle(rootId,state,family=this.retirementFamilies([rootId]).get(rootId)){
    for(const entry of family){
      let run;try{run=this.engine.runs instanceof Map?this.engine.runs.get(entry.id):this.engine.getRun(entry.id);}catch{continue;}
      if(!run)continue;
      if(active.has(run.status)||run.settled===false)throw Object.assign(Error('Wait for the conversation to finish stopping before '+(state==='archived'?'archiving it.':'moving it to Trash.')),{status:409,code:'CONVERSATION_BUSY'});
    }
    return family.map(entry=>entry.id);
  }
  async purgeRetiredReceipts(ids){
    // The caller already holds the conversation queue. Hide all affected IDs
    // before awaiting either durable store and never reacquire the capture queue.
    let persist=false;
    for(const id of ids){
      this.retiredReceiptIds.add(id);
      const live=this.engine.runs?.get?.(id);
      if(live){retireTurnReceipts(live);this.engine.markRunDirty?.(id);persist=true;}
    }
    try{
      if(persist)await this.engine.persist?.();
      for(const id of ids){
        let run;try{run=await this.readFile(id);}catch(error){if(error.code==='ENOENT')continue;throw error;}
        if(run.receiptDiagnosticsRemoved===true)continue;
        await atomicWrite(this.io,path.join(this.directory,id+'.json'),JSON.stringify(retireTurnReceipts(run)));
      }
    }catch(cause){
      throw Object.assign(Error('The chat was archived or moved to Trash, but Receipts cleanup could not finish. Try the action again after checking storage.'),{status:503,code:'CONVERSATION_RECEIPTS_PENDING',cause});
    }
  }
  async commitReceiptRetirement(roots){
    const ids=new Set(roots.flatMap(id=>this.states[id]?.receiptPurgePending||[]));
    if(!ids.size)return;
    await this.purgeRetiredReceipts(ids);
    // A crash between stores leaves an exact, recorded list for explicit retry
    // or restore. Successful retirement needs no startup sweep.
    const next={...this.states};
    for(const rootId of roots){
      if(!this.states[rootId]?.receiptPurgePending)continue;
      const {receiptPurgePending,...state}=this.states[rootId];next[rootId]=state;
    }
    try{await atomicWrite(this.io,this.stateFile,JSON.stringify(next));this.states=next;}
    catch(cause){throw Object.assign(Error('Receipts were removed, but cleanup could not be confirmed. Retry after checking storage.'),{status:503,code:'CONVERSATION_RECEIPTS_PENDING',cause});}
  }
  purgeArchivedReceipts(input){
    const {rootIds,expectedTurnIds,expectedMetadataRevision}=input||{};
    const pending=this.chain.catch(()=>{}).then(async()=>{
      this.assertStateWritable();
      const scopeError=()=>Object.assign(Error('The selected archived chats or turns changed. No Receipts were removed.'),{status:409,code:'CONVERSATION_RECEIPTS_SCOPE'});
      if(!Array.isArray(rootIds)||!rootIds.length||rootIds.length>250||rootIds.some(id=>!validId(id))||new Set(rootIds).size!==rootIds.length
        ||!Array.isArray(expectedTurnIds)||!expectedTurnIds.length||expectedTurnIds.length>2000||expectedTurnIds.some(id=>!validId(id))||new Set(expectedTurnIds).size!==expectedTurnIds.length||!Number.isSafeInteger(expectedMetadataRevision))
        throw Object.assign(Error('Supply exact archived chat and turn IDs and the current organization revision.'),{status:400,code:'CONVERSATION_RECEIPTS_SCOPE'});
      if(expectedMetadataRevision!==this.metadataRevision)throw Object.assign(Error('Conversation organization changed. Reload before retrying.'),{status:409,code:'CONVERSATION_REVISION'});
      const next={...this.states},ids=new Set(),requested=new Set(expectedTurnIds),families=this.retirementFamilies(rootIds);
      for(const id of rootIds){
        if(this.states[id]?.state!=='archived')throw scopeError();
        const turns=this.assertRetirementIdle(id,'archived',families.get(id));
        const receiptPurgePending=turns.filter(turn=>requested.has(turn));
        if(!receiptPurgePending.length||next[id].receiptPurgePending?.some(turn=>!requested.has(turn)))throw scopeError();
        next[id]={...next[id],receiptPurgePending};
        for(const turn of receiptPurgePending)ids.add(turn);
      }
      if(ids.size!==requested.size)throw scopeError();
      const encoded=JSON.stringify(next);
      if(Buffer.byteLength(encoded)>8*1024*1024)throw Object.assign(Error('Conversation metadata is full. Nothing was changed.'),{status:413});
      await atomicWrite(this.io,this.stateFile+'.bak',JSON.stringify(this.states));
      await atomicWrite(this.io,this.stateFile,encoded);
      this.states=next;
      await this.commitReceiptRetirement(rootIds);
      return {rootIds:[...rootIds],turns:ids.size,metadataRevision:this.metadataRevision};
    });
    this.chain=pending.catch(error=>{if(![400,404,409].includes(error.status))throw error;});
    this.chain.catch(()=>{});
    return pending;
  }
  // Bind cleanup to its committed retirement, not merely the conversation ID.
  // A restore or later retirement invalidates old queued destructive work.
  retirementCurrent(rootId,token){
    return !this.transitions.has(rootId)&&['archived','deleted'].includes(this.states[rootId]?.state)
      &&(!token||this.states[rootId]?.lifecycleToken===token);
  }
  changeState(rootId,change){
    const operation=async()=>{
      this.assertStateWritable();
      const transition=Object.hasOwn(change,'state');
      let receiptIds;
      if(transition){
        if(change.state!=='active')receiptIds=this.assertRetirementIdle(rootId,change.state);
        this.transitions.set(rootId,change.state);
      }
      try {
      if(transition&&change.state==='active')await this.commitReceiptRetirement([rootId]);
      const metadata={state:'active',...this.states[rootId],...change,...(transition?{lifecycleToken:randomUUID()}:{}),revision:this.metadataRevision+1,updatedAt:new Date().toISOString()},next={...this.states,[rootId]:metadata};
      if(receiptIds?.length)metadata.receiptPurgePending=[...new Set([...(metadata.receiptPurgePending||[]),...receiptIds])];
      const encoded=JSON.stringify(next);
      if(Buffer.byteLength(encoded)>8*1024*1024)throw Object.assign(Error('Conversation metadata exceeds its 8 MiB storage limit. Shorten a goal objective before saving; existing conversations remain readable.'),{status:413,code:'CONVERSATION_METADATA_TOO_LARGE'});
      await atomicWrite(this.io,this.stateFile+'.bak',JSON.stringify(this.states));
      await atomicWrite(this.io,this.stateFile,encoded);
      this.states=next;this.stateError=null;this.stateWriteError=null;
      // This revision belongs to committed organization changes, not streaming
      // turn snapshots. Persisted record revisions preserve CAS across restart.
      ++this.metadataRevision;
      if(receiptIds?.length)await this.commitReceiptRetirement([rootId]);
      const receipt={rootId,...this.states[rootId],title:metadata.title||this.entries.get(rootId)?.title||'',revision:this.metadataRevision};
      this.emit('updated',this.status());this.emit('metadata.updated',clone(receipt));return receipt;
      } finally {if(transition)this.transitions.delete(rootId);}
    };
    this.chain=this.chain.catch(()=>{}).then(operation).catch(error=>{if(['CONVERSATION_BUSY','CONVERSATION_RECEIPTS_PENDING'].includes(error.code))throw error;this.stateWriteError='Conversation changes could not be saved. Saved chats are preserved.';this.emit('updated',this.status());throw Object.assign(Error(this.stateWriteError),{status:503,code:'CONVERSATION_SAVE_FAILED',cause:error});});return this.chain;
  }
  folderState(id){return this.states['folder:'+id]?.state||'active';}
  setFolderState({folderIds,rootIds,state,expectedMetadataRevision,parentId}){
    const operation=async()=>{
      this.assertStateWritable();
      if(expectedMetadataRevision!==this.metadataRevision)throw Object.assign(Error('Conversation organization changed. Reload before retrying.'),{status:409,code:'CONVERSATION_REVISION'});
      if(state==='active'&&parentId&&this.folderState(parentId)!=='active')throw Object.assign(Error('Restore the parent folder first.'),{status:409,code:'FOLDER_PARENT_RETIRED'});
      const available=new Set(this.list('all').map(item=>item.rootId));
      const roots=rootIds.filter(id=>available.has(id));
      const pending=new Map();
      if(state!=='active'){
        const families=this.retirementFamilies(roots);
        for(const id of roots)pending.set(id,this.assertRetirementIdle(id,state,families.get(id)));
      }
      for(const id of roots)this.transitions.set(id,state);
      try{
        if(state==='active')await this.commitReceiptRetirement(roots);
        const next=clone(this.states),updatedAt=new Date().toISOString(),receipts=[];
        for(const id of roots){const value={state:'active',...next[id],state,updatedAt,revision:this.metadataRevision+1,lifecycleToken:randomUUID()};if(pending.get(id)?.length)value.receiptPurgePending=[...new Set([...(value.receiptPurgePending||[]),...pending.get(id)])];next[id]=value;}
        for(const id of folderIds)next['folder:'+id]={kind:'folder',state,updatedAt,revision:this.metadataRevision+1,lifecycleToken:randomUUID()};
        const encoded=JSON.stringify(next);
        if(Buffer.byteLength(encoded)>8*1024*1024)throw Object.assign(Error('Conversation metadata is full. Nothing was changed.'),{status:413});
        await atomicWrite(this.io,this.stateFile+'.bak',JSON.stringify(this.states));
        await atomicWrite(this.io,this.stateFile,encoded);
        this.states=next;this.stateWriteError=null;this.metadataRevision++;
        if(state!=='active')await this.commitReceiptRetirement(roots);
        for(const id of roots)receipts.push({rootId:id,...this.states[id]});
        this.emit('updated',this.status());
        for(const receipt of receipts)this.emit('metadata.updated',{...receipt,revision:this.metadataRevision});
        return {state,folderIds,rootIds:roots,receipts,lifecycleRevision:this.metadataRevision};
      }finally{for(const id of roots)this.transitions.delete(id);}
    };
    const pending=this.chain.catch(()=>{}).then(operation);
    // Rejected user preconditions are not failed storage drains. Preserve real
    // I/O failures for shutdown, but do not let a stale request poison close.
    this.chain=pending.catch(error=>{if([400,404,409].includes(error.status))return;throw error;});
    this.chain.catch(()=>{}); // Keep the failed drain observable without an unhandled rejection.
    return pending;
  }
  async setState(id,state){
    if(!['active','archived','deleted'].includes(state))throw Error('Invalid conversation state.');
    this.assertStateWritable();
    const family=await this.family(id);
    if(state!=='active'&&family.runs.some(run=>active.has(run.status)||run.settled===false))throw Object.assign(Error('Wait for the conversation to finish stopping before '+(state==='archived'?'archiving it.':'moving it to Trash.')),{status:409});
    return this.changeState(family.rootId,{state});
  }
  async rename(id,title){
    this.assertStateWritable();
    if(typeof title!=='string'||!title.trim()||title.trim().length>120||title.includes('\0'))throw Object.assign(Error('Use a conversation title of 1 to 120 characters.'),{status:400,code:'CONVERSATION_TITLE_INVALID'});
    const family=await this.family(id);return this.changeState(family.rootId,{title:title.trim()});
  }
  async export(id,{format='json',attachments,...options}={}){
    const family=await this.family(id),ids=[...new Set(family.runs.flatMap(run=>run.attachmentIds||[]))],attachmentManifest=[];
    for(const attachmentId of ids){try{attachmentManifest.push(await attachments?.get(attachmentId));}catch{attachmentManifest.push({id:attachmentId,available:false});}}
    return serializeConversationExport(family,{...options,format,attachmentManifest:attachmentManifest.filter(Boolean)});
  }
  async close(){if(this.closed)return;this.engine.off('event',this.listener);for(const run of this.engine.listRuns())await this.capture(run);await this.chain.catch(error=>{if(error.code!=='CONVERSATION_BUSY')throw error;});this.closed=true;}
}
