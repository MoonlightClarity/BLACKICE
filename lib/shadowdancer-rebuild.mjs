import {resolveDirectoryRoot} from './directory-location.mjs';
/** Revision-aware Shadowdancer Context rebuilds.
 * Source runs are never overwritten; unchanged modules/pages are reused with
 * provenance in a new run, while dependency-affected work is recomputed.
 */
import path from 'node:path';
import {readdir,readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {assertSafeShadowdancerPath} from './shadowdancer-context.mjs';
import {atomicJSON as uncheckedAtomicJSON,sourceSnapshot,testSuiteSnapshot,extractRequirements} from './shadowdancer-verification.mjs';
import {FilePatchStore} from './file-patches.mjs';
import {createWorkspaceToolHandler} from './workspace-tools.mjs';
const ID=/^[A-Za-z0-9_-]{1,120}$/;
const fail=(code,message,status=400)=>Object.assign(new Error(message),{code,status});
const hash=b=>createHash('sha256').update(b).digest('hex');
const compare=(a,b)=>a.id.localeCompare(b.id,undefined,{numeric:true});
const safeBytes=async file=>{await assertSafeShadowdancerPath(file);return readFile(file);};
const exists=async file=>{await assertSafeShadowdancerPath(file);try{return (await stat(file)).isFile()}catch(error){if(error.code==='ENOENT')return false;throw error}};
const read=async file=>JSON.parse((await safeBytes(file)).toString('utf8'));
const atomicJSON=async (file,value)=>{await assertSafeShadowdancerPath(file);return uncheckedAtomicJSON(file,value);};
const validateId=id=>{if(typeof id!=='string'||!ID.test(id))throw fail('DIRECTORY_REBUILD_ID','Invalid conversation/run ID');return id};
export function parseRebuildRequest(text){
 const match=/^REBUILD_FROM:\s*([A-Za-z0-9_-]{1,120})(?:\r?\nEDIT_REVISION:\s*(edit-\d{5,10}))?\s*$/.exec(String(text||'').trim());
 return match?{sourceRunId:match[1],...(match[2]?{expectedEditId:match[2]}:{})}:null;
}
async function indexModules(folder){
 const result=[];
 async function walk(dir,depth=0){
  if(depth>14||result.length>120)throw fail('DIRECTORY_REBUILD_LIMIT','Too many or deeply nested modules');
  let rows=[];try{await assertSafeShadowdancerPath(dir);rows=await readdir(dir,{withFileTypes:true})}catch(e){if(e.code==='ENOENT')return;throw e}
  for(const row of rows){
   if(row.isSymbolicLink())continue;
   if(row.isDirectory())await walk(path.join(dir,row.name),depth+1);
   else if(row.isFile()&&row.name==='module.json'){
    const file=path.join(dir,row.name),data=await read(file),resultFile=path.join(dir,'result.json');
    if(typeof data.id!=='string'||!/^\d+(?:\.\d+)*$/.test(data.id))throw fail('DIRECTORY_REBUILD_MODULE','Invalid numbered module');
    result.push({id:data.id,dir:path.relative(folder,dir).split(path.sep).join('/'),
      file,result:resultFile,objective:data.objective,doneWhen:data.doneWhen,
      depth:data.depth,children:Array.isArray(data.children)?data.children:[],
      dependsOn:Array.isArray(data.dependsOn)?data.dependsOn:[],
      requirementIds:Array.isArray(data.requirementIds)?data.requirementIds:[],
      hasResult:await exists(resultFile)});
   }
  }
 }
 await walk(folder);
 return result.sort(compare);
}
async function indexPages(folder){
 let rows=[];try{await assertSafeShadowdancerPath(folder);rows=await readdir(folder,{withFileTypes:true})}catch(e){if(e.code==='ENOENT')return [];throw e}
 const pages=[];
 for(const row of rows){
  if(!row.isDirectory()||!/^page-\d{4}$/.test(row.name))continue;
  const dir=path.join(folder,row.name),source=path.join(dir,'source.json'),result=path.join(dir,'result.json');
  if(!await exists(source)||!await exists(result))throw fail('DIRECTORY_REBUILD_PAGE','Incomplete source page '+row.name);
  const page=(await read(source)).page||Number(row.name.slice(5));
  pages.push({id:'page:'+page,index:Number(page),dir:row.name,source,result});
 }
 return pages.sort((a,b)=>a.index-b.index);
}
/** Pure, read-only dependency/impact preview for a specific saved run. */
export async function planShadowdancerRebuild({cwd,conversationId,sourceRunId,expectedEditId}){
 if(typeof cwd!=='string'||!path.isAbsolute(cwd))throw fail('DIRECTORY_REBUILD_CWD','Use an absolute saved workspace');
 validateId(conversationId);validateId(sourceRunId);
 const root=resolveDirectoryRoot(cwd,conversationId),sourceFolder=path.join(root,'runs',sourceRunId);
 if(!await exists(path.join(sourceFolder,'integration','final.json')))
  throw fail('DIRECTORY_REBUILD_NO_FINAL','Run has no completed integration receipt',409);
 const auditFile=path.join(root,'conversation','context','audit.json');
 const invalidationFile=path.join(root,'conversation','context','invalidation.json');
 let audits=[],invalidation={};
 try{audits=await read(auditFile)}catch(e){if(e.code!=='ENOENT')throw e}
 try{invalidation=await read(invalidationFile)}catch(e){if(e.code!=='ENOENT')throw e}
 if(!Array.isArray(audits))throw fail('DIRECTORY_REBUILD_AUDIT','Audit history is invalid');
 if(invalidation.staleRuns?.[sourceRunId]?.state!=='stale')
  throw fail('DIRECTORY_REBUILD_NOT_STALE','No pending audited context revision for this run',409);
 const edits=audits.filter(x=>x?.status==='committed'&&x.affectedRuns?.includes(sourceRunId));
 if(!edits.length)throw fail('DIRECTORY_REBUILD_AUDIT','No committed edits affect this run');
 if(expectedEditId&&edits.at(-1).id!==expectedEditId)
  throw fail('DIRECTORY_REBUILD_CONFLICT','A newer Context edit was saved; refresh before rebuilding',409);
 const editsByFile=new Map();
 for(const edit of edits)editsByFile.set(edit.file,edit);
 for(const [file,edit] of editsByFile){
  if(typeof file!=='string'||file.length>320||path.isAbsolute(file)||/[:\\\x00-\x1f]/.test(file)||
     file.split('/').some(x=>!x||x==='..'||x==='.')||
     !(file==='conversation/context/summary.json'||
       new RegExp('^runs/'+sourceRunId+'/(?:sources/page-\\d{4}/(?:source|result)\\.json|modules/(?:\\d+(?:\\.\\d+)*/)+(?:module|result)\\.json)$').test(file)))
   throw fail('DIRECTORY_REBUILD_EDIT_SCOPE','Unsafe edited file path');
  const full=path.join(root,...file.split('/'));
  if(!await exists(full)||hash(await safeBytes(full))!==edit.afterHash)
   throw fail('DIRECTORY_REBUILD_EDIT_CONFLICT','Edited file no longer matches audit: '+file,409);
 }
 const modules=await indexModules(path.join(sourceFolder,'modules'));
 const pages=await indexPages(path.join(sourceFolder,'sources'));
 if(!modules.length&&!pages.length)throw fail('DIRECTORY_REBUILD_EMPTY','No rebuildable content in saved run',409);
 const leaves=modules.filter(x=>x.hasResult);
 const moduleEdits=[],resultOverrides=[],sourceEdits=[],pageOverrides=[];
 let globalChange=false;
 for(const [file] of editsByFile){
  if(file==='conversation/context/summary.json'){globalChange=true;continue}
  const prefix='runs/'+sourceRunId+'/';
  if(!file.startsWith(prefix))throw fail('DIRECTORY_REBUILD_EDIT_SCOPE','Edit belongs to another run');
  const parts=file.slice(prefix.length).split('/');
  if(parts[0]==='modules'&&parts.length>=3){
    const id=parts.at(-2);
    if(!modules.some(x=>x.id===id))throw fail('DIRECTORY_REBUILD_MODULE','Edited module not found: '+id);
    if(parts.at(-1)==='module.json')moduleEdits.push(id);
    else if(parts.at(-1)==='result.json')resultOverrides.push(id);
    else throw fail('DIRECTORY_REBUILD_EDIT_TYPE','Unsupported module edit');
  }else if(parts[0]==='sources'&&/^page-\d{4}$/.test(parts[1])){
    const index=Number(parts[1].slice(5));
    if(!pages.some(x=>x.index===index))throw fail('DIRECTORY_REBUILD_PAGE','Edited source page not found');
    if(parts.at(-1)==='source.json')sourceEdits.push(index);
    else if(parts.at(-1)==='result.json')pageOverrides.push(index);
    else throw fail('DIRECTORY_REBUILD_EDIT_TYPE','Unsupported page edit');
  }else throw fail('DIRECTORY_REBUILD_EDIT_TYPE','Unsupported Context edit: '+file);
 }
 const reextract=new Set(globalChange?pages.map(p=>p.index):sourceEdits);
 const rework=new Set(globalChange?leaves.map(x=>x.id):[]);
 const changedModules=[...new Set([...moduleEdits,...resultOverrides])];
 for(const id of moduleEdits)for(const leaf of leaves)
  if(leaf.id===id||leaf.id.startsWith(id+'.'))rework.add(leaf.id);
 // Legacy modules did not always declare dependencies; later chronological
 // siblings are conservatively rerun rather than treated as independent.
 for(const id of changedModules){
  const directDependents=leaves.filter(x=>x.dependsOn.includes(id));
  for(const leaf of directDependents)rework.add(leaf.id);
  if(!directDependents.length)for(const leaf of leaves)
   if(leaf.id.localeCompare(id,undefined,{numeric:true})>0&&!leaf.dependsOn.length)
     rework.add(leaf.id);
 }
 let changed=true;
 while(changed){changed=false;for(const leaf of leaves){
   if(rework.has(leaf.id))continue;
   if(leaf.dependsOn.some(id=>rework.has(id))){rework.add(leaf.id);changed=true}
 }}
 // An edited result is a deliberate user override; do not overwrite it,
 // unless an objective edit or another upstream change also invalidated it.
 for(const id of resultOverrides){
   const target=leaves.find(x=>x.id===id);
   const upstreamChanged=target&&changedModules.some(other=>other!==id&&(
     target.dependsOn.includes(other)||
     (!target.dependsOn.length&&target.id.localeCompare(other,undefined,{numeric:true})>0)
   ));
   const pendingDependency=target?.dependsOn.some(dep=>rework.has(dep));
   if(!moduleEdits.includes(id)&&!globalChange&&!upstreamChanged&&!pendingDependency)
     rework.delete(id);
 }
 const goalFile=path.join(sourceFolder,'request.json');
 let request=null;
 if(await exists(goalFile))request=(await read(goalFile)).request;
 if(!request){
  const rootModule=modules.find(x=>x.id==='1');
  if(rootModule)request=(await read(rootModule.file)).objective;
  else request=(await read(path.join(root,'conversation','context','summary.json'))).request;
 }
 if(moduleEdits.includes('1')){
  const node=modules.find(x=>x.id==='1');
  if(node)request=(await read(node.file)).objective;
 }
 if(typeof request!=='string'||!request.trim())
  throw fail('DIRECTORY_REBUILD_GOAL','Original request was not saved',409);
 return {version:1,mode:'targeted',cwd,conversationId,sourceRunId,root,sourceFolder,
  originalRequest:request,hasMaterial:pages.length>0,
  editIds:edits.map(x=>x.id),latestEditId:edits.at(-1).id,
  changedFiles:[...editsByFile.keys()].sort(),globalChange,
  rerunModules:leaves.filter(x=>rework.has(x.id)).map(x=>x.id),
  reusedModules:leaves.filter(x=>!rework.has(x.id)).map(x=>x.id),
  moduleEdits,resultOverrides,
  reextractPages:[...reextract].sort((a,b)=>a-b),
  reusedPages:pages.filter(x=>!reextract.has(x.index)).map(x=>x.index),
  pageOverrides,modules,pages,
  note:'Rebuild creates a new run. The source run and its historical results remain intact.'};
}
async function prepareRebuiltDirectory(engine,plan){
 engine.request=plan.originalRequest;
 if(plan.sourceRunId===engine.runId)throw fail('DIRECTORY_REBUILD_ID','Rebuild must have a new run ID');
 const match=plan.originalRequest.match(/^REPOSITORY_ROOT:\s*(.+)$/mi);
 let repository=match?.[1]?.trim();
 if(!repository){
  try{repository=(await read(path.join(plan.root,'conversation','context','requirements.json'))).repositoryRoot;}
  catch(e){if(e.code!=='ENOENT')throw e;}
 }
 if(repository){
  await assertSafeShadowdancerPath(repository);
  if(!path.isAbsolute(repository)||!(await stat(repository)).isDirectory())
   throw fail('DIRECTORY_REBUILD_REPO','Original repository root no longer exists',409);
  if(!engine.canWrite)throw fail('DIRECTORY_REPOSITORY_READ_ONLY','Repository rebuild is unavailable in a read-only conversation.');
  engine.repoRoot=path.resolve(repository);
  engine.repoPatchStore=new FilePatchStore({dataDir:engine.turnRoot});
  engine.repoToolHandler=(engine.createRepositoryHandler||createWorkspaceToolHandler)({
   cwd:engine.repoRoot,signal:engine.signal,
   patchStore:engine.repoPatchStore,runId:engine.runId,nodeId:'shadowdancer',
   onEvent:event=>engine.onProgress({phase:'workspace',module:'tools',
     event:event.type,action:event.action}),
  });
  if(!/^REPOSITORY_ROOT:\s*/mi.test(engine.request))
   engine.request+='\nREPOSITORY_ROOT: '+engine.repoRoot;
 }
 for(const directory of [engine.turnRoot,engine.context,engine.modules])await assertSafeShadowdancerPath(directory);
 await engine.open();
 await atomicJSON(path.join(engine.turnRoot,'request.json'),{
  version:1,request:engine.request,hasSource:plan.hasMaterial,
  sourceRunId:plan.sourceRunId,rebuildEditIds:plan.editIds,
  createdAt:new Date().toISOString(),
 });
 if(engine.repoRoot){
  engine.repoOriginalFiles=await engine.repositorySourceHashes();
  engine.initialTestSuite=await testSuiteSnapshot(engine.repoRoot);
  await atomicJSON(path.join(engine.turnRoot,'verification','initial-test-suite.json'),{
   version:1,at:new Date().toISOString(),...engine.initialTestSuite,
   note:'Pre-rebuild test baseline; changes during this rebuilt run are audited.',
  });
  engine.requirements=extractRequirements(engine.request);
  await atomicJSON(path.join(engine.turnRoot,'verification','requirements-ledger.json'),
    engine.requirements);
  await atomicJSON(path.join(engine.context,'requirements.json'),{
   version:1,fullTask:engine.request,repositoryRoot:engine.repoRoot,
   sourceRunId:plan.sourceRunId,
   note:'Full original requirements explicitly imported by rebuilt modules.',
  });
 }
 engine.stats.rebuildFrom=plan.sourceRunId;
 engine.stats.editRevisions=plan.editIds;
 engine.stats.reusedModules=plan.reusedModules.length;
 engine.stats.rerunModules=plan.rerunModules.length;
 engine.stats.reusedPages=plan.reusedPages.length;
 engine.stats.reextractedPages=plan.reextractPages.length;
 await engine.label('rebuild-request',{module:'conversation/context',
  sourceFiles:plan.changedFiles.map(x=>path.join(plan.root,...x.split('/'))),
  text:'Targeted rebuild of '+plan.sourceRunId+' after '+plan.editIds.join(', '),
  metadata:{sourceRunId:plan.sourceRunId,editIds:plan.editIds,
   rerunModules:plan.rerunModules,reextractPages:plan.reextractPages}});
 await engine.summary({rebuildSourceRunId:plan.sourceRunId,rebuildEditIds:plan.editIds,
  rebuildStatus:'running',
  requirementLedgerFile:engine.repoRoot?
    path.join(engine.turnRoot,'verification','requirements-ledger.json'):undefined});
}
async function rebuildModules(engine,plan){
 const rerun=new Set(plan.rerunModules);
 const moduleRefs=[];
 const rework=[];
 for(const node of plan.modules){
  const original=await read(node.file);
  const target=path.join(engine.modules,node.dir,'module.json');
  const next={...original,rebuildSourceRunId:plan.sourceRunId,
   rebuiltFrom:node.file,rebuiltAt:new Date().toISOString()};
  await atomicJSON(target,next);
  if(!node.hasResult)continue;
  const resultTarget=path.join(engine.modules,node.dir,'result.json');
  if(rerun.has(node.id)){
   rework.push({id:node.id,objective:next.objective,dir:'modules/'+node.dir,
    file:target,depth:next.depth,doneWhen:next.doneWhen,
    dependsOn:next.dependsOn||[],requirementIds:next.requirementIds||[]});
  }else{
   const previous=await read(node.result);
   await atomicJSON(resultTarget,{...previous,verified:false,
    status:plan.resultOverrides.includes(node.id)?
      'user_edited_pending_verification':'reused_pending_verification',
    rebuiltFrom:node.result,rebuildSourceRunId:plan.sourceRunId,
    reusedIn:engine.runId,
   });
   await engine.label('module-reused',{module:'modules/'+node.dir,
    sourceFiles:[resultTarget,node.result],
    text:plan.resultOverrides.includes(node.id)?
      'User edited module result loaded without regenerating it.':
      'Unchanged module result reused from saved disk file.',
    metadata:{id:node.id,edited:plan.resultOverrides.includes(node.id),
      sourceRunId:plan.sourceRunId}});
  }
  moduleRefs.push({id:node.id,ref:'module:'+node.id,
   path:resultTarget,kind:'module'});
 }
 engine.work=rework;
 // Place reusable references in the index so rerun modules can load their
 // exact declared prerequisite results.
 engine.allRefs=moduleRefs.filter(x=>!rerun.has(x.id))
   .map(({id,...rest})=>rest);
 if(rework.length){
  await engine.workLeaves();
  const seen=new Set(engine.allRefs.map(x=>x.ref));
  for(const candidate of moduleRefs){
   if(!seen.has(candidate.ref)||!await exists(candidate.path))
    throw fail('DIRECTORY_REBUILD_WORK_MISSING','Recomputed module result is absent: '+candidate.ref);
  }
 }
 return moduleRefs.map(({id,...rest})=>rest);
}
async function rebuildPages(engine,plan){
 const affected=new Set(plan.reextractPages);
 const result=[];
 for(const page of plan.pages){
  const targetDir=path.join(engine.turnRoot,'sources',page.dir);
  const targetSource=path.join(targetDir,'source.json');
  const targetResult=path.join(targetDir,'result.json');
  const original=await read(page.source);
  if(typeof original.content!=='string')throw fail('DIRECTORY_REBUILD_PAGE','Saved page content is invalid');
  await atomicJSON(targetSource,{...original,sourceSha256:hash(original.content),
   rebuiltFrom:page.source,rebuildSourceRunId:plan.sourceRunId});
  if(affected.has(page.index)){
   const extracted=await engine.infer('page-extract','sources/'+page.dir,{
    task:engine.request,sourceFiles:[targetSource],
    instructions:'Extract exact values and quoted items relevant to this request from this changed source page. Return JSON {"summary":"...","items":[{"value":"...","quote":"..."}],"uncertainty":"..."}. Do not assert unseen content.',
    source:await read(targetSource),
   });
   const obj=extracted.parsed||{};
   const items=(Array.isArray(obj.items)?obj.items:[])
    .filter(x=>x&&typeof x==='object'&&typeof x.value==='string')
    .map(x=>({value:String(x.value||''),quote:String(x.quote||'')}))
    .filter(x=>x.value&&original.content.toLowerCase().includes(x.value.toLowerCase()));
   await atomicJSON(targetResult,{version:1,ref:page.id,kind:'page',
    summary:String(obj.summary||extracted.output),
    items,anchoredItems:items.map(x=>x.value),
    sourceFile:targetSource,sourceSha256:hash(original.content),verified:false,
    reextractedFrom:page.result,rebuildSourceRunId:plan.sourceRunId});
  }else{
   const previous=await read(page.result);
   await atomicJSON(targetResult,{...previous,sourceFile:targetSource,
    sourceSha256:hash(original.content),verified:false,
    status:plan.pageOverrides.includes(page.index)?
      'user_edited_pending_integration':'reused_pending_integration',
    rebuiltFrom:page.result,rebuildSourceRunId:plan.sourceRunId});
   await engine.label('page-reused',{module:'sources/'+page.dir,
    sourceFiles:[targetResult,page.result],
    text:plan.pageOverrides.includes(page.index)?
      'Audited user-edited page result reused in new synthesis.':
      'Unchanged source page result reused, no extraction call.',
    metadata:{page:page.index}});
  }
  engine.stats.sourceRefs++;
  result.push({ref:page.id,path:targetResult,kind:'page'});
 }
 return result;
}
async function persistRebuildCompletion(engine,plan,result){
 // Resolve only the edited source run, never mutate the historical answer.
 // An intervening audit edit means the new run is already out of date.
 const auditFile=path.join(plan.root,'conversation','context','audit.json');
 const invalidationFile=path.join(plan.root,'conversation','context','invalidation.json');
 const all=await read(auditFile);
 const latest=all.filter(x=>x?.status==='committed'&&x.affectedRuns?.includes(plan.sourceRunId)).at(-1);
 const invalidation=await read(invalidationFile);
 if(latest?.id!==plan.latestEditId||
    invalidation.staleRuns?.[plan.sourceRunId]?.state!=='stale')
  throw fail('DIRECTORY_REBUILD_CONFLICT','A later Context edit was saved while rebuilding; original run remains stale',409);
 const historyFile=path.join(plan.root,'conversation','context','rebuilds.json');
 let history=[];try{history=await read(historyFile)}catch(e){if(e.code!=='ENOENT')throw e}
 if(!Array.isArray(history))throw fail('DIRECTORY_REBUILD_HISTORY','Saved rebuild history is invalid');
 const at=new Date().toISOString();
 const markHistorical=runId=>{
  invalidation.staleRuns[runId]={
   ...invalidation.staleRuns[runId],
   state:'rebuilt',rebuiltBy:engine.runId,rebuiltAt:at,
   historicalFinalIsStale:true,
   reason:'This original result is historical; a newer run integrates the edited context.',
  };
 };
 markHistorical(plan.sourceRunId);
 // Earlier versions applied a conversation-wide edit to every historical
 // result, even if those results were already superseded. Reconcile only
 // proven ancestors with the SAME pending global edit; unrelated stale
 // revisions stay untouched. This repairs the false pending state in history.
 const ancestors=new Set();
 let cursor=plan.sourceRunId;
 for(let depth=0;depth<100;depth++){
  const parent=[...history].reverse().find(x=>x?.newRunId===cursor)?.sourceRunId;
  if(!parent||ancestors.has(parent)||parent===plan.sourceRunId)break;
  ancestors.add(parent);cursor=parent;
 }
 for(const ancestor of ancestors){
  const old=invalidation.staleRuns?.[ancestor];
  if(old?.state==='stale'&&old?.editId===plan.latestEditId&&
     old?.kind==='conversation'&&old?.sourceFile==='conversation/context/summary.json')
   markHistorical(ancestor);
 }
 invalidation.updatedAt=at;
 await atomicJSON(invalidationFile,invalidation);
 history.push({version:1,sourceRunId:plan.sourceRunId,newRunId:engine.runId,
  editIds:plan.editIds,finalPath:result.finalPath,at,
  rerunModules:plan.rerunModules,reusedModules:plan.reusedModules,
  reextractPages:plan.reextractPages,reusedPages:plan.reusedPages,
  verificationStatus:engine.verification?.status||null,
  finalStatus:(await read(result.finalPath)).status,
 });
 await atomicJSON(historyFile,history);
 await engine.summary({rebuildSourceRunId:plan.sourceRunId,
  rebuildStatus:'completed',rebuildFinishedAt:at});
}
/** Execute one immutable, continuation-scoped targeted rebuild. */
export async function executeShadowdancerRebuild(engine,{sourceRunId,expectedEditId}={}){
 const plan=await planShadowdancerRebuild({cwd:engine.cwd,
  conversationId:engine.conversationId,sourceRunId,expectedEditId});
 const manifest=path.join(engine.turnRoot,'rebuild.json');
 let initialized=false;
 try{
  await prepareRebuiltDirectory(engine,plan);initialized=true;
  await atomicJSON(manifest,{...plan,modules:undefined,pages:undefined,
   status:'running',newRunId:engine.runId,startedAt:new Date().toISOString()});
  const pages=plan.pages.length?await rebuildPages(engine,plan):[];
  const modules=plan.modules.length?await rebuildModules(engine,plan):[];
  engine.allRefs=[...pages,...modules];
  // Fresh executable verification against the current source/test hashes.
  if(engine.repoRoot){
   const receipt=await engine.verifyAndRepairRepository();
   if(receipt?.status==='unavailable')await engine.reviewRepository();
  }
  const integrated=await engine.integrate();
  const result=await engine.finishRun(integrated);
  await persistRebuildCompletion(engine,plan,result);
  const header='Context rebuild from '+sourceRunId+
   ' (revisions '+plan.editIds.join(', ')+'). Reran '+plan.rerunModules.length+
   ' module(s), reused '+plan.reusedModules.length+' module(s); re-extracted '+
   plan.reextractPages.length+' page(s), reused '+plan.reusedPages.length+' page(s).\n\n';
  const answer=header+result.answer;
  const final=await read(result.finalPath);
  await atomicJSON(result.finalPath,{...final,answer,
   rebuild:{sourceRunId,newRunId:engine.runId,
    editIds:plan.editIds,rerunModules:plan.rerunModules,
    reusedModules:plan.reusedModules,reextractPages:plan.reextractPages,
    reusedPages:plan.reusedPages}});
  await atomicJSON(manifest,{...plan,modules:undefined,pages:undefined,
   status:'completed',newRunId:engine.runId,finalPath:result.finalPath,
   finishedAt:new Date().toISOString(),stats:result.stats});
  await engine.label('rebuild-completed',{module:'integration',
   sourceFiles:[manifest,result.finalPath],text:'Rebuild completed with current referenced findings.',
   metadata:{sourceRunId,editIds:plan.editIds}});
  await engine.summary({lastAnswer:answer,rebuildStatus:'completed',
   finalPath:result.finalPath});
  return {...result,answer,rebuild:{sourceRunId,...plan,
   modules:undefined,pages:undefined}};
 }catch(error){
  if(initialized){
   await atomicJSON(manifest,{...plan,modules:undefined,pages:undefined,
    status:'failed',newRunId:engine.runId,error:String(error?.message||error),
    code:error?.code||'DIRECTORY_REBUILD_FAILED',failedAt:new Date().toISOString()});
   await engine.summary({rebuildStatus:'failed',rebuildError:String(error?.message||error)});
  }
  throw error;
 }
}
