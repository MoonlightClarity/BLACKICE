import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {compileVisual,VISUAL_EXAMPLE} from '../public/visual-document.mjs';
import {validDirectArguments} from './direct-execution-api.mjs';

const fail=(message,code='VISUAL_INVALID',status=400)=>Object.assign(new Error(message),{code,status});
const id=value=>{if(typeof value!=='string'||! /^[a-zA-Z0-9_-]{1,120}$/.test(value))throw fail('Invalid visual or conversation ID.');return value;};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const payload=value=>({success:true,contentItems:[{type:'inputText',text:JSON.stringify(value)}]});

/** One atomically replaced journal per conversation; revisions and retry receipts commit together. */
export class VisualArtifacts{
 constructor({dataDir,assertConversation=async()=>{},onChange=()=>{},isClosing=()=>false}){this.directory=path.join(dataDir,'visual-artifacts');this.assertConversation=assertConversation;this.onChange=onChange;this.isClosing=isClosing;this.pending=new Map();}
 async load(conversationId){id(conversationId);await this.assertConversation(conversationId);try{const file=path.join(this.directory,conversationId+'.json');if((await fs.stat(file)).size>20*1024*1024)throw Error('Too large');const state=JSON.parse(await fs.readFile(file,'utf8'));if(state.version!==1||!Array.isArray(state.artifacts)||state.artifacts.length>100||!state.receipts||typeof state.receipts!=='object'||typeof state.automatic!=='boolean'||state.artifacts.some(a=>!a.id||!Array.isArray(a.revisions)||!a.revisions.length||a.revisions.length>200))throw Error('Invalid journal');return state;}catch(e){if(e.code==='ENOENT')return {version:1,artifacts:[],receipts:{},automatic:false};throw fail('Saved visuals could not be read. They have not been replaced.','VISUAL_DAMAGED',503);}}
 async read(args){const state=await this.load(args.conversationId);
  if(args.action==='list')return {automatic:state.automatic,artifacts:state.artifacts.map(a=>({id:a.id,title:a.revisions.at(-1).document.title,revision:a.revisions.length,createdRunId:a.revisions[0].runId,history:a.revisions.map(r=>({revision:r.revision,at:r.at,actor:r.actor,runId:r.runId}))}))};
  const artifact=state.artifacts.find(a=>a.id===id(args.artifactId));if(!artifact)throw fail('Visual not found.','VISUAL_NOT_FOUND',404);
  const revision=args.revision??artifact.revisions.length;if(!Number.isSafeInteger(revision)||revision<1||revision>artifact.revisions.length)throw fail('Visual revision not found.','VISUAL_NOT_FOUND',404);
  const saved=artifact.revisions[revision-1];try{const compiled=compileVisual(saved.document);if(compiled.svg!==saved.svg||compiled.text!==saved.text)throw Error('Mismatch');}catch{throw fail('Saved visual content failed validation. Original data is preserved.','VISUAL_DAMAGED',503);}
  return {id:artifact.id,conversationId:args.conversationId,currentRevision:artifact.revisions.length,...saved};
 }
 async execute(args,{actor='user',runId=null,signal,canWrite=true}={}){
  if(args.action==='describe')return {version:1,example:VISUAL_EXAMPLE,primitives:'items with explicit positions and status; labeled connections (uncertain optional); bounded groups; grid columns/rows; notes. Mix them; no technique selection required.',custom:'kind custom requires svg, title and summary. Static SVG only: no references, CSS, filters or external resources.',guidance:'Use only on explicit request or when automatic is enabled. Use a visual when relationships, competing explanations, gaps or order are easier to inspect spatially. Prefer prose for a simple answer and a table for exact comparisons. A diagram is not evidence. Read before revising; preserve user edits. No model is started.'};
  if(['list','read','export'].includes(args.action))return this.read({...args,action:args.action==='export'?'read':args.action});
  if(!canWrite)throw fail('This agent is read-only.','VISUAL_READ_ONLY',403);
  id(args.conversationId);if(typeof args.requestId!=='string'||! /^[\w.:-]{1,160}$/.test(args.requestId))throw fail('A stable requestId is required.');
  const prior=this.pending.get(args.conversationId)||Promise.resolve();
  const operation=prior.catch(()=>{}).then(async()=>{
   if(this.isClosing())throw fail('BLACKICE is closing.','VISUAL_CLOSING',503);
   signal?.throwIfAborted();const state=await this.load(args.conversationId),key=digest([actor,args.requestId]),hash=digest(args),receipt=state.receipts[key];
   if(receipt){if(receipt.hash!==hash)throw fail('This requestId already names different content.','VISUAL_REQUEST_CONFLICT',409);return receipt.result;}
   let result;
   if(args.action==='preferences'){if(typeof args.automatic!=='boolean')throw fail('automatic must be boolean.');state.automatic=args.automatic;result={automatic:state.automatic};}
   else{
    if(!['create','revise'].includes(args.action))throw fail('Unknown visual action.');
    const compiled=compileVisual(args.document);let artifact;
    if(args.action==='create'){if(state.artifacts.length>=100)throw fail('This conversation has reached 100 visuals.');artifact={id:randomUUID(),revisions:[]};state.artifacts.push(artifact);}
    else{artifact=state.artifacts.find(a=>a.id===id(args.artifactId));if(!artifact)throw fail('Visual not found.','VISUAL_NOT_FOUND',404);if(args.expectedRevision!==artifact.revisions.length)throw fail(`Visual changed; read revision ${artifact.revisions.length} before revising. Your draft is preserved.`, 'VISUAL_REVISION_CONFLICT',409);}
    if(artifact.revisions.length>=200)throw fail('Revision limit reached. Create a new visual.');
    const revision={revision:artifact.revisions.length+1,at:new Date().toISOString(),actor,runId,...compiled};artifact.revisions.push(revision);
    result={id:artifact.id,conversationId:args.conversationId,revision:revision.revision,title:compiled.document.title,text:compiled.text};
   }
   state.receipts[key]={hash,result};if(Buffer.byteLength(JSON.stringify(state))>20*1024*1024)throw fail('Conversation visual storage limit reached. Export and start a new conversation.');
   signal?.throwIfAborted();await fs.mkdir(this.directory,{recursive:true});const target=path.join(this.directory,args.conversationId+'.json'),temp=target+'.'+randomUUID()+'.tmp';
   try{const handle=await fs.open(temp,'wx',0o600);try{await handle.writeFile(JSON.stringify(state));await handle.sync();}finally{await handle.close();}signal?.throwIfAborted();await fs.rename(temp,target);}finally{await fs.rm(temp,{force:true}).catch(()=>{});}
   try{this.onChange({type:'visual.updated',data:{conversationId:args.conversationId,...result},at:new Date().toISOString()});}catch{}
   return result;
  });this.pending.set(args.conversationId,operation);try{return await operation;}finally{if(this.pending.get(args.conversationId)===operation)this.pending.delete(args.conversationId);}
 }
}

