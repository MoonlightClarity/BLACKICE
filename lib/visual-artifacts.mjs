import {compileVisual as compileGradient} from '../public/visual-document-renderer-gradient-1.mjs';
import {VISUAL_PREVIEW_FEEDBACK} from './visual-preview-feedback.mjs';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {compileVisual} from '../public/visual-document.mjs';
import {compileVisual as compileGeometry} from '../public/visual-document-renderer-geometry.mjs';
import {compileVisual as compileComposition} from '../public/visual-document-renderer-composition.mjs';
import {compileVisual as compileOriginal} from '../public/visual-document-renderer-original.mjs';
import {compileVisual as compileClamped} from '../public/visual-document-renderer-clamped.mjs';
import {compileVisual as compileLabels} from '../public/visual-document-renderer-labels.mjs';
import {compileVisual as compileLabels3} from '../public/visual-document-renderer-labels-3.mjs';
import {compileVisual as compileBriefing} from '../public/visual-document-renderer-briefing.mjs';
import {visualDesignDescription,VISUAL_GUIDE_FOCUSES} from './visual-design-guide.mjs';
import {applyVisualEdits,visualChanges,VISUAL_COLLECTIONS} from '../public/visual-edits.mjs';
import {validDirectArguments} from './direct-execution-api.mjs';

const fail=(message,code='VISUAL_INVALID',status=400)=>Object.assign(new Error(message),{code,status});
const id=value=>{if(typeof value!=='string'||! /^[a-zA-Z0-9_-]{1,120}$/.test(value))throw fail('Invalid visual or conversation ID.');return value;};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const boundedChange=value=>typeof value==='string'&&value.length>1000?{preview:value.slice(0,1000),characters:value.length,truncated:true}:Array.isArray(value)?value.map(boundedChange):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,boundedChange(v)])):value;
const payload=value=>({success:true,contentItems:[{type:'inputText',text:JSON.stringify(value)}]});
// Rendering is part of the persisted revision contract. Never change an existing
// renderer implementation: add a new identifier and retain old readers instead.
const CURRENT_RENDERER='gradient-1';
const renderers={'gradient-1':compileGradient,'briefing-1':compileBriefing,'geometry-1':compileGeometry,'labels-2':compileLabels,'labels-3':compileLabels3};
function validateSavedRevision(saved){
 const choices=saved.renderer===undefined?[compileGeometry,compileComposition,compileOriginal,compileClamped]:[renderers[saved.renderer]];
 return choices.some(render=>{if(!render)return false;try{const compiled=render(saved.document);return compiled.svg===saved.svg&&compiled.text===saved.text;}catch{return false;}});
}

