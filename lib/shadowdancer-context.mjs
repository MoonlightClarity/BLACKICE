import {resolveDirectoryRoot} from './directory-location.mjs';
/** Auditable, revisioned Shadowdancer context for the BLACKICE pilot.
 *
 * User edits, removals and explicit imports are scoped to one conversation.
 * Prior versions are retained as revision snapshots, outside the active context.
 * A changed source invalidates its derived answers; editing never verifies one.
 */
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile, stat, lstat, realpath, unlink } from 'node:fs/promises';

const queues = new Map();
const IDENT = /^[a-zA-Z0-9_-]{1,120}$/;
const RUN_FILE = /^runs\/[a-zA-Z0-9_-]{1,120}\/(.+)$/;

function bad(code, message, status = 400) {
  return Object.assign(new Error(message), {code,status});
}
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function normalizeRel(file) {
  if (typeof file !== 'string' || file.startsWith('/') ||
      file.includes('\\') || /[:\x00-\x1f]/.test(file) || file.includes('//') || file.split('/').some(x => !x || x === '..' || x === '.')) {
    throw bad('SHADOWDANCER_PATH', 'Choose a file inside the selected Shadowdancer context.');
  }
  return file;
}
function contextRoot(cwd, conversationId) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !IDENT.test(conversationId)) {
    throw bad('SHADOWDANCER_CONTEXT', 'The saved conversation or workspace was not found.');
  }
  return resolveDirectoryRoot(cwd,conversationId);
}
function category(file) {
  if (file.startsWith('conversation/context/revisions/') ||
      ['conversation/context/audit.json','conversation/context/invalidation.json','conversation/context/rebuilds.json','conversation/context/pending-change.json'].includes(file))
    return {kind:'audit',editableFields:[],replaceable:false,deletable:false,importable:false};
  const flags={replaceable:true,deletable:true,importable:true};
  if (/^conversation\/context\/imports\/[A-Za-z0-9_-]+\.json$/.test(file))return {...flags,kind:'import',editableFields:['content']};
  if (file === 'conversation/context/summary.json') return {kind:'conversation', editableFields:['userSummary','pinnedConstraints']};
  const run = RUN_FILE.exec(file);
  if (!run) return {...flags,kind:file==='conversation/context/turns.json'?'turn-index':'context',editableFields:[]};
  const target=run[1];
  if (/^sources\/page-\d{4}\/source\.json$/.test(target))return {kind:'source',editableFields:['content']};
  if (/^sources\/page-\d{4}\/result\.json$/.test(target))return {kind:'page-result',editableFields:['summary','items']};
  if (/^modules\/(?:\d+(?:\.\d+)*\/)+module\.json$/.test(target))return {kind:'module',editableFields:['objective','doneWhen']};
  if (/^modules\/(?:\d+(?:\.\d+)*\/)+result\.json$/.test(target))return {kind:'module-result',editableFields:['finding','candidate_answer','uncertainty']};
  return {...flags,kind:target.includes('turns/')?'turn':'derived', editableFields:[]};
}
function metadata(file) {
  const value=category(file);
  return {replaceable:true,deletable:true,importable:true,...value,
    editable:value.replaceable!==false||value.editableFields.length>0};
}
async function assertSafePath(p) {
  const absolute=path.resolve(p),root=path.parse(absolute).root;
  let current=root;
  for(const part of absolute.slice(root.length).split(path.sep).filter(Boolean)){
    current=path.join(current,part);
    let info;
    try{info=await lstat(current);}catch(error){if(error.code==='ENOENT')return;throw error;}
    if(info.isSymbolicLink())throw bad('SHADOWDANCER_PATH','Directory context cannot follow symbolic links or junctions.');
  }
  const resolved=await realpath(absolute);
  if(path.relative(absolute,resolved)!=='')throw bad('SHADOWDANCER_PATH','Directory context path resolves outside its saved location.');
}
async function optionalJSON(p,fallback) {
  try{return (await safeJSON(p)).value;}
  catch(error){if(error.code==='ENOENT')return fallback;throw error;}
}
async function safeJSON(p) {
  await assertSafePath(p);
  const info=await stat(p);
  if(!info.isFile())throw bad('SHADOWDANCER_INVALID_FILE','Selected context path is not a file.');
  const bytes=await readFile(p);
  const text=bytes.toString('utf8');
  try{return {value:JSON.parse(text),bytes,digest:sha(bytes)};}
  catch(error){if(error instanceof SyntaxError)throw bad('SHADOWDANCER_INVALID_FILE','Selected context file is not readable JSON.');throw error;}
}
async function atomicJSON(p,value) {
  await assertSafePath(p);
  await mkdir(path.dirname(p),{recursive:true});
  await assertSafePath(path.dirname(p));
  const tmp=p+'.tmp-'+randomUUID();
  await writeFile(tmp,JSON.stringify(value,null,2)+'\n','utf8');
  await rename(tmp,p);
}
async function contextFiles(root){
  await assertSafePath(root);
  const collected=[];
  async function traverse(dir){
    let list;try{await assertSafePath(dir);list=await readdir(dir,{withFileTypes:true})}catch(error){if(error.code==='ENOENT')return;throw error;}
    for(const item of list){
      const full=path.join(dir,item.name);
      if(item.isSymbolicLink())continue;
      if(item.isDirectory()){
        // Revision snapshots are available through history, not active context.
        if(path.relative(root,full).split(path.sep).join('/')!=='conversation/context/revisions')await traverse(full);
        continue;
      }
      if(item.isFile()&&item.name.endsWith('.json')&&!item.name.endsWith('.tmp')) {
        const relative=path.relative(root,full).split(path.sep).join('/');
        if(relative.startsWith('conversation/context/revisions/'))continue;
        const s=await stat(full);
        collected.push({file:relative,bytes:s.size,updatedAt:s.mtime.toISOString(),...metadata(relative)});
      }
    }
  }
  await traverse(root);collected.sort((a,b)=>a.file.localeCompare(b.file,undefined,{numeric:true}));
  return collected;
}
async function locked(key,task){
  const prior=queues.get(key)||Promise.resolve();
  let release;
  const next=new Promise(resolve=>{release=resolve;});
  const end=prior.then(()=>next,()=>next);
  queues.set(key,end);
  await prior.catch(()=>{});
  try{return await task();}
  finally{release();if(queues.get(key)===end)queues.delete(key);}
}
export async function listShadowdancerContext({cwd,conversationId}) {
  const root=contextRoot(cwd,conversationId);
  await locked(root,()=>recoverContextChange(root));
  const files=await contextFiles(root);
  if(!files.length)throw bad('SHADOWDANCER_CONTEXT_NOT_FOUND','This conversation has no saved Shadowdancer context.',404);
  const summaryPath=path.join(root,'conversation','context','summary.json');
  const summary=await optionalJSON(summaryPath,{}),
    invalidation=await optionalJSON(path.join(root,'conversation','context','invalidation.json'),{}),
    audit=await optionalJSON(path.join(root,'conversation','context','audit.json'),[]);
  if(!Array.isArray(audit))throw bad('SHADOWDANCER_AUDIT','The context audit history is invalid.');
  const managed=(await readManagedContextAtRoot(root,conversationId,'conversation/context/summary.json')).sources[0];
  return {conversationId,summary,files, invalidation,
    ...(managed?{managedSummary:managed.value,managedSummaryEditId:managed.editId||null,managedSummaryEditMode:managed.editMode||'fields'}:{}),
    revisionCount:Array.isArray(audit)?audit.length:0,
    audited:true,totalFiles:files.length};
}
export async function readShadowdancerFile({cwd,conversationId,file}) {
  const root=contextRoot(cwd,conversationId);
  await locked(root,()=>recoverContextChange(root));
  const rel=normalizeRel(file),full=path.join(root,...rel.split('/'));
  const {value,bytes,digest}=await safeJSON(full);
  const meta=metadata(rel);
  const managedContext=await readManagedContextAtRoot(root,conversationId,rel),managed=managedContext.sources[0];
  return {conversationId,file:rel,hash:digest,bytes:bytes.length,kind:meta.kind,
    editableFields:meta.editableFields,value,replaceable:meta.replaceable,
    editable:meta.editable,deletable:meta.deletable,importable:meta.importable,
    managedEditId:managed?.editId||managedContext.deletedFiles[0]?.editId||null,
    ...(managedContext.deletedFiles.length?{managedDeleted:true}:{}),
    ...(managed?{managedValue:managed.value,managedHash:managed.hash,editMode:managed.editMode||'fields'}:{}),
    ...(meta.kind==='import'?{importedFrom:value.source}:{} )};
}
export async function contextAuditHistory({cwd,conversationId,offset=0,limit=80}) {
  const root=contextRoot(cwd,conversationId);
  await locked(root,()=>recoverContextChange(root));
  const file=path.join(root,'conversation','context','audit.json');
  const events=await optionalJSON(file,[]);
  if(!Array.isArray(events))throw bad('SHADOWDANCER_AUDIT','The context audit history is invalid.');
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1)throw bad('SHADOWDANCER_QUERY','Use a nonnegative offset and positive page size.');
  const items=events.slice().reverse().slice(offset,offset+limit),nextOffset=offset+items.length<events.length?offset+items.length:null;
  return {conversationId,total:events.length,offset,items,nextOffset,hasMore:nextOffset!==null};
}
function checkChanges(meta,changes) {
  if(!changes||typeof changes!=='object'||Array.isArray(changes))throw bad('SHADOWDANCER_EDIT','Enter an object of editable fields.');
  const keys=Object.keys(changes);
  if(!keys.length||keys.some(k=>!meta.editableFields.includes(k)))throw bad('SHADOWDANCER_EDIT_FIELDS','Only fields listed as editable may be changed.');
  for(const [key,value] of Object.entries(changes)){
    if(['content','objective','doneWhen','summary','finding','candidate_answer','uncertainty','userSummary'].includes(key)){
      if(typeof value!=='string')throw bad('SHADOWDANCER_EDIT_FIELDS',key+' must be text.');
    } else if(key==='pinnedConstraints') {
      if(!Array.isArray(value)||value.some(s=>typeof s!=='string'))throw bad('SHADOWDANCER_EDIT_FIELDS','Pinned constraints must be an array of strings.');
    } else if(key==='items') {
      if(!Array.isArray(value)||value.some(x=>!x||typeof x!=='object'||Array.isArray(x)||typeof x.value!=='string'||typeof x.quote!=='string'))throw bad('SHADOWDANCER_EDIT_FIELDS','Page items must contain value and quote strings.');
    }
  }
}
async function finalPaths(root,conversationId,runId){
  const runsPath=path.join(root,'runs');
  let names=[];try{await assertSafePath(runsPath);names=await readdir(runsPath,{withFileTypes:true})}catch(error){if(error.code!=='ENOENT')throw error;}
  return names.filter(n=>n.isDirectory()&&IDENT.test(n.name)&&(!runId||n.name===runId)).map(n=>({runId:n.name,file:path.join(runsPath,n.name,'integration','final.json')}));
}
function checkRevision(expectedHash) {
  if(typeof expectedHash!=='string'||!/^[a-f0-9]{64}$/i.test(expectedHash))throw bad('SHADOWDANCER_EXPECTED_HASH','Open the latest file before changing it.');
}
function checkReason(reason) {
  if(typeof reason!=='string'||!reason.trim())throw bad('SHADOWDANCER_EDIT_REASON','Provide a reason for this context revision.');
}
function checkedJSON(value) {
  let text;
  try{text=JSON.stringify(value);}catch(error){if(error instanceof TypeError)throw bad('SHADOWDANCER_EDIT','Enter valid JSON for this context.');throw error;}
  if(text===undefined)throw bad('SHADOWDANCER_EDIT','Enter a JSON-compatible context value.');
  return JSON.parse(text);
}
function effectiveManagedValue(canonical,managed) {
  if(!managed)return canonical;
  if(managed.editMode==='replace')return managed.value;
  return canonical&&typeof canonical==='object'&&!Array.isArray(canonical)&&managed.value&&typeof managed.value==='object'&&!Array.isArray(managed.value)?
    {...canonical,...managed.value}:managed.value;
}
async function checkManagedRevision(root,conversationId,file,expectedManagedEditId) {
  const context=await readManagedContextAtRoot(root,conversationId,file);
  const managed=context.sources[0],current=managed?.editId||context.deletedFiles[0]?.editId||null;
  if(expectedManagedEditId!==undefined&&expectedManagedEditId!==current)
    throw bad('SHADOWDANCER_REVISION_CONFLICT','The user-managed context changed after it was opened. Reload before changing it.',409);
  return managed;
}
async function checkCurrent(full,expectedHash) {
  checkRevision(expectedHash);
  let prior;
  try{prior=await safeJSON(full);}catch(error){if(error.code==='ENOENT')throw bad('SHADOWDANCER_REVISION_CONFLICT','This context was removed after it was opened. Reload before changing it.',409);throw error;}
  if(prior.digest.toLowerCase()!==expectedHash.toLowerCase())throw bad('SHADOWDANCER_REVISION_CONFLICT','This file changed after it was opened. Reload before changing it.',409);
  return prior;
}
async function updateTurnIndex(root,rel,updated) {
  const turn=/^runs\/([A-Za-z0-9_-]+)\/turns\/([A-Za-z0-9_-]+)\.json$/.exec(rel);
  if(!turn)return;
  const file=path.join(root,'conversation','context','turns.json');
  const turns=await optionalJSON(file,[]);
  if(!Array.isArray(turns))throw bad('SHADOWDANCER_AUDIT','The saved turn index is invalid.');
  const next=turns.flatMap(row=>row.id===turn[2]&&row.runId===turn[1]?(updated===undefined?[]:[updated]):[row]);
  await atomicJSON(file,next);
  const summaryFile=path.join(root,'conversation','context','summary.json');
  const summary=await optionalJSON(summaryFile,null);
  if(summary&&typeof summary==='object'&&!Array.isArray(summary))await atomicJSON(summaryFile,{...summary,totalTurns:next.length});
}
async function recoverContextChange(root) {
  const context=path.join(root,'conversation','context'),pendingFile=path.join(context,'pending-change.json');
  const pending=await optionalJSON(pendingFile,null);
  if(!pending)return;
  const row=pending.row;
  if(!row||!/^edit-\d{5,}$/.test(row.id||'')||!['edit','delete','import'].includes(row.action)||row.status!=='committed')
    throw bad('SHADOWDANCER_AUDIT','A saved context change needs repair before new changes can be made.');
  const rel=normalizeRel(row.file),meta=metadata(rel);
  if(!meta.replaceable)throw bad('SHADOWDANCER_AUDIT','The pending context change targets revision bookkeeping.');
  const after=await safeJSON(path.join(context,'revisions',row.id,'after.json'));
  if(row.action!=='delete'&&after.digest!==row.afterHash)throw bad('SHADOWDANCER_AUDIT','The pending context revision does not match its saved content.');
  const file=path.join(root,...rel.split('/'));
  let current;try{current=await safeJSON(file);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(current&&current.digest!==row.beforeHash&&current.digest!==row.afterHash)
    throw bad('SHADOWDANCER_REVISION_CONFLICT','Context changed while an earlier revision was being saved; no newer content was overwritten.',409);
  const invalidationPath=path.join(context,'invalidation.json'),invalidation=await optionalJSON(invalidationPath,{});
  await atomicJSON(invalidationPath,{...invalidation,...pending.invalidation,
    staleRuns:{...(invalidation.staleRuns||{}),...(pending.invalidation?.staleRuns||{})}});
  if(row.action==='delete'){if(current)await unlink(file);}
  else if(current?.digest!==row.afterHash)await atomicJSON(file,after.value);
  await updateTurnIndex(root,rel,row.action==='delete'?undefined:after.value);
  const auditFile=path.join(context,'audit.json'),audit=await optionalJSON(auditFile,[]);
  if(!Array.isArray(audit))throw bad('SHADOWDANCER_AUDIT','The context audit history is invalid.');
  const existing=audit.find(item=>item.id===row.id);
  if(existing&&(existing.file!==row.file||existing.afterHash!==row.afterHash))throw bad('SHADOWDANCER_AUDIT','The pending context revision conflicts with its audit record.');
  if(!existing){audit.push(row);await atomicJSON(auditFile,audit);}
  await unlink(pendingFile);
}
async function commitContextChange({root,conversationId,rel,meta,prior,updated,reason,actor,action,source,changedFields}) {
  const auditPath=path.join(root,'conversation','context','audit.json');
  const audit=await optionalJSON(auditPath,[]);
  if(!Array.isArray(audit))throw bad('SHADOWDANCER_AUDIT','Audit history is invalid; no context was changed.');
  const invalidationPath=path.join(root,'conversation','context','invalidation.json');
  const invalidation=await optionalJSON(invalidationPath,{});
  if(!invalidation||typeof invalidation!=='object'||Array.isArray(invalidation))throw bad('SHADOWDANCER_AUDIT','Context invalidation data is invalid; no context was changed.');
  const turn=/^runs\/([A-Za-z0-9_-]+)\/turns\/([A-Za-z0-9_-]+)\.json$/.exec(rel);
  if(turn){
    const turns=await optionalJSON(path.join(root,'conversation','context','turns.json'),[]);
    if(!Array.isArray(turns))throw bad('SHADOWDANCER_AUDIT','The saved turn index is invalid; no context was changed.');
  }
  const summary=meta.kind==='conversation'?prior?.value:await optionalJSON(path.join(root,'conversation','context','summary.json'),{});
  const affectedRun=RUN_FILE.exec(rel)?.[0].split('/')[1]||
    (IDENT.test(summary?.currentRun||'')?summary.currentRun:null);
  const candidates=await finalPaths(root,conversationId,affectedRun),affected=[];
  for(const candidate of candidates){try{await stat(candidate.file);affected.push(candidate.runId);}catch(error){if(error.code!=='ENOENT')throw error;}}
  const editId='edit-'+String(audit.length+1).padStart(5,'0');
  const revDir=path.join(root,'conversation','context','revisions',editId);
  await assertSafePath(revDir);
  try{await lstat(revDir);throw bad('SHADOWDANCER_AUDIT','Revision already exists; no context was changed.');}catch(error){if(error.code!=='ENOENT')throw error;}
  const newHash=updated===undefined?null:sha(Buffer.from(JSON.stringify(updated,null,2)+'\n'));
  const row={id:editId,at:new Date().toISOString(),actor:String(actor||''),reason:reason.trim(),
    action,file:rel,kind:meta.kind,beforeHash:prior?.digest||null,afterHash:newHash,
    changedFields:changedFields||(action==='delete'?[]:['$value']),
    editMode:action==='edit'&&changedFields?.includes('$value')?'replace':'fields',
    affectedRuns:affected,status:'committed',...(source?{source}:{})};
  await atomicJSON(path.join(revDir,'before.json'),prior?.value??null);
  await atomicJSON(path.join(revDir,'after.json'),updated??null);
  const staleRuns={...(invalidation.staleRuns||{})};
  for(const runId of affected)staleRuns[runId]={state:'stale',editId,sourceFile:rel,kind:meta.kind,at:row.at,
    reason:'Context changed after synthesis; regenerate before treating the final as current.'};
  // The write-ahead marker makes a lost response/interruption recoverable. A
  // following read or edit completes this exact revision before exposing it.
  await atomicJSON(path.join(root,'conversation','context','pending-change.json'),{
    version:1,row,invalidation:{version:1,staleRuns,latestEdit:editId,updatedAt:row.at}});
  await recoverContextChange(root);
  return {updated:action!=='delete',deleted:action==='delete',imported:action==='import',
    file:rel,hash:newHash,editId,changedFields:row.changedFields,invalidatedRuns:affected,
    status:affected.length?'stale':action==='delete'?'deleted':action==='import'?'imported':'edited'};
}
export async function editShadowdancerContext({
  cwd,conversationId,file,expectedHash,expectedManagedEditId,changes,value,reason,actor='local-user',isActive=()=>false
}) {
  const root=contextRoot(cwd,conversationId),rel=normalizeRel(file),meta=metadata(rel);
  const replace=value!==undefined;
  if(!meta.replaceable)throw bad('SHADOWDANCER_READ_ONLY','This is revision bookkeeping. Select the context you want to correct.');
  if(!replace&&!meta.editableFields.length)throw bad('SHADOWDANCER_EDIT_FIELDS','Use a complete JSON replacement value to correct this generated context.');
  if(replace&&changes!==undefined)throw bad('SHADOWDANCER_EDIT','Use either a replacement value or field changes.');
  checkRevision(expectedHash);checkReason(reason);
  if(!replace){
    if(meta.kind==='import'){
      if(!changes||typeof changes!=='object'||Array.isArray(changes)||Object.keys(changes).length!==1||!Object.hasOwn(changes,'content'))throw bad('SHADOWDANCER_EDIT_FIELDS','Change the imported content; its source provenance is retained.');
      checkedJSON(changes.content);
    }else checkChanges(meta,changes);
  }
  return locked(root,async()=>{
    await recoverContextChange(root);
    if(isActive())throw bad('SHADOWDANCER_RUN_ACTIVE','Stop or finish the directory run before changing its context.',409);
    const prior=await checkCurrent(path.join(root,...rel.split('/')),expectedHash);
    const managed=await checkManagedRevision(root,conversationId,rel,expectedManagedEditId),effective=effectiveManagedValue(prior.value,managed);
    if(!replace&&(!effective||typeof effective!=='object'||Array.isArray(effective)))throw bad('SHADOWDANCER_EDIT','Use full JSON replacement for this context value.');
    let updated=replace?checkedJSON(value):{...effective,...changes};
    if(meta.kind==='conversation'){
      if(!updated||typeof updated!=='object'||Array.isArray(updated))throw bad('SHADOWDANCER_EDIT','Conversation context must be a JSON object.');
      for(const field of ['conversationId','currentRun','version'])if(Object.hasOwn(prior.value,field))updated[field]=prior.value[field];
    }
    if(meta.kind==='import'){
      if(!updated||typeof updated!=='object'||Array.isArray(updated)||!Object.hasOwn(updated,'content'))throw bad('SHADOWDANCER_EDIT','An imported context record must contain content.');
      for(const field of ['id','version','source','importedAt'])updated[field]=prior.value[field];
    }
    const turn=/^runs\/([A-Za-z0-9_-]+)\/turns\/([A-Za-z0-9_-]+)\.json$/.exec(rel);
    if(turn){
      if(!updated||typeof updated!=='object'||Array.isArray(updated))throw bad('SHADOWDANCER_EDIT','A saved turn must be a JSON object.');
      updated.id=turn[2];updated.runId=turn[1];
    }
    if(meta.kind==='source'&&updated&&typeof updated.content==='string')updated.sourceSha256=sha(updated.content);
    if(meta.kind==='page-result'&&!replace){
      const source=(await safeJSON(path.join(root,...rel.replace(/result\.json$/,'source.json').split('/')))).value;
      const support=String(source.content||'').toLowerCase();
      for(const row of updated.items||[])if(!support.includes(row.value.toLowerCase()))throw bad('SHADOWDANCER_SOURCE_SUPPORT','A claimed value is absent from the saved source page. Correct the source first.');
      updated.anchoredItems=(updated.items||[]).map(row=>row.value);
    }
    if(updated&&typeof updated==='object'&&!Array.isArray(updated)&&['module-result','page-result','derived','import'].includes(meta.kind))updated.verified=false;
    checkedJSON(updated);
    if(JSON.stringify(effective)===JSON.stringify(updated))return {unchanged:true,hash:prior.digest,file:rel,managedEditId:managed?.editId||null};
    const result=await commitContextChange({root,conversationId,rel,meta,prior,updated,reason,actor,action:'edit',changedFields:replace?['$value']:Object.keys(changes)});
    return {...result,changedFields:replace?['$value']:Object.keys(changes)};
  });
}
export async function deleteShadowdancerContext({cwd,conversationId,file,expectedHash,expectedManagedEditId,reason,actor='local-user',isActive=()=>false}) {
  const root=contextRoot(cwd,conversationId),rel=normalizeRel(file),meta=metadata(rel);
  if(!meta.deletable)throw bad('SHADOWDANCER_READ_ONLY','This is the context revision record. Select the context you want to remove.');
  checkRevision(expectedHash);checkReason(reason);
  return locked(root,async()=>{
    await recoverContextChange(root);
    if(isActive())throw bad('SHADOWDANCER_RUN_ACTIVE','Stop or finish the directory run before changing its context.',409);
    const prior=await checkCurrent(path.join(root,...rel.split('/')),expectedHash);
    await checkManagedRevision(root,conversationId,rel,expectedManagedEditId);
    return commitContextChange({root,conversationId,rel,meta,prior,updated:undefined,reason,actor,action:'delete'});
  });
}
export async function importShadowdancerContext({cwd,conversationId,source,expectedSourceHash,expectedSourceManagedEditId,reason,actor='local-user',isActive=()=>false}) {
  const root=contextRoot(cwd,conversationId);
  if(!source||typeof source!=='object')throw bad('SHADOWDANCER_IMPORT_SOURCE','Select a source conversation and file.');
  const sourceRoot=contextRoot(source.cwd,source.conversationId),sourceFile=normalizeRel(source.file);
  if(path.resolve(sourceRoot)===path.resolve(root))throw bad('SHADOWDANCER_IMPORT_SAME_CONVERSATION','This context already belongs to the selected conversation.');
  if(!metadata(sourceFile).importable)throw bad('SHADOWDANCER_IMPORT_SOURCE','Select source context rather than its revision bookkeeping.');
  checkRevision(expectedSourceHash);checkReason(reason);
  const {original,managed,content}=await locked(sourceRoot,async()=>{
    await recoverContextChange(sourceRoot);
    const original=await checkCurrent(path.join(sourceRoot,...sourceFile.split('/')),expectedSourceHash);
    const managed=await checkManagedRevision(sourceRoot,source.conversationId,sourceFile,expectedSourceManagedEditId);
    return {original,managed,content:effectiveManagedValue(original.value,managed)};
  });
  const effectiveHash=managed?.editId?sha(JSON.stringify(content,null,2)+'\n'):null;
  const provenance={conversationId:source.conversationId,runId:source.runId||null,file:sourceFile,hash:effectiveHash||original.digest,
    ...(effectiveHash?{canonicalHash:original.digest,managedEditId:managed.editId,managedHash:managed.hash}:{} )};
  const id='import-'+sha(JSON.stringify(provenance)).slice(0,24),rel='conversation/context/imports/'+id+'.json';
  return locked(root,async()=>{
    await recoverContextChange(root);
    if(isActive())throw bad('SHADOWDANCER_RUN_ACTIVE','Stop or finish the directory run before changing its context.',409);
    const existing=await optionalJSON(path.join(root,...rel.split('/')),null);
    if(existing){const current=await safeJSON(path.join(root,...rel.split('/')));return {unchanged:true,alreadyImported:true,file:rel,hash:current.digest,importedFrom:provenance};}
    const updated={version:1,id,source:provenance,importedAt:new Date().toISOString(),content,verified:false};
    checkedJSON(updated);
    const result=await commitContextChange({root,conversationId,rel,meta:metadata(rel),prior:null,updated,reason,actor,action:'import',source:provenance});
    return {...result,importedFrom:provenance};
  });
}

/** Only current-conversation user revisions and explicit copied imports enter
 * later execution. Before snapshots and unrelated conversations are never read.
 * Removed records stay absent even when an old aggregate mentions them. */
async function readManagedContextAtRoot(root,conversationId,onlyFile) {
  const context=path.join(root,'conversation','context');
  const audit=await optionalJSON(path.join(context,'audit.json'),[]);
  if(!Array.isArray(audit))throw bad('SHADOWDANCER_AUDIT','The context audit history is invalid.');
  const invalidation=await optionalJSON(path.join(context,'invalidation.json'),{});
  const histories=new Map();
  for(const row of audit)if(row?.status==='committed'&&typeof row.file==='string'){
    const file=normalizeRel(row.file),rows=histories.get(file)||[];rows.push(row);histories.set(file,rows);
  }
  const sources=[],deletedFiles=[];
  for(const [file,rows] of histories){
    if(onlyFile&&file!==onlyFile)continue;
    const row=rows.at(-1);
    const meta=metadata(file);
    if(!meta.replaceable)continue;
    if(row.action==='delete'){deletedFiles.push({file,editId:row.id,actor:row.actor});continue;}
    // Runtime summary/index refreshes must not overwrite an explicit correction.
    // The committed revision is the overlay; canonical files remain inspectable.
    let value,started=false,revision,editMode='fields';
    const lastReset=rows.findLastIndex(change=>change.action==='delete'||change.action==='import'||change.editMode==='replace'||change.changedFields?.includes('$value'));
    for(const change of rows.slice(Math.max(0,lastReset))){
      if(change.action==='delete'){value=undefined;started=false;editMode='fields';continue;}
      revision=await safeJSON(path.join(context,'revisions',change.id,'after.json'));
      if(change.afterHash&&revision.digest!==change.afterHash)throw bad('SHADOWDANCER_AUDIT','A managed context revision does not match its saved content.');
      const complete=change.action==='import'||change.editMode==='replace'||change.changedFields?.includes('$value');
      if(complete){value=revision.value;started=true;editMode='replace';continue;}
      const fields=change.changedFields?.length?change.changedFields:meta.editableFields;
      if(!started){
        value=meta.kind==='conversation'?Object.fromEntries(['userSummary','pinnedConstraints'].filter(field=>Object.hasOwn(revision.value||{},field)).map(field=>[field,revision.value[field]])):revision.value;
        started=true;
      }else if(value&&typeof value==='object'&&!Array.isArray(value)){
        value={...value,...Object.fromEntries(fields.filter(field=>Object.hasOwn(revision.value||{},field)).map(field=>[field,revision.value[field]]))};
      }
    }
    if(meta.kind==='source'&&typeof value?.content==='string')value={...value,sourceSha256:sha(value.content)};
    if(meta.kind==='page-result'&&Array.isArray(value?.items))value={...value,anchoredItems:value.items.map(item=>item.value),verified:false};
    sources.push({file,hash:sha(JSON.stringify(value,null,2)+'\n'),value,kind:meta.kind,editId:row.id,actor:row.actor,
      action:row.action||'edit',editMode,changedFields:row.changedFields||[],
      ...(meta.kind==='import'?{importedFrom:value.source}:{})});
  }
  const summary=!onlyFile||onlyFile==='conversation/context/summary.json'?await optionalJSON(path.join(context,'summary.json'),null):null;
  if((!onlyFile||onlyFile==='conversation/context/summary.json')&&!histories.has('conversation/context/summary.json')&&summary&&(summary.userSummary||summary.pinnedConstraints?.length)){
    const current=await safeJSON(path.join(context,'summary.json'));
    sources.push({file:'conversation/context/summary.json',hash:current.digest,kind:'conversation',actor:'local-user',action:'edit',
      value:{userSummary:typeof summary.userSummary==='string'?summary.userSummary:'',pinnedConstraints:Array.isArray(summary.pinnedConstraints)?summary.pinnedConstraints:[]}});
  }
  return {conversationId,latestEditId:audit.at(-1)?.id||null,hasChanges:!!(sources.length||deletedFiles.length),sources,deletedFiles,
    invalidatedRunIds:Object.entries(invalidation?.staleRuns||{}).filter(([,row])=>row?.state==='stale').map(([id])=>id)};
}

export async function readManagedDirectoryContext({cwd,conversationId}) {
  const root=contextRoot(cwd,conversationId);
  return locked(root,async()=>{await recoverContextChange(root);return readManagedContextAtRoot(root,conversationId);});
}

export {assertSafePath as assertSafeShadowdancerPath};