const properties={action:{type:'string',enum:['describe','list','read','create','revise','export']},conversationId:{type:'string'},artifactId:{type:'string'},revision:{type:'integer',minimum:1},expectedRevision:{type:'integer',minimum:1},requestId:{type:'string'},document:{type:'object',description:'Version 1 visual document. Call describe for a composable example; custom SVG is supported.'}};
export function visualTool(store,{native=false,conversationId,runId,canWrite=true,isClosing=()=>false,authorizeWrite=client=>{if(!client?.scopes?.includes('files:write'))throw fail('Visual edits require files:write access.','VISUAL_SCOPE',403);}}={}){
 const fields={...properties};if(native)delete fields.conversationId;
 return {definition:{...(native?{type:'function'}:{}),name:native?'relay_visual':'blackice_visual',scope:'read',requiredScopes:['read'],mutating:true,description:'Create, inspect and revise editable visual reasoning artifacts without starting a model. Optional and independent of Planning. Use only when the user asks or the conversation list reports automatic=true. Prefer text for simple answers. Call describe for primitives and custom SVG; read current revision before edits. All changes persist in chat. Direct edits require files:write access.',inputSchema:{type:'object',additionalProperties:false,required:native?['action']:['action','requestId'],properties:fields},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}},async execute(args,context={}){
  if(!properties.action.enum.includes(args.action))throw fail('Use a supported visual tool action.');
  if(isClosing()&&!['describe','list','read','export'].includes(args.action))throw fail('BLACKICE is closing.','VISUAL_CLOSING',503);
  if(native&&args.conversationId&&args.conversationId!==conversationId)throw fail('Wrong conversation.','VISUAL_SCOPE',403);
  if(!native&&!context.client?.id)throw fail('Authenticated connection required.','VISUAL_SCOPE',403);
  if(!native&&['create','revise'].includes(args.action))await authorizeWrite(context.client);
  return payload(await store.execute({...args,...(native?{conversationId}:{})},{actor:native?`agent:${runId}`:`connector:${context.client.id}`,runId,signal:context.signal,canWrite}));
 }};
}
export function nativeVisualTools(store,options={}){
 const provider=async({taskId,runId,signal,canWrite})=>{const entry=visualTool(store,{...options,native:true,conversationId:taskId,runId,canWrite});return {tools:[entry.definition],async handle(call,context={}){if(call.namespace||call.name!=='relay_visual')throw fail('Visual tool not attached.');const args=typeof call.arguments==='string'?JSON.parse(call.arguments):call.arguments;if(!validDirectArguments(args,entry.definition.inputSchema))throw fail('Use the attached visual schema.');return entry.execute(args,{signal:context.signal||signal});}};};
 provider.catalog=[visualTool(store,{native:true}).definition];return provider;
}

export async function handleVisualHttp({req,res,pathname,body,json,store,mutations}){
 const match=pathname.match(/^\/api\/conversations\/([\w-]+)\/visuals$/);if(!match)return false;
 const conversationId=match[1];
 if(req.method==='GET'){const query=new URL(req.url,'http://localhost').searchParams;json(res,200,await store.execute({conversationId,action:query.has('artifactId')?'read':'list',...(query.has('artifactId')?{artifactId:query.get('artifactId')} : {}),...(query.has('revision')?{revision:Number(query.get('revision'))}:{})}));return true;}
 if(req.method==='POST'){const args=await body(req,65536);if(!args||Object.keys(args).some(k=>!['action','artifactId','expectedRevision','requestId','document','automatic'].includes(k))||!['create','revise','preferences'].includes(args.action))throw fail('Unsupported visual edit.');const work=store.execute({...args,conversationId});mutations.add(work);try{json(res,200,await work);}finally{mutations.delete(work);}return true;}
 throw fail('Method not supported.','VISUAL_METHOD',405);
}