/** One atomically replaced journal per conversation; revisions and retry receipts commit together. */
export class VisualArtifacts{
 constructor({dataDir,assertConversation=async()=>{},onChange=()=>{},isClosing=()=>false,renderPreview}){this.renderPreview=renderPreview;this.directory=path.join(dataDir,'visual-artifacts');this.assertConversation=assertConversation;this.onChange=onChange;this.isClosing=isClosing;this.pending=new Map();}
 async load(conversationId){id(conversationId);await this.assertConversation(conversationId);try{const file=path.join(this.directory,conversationId+'.json');if((await fs.stat(file)).size>20*1024*1024)throw Error('Too large');const state=JSON.parse(await fs.readFile(file,'utf8'));if(state.version!==1||!Array.isArray(state.artifacts)||state.artifacts.length>100||!state.receipts||typeof state.receipts!=='object'||typeof state.automatic!=='boolean'||state.artifacts.some(a=>!a.id||!Array.isArray(a.revisions)||!a.revisions.length||a.revisions.length>200))throw Error('Invalid journal');return state;}catch(e){if(e.code==='ENOENT')return {version:1,artifacts:[],receipts:{},automatic:true};throw fail('Saved visuals could not be read. They have not been replaced.','VISUAL_DAMAGED',503);}}
 async read(args){const state=await this.load(args.conversationId);
  if(args.action==='list')return {automatic:true,artifacts:state.artifacts.map(a=>({id:a.id,title:a.revisions.at(-1).document.title,revision:a.revisions.length,createdRunId:a.revisions[0].runId,lastActor:a.revisions.at(-1).actor,history:a.revisions.map(r=>({revision:r.revision,at:r.at,actor:r.actor,runId:r.runId}))}))};
  const artifact=state.artifacts.find(a=>a.id===id(args.artifactId));if(!artifact)throw fail('Visual not found.','VISUAL_NOT_FOUND',404);
  if(args.action==='changes'){
   const since=args.sinceRevision,limit=args.limit??5;if(!Number.isInteger(since)||since<0||since>artifact.revisions.length||!Number.isInteger(limit)||limit<1||limit>20)throw fail('Use an observed sinceRevision and a limit from 1 to 20.');
   const revisions=artifact.revisions.slice(since,since+limit).map((r,i)=>({revision:r.revision,actor:r.actor,at:r.at,changes:boundedChange(r.changes??visualChanges(artifact.revisions[since+i-1]?.document,r.document))}));
   return {id:artifact.id,currentRevision:artifact.revisions.length,throughRevision:since+revisions.length,hasMore:since+revisions.length<artifact.revisions.length,revisions};
  }
  const revision=args.revision??artifact.revisions.length;if(!Number.isSafeInteger(revision)||revision<1||revision>artifact.revisions.length)throw fail('Visual revision not found.','VISUAL_NOT_FOUND',404);
  const saved=artifact.revisions[revision-1];if(!validateSavedRevision(saved))throw fail('Saved visual content failed validation. Original data is preserved.','VISUAL_DAMAGED',503);
  return {id:artifact.id,conversationId:args.conversationId,currentRevision:artifact.revisions.length,...saved};
 }
 async execute(args,{actor='user',runId=null,signal,canWrite=true}={}){
  if(args.action==='describe')return {version:2,...visualDesignDescription(args.focus),primitives:'Items, links, groups, notes and custom regions have stable IDs, assigned if omitted. Omit coordinates for automatic layout; layout.columns is an optional geometry hint. Groups may name item IDs in members. Regions have label, summary and static svg; their contents have no inferred semantics. Grid columns/rows can be mixed in. Read the saved document to obtain assigned IDs.',patch:'Use action patch with artifactId, expectedRevision from the current read, a stable requestId and operations. Direct calls also require conversationId. Replace example object IDs with IDs returned by read.',operationExamples:[{op:'update',collection:'items',id:'observed',value:{label:'Corrected observation'}},{op:'add',collection:'notes',id:'next-test',value:{text:'Compare versions under equal load.'}}],operations:'add/update/remove target collection and id; set_document changes title/summary/layout/dimensions; set_cell names zero-based row/column and value. Removing an item requires removing its links and group memberships in the same atomic patch. changes returns actor-tagged field differences after sinceRevision, default 5 revisions; paginate using throughRevision.',custom:'Use custom SVG regions inside composed documents or kind custom for a whole SVG. Static only: bounded local gradient paints are supported; no reusable/external references, CSS, filters or external resources.',guidance:'preview renders the document without saving. Read an existing artifact before editing it, use its expectedRevision, and preserve user edits. This tool starts no model.'};
  if(args.action==='preview'){
   if(!this.renderPreview)throw fail('Rendered preview is unavailable in this server. Do not claim visual inspection.','VISUAL_PREVIEW_UNAVAILABLE',503);
   const compiled=args.document?compileVisual(args.document):await this.read({...args,action:'read'});
   if(args.inspection!==undefined&&args.inspection!=='asset')throw fail('Unknown visual inspection mode.');
   return this.renderPreview(compiled,{signal,inspection:args.inspection});
  }
  if(['list','read','changes','export'].includes(args.action))return this.read({...args,action:args.action==='export'?'read':args.action});
  if(!canWrite)throw fail('This agent is read-only.','VISUAL_READ_ONLY',403);
  id(args.conversationId);if(typeof args.requestId!=='string'||! /^[\w.:-]{1,160}$/.test(args.requestId))throw fail('A stable requestId is required.');
  const prior=this.pending.get(args.conversationId)||Promise.resolve();
  const operation=prior.catch(()=>{}).then(async()=>{
   if(this.isClosing())throw fail('BLACKICE is closing.','VISUAL_CLOSING',503);
   signal?.throwIfAborted();const state=await this.load(args.conversationId),key=digest([actor,args.requestId]),hash=digest(args),receipt=state.receipts[key];
   if(receipt){if(receipt.hash!==hash)throw fail('This requestId already names different content.','VISUAL_REQUEST_CONFLICT',409);return receipt.result;}
   let result;
   if(args.action==='preferences'){if(typeof args.automatic!=='boolean')throw fail('automatic must be boolean.');state.automatic=true;result={automatic:true};}
   else{
    if(!['create','revise','patch'].includes(args.action))throw fail('Unknown visual action.');
    let artifact;
    if(args.action==='create'){if(state.artifacts.length>=100)throw fail('This conversation has reached 100 visuals.');artifact={id:randomUUID(),revisions:[]};state.artifacts.push(artifact);}
    else{artifact=state.artifacts.find(a=>a.id===id(args.artifactId));if(!artifact)throw fail('Visual not found.','VISUAL_NOT_FOUND',404);if(args.expectedRevision!==artifact.revisions.length)throw fail(`Visual changed; read revision ${artifact.revisions.length} before revising. Your draft is preserved.`, 'VISUAL_REVISION_CONFLICT',409);}
    if(args.action==='patch'&&args.document!==undefined)throw fail('Use operations, not a replacement document, for patch.');
    const before=artifact.revisions.at(-1)?.document,compiled=compileVisual(args.action==='patch'?applyVisualEdits(before,args.operations):args.document);
    if(artifact.revisions.length>=200)throw fail('Revision limit reached. Create a new visual.');
    const revision={revision:artifact.revisions.length+1,at:new Date().toISOString(),actor,runId,renderer:CURRENT_RENDERER,changes:visualChanges(before,compiled.document),...compiled};artifact.revisions.push(revision);
    result={id:artifact.id,conversationId:args.conversationId,revision:revision.revision,title:compiled.document.title,text:compiled.text,objects:Object.fromEntries(VISUAL_COLLECTIONS.filter(c=>compiled.document[c]).map(c=>[c,compiled.document[c].map(o=>o.id).filter(Boolean)]))};
   }
   state.receipts[key]={hash,result};if(Buffer.byteLength(JSON.stringify(state))>20*1024*1024)throw fail('Conversation visual storage limit reached. Export and start a new conversation.');
   signal?.throwIfAborted();await fs.mkdir(this.directory,{recursive:true});const target=path.join(this.directory,args.conversationId+'.json'),temp=target+'.'+randomUUID()+'.tmp';
   try{const handle=await fs.open(temp,'wx',0o600);try{await handle.writeFile(JSON.stringify(state));await handle.sync();}finally{await handle.close();}signal?.throwIfAborted();await fs.rename(temp,target);}finally{await fs.rm(temp,{force:true}).catch(()=>{});}
   try{this.onChange({type:'visual.updated',data:{conversationId:args.conversationId,...result},at:new Date().toISOString()});}catch{}
   return result;
  });this.pending.set(args.conversationId,operation);try{return await operation;}finally{if(this.pending.get(args.conversationId)===operation)this.pending.delete(args.conversationId);}
 }
}

