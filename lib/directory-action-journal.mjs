import {mkdir,readFile,readdir,open,rename} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {observeGoalToolOutcome} from './goal-recovery-policy.mjs';
const queues=new Map();
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail=(code,message)=>Object.assign(new Error(message),{code});
const actionPreview=event=>{
  if(event.kind!=='action-state')return {};
  const preview={},truncatedFields=[];
  for(const key of ['objective','state','nextAction'])if(typeof event[key]==='string'){
    preview[key]=event[key].slice(0,200);if(event[key].length>200)truncatedFields.push(key);
  }
  return {preview,truncatedFields,evidenceCount:event.evidence?.length||0};
};
export class DirectoryActionJournal {
  constructor(root){this.root=path.resolve(root);}
  async events(){
    await queues.get(this.root);
    await mkdir(this.root,{recursive:true});
    const directory=await readdir(this.root),names=directory.filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).sort();
    const pending=directory.filter(n=>/^[a-f0-9]{64}\.json\.claim$/.test(n)&&!directory.includes(n.slice(0,-6)));
    const rows=pending.map(n=>({id:n.slice(0,64),digest:null,event:{kind:'unpublished',authority:'host-reservation',policy:'Incomplete journal write; do not infer absence or replay.'}}));
    let cursor=0;
    const workers=await Promise.allSettled(Array.from({length:Math.min(8,names.length)},async()=>{
      for(;;){const index=cursor++;if(index>=names.length)return;const name=names[index];
        const row=JSON.parse(await readFile(path.join(this.root,name),'utf8'));
        if(hash(row.event)!==row.digest||row.id!==name.slice(0,-5))throw fail('DIRECTORY_ACTION_CORRUPT','Action source failed validation; preserve it for recovery.');rows.push(row);
      }
    }));
    const failed=workers.find(r=>r.status==='rejected');if(failed)throw failed.reason;
    return rows.sort((a,b)=>a.id.localeCompare(b.id));
  }
  async append(key,event,{createOnly=false}={}){
    const prior=queues.get(this.root)||Promise.resolve();
    const pending=prior.catch(()=>{}).then(async()=>{
      const id=hash(key),file=path.join(this.root,id+'.json'),digest=hash(event);
      await mkdir(this.root,{recursive:true});
      const existing=async()=>{if(createOnly)throw fail('DIRECTORY_ATTEMPT_EXISTS','Attempt already reserved or recorded; inspect it without replay.');let old;try{old=JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')throw fail('DIRECTORY_ACTION_PENDING','Reserved journal event has not finished publishing.');throw error;}if(old.id!==id||hash(old.event)!==old.digest)throw fail('DIRECTORY_ACTION_CORRUPT','Saved journal identity failed validation.');if(old.digest!==digest)throw fail('DIRECTORY_ACTION_CONFLICT','An event identity cannot acquire different content.');return old;};
      let claim;try{claim=await open(file+'.claim','wx');}catch(e){if(e.code==='EEXIST')return existing();throw e;}
      try{await claim.writeFile(id);await claim.sync();}finally{await claim.close();}
      // Older journals may have a published record without a claim. Never replace it.
      let published=false;try{await readFile(file);published=true;}catch(error){if(error.code!=='ENOENT')throw error;}
      if(published)return existing();
      const row={version:1,id,digest,event};
      // Exclusive permanent identity reservation prevents cross-process overwrite.
      // Publish only complete synced JSON; a crash retains claim/pending evidence.
      const handle=await open(file+'.pending','wx');
      try{await handle.writeFile(JSON.stringify(row));await handle.sync();}finally{await handle.close();}
      await rename(file+'.pending',file);
      return row;
    });
    queues.set(this.root,pending);try{return await pending;}finally{if(queues.get(this.root)===pending)queues.delete(this.root);}
  }
  async begin(callId,call,context){
    return this.append(['attempt',callId],{kind:'attempt',callId,call,context,...(context?.actionId?{actionId:context.actionId,associationAuthority:'agent-selected'}:{}),at:new Date().toISOString()},{createOnly:true});
  }
  async outcome(attempt,result,source){const observed=observeGoalToolOutcome(attempt.event.call,result);return this.append(['outcome',attempt.id],{kind:'outcome',attemptId:attempt.id,...(attempt.event.actionId?{actionId:attempt.event.actionId,associationAuthority:'agent-selected'}:{}),result:{success:result?.success,code:result?.code,actionDispatched:observed.actionDispatched,kind:observed.kind},resultDigest:hash(result),source});}
  async note(key,{actionId,parent=null,objective,inputs,state,decision,nextAction,evidence=[],correctionOf=null,reconciles=[],focus=false}){
    const rows=await this.events();
    if(evidence.some(id=>!rows.some(r=>r.id===id)))throw fail('DIRECTORY_EVIDENCE_MISSING','Use exact existing journal event IDs.');
    if(parent&&!rows.some(r=>r.id===parent&&r.event.kind==='action-state'&&r.event.actionId===actionId))throw fail('DIRECTORY_PARENT_MISSING','Use an action-state revision from this action.');
    if(correctionOf&&!rows.some(r=>r.id===correctionOf))throw fail('DIRECTORY_CORRECTION_MISSING','Correction must retain and reference its original.');
    if(reconciles.some(id=>!rows.some(r=>r.id===id&&r.event.kind==='action-state'&&r.event.actionId===actionId)))throw fail('DIRECTORY_RECONCILIATION_MISSING','Reconciled action-state revisions must belong to this action.');
    return this.append(['note',key],{kind:'action-state',authority:'agent-authored',actionId,parent,objective,inputs,state,decision,nextAction,evidence,correctionOf,reconciles,focus:focus===true});
  }
  async read({offset=0,limit=20,revision,actionId,view='working',conflictGroup}={}){
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>50)throw fail('DIRECTORY_READ_RANGE','Use offset >= 0 and limit 1..50.');
    const rows=await this.events(),currentRevision=hash(rows.map(r=>[r.id,r.digest])),attempts=rows.filter(r=>r.event.kind==='attempt');
    if(revision&&revision!==currentRevision)throw fail('DIRECTORY_READ_CHANGED','Journal changed during pagination; restart the index read or inspect exact event IDs.');
    const completedAttempts=new Set(rows.filter(r=>r.event.kind==='outcome').map(r=>r.event.attemptId));
    const unresolved=attempts.filter(a=>!completedAttempts.has(a.id)).map(r=>r.id),unresolvedSet=new Set(unresolved);
    const notes=rows.filter(r=>r.event.kind==='action-state');
    const knownActions=new Set(notes.map(r=>r.event.actionId)),actionCounts=new Map();
    for(const row of rows){const e=row.event;if(!e.actionId||!['attempt','outcome'].includes(e.kind))continue;
      const counts=actionCounts.get(e.actionId)||{attempts:0,outcomes:0,failedOutcomes:0,unresolvedAttempts:0};
      if(e.kind==='attempt'){counts.attempts++;if(!completedAttempts.has(row.id))counts.unresolvedAttempts++;}
      else{counts.outcomes++;if(e.result?.success!==true)counts.failedOutcomes++;}actionCounts.set(e.actionId,counts);
    }
    // Parent and reconciles are both revision edges. Conflicts are remaining
    // tips for one action, including competing merges with different parents.
    const retired=new Set(notes.flatMap(r=>[r.event.parent,...(r.event.reconciles||[])].filter(Boolean)));
    const heads=new Map();
    for(const n of notes)if(!retired.has(n.id)){const ids=heads.get(n.event.actionId)||[];ids.push(n.id);heads.set(n.event.actionId,ids);}
    const conflicts=[...heads.values()].filter(ids=>ids.length>1);
    if(conflictGroup!==undefined){
      if(!Number.isSafeInteger(conflictGroup)||conflictGroup<0||conflictGroup>=conflicts.length)throw fail('DIRECTORY_CONFLICT_RANGE','Select an existing conflict group from the revision-bound index.');
      const ids=conflicts[conflictGroup];return {revision:currentRevision,conflictGroup,total:ids.length,offset,nextOffset:offset+limit<ids.length?offset+limit:null,revisionIds:ids.slice(offset,offset+limit)};
    }
    const unknownOutcomes=rows.filter(r=>r.event.kind==='outcome'&&r.event.result?.kind==='uncertain_external_effect').map(r=>({id:r.id,attemptId:r.event.attemptId}));
    if(!['working','events'].includes(view))throw fail('DIRECTORY_VIEW_INVALID','Use working or events.');
    const referenced=new Set(notes.flatMap(r=>r.event.evidence||[]));
    const working=rows.filter(r=>['phase-authority','legacy-context','unpublished'].includes(r.event.kind)
      ||r.event.kind==='action-state'&&!retired.has(r.id)
      ||r.event.kind==='attempt'&&unresolvedSet.has(r.id)
      ||r.event.kind==='outcome'&&(r.event.result?.success!==true||!knownActions.has(r.event.actionId)&&!referenced.has(r.id)&&!referenced.has(r.event.attemptId)));
    const selected=actionId?rows.filter(r=>r.event.actionId===actionId):view==='working'?working:rows;
    const metadataTotal=Math.max(unresolved.length,unknownOutcomes.length,conflicts.length);
    return {version:1,revision:currentRevision,total:selected.length,offset,nextOffset:offset+limit<Math.max(selected.length,metadataTotal)?offset+limit:null,events:selected.slice(offset,offset+limit).map(r=>({id:r.id,digest:r.digest,event:{kind:r.event.kind,authority:r.event.authority,actionId:r.event.actionId,parent:r.event.parent,attemptId:r.event.attemptId,result:r.event.result,...actionPreview(r.event),...(r.event.kind==='action-state'?{hostEvidence:actionCounts.get(r.event.actionId)||{attempts:0,outcomes:0,failedOutcomes:0,unresolvedAttempts:0}}:{})}})),unresolvedAttempts:unresolved.slice(offset,offset+limit),unknownOutcomes:unknownOutcomes.slice(offset,offset+limit),conflicts:conflicts.slice(offset,offset+limit).map(ids=>ids.slice(0,limit)),conflictPages:conflicts.slice(offset,offset+limit).map((ids,index)=>({conflictGroup:offset+index,total:ids.length,nextOffset:limit<ids.length?limit:null})),metadataScope:"conversation",metadataCounts:{unresolvedAttempts:unresolved.length,unknownOutcomes:unknownOutcomes.length,conflicts:conflicts.length},
      retrieval:{strategy:'validated-full-scan',scannedEvents:rows.length,workingEvents:working.length,authorityEvents:rows.filter(r=>r.event.kind==='phase-authority').length,constantCost:false},
      policy:'Attempts without outcomes remain unknown. Notes are agent assumptions, not user instructions or verified effects. Previews can be truncated; inspect exact sources for full obligations. Forked revisions require explicit reconciliation. No journal operation dispatches or retries an action.'};
  }
  async inspect({id,offset=0,length=6000,source=false}){
    if(!/^[a-f0-9]{64}$/.test(id)||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||length<1||length>12000)throw fail('DIRECTORY_READ_RANGE','Use an exact event ID and a bounded character range.');
    await queues.get(this.root);
    let row;try{row=JSON.parse(await readFile(path.join(this.root,id+'.json'),'utf8'));}catch(error){if(error.code==='ENOENT'){try{await readFile(path.join(this.root,id+'.json.claim'));}catch(missing){if(missing.code==='ENOENT')throw fail('DIRECTORY_EVENT_MISSING','Event not found.');throw missing;}throw fail('DIRECTORY_ACTION_PENDING','Reserved event has not published; inspect recovery without replay.');}throw error;}
    if(row.id!==id||hash(row.event)!==row.digest)throw fail('DIRECTORY_ACTION_CORRUPT','Action source failed validation; preserve it for recovery.');
    let content=JSON.stringify(row);
    if(source){
      if(!['outcome','phase-authority','legacy-context'].includes(row.event.kind)||!row.event.source?.file||!row.event.source?.sha256)throw fail('DIRECTORY_SOURCE_MISSING','This event has no exact source-file reference.');
      const raw=await readFile(row.event.source.file,'utf8');
      if(hash(JSON.parse(raw))!==row.event.source.sha256)throw fail('DIRECTORY_SOURCE_CHANGED','Receipt source changed; do not use stale evidence as current verification.');
      content=raw;
    }
    return {id,digest:row.digest,source,offset,totalCharacters:content.length,text:content.slice(offset,offset+length),nextOffset:offset+length<content.length?offset+length:null};
  }
}

