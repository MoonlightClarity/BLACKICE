/**
 * Conversation autonomy: an operating mode, independent of Goal and Planning.
 * It never creates an objective or an artificial "completed goal" state.
 * The only additional model restriction is the user's exact allowlist.
 */
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {normalizeAutonomyModelAllowlist,requireAutonomyModel} from './autonomy-model-allowlist.mjs';

const fail=(message,code='AUTONOMY_INVALID',status=400)=>Object.assign(new Error(message),{code,status});
const clone=value=>structuredClone(value);
const now=()=>new Date().toISOString();
const rootOf=run=>run.taskId||run.id;
const activeRun=new Set(['queued','running','waiting']);
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const SKILL=readFileSync(new URL('../skills/autonomy/SKILL.md',import.meta.url),'utf8');
export const AUTONOMY_SKILL_CONTENT=SKILL;

export const AUTONOMY_TOOL={
  type:'function',name:'relay_autonomy',
  description:'Read this conversation’s autonomous operating mode, record progress, choose a model for a later turn, or enter idle until new user direction. Never changes the user-selected model allowlist or calibration and never creates a new goal.',
  inputSchema:{type:'object',additionalProperties:false,required:['action'],properties:{
    action:{type:'string',enum:['read','progress','select_model','idle']},
    model:{type:'string',minLength:1,maxLength:400,description:'An exact model identifier from the saved autonomy allowlist. Used for the next autonomous turn only.'},
    summary:{type:'string',minLength:1,maxLength:4000},
  }},
};

export function validateAutonomyCalibration(input,{catalog}={}){
  if(!input||typeof input!=='object'||Array.isArray(input))throw fail('Provide autonomy calibration and exact eligible model IDs.');
  if(Object.keys(input).some(key=>!['calibration','modelAllowlist','selectedModel'].includes(key)))throw fail('Unknown autonomy calibration field.');
  const calibration=input.calibration??'';
  if(typeof calibration!=='string'||calibration.length>12000||calibration.includes('\0'))throw fail('Calibration must be at most 12,000 characters.');
  const modelAllowlist=normalizeAutonomyModelAllowlist(input.modelAllowlist,{...(catalog?.length?{catalog}:{})});
  let selectedModel=input.selectedModel??null;
  if(selectedModel!==null)selectedModel=requireAutonomyModel({allowlist:modelAllowlist,requestedModel:selectedModel,...(catalog?.length?{catalog}:{})});
  return {calibration:calibration.trim(),modelAllowlist,selectedModel};
}

