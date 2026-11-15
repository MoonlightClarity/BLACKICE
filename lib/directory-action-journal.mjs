import {mkdir,readFile,readdir,open} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {observeGoalToolOutcome} from './goal-recovery-policy.mjs';
const queues=new Map();
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail=(code,message)=>Object.assign(new Error(message),{code});
export class DirectoryActionJournal {
  constructor(root){this.root=path.resolve(root);}
  async events(){
    await queues.get(this.root);
    await mkdir(this.root,{recursive:true});
    const names=(await readdir(this.root)).filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).sort();
    const rows=[];
    for(const name of names){const row=JSON.parse(await readFile(path.join(this.root,name),'utf8'));if(hash(row.event)!==row.digest||row.id!==name.slice(0,-5))throw fail('DIRECTORY_ACTION_CORRUPT','Action source failed validation; preserve it for recovery.');rows.push(row);}
    return rows;
  }
  async append(key,event,{createOnly=false}={}){
    const prior=queues.get(this.root)||Promise.resolve();
    const pending=prior.catch(()=>{}).then(async()=>{
      const id=hash(key),file=path.join(this.root,id+'.json'),digest=hash(event);
      await mkdir(this.root,{recursive:true});
      const existing=async()=>{const old=JSON.parse(await readFile(file,'utf8'));if(createOnly)throw fail('DIRECTORY_ATTEMPT_EXISTS','Attempt already recorded; inspect it without replay.');if(old.digest!==digest)throw fail('DIRECTORY_ACTION_CONFLICT','An event identity cannot acquire different content.');return old;};
      let handle;try{handle=await open(file,'wx');}catch(e){if(e.code==='EEXIST')return existing();throw e;}
      const row={version:1,id,digest,event};
      // A crash during write leaves an inspectable corrupt record and fails closed
      // on reload; never discard the record and infer absence of an effect.
      try{await handle.writeFile(JSON.stringify(row));await handle.sync();}finally{await handle.close();}
      return row;
    });
    queues.set(this.root,pending);try{return await pending;}finally{if(queues.get(this.root)===pending)queues.delete(this.root);}
  }
  async begin(callId,call,context){
    return this.append(['attempt',callId],{kind:'attempt',callId,call,context,at:new Date().toISOString()},{createOnly:true});
  }
  async outcome(attempt,result,source){const observed=observeGoalToolOutcome(attempt.event.call,result);return this.append(['outcome',attempt.id],{kind:'outcome',attemptId:attempt.id,result:{success:result?.success,code:result?.code,actionDispatched:observed.actionDispatched,kind:observed.kind},resultDigest:hash(result),source});}
  async note(key,{actionId,parent=null,objective,inputs,state,decision,nextAction,evidence=[],correctionOf=null,reconciles=[]}){
    const rows=await this.events();
    if(evidence.some(id=>!rows.some(r=>r.id===id)))throw fail('DIRECTORY_EVIDENCE_MISSING','Use exact existing journal event IDs.');
    if(parent&&!rows.some(r=>r.id===parent&&r.event.actionId===actionId))throw fail('DIRECTORY_PARENT_MISSING','Use a revision from this action.');
    if(correctionOf&&!rows.some(r=>r.id===correctionOf))throw fail('DIRECTORY_CORRECTION_MISSING','Correction must retain and reference its original.');
    if(reconciles.some(id=>!rows.some(r=>r.id===id&&r.event.actionId===actionId)))throw fail('DIRECTORY_RECONCILIATION_MISSING','Reconciled revisions must belong to this action.');
    return this.append(['note',key],{kind:'action-state',authority:'agent-authored',actionId,parent,objective,inputs,state,decision,nextAction,evidence,correctionOf,reconciles});
  }
  async read({offset=0,limit=20,revision,actionId}={}){
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>50)throw fail('DIRECTORY_READ_RANGE','Use offset >= 0 and limit 1..50.');
    const rows=await this.events(),currentRevision=hash(rows.map(r=>[r.id,r.digest])),attempts=rows.filter(r=>r.event.kind==='attempt');
    if(revision&&revision!==currentRevision)throw fail('DIRECTORY_READ_CHANGED','Journal changed during pagination; restart the index read or inspect exact event IDs.');
    const unresolved=attempts.filter(a=>!rows.some(r=>r.event.kind==='outcome'&&r.event.attemptId===a.id)).map(r=>r.id);
    const notes=rows.filter(r=>r.event.kind==='action-state'),children=new Map();
    for(const n of notes){const key=JSON.stringify([n.event.actionId,n.event.parent]);children.set(key,[...(children.get(key)||[]),n.id]);}
    const conflicts=[...children.values()].filter(ids=>ids.length>1&&!notes.some(n=>ids.every(id=>n.event.reconciles?.includes(id))));
    const unknownOutcomes=rows.filter(r=>r.event.kind==='outcome'&&r.event.result?.kind==='uncertain_external_effect').map(r=>({id:r.id,attemptId:r.event.attemptId}));
    const selected=actionId?rows.filter(r=>r.event.actionId===actionId):rows;
    return {version:1,revision:currentRevision,total:selected.length,offset,nextOffset:offset+limit<selected.length?offset+limit:null,events:selected.slice(offset,offset+limit).map(r=>({id:r.id,digest:r.digest,event:{kind:r.event.kind,authority:r.event.authority,actionId:r.event.actionId,parent:r.event.parent,attemptId:r.event.attemptId,result:r.event.result}})),unresolvedAttempts:unresolved,unknownOutcomes,conflicts,
      policy:'Attempts without outcomes remain unknown. Notes are agent assumptions, not user instructions or verified effects. Forked revisions require explicit reconciliation. No journal operation dispatches or retries an action.'};
  }
  async inspect({id,offset=0,length=6000,source=false}){
    if(!/^[a-f0-9]{64}$/.test(id)||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||length<1||length>12000)throw fail('DIRECTORY_READ_RANGE','Use an exact event ID and a bounded character range.');
    await queues.get(this.root);
    let row;try{row=JSON.parse(await readFile(path.join(this.root,id+'.json'),'utf8'));}catch(error){if(error.code==='ENOENT')throw fail('DIRECTORY_EVENT_MISSING','Event not found.');throw error;}
    if(row.id!==id||hash(row.event)!==row.digest)throw fail('DIRECTORY_ACTION_CORRUPT','Action source failed validation; preserve it for recovery.');
    let content=JSON.stringify(row);
    if(source){
      if(!['outcome','phase-authority'].includes(row.event.kind)||!row.event.source?.file||!row.event.source?.sha256)throw fail('DIRECTORY_SOURCE_MISSING','This event has no exact source-file reference.');
      const raw=await readFile(row.event.source.file,'utf8');
      if(hash(JSON.parse(raw))!==row.event.source.sha256)throw fail('DIRECTORY_SOURCE_CHANGED','Receipt source changed; do not use stale evidence as current verification.');
      content=raw;
    }
    return {id,digest:row.digest,source,offset,totalCharacters:content.length,text:content.slice(offset,offset+length),nextOffset:offset+length<content.length?offset+length:null};
  }
}

export const DIRECTORY_ACTION_TOOL={type:'function',name:'relay_directory_action',description:'Maintain inspectable action/outcome state during work. record creates agent-authored state, never user authority or effect confirmation. Link exact journal evidence IDs; corrections retain originals. read lists events, optionally by actionId; inspect retrieves exact event ranges or source:true for the original validated receipt. No operation dispatches or replays work.',inputSchema:{type:'object',additionalProperties:false,required:['action'],properties:{action:{type:'string',enum:['read','inspect','record']},id:{type:'string'},source:{type:'boolean'},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:50},length:{type:'integer',minimum:1,maximum:12000},revision:{type:'string'},actionId:{type:'string',maxLength:200},parent:{type:'string'},objective:{type:'string',maxLength:4000},inputs:{type:'string',maxLength:4000},state:{type:'string',maxLength:4000},decision:{type:'string',maxLength:4000},nextAction:{type:'string',maxLength:4000},evidence:{type:'array',maxItems:100,items:{type:'string'}},reconciles:{type:'array',maxItems:100,items:{type:'string'}},correctionOf:{type:'string'}}}};