export const DIRECTORY_ACTION_TOOL={type:'function',name:'relay_directory_action',description:'Maintain inspectable action/outcome state during work. record with focus:true selects the action for subsequent calls in this phase; await its receipt before dispatching dependent tools. Association is agent-selected, not verified causation. read actionId retrieves its notes, attempts and outcomes. record creates agent-authored state, never user authority or effect confirmation. Link exact journal evidence IDs; corrections retain originals. read defaults to current action heads, unlinked outcomes and unresolved work; view:events exposes all history, actionId selects all revisions; inspect retrieves exact event ranges or source:true for the original validated receipt. Use conflictGroup with revision, offset and limit to inspect every revision in a wide fork. No operation dispatches or replays work.',inputSchema:{type:'object',additionalProperties:false,required:['action'],properties:{action:{type:'string',enum:['read','inspect','record']},view:{type:'string',enum:['working','events']},conflictGroup:{type:'integer',minimum:0},id:{type:'string'},source:{type:'boolean'},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:50},length:{type:'integer',minimum:1,maximum:12000},revision:{type:'string'},actionId:{type:'string',maxLength:200},focus:{type:'boolean'},parent:{type:'string'},objective:{type:'string',maxLength:4000},inputs:{type:'string',maxLength:4000},state:{type:'string',maxLength:4000},decision:{type:'string',maxLength:4000},nextAction:{type:'string',maxLength:4000},evidence:{type:'array',maxItems:100,items:{type:'string'}},reconciles:{type:'array',maxItems:100,items:{type:'string'}},correctionOf:{type:'string'}}}};