export class ConversationAutonomy {
  constructor({engine,conversations,autoStart=true,continuationDelayMs=750,nowTime=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}={}){
    this.engine=engine;this.conversations=conversations;this.started=autoStart;
    this.delay=continuationDelayMs;this.nowTime=nowTime;this.setTimer=setTimer;this.clearTimer=clearTimer;
    this.timers=new Map();this.chains=new Map();this.epochs=new Map();this.pending=new Set();this.closed=false;
  }
  raw(id){return this.conversations.states[id]?.autonomy||null;}
  async root(id){
    if(this.conversations.states[id]&&(this.engine.runs.has(id)||this.conversations.entries.has(id)))return id;
    return (await this.conversations.family(id)).rootId;
  }
  forRun(run){const row=this.raw(rootOf(run));return row?.enabled?row:null;}
  async get(id){const root=await this.root(id);return this.view(root);}
  view(id){const row=this.raw(id);if(!row)return null;
    const live=[...this.engine.runs.values()].find(run=>rootOf(run)===id&&(activeRun.has(run.status)||run.settled===false));
    return {...clone(row),conversationId:id,running:Boolean(live&&live.status==='running'),currentRunId:live?.id||row.currentRunId||null};
  }
  publish(id){this.engine.emit('event',{type:'autonomy.updated',at:now(),data:{conversationId:id,autonomy:this.view(id)}});}
  async save(id,state){
    const prior=this.raw(id);
    const row=state?{...clone(state),revision:(prior?.revision||0)+1,updatedAt:now()}:null;
    await this.conversations.changeState(id,{autonomy:row});
    this.publish(id);return row;
  }
  invalidate(id){
    this.epochs.set(id,(this.epochs.get(id)||0)+1);
    if(this.timers.has(id))this.clearTimer(this.timers.get(id));
    this.timers.delete(id);
  }
  enqueue(id,fn){
    const promise=(this.chains.get(id)||Promise.resolve()).catch(()=>{}).then(fn);
    this.chains.set(id,promise);
    promise.finally(()=>{if(this.chains.get(id)===promise)this.chains.delete(id);}).catch(()=>{});
    return promise;
  }
  track(promise){this.pending.add(promise);promise.finally(()=>this.pending.delete(promise)).catch(()=>{});return promise;}
  async init(){
    this.engine.autonomy=this;
    this.listener=event=>{
      if(event.type!=='run.updated'||!event.data?.id||event.data.settled!==true)return;
      const run=event.data,root=rootOf(run);
      if(this.raw(root)?.enabled)this.track(this.enqueue(root,()=>this.settled(root,run)).catch(error=>{
        this.engine.emit('event',{type:'autonomy.error',at:now(),data:{conversationId:root,code:error.code||'AUTONOMY_CONTINUATION_ERROR',error:error.message}});
      }));
    };
    this.engine.on('event',this.listener);
    // An interrupted in-flight dispatch must not be automatically replayed.
    for(const [root,state] of Object.entries(this.conversations.states)){
      const row=state?.autonomy;
      if(!row?.enabled||row.status!=='active')continue;
      let family;try{family=await this.conversations.family(root);}catch{}
      const latest=family?.runs.at(-1);
      if(!latest||row.dispatch||latest.settled!==true||['failed','cancelled'].includes(latest.status)){
        await this.save(root,{...row,status:'interrupted',lastReason:'An autonomous turn or its effects may be unresolved after restart; inspect saved receipts before resuming.',dispatch:null});
      }else if(row.lastSettledRunId!==latest.id){
        await this.settled(root,latest);
      }else this.schedule(root);
    }
    return this;
  }
  start(){this.started=true;for(const [root,state]of Object.entries(this.conversations.states))if(state?.autonomy?.enabled&&state.autonomy.status==='active')this.schedule(root);}
  policyForRun(run){ // Always consult current calibration, not a stale turn snapshot.
    const row=this.raw(rootOf(run));
    return row?.enabled?row:run.autonomy?.automatic&&row?row:null;
  }
  async control(id,body={}){
    const root=await this.root(id);
    const action=body.action;
    if(!['enable','disable','calibrate','resume','select_model'].includes(action))throw fail('Choose enable, disable, calibrate, resume or select_model.');
    if(action!=='select_model')this.invalidate(root);
    return this.enqueue(root,async()=>{
      if(this.closed||this.engine.closed)throw fail('BLACKICE is closing.','AUTONOMY_CLOSED',503);
      let row=this.raw(root);
      if(body.expectedRevision!==undefined&&body.expectedRevision!==(row?.revision||0))throw fail('Autonomy calibration changed; reload its latest version.','AUTONOMY_REVISION_CONFLICT',409);
      if(['enable','resume'].includes(action) && ['active','waiting'].includes(this.conversations.states[root]?.goal?.status))
        throw fail('Pause the existing Goal Mode before enabling autonomy; saved goals remain intact.','AUTONOMY_GOAL_CONFLICT',409);
      if(action==='enable'){
        const catalog=this.engine.runtime.status()?.models;
        const validated=validateAutonomyCalibration({
          calibration:body.calibration??row?.calibration??'',
          modelAllowlist:body.modelAllowlist??row?.modelAllowlist,
          selectedModel:body.selectedModel??row?.selectedModel??null,
        },{catalog});
        const stamp=now();
        row={id:row?.id||randomUUID(),generation:(row?.generation||0)+1,enabled:true,status:'active',...validated,
          createdAt:row?.createdAt||stamp,currentRunId:row?.currentRunId||null,lastSettledRunId:row?.lastSettledRunId||null,
          dispatch:null,lastReason:'Autonomous operation enabled. Calibration is separate from goals.',noProgressTurns:0};
      }else if(!row)throw fail('This conversation has no autonomy calibration.','AUTONOMY_NOT_FOUND',404);
      else if(action==='disable')row={...row,generation:row.generation+1,enabled:false,status:'paused',dispatch:null,lastReason:'Autonomous continuation disabled; saved calibration retained.'};
      else if(action==='resume')row={...row,generation:row.generation+1,enabled:true,status:'active',dispatch:null,noProgressTurns:0,lastReason:'Autonomous operation resumed.'};
      else if(action==='calibrate'){
        const catalog=this.engine.runtime.status()?.models;
        const validated=validateAutonomyCalibration({
          calibration:body.calibration??row.calibration,
          modelAllowlist:body.modelAllowlist??row.modelAllowlist,
          selectedModel:body.selectedModel===undefined?row.selectedModel:body.selectedModel,
        },{catalog});
        row={...row,...validated,generation:row.generation+1,dispatch:null,status:row.enabled?'active':'paused',lastReason:'Updated conversation calibration.'};
      }else if(action==='select_model'){
        if(!row.enabled)throw fail('Enable autonomy before selecting an autonomous model.');
        const model=requireAutonomyModel({allowlist:row.modelAllowlist,requestedModel:body.selectedModel,...(this.engine.runtime.status()?.models?.length?{catalog:this.engine.runtime.status().models}:{})});
        row={...row,selectedModel:model,lastReason:'Model selected within the saved user allowlist.'};
      }
      const saved=await this.save(root,row);
      if(saved.enabled&&saved.status==='active')this.schedule(root);
      return {autonomy:this.view(root)};
    }).catch(error=>{this.schedule(root);throw error;});
  }
  async admitRun(run){
    const root=rootOf(run);
    return this.enqueue(root,async()=>{
      const state=this.raw(root);
      if(run.autonomyDispatch&&( !state?.enabled||state.status!=='active'||run.autonomyDispatch.generation!==state.generation||
          run.autonomyDispatch.epoch!==(this.epochs.get(root)||0)))
        throw fail('A newer autonomy control superseded this automatic continuation.','AUTONOMY_DISPATCH_SUPERSEDED',409);
      if(!state?.enabled)return;
      if(!run.autonomyDispatch)this.invalidate(root); // User-authored turn supersedes pending automatic continuation.
      run.autonomy={id:state.id,generation:state.generation,automatic:Boolean(run.autonomyDispatch)};
      await this.save(root,{...state,status:'active',dispatch:null,currentRunId:run.id,lastReason:'Operating with saved conversation calibration.'});
    });
  }
  async settled(root,run){
    const prior=this.raw(root);
    if(!prior?.enabled||prior.currentRunId!==run.id||prior.lastSettledRunId===run.id)return;
    if(run.errorCode==='AUTONOMY_DISPATCH_SUPERSEDED'){this.schedule(root);return;}
    if(run.status==='cancelled'||run.status==='failed'){
      await this.save(root,{...prior,status:'interrupted',dispatch:null,lastSettledRunId:run.id,
        lastReason:'An autonomous turn did not complete. Inspect saved effects before resuming; no operation is replayed.'});
      return;
    }
    if(run.autonomyIdle){
      await this.save(root,{...prior,status:'idle',lastReason:run.autonomyIdle,dispatch:null,lastSettledRunId:run.id,noProgressTurns:0});
      return;
    }
    const progressed=Boolean(run.autonomyProgress||run.autonomyToolCount||run.goalToolCount);
    const noProgressTurns=progressed?0:(prior.noProgressTurns||0)+1;
    await this.save(root,{...prior,status:noProgressTurns>=3?'idle':'active',noProgressTurns,dispatch:null,lastSettledRunId:run.id,
      lastReason:noProgressTurns>=3?'Three turns without observed tool work or progress; idle rather than consume more quota.':run.autonomyProgress||'Continuing autonomous operation.'});
    if(noProgressTurns<3)this.schedule(root);
  }
  schedule(root){
    const row=this.raw(root);
    if(!this.started||this.closed||this.engine.closed||!row?.enabled||row.status!=='active'||this.timers.has(root))return;
    const timer=this.setTimer(()=>{
      this.timers.delete(root);this.track(this.enqueue(root,()=>this.dispatch(root)).catch(async error=>{
        const latest=this.raw(root);if(latest?.enabled){await this.save(root,{...latest,status:'interrupted',dispatch:null,lastReason:error.message});}
      }));
    },this.delay);
    timer?.unref?.();this.timers.set(root,timer);
  }
  async dispatch(root){
    let state=this.raw(root);
    if(!this.started||this.closed||!state?.enabled||state.status!=='active')return null;
    const epoch=this.epochs.get(root)||0;
    const family=await this.conversations.family(state.currentRunId||root);
    state=this.raw(root);
    if(!state?.enabled||state.status!=='active'||epoch!==(this.epochs.get(root)||0))return null;
    if(family.state!=='active'){await this.save(root,{...state,status:'paused',lastReason:'Conversation is archived or deleted.'});return null;}
    const latest=family.runs.at(-1);
    if(!latest||latest.settled!==true||this.engine.conversationBusy(latest)){this.schedule(root);return null;}
    const node=latest.workflow?.nodes.find(item=>item.type==='agent');
    if(!node){await this.save(root,{...state,status:'interrupted',lastReason:'No runnable agent in this conversation.'});return null;}
    if(this.engine.executionStatus().availableSlots===0){this.schedule(root);return null;}
    if(!this.engine.runs.has(latest.id))this.engine.restoreArchivedRun(latest);
    const prior=latest.nodes?.[node.id];
    const threadModel=prior?.threadId?await this.engine.runtime.savedThreadModel?.(prior.threadId):undefined;
    if(epoch!==(this.epochs.get(root)||0))return null;
    const model=state.selectedModel||(state.modelAllowlist.includes(threadModel)?threadModel:
      state.modelAllowlist.includes(node.model)?node.model:state.modelAllowlist[0]);
    requireAutonomyModel({allowlist:state.modelAllowlist,requestedModel:model,
      ...(this.engine.runtime.status()?.models?.length?{catalog:this.engine.runtime.status().models}:{})});
    const requestId='autonomy_'+sha([state.id,state.generation,latest.id]).slice(0,45);
    await this.save(root,{...state,dispatch:{sourceRunId:latest.id,requestId,generation:state.generation}});
    state=this.raw(root);
    if(!state?.enabled||state.status!=='active'||epoch!==(this.epochs.get(root)||0))return null;
    const message=[
      'Continue this same conversation in autonomous operating mode. This is a system continuation, not a new user goal.',
      'Honor saved user directions and the current calibration. Choose the next worthwhile action without a routine approval checkpoint.',
      'Use relay_autonomy idle if the current work is finished or no productive next action exists. Never invent work to keep the loop running.',
    ].join('\n');
    try{
      return this.engine.continueRun(latest.id,{nodeId:node.id,message,model,requestId},
        {historyRuns:family.runs,threadModel,autonomyDispatch:{id:state.id,generation:state.generation,epoch}});
    }catch(error){
      const latestState=this.raw(root);if(latestState?.enabled)await this.save(root,{...latestState,status:'interrupted',dispatch:null,lastReason:error.message});
      return null;
    }
  }
  instructions(run){
    const row=this.forRun(run);if(!row)return '';
    return '\n\nAUTONOMOUS OPERATING MODE (NOT A GOAL)\n'+
      JSON.stringify({calibration:row.calibration,exactModelAllowlist:row.modelAllowlist,
        selectedModel:row.selectedModel,modeStatus:row.status})+
      '\nThe model allowlist is enforced by the host. Do not alter it, invent a permanent objective, or ask for routine approvals. '+
      'An explicit user model choice for a manual turn remains a user action; subsequent autonomous model selections obey the allowlist.\n'+SKILL+
      '\nEND AUTONOMOUS OPERATING MODE\n';
  }
  wrapTools(run,nodeId,handler){
    return async(call,context)=>{
      const result=await handler(call,context);
      if(call?.name!==AUTONOMY_TOOL.name&&this.policyForRun(run)?.enabled){
        run.autonomyToolCount=(run.autonomyToolCount||0)+1;
      }
      return result;
    };
  }
  async handle(run,nodeId,call){
    const reply=value=>({success:true,contentItems:[{type:'inputText',text:JSON.stringify(value)}]});
    try{
      const args=typeof call.arguments==='string'?JSON.parse(call.arguments):call.arguments;
      if(!args||!AUTONOMY_TOOL.inputSchema.properties.action.enum.includes(args.action))throw fail('Choose read, progress, select_model or idle.');
      const root=rootOf(run);
      if(args.action==='read')return reply({autonomy:this.view(root)});
      return await this.enqueue(root,async()=>{
        const state=this.raw(root);
        if(!state?.enabled||run.autonomy?.id!==state.id||run.autonomy.generation!==state.generation)
          throw fail('Autonomy calibration changed or was disabled.','AUTONOMY_CHANGED',409);
        if(args.action==='select_model'){
          const model=requireAutonomyModel({allowlist:state.modelAllowlist,requestedModel:args.model,
            ...(this.engine.runtime.status()?.models?.length?{catalog:this.engine.runtime.status().models}:{})});
          await this.save(root,{...state,selectedModel:model,lastReason:'Agent selected a whitelisted model for the next continuation.'});
          return reply({selectedModel:model,for:'next-autonomous-turn',allowlist:state.modelAllowlist});
        }
        if(typeof args.summary!=='string'||!args.summary.trim()||args.summary.length>4000)throw fail('Describe progress or why the agent is idle.');
        if(args.action==='progress'){
          run.autonomyProgress=args.summary.trim();return reply({recorded:true});
        }
        run.autonomyIdle=args.summary.trim();return reply({idle:true,autonomyEnabled:true});
      });
    }catch(error){return {success:false,code:error.code||'AUTONOMY_INVALID',contentItems:[{type:'inputText',text:error.message}]};}
  }
  async pauseAll(reason='Autonomous continuation disabled by Stop all.'){
    const roots=Object.entries(this.conversations.states).filter(([,r])=>r.autonomy?.enabled).map(([id])=>id);
    for(const id of roots)this.invalidate(id);
    await Promise.all(roots.map(root=>this.enqueue(root,async()=>{
      const state=this.raw(root);if(state?.enabled)await this.save(root,{...state,enabled:false,status:'paused',generation:state.generation+1,dispatch:null,lastReason:reason});
    })));
    return {paused:roots.length};
  }
  async close(){this.closed=true;this.engine.off('event',this.listener);
    for(const timer of this.timers.values())this.clearTimer(timer);this.timers.clear();
    await Promise.allSettled([...this.chains.values(),...this.pending]);
  }
}
