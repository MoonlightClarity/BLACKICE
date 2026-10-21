import {EventEmitter} from 'node:events';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {taskTitle} from '../public/task-title.mjs';
import {serializeConversationExport} from './conversation-export.mjs';
import {conversationSearchOptions,createConversationSearchDocument,searchConversationDocuments} from './conversation-search.mjs';

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
const mergeEvents=(...lists)=>{const seen=new Set();return lists.flat().filter(event=>{const data=event.data||event,key=JSON.stringify([event.at,event.nodeId,data.type,data.itemId||data.item?.id,data.text??data.item?.text,data.delta,data.action]);if(seen.has(key))return false;seen.add(key);return true;}).sort((a,b)=>(Date.parse(a.at)||0)-(Date.parse(b.at)||0));};

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
  constructor({dataDir,engine,io=fs}){super();this.directory=path.join(dataDir,'conversations');this.stateFile=path.join(dataDir,'conversation-state.json');this.states={};this.engine=engine;this.io=io;this.entries=new Map();this.messages=new Map();this.searchDocuments=new Map();this.chain=Promise.resolve();this.metadataRevision=0;this.error=null;this.stateError=null;this.stateWriteError=null;this.writeFailures=new Set();this.stateRecoveryRequired=false;this.recovered=false;this.closed=false;}
  async readStates(file){
    if((await this.io.stat(file)).size>8*1024*1024)throw recoveryError();
    const value=JSON.parse(await this.io.readFile(file,'utf8'));
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.entries(value).some(([id,item])=>!validId(id)||!['active','archived','deleted'].includes(item?.state)||item.title!==undefined&&(typeof item.title!=='string'||!item.title.trim()||item.title.length>120)))throw recoveryError();
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
    const owned=new Set(this.engine.listRuns().map(run=>run.id));
    for(const file of await this.io.readdir(this.directory)){
      if(!file.endsWith('.json')||!validId(file.slice(0,-5)))continue;
      try{const run=await this.readFile(file.slice(0,-5));this.remember(owned.has(run.id)?run:recoverUnownedTurn(run));this.messages.set(run.id,run.events||[]);}
      catch(error){this.error=`Conversation archive needs attention: ${file}: ${error.message}`;}
    }
    for(const run of this.engine.listRuns())try{await this.capture(run);}catch{}
    this.listener=event=>{
      if(event.type==='run.updated'&&event.data?.id)this.capture(event.data).catch(()=>{});
      if(event.type==='agent.event'&&durableEvent(event)){
        const receipts=this.messages.get(event.runId)||[];receipts.push(clone(event));this.messages.set(event.runId,receipts);
        try{this.capture(this.engine.getRun(event.runId)).catch(()=>{});}catch{}
      }
    };
    this.engine.on('event',this.listener);return this;
  }
  status(){const error=this.stateError||this.stateWriteError||this.error||(this.writeFailures.size?'Some conversation changes could not be saved. Retry after checking available disk space.':null);return{healthy:!error,error,turns:this.entries.size,conversations:this.list('all').length,metadataRevision:this.metadataRevision,recovered:this.recovered,recoveryRequired:this.stateRecoveryRequired,stateRecoveryRequired:this.stateRecoveryRequired};}
  remember(run){this.engine.rememberClientRequest?.(run);this.entries.set(run.id,{id:run.id,taskId:run.taskId||null,parentRunId:run.parentRunId||null,createdAt:run.createdAt,updatedAt:run.updatedAt||run.createdAt,status:run.status,settled:run.settled,title:taskTitle(run.input,{max:140,fallback:run.workflowName||'Conversation'})});this.searchDocuments.set(run.id,createConversationSearchDocument(run));}
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
    // Tool traces remain in execution history. Conversation receipts retain actual messages.
    run.events=mergeEvents(this.messages.get(run.id)||[],(run.events||[]).filter(durableEvent));
    this.messages.set(run.id,clone(run.events));
    const text=JSON.stringify(run);if(Buffer.byteLength(text)>32*1024*1024){this.error='A conversation turn exceeded32MiB and was not archived.';this.emit('updated',this.status());return Promise.reject(Error(this.error));}
    const operation=async()=>{
      const file=path.join(this.directory,run.id+'.json');if(!validId(run.id))throw Error('Invalid conversation run ID.');
      await atomicWrite(this.io,file,text);this.writeFailures.delete(run.id);this.remember(run);this.emit('updated',this.status());
    };
    this.chain=this.chain.catch(()=>{}).then(operation).catch(error=>{this.writeFailures.add(run.id);this.emit('updated',this.status());throw error;});return this.chain;
  }
  async get(id){
    try{const live=this.engine.getRun(id);live.events=mergeEvents(this.messages.get(id)||[],live.events||[]);return live;}catch{}
    if(!this.entries.has(id))throw missing();
    const run=await this.readFile(id);
    return recoverUnownedTurn(run);
  }
  async family(id){
    await this.chain.catch(()=>{});const selected=await this.get(id),taskId=selected.taskId||selected.id;
    const live=this.engine.listRuns(),all=new Map([...this.entries.values()].map(e=>[e.id,e]));for(const run of live)all.set(run.id,{...run,taskId:run.taskId||run.id});
    // Older releases did not have taskId. Walk parent links to group their real conversations.
    const rootOf=item=>{let root=item,seen=new Set();while(root.parentRunId&&all.has(root.parentRunId)&&!seen.has(root.id)){seen.add(root.id);root=all.get(root.parentRunId);}return root.taskId||root.id;};
    const rootId=rootOf(all.get(id)||selected),ids=[...all.values()].filter(item=>(item.taskId===taskId&&taskId!==selected.id)||rootOf(item)===rootId).sort((a,b)=>Date.parse(a.createdAt)-Date.parse(b.createdAt)).map(item=>item.id);
    const runs=await Promise.all(ids.map(runId=>this.get(runId)));
    return{rootId,taskId:rootId,state:this.stateRecoveryRequired?'unknown':this.states[rootId]?.state||'active',title:this.states[rootId]?.title||this.entries.get(rootId)?.title||taskTitle(runs[0]?.input,{max:140,fallback:'Conversation'}),runs,truncated:!this.status().healthy,recoveryRequired:this.stateRecoveryRequired};
  }
  rootIdFor(entry){let root=entry,seen=new Set();while(root.parentRunId&&this.entries.has(root.parentRunId)&&!seen.has(root.id)){seen.add(root.id);root=this.entries.get(root.parentRunId);}return root.taskId||root.id;}
  list(state='active'){
    if(!['active','archived','deleted','all'].includes(state))throw Error('Choose active, archived or deleted conversations.');
    if(this.stateRecoveryRequired&&state!=='all')throw recoveryError();
    const groups=new Map(),rootOf=entry=>this.rootIdFor(entry);
    for(const entry of [...this.entries.values()].sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt))){const rootId=rootOf(entry);if(!groups.has(rootId))groups.set(rootId,{...clone(entry),taskId:rootId,rootId,runId:entry.id,latestRunId:entry.id,title:this.states[rootId]?.title||this.entries.get(rootId)?.title||entry.title,state:this.stateRecoveryRequired?'unknown':this.states[rootId]?.state||'active'});}return[...groups.values()].filter(item=>state==='all'||item.state===state);
  }
  search(value={}){
    const options=conversationSearchOptions(value);
    // Unknown organization cannot safely distinguish saved chats from Trash.
    if(this.stateRecoveryRequired)throw recoveryError();
    const health=this.status(),result=searchConversationDocuments({summaries:this.list('all'),documents:this.searchDocuments,rootIdFor:id=>this.rootIdFor(this.entries.get(id)),options});
    return{...result,truncated:!health.healthy,recoveryRequired:false};
  }
  assertStateWritable(){if(this.stateRecoveryRequired)throw recoveryError();if(this.closed)throw Object.assign(Error('Conversation archive is closed.'),{status:503});}
  changeState(rootId,change){
    const operation=async()=>{
      this.assertStateWritable();
      const metadata={state:'active',...this.states[rootId],...change,updatedAt:new Date().toISOString()},next={...this.states,[rootId]:metadata};
      await atomicWrite(this.io,this.stateFile+'.bak',JSON.stringify(this.states));
      await atomicWrite(this.io,this.stateFile,JSON.stringify(next));
      this.states=next;this.stateError=null;this.stateWriteError=null;
      // This revision belongs to committed organization changes, not streaming
      // turn snapshots. Reconnecting clients must still reload after a restart.
      const receipt={rootId,...metadata,title:metadata.title||this.entries.get(rootId)?.title||'',revision:++this.metadataRevision};
      this.emit('updated',this.status());this.emit('metadata.updated',clone(receipt));return receipt;
    };
    this.chain=this.chain.catch(()=>{}).then(operation).catch(error=>{this.stateWriteError='Conversation changes could not be saved. Saved chats are preserved.';this.emit('updated',this.status());throw Object.assign(Error(this.stateWriteError),{status:503,code:'CONVERSATION_SAVE_FAILED',cause:error});});return this.chain;
  }
  async setState(id,state){
    if(!['active','archived','deleted'].includes(state))throw Error('Invalid conversation state.');
    this.assertStateWritable();
    const family=await this.family(id);
    if(state==='deleted'&&family.runs.some(run=>active.has(run.status)||run.settled===false))throw Object.assign(Error('Wait for the conversation to finish stopping before moving it to Trash.'),{status:409});
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
  async close(){if(this.closed)return;this.engine.off('event',this.listener);for(const run of this.engine.listRuns())await this.capture(run);await this.chain;this.closed=true;}
}