const properties={inspection:{type:'string',enum:['asset'],description:"For preview, add light/dark/mid backgrounds, 64/32px sizes and grayscale to compare the asset's silhouette and contrast."},focus:{type:'string',enum:VISUAL_GUIDE_FOCUSES,description:"For describe, select a design chapter. Omit for the general SVG format and examples."},action:{type:'string',enum:['describe','preview','list','read','changes','create','revise','patch','export']},conversationId:{type:'string'},artifactId:{type:'string'},sinceRevision:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:20},operations:{type:'array',minItems:1,maxItems:80,items:{type:'object'}},revision:{type:'integer',minimum:1},expectedRevision:{type:'integer',minimum:1},requestId:{type:'string'},document:{type:'object',description:'Version 2 visual document (version 1 remains readable). Call describe for authored SVG examples and design guidance.'}};
export function visualTool(store,{native=false,conversationId,runId,canWrite=true,isClosing=()=>false,authorizeWrite=client=>{if(!client?.scopes?.includes('files:write'))throw fail('Visual edits require files:write access.','VISUAL_SCOPE',403);}}={}){
 const fields={...properties};if(native)delete fields.conversationId;
 return {definition:{...(native?{type:'function'}:{}),name:native?'relay_visual':'blackice_visual',scope:'read',requiredScopes:['read'],mutating:true,description:"Create and edit saved SVG artwork, diagrams, charts and mockups. describe returns the visual document format and examples; optional focus selects a design chapter. preview renders an unsaved document and returns images plus layout warnings; inspection:asset adds a contact sheet. Inspect those images to decide which details to repair.\ncreate saves document. read returns its current revision and objects; changes shows edits since sinceRevision. revise replaces the document; patch edits stable object IDs using operations. Supply expectedRevision when editing and reread after a conflict. export returns the selected saved revision. Direct calls require requestId. Saved artifacts also require conversationId; native calls use the current conversation and require requestId for saves. preview accepts document without saving, or artifactId to render a saved revision. It returns image content for visual inspection.",inputSchema:{type:'object',additionalProperties:false,required:native?['action']:['action','requestId'],properties:fields},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}},async execute(args,context={}){
  if(!properties.action.enum.includes(args.action))throw fail('Use a supported visual tool action.');
  if(isClosing()&&!['describe','list','read','changes','export'].includes(args.action))throw fail('BLACKICE is closing.','VISUAL_CLOSING',503);
  if(native&&args.conversationId&&args.conversationId!==conversationId)throw fail('Wrong conversation.','VISUAL_SCOPE',403);
  if(!native&&!context.client?.id)throw fail('Authenticated connection required.','VISUAL_SCOPE',403);
  if(!native&&['create','revise','patch'].includes(args.action))await authorizeWrite(context.client);
  const result=await store.execute({...args,...(native?{conversationId}:{})},{actor:native?`agent:${runId}`:`connector:${context.client.id}`,runId,signal:context.signal,canWrite});
  if(args.action==='read'){const {svg,...semantic}=result;return payload(semantic);}
  if(args.action==='preview'){const {imageUrl,inspectionImageUrl,...inspection}=result;return {success:true,contentItems:[{type:'inputText',text:JSON.stringify({...inspection,imageFeedback:VISUAL_PREVIEW_FEEDBACK})},{type:'inputImage',imageUrl},...(inspectionImageUrl?[{type:'inputImage',imageUrl:inspectionImageUrl}]:[])]};}
  return payload(result);
 }};
}
export function nativeVisualTools(store,options={}){
 const provider=async({taskId,runId,signal,canWrite})=>{const entry=visualTool(store,{...options,native:true,conversationId:taskId,runId,canWrite});
  let instructions='';try{const catalog=await store.read({action:'list',conversationId:taskId});if(catalog.artifacts.length)instructions='SAVED VISUALS\nSaved artifact IDs, revisions and last editors: '+JSON.stringify(catalog.artifacts.slice(-8).map(a=>({id:a.id,revision:a.revision,lastActor:a.lastActor})))+'. To continue an artifact, read changes after your observed revision and keep user corrections.';}catch{instructions='Saved visual metadata is unavailable; no artifact revisions were read.';}
  return {tools:[entry.definition],instructions,async handle(call,context={}){if(call.namespace||call.name!=='relay_visual')throw fail('Visual tool not attached.');const args=typeof call.arguments==='string'?JSON.parse(call.arguments):call.arguments;if(!validDirectArguments(args,entry.definition.inputSchema))throw fail('Use the attached visual schema.');return entry.execute(args,{signal:context.signal||signal});}};};
 provider.catalog=[visualTool(store,{native:true}).definition];return provider;
}

export async function handleVisualHttp({req,res,pathname,body,json,store,mutations}){
 const match=pathname.match(/^\/api\/conversations\/([\w-]+)\/visuals$/);if(!match)return false;
 const conversationId=match[1];
 if(req.method==='GET'){const query=new URL(req.url,'http://localhost').searchParams;json(res,200,await store.execute({conversationId,action:query.has('artifactId')?'read':'list',...(query.has('artifactId')?{artifactId:query.get('artifactId')} : {}),...(query.has('revision')?{revision:Number(query.get('revision'))}:{})}));return true;}
 if(req.method==='POST'){const args=await body(req,65536);if(!args||Object.keys(args).some(k=>!['action','artifactId','expectedRevision','requestId','document','operations','automatic'].includes(k))||!['create','revise','patch','preferences'].includes(args.action))throw fail('Unsupported visual edit.');const work=store.execute({...args,conversationId});mutations.add(work);try{json(res,200,await work);}finally{mutations.delete(work);}return true;}
 throw fail('Method not supported.','VISUAL_METHOD',405);
}
