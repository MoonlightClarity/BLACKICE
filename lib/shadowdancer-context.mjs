/** Auditable, revisioned Shadowdancer context for the BLACKICE pilot.
 *
 * Generated outputs and turn logs remain historical evidence. User edits are
 * constrained to selected context fields and saved as revision snapshots. Every
 * edit invalidates derived final answers; an old final is never silently
 * relabeled as verified or rewritten.
 */
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile, stat, lstat, realpath } from 'node:fs/promises';

const MAX_ENTRY_BYTES = 300_000;
const MAX_FILES = 750;
const MAX_EDIT_BYTES = 100_000;
const queues = new Map();
const IDENT = /^[a-zA-Z0-9_-]{1,120}$/;
const RUN_FILE = /^runs\/[a-zA-Z0-9_-]{1,120}\/(.+)$/;

function bad(code, message, status = 400) {
  return Object.assign(new Error(message), {code,status});
}
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function normalizeRel(file) {
  if (typeof file !== 'string' || file.length > 320 || file.startsWith('/') ||
      file.includes('\\') || /[:\x00-\x1f]/.test(file) || file.includes('//') || file.split('/').some(x => !x || x === '..' || x === '.')) {
    throw bad('SHADOWDANCER_PATH', 'Choose a file inside the selected Shadowdancer context.');
  }
  return file;
}
function contextRoot(cwd, conversationId) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !IDENT.test(conversationId)) {
    throw bad('SHADOWDANCER_CONTEXT', 'The saved conversation or workspace was not found.');
  }
  return path.join(cwd, '.shadowdancer', conversationId);
}
function category(file) {
  if (file === 'conversation/context/summary.json') return {kind:'conversation', editableFields:['userSummary','pinnedConstraints']};
  const run = RUN_FILE.exec(file);
  if (!run) return {kind:'audit',editableFields:[]};
  const target=run[1];
  if (/^sources\/page-\d{4}\/source\.json$/.test(target))return {kind:'source',editableFields:['content']};
  if (/^sources\/page-\d{4}\/result\.json$/.test(target))return {kind:'page-result',editableFields:['summary','items']};
  if (/^modules\/(?:\d+(?:\.\d+)*\/)+module\.json$/.test(target))return {kind:'module',editableFields:['objective','doneWhen']};
  if (/^modules\/(?:\d+(?:\.\d+)*\/)+result\.json$/.test(target))return {kind:'module-result',editableFields:['finding','candidate_answer','uncertainty']};
  return {kind:target.includes('turns/')?'turn':'derived', editableFields:[]};
}
function limit(str, n) {return String(str||'').slice(0,n);}
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
  if(!info.isFile()||info.size>MAX_ENTRY_BYTES)throw bad('SHADOWDANCER_FILE_SIZE','Selected context file exceeds the review limit.');
  const bytes=await readFile(p);
  if(bytes.length>MAX_ENTRY_BYTES)throw bad('SHADOWDANCER_FILE_SIZE','Selected context file exceeds the review limit.');
  try{return {value:JSON.parse(bytes.toString('utf8')),bytes,digest:sha(bytes)};}
  catch{throw bad('SHADOWDANCER_INVALID_FILE','Selected context file is not readable JSON.');}
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
  async function traverse(dir,level=0){
    if(level>14||collected.length>=MAX_FILES)return;
    let list;try{await assertSafePath(dir);list=await readdir(dir,{withFileTypes:true})}catch(error){if(error.code==='ENOENT')return;throw error;}
    for(const item of list){
      if(collected.length>=MAX_FILES)return;
      const full=path.join(dir,item.name);
      if(item.isSymbolicLink())continue;
      if(item.isDirectory()){await traverse(full,level+1);continue;}
      if(item.isFile()&&item.name.endsWith('.json')&&!item.name.endsWith('.tmp')) {
        const relative=path.relative(root,full).split(path.sep).join('/');
        if(relative.startsWith('conversation/context/revisions/'))continue;
        const s=await stat(full);
        collected.push({file:relative,bytes:s.size,updatedAt:s.mtime.toISOString(),...category(relative)});
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
  const files=await contextFiles(root);
  if(!files.length)throw bad('SHADOWDANCER_CONTEXT_NOT_FOUND','This conversation has no saved Shadowdancer context.',404);
  const summaryPath=path.join(root,'conversation','context','summary.json');
  const summary=await optionalJSON(summaryPath,{}),
    invalidation=await optionalJSON(path.join(root,'conversation','context','invalidation.json'),{}),
    audit=await optionalJSON(path.join(root,'conversation','context','audit.json'),[]);
  if(!Array.isArray(audit))throw bad('SHADOWDANCER_AUDIT','The context audit history is invalid.');
  return {conversationId,summary,files, invalidation,
    revisionCount:Array.isArray(audit)?audit.length:0,
    audited:true, visibleLimit:MAX_FILES};
}
export async function readShadowdancerFile({cwd,conversationId,file}) {
  const root=contextRoot(cwd,conversationId);
  const rel=normalizeRel(file),full=path.join(root,...rel.split('/'));
  const {value,bytes,digest}=await safeJSON(full);
  const meta=category(rel);
  return {conversationId,file:rel,hash:digest,bytes:bytes.length,kind:meta.kind,
    editableFields:meta.editableFields,value,
    editable:meta.editableFields.length>0};
}
export async function contextAuditHistory({cwd,conversationId,limit=80}) {
  const root=contextRoot(cwd,conversationId);
  const file=path.join(root,'conversation','context','audit.json');
  const events=await optionalJSON(file,[]);
  if(!Array.isArray(events))throw bad('SHADOWDANCER_AUDIT','The context audit history is invalid.');
  return {conversationId,total:events.length,items:events.slice(-Math.min(Math.max(limit,1),200)).reverse()};
}
function checkChanges(meta,changes) {
  if(!changes||typeof changes!=='object'||Array.isArray(changes))throw bad('SHADOWDANCER_EDIT','Enter an object of editable fields.');
  const keys=Object.keys(changes);
  if(!keys.length||keys.some(k=>!meta.editableFields.includes(k)))throw bad('SHADOWDANCER_EDIT_FIELDS','Only fields listed as editable may be changed.');
  for(const [key,value] of Object.entries(changes)){
    if(['content','objective','doneWhen','summary','finding','candidate_answer','uncertainty','userSummary'].includes(key)){
      if(typeof value!=='string'||value.length>MAX_EDIT_BYTES)throw bad('SHADOWDANCER_EDIT_FIELDS',key+' must be bounded text.');
    } else if(key==='pinnedConstraints') {
      if(!Array.isArray(value)||value.length>40||value.some(s=>typeof s!=='string'||s.length>700))throw bad('SHADOWDANCER_EDIT_FIELDS','Pinned constraints must be bounded strings.');
    } else if(key==='items') {
      if(!Array.isArray(value)||value.length>100||value.some(x=>!x||typeof x!=='object'||Array.isArray(x)||typeof x.value!=='string'||x.value.length>180||typeof x.quote!=='string'||x.quote.length>230))throw bad('SHADOWDANCER_EDIT_FIELDS','Page items must contain bounded value and quote strings.');
    }
  }
}
async function finalPaths(root,conversationId,runId){
  const runsPath=path.join(root,'runs');
  let names=[];try{await assertSafePath(runsPath);names=await readdir(runsPath,{withFileTypes:true})}catch(error){if(error.code!=='ENOENT')throw error;}
  return names.filter(n=>n.isDirectory()&&IDENT.test(n.name)&&(!runId||n.name===runId)).map(n=>({runId:n.name,file:path.join(runsPath,n.name,'integration','final.json')}));
}
export async function editShadowdancerContext({
  cwd,conversationId,file,expectedHash,changes,reason,actor='local-user',isActive=()=>false
}) {
  const root=contextRoot(cwd,conversationId);
  const rel=normalizeRel(file),meta=category(rel);
  if(!meta.editableFields.length)throw bad('SHADOWDANCER_READ_ONLY','This is historical evidence or derived output. Edit a source/result/summary instead.');
  if(typeof expectedHash!=='string'||!/^[a-f0-9]{64}$/i.test(expectedHash))throw bad('SHADOWDANCER_EXPECTED_HASH','Open the latest file before editing.');
  if(typeof reason!=='string'||!reason.trim()||reason.length>500)throw bad('SHADOWDANCER_EDIT_REASON','Provide a short reason for this context revision.');
  checkChanges(meta,changes);
  const full=path.join(root,...rel.split('/'));
  return locked(root, async ()=>{
    if(isActive())throw bad('SHADOWDANCER_RUN_ACTIVE','Stop or finish the directory run before changing its context.',409);
    const prior=await safeJSON(full);
    if(prior.digest.toLowerCase()!==expectedHash.toLowerCase())throw bad('SHADOWDANCER_REVISION_CONFLICT','This file changed after it was opened. Reload before editing.',409);
    if(!prior.value||typeof prior.value!=='object'||Array.isArray(prior.value))throw bad('SHADOWDANCER_EDIT','Editable context must be a JSON object.');
    const updated={...prior.value,...changes};
    if(meta.kind==='source'){
      updated.sourceSha256=sha(updated.content);
    }
    if(meta.kind==='page-result'){
      const sourceRel=rel.replace(/result\.json$/,'source.json');
      const source=(await safeJSON(path.join(root,...sourceRel.split('/')))).value;
      for(const row of updated.items||[]){
        if(!String(source.content||'').toLowerCase().includes(row.value.toLowerCase()))throw bad('SHADOWDANCER_SOURCE_SUPPORT','A claimed value is absent from the saved source page. Correct the source first.');
      }
      updated.anchoredItems=(updated.items||[]).map(row=>row.value);
    }
    if(meta.kind==='module-result'||meta.kind==='page-result')updated.verified=false;
    const before=JSON.stringify(prior.value),after=JSON.stringify(updated);
    if(before===after)return {unchanged:true,hash:prior.digest,file:rel};
    const auditPath=path.join(root,'conversation','context','audit.json');
    const audit=await optionalJSON(auditPath,[]);
    if(!Array.isArray(audit))throw bad('SHADOWDANCER_AUDIT','Audit history is invalid; no edit was made.');
    const editId='edit-'+String(audit.length+1).padStart(5,'0');
    const revDir=path.join(root,'conversation','context','revisions',editId);
    const newBytes=Buffer.from(JSON.stringify(updated,null,2)+'\n');
    const newHash=sha(newBytes);
    // Conversation-wide notes invalidate only the current canonical result.
    // Superseded runs remain immutable history, rather than becoming fresh
    // rebuild candidates whenever their descendant's summary changes.
    const affectedRun=RUN_FILE.exec(rel)?.[0].split('/')[1]||
      (meta.kind==='conversation'&&IDENT.test(prior.value.currentRun||'')?
        prior.value.currentRun:null);
    const priorFiles=await finalPaths(root,conversationId,affectedRun);
    const affected=[];
    for(const candidate of priorFiles){
      try{await stat(candidate.file);affected.push(candidate.runId)}catch{}
    }
    const row={id:editId,at:new Date().toISOString(),actor:limit(actor,120),reason:reason.trim(),
      file:rel,kind:meta.kind,beforeHash:prior.digest,afterHash:newHash,
      changedFields:Object.keys(changes), affectedRuns:affected,
      status:'committed'};
    const invalidationPath=path.join(root,'conversation','context','invalidation.json');
    const invalidation=await optionalJSON(invalidationPath,{});
    if(!invalidation||typeof invalidation!=='object'||Array.isArray(invalidation))throw bad('SHADOWDANCER_AUDIT','Context invalidation data is invalid; no edit was made.');
    await assertSafePath(revDir);
    try{await lstat(revDir);throw bad('SHADOWDANCER_AUDIT','Revision already exists; no edit was made.');}catch(error){if(error.code!=='ENOENT')throw error;}
    // Archive both entire versions before altering the canonical file.
    await atomicJSON(path.join(revDir,'before.json'),prior.value);
    await atomicJSON(path.join(revDir,'after.json'),updated);

    const staleRuns={...(invalidation.staleRuns||{})};
    for(const runId of affected)staleRuns[runId]={
      state:'stale',editId,sourceFile:rel,kind:meta.kind,at:row.at,
      reason:'Context changed after synthesis; regenerate before treating the final as current.'
    };
    // Mark derived evidence stale before canonical data can change. An interrupted
    // edit may be conservatively stale, but must never look freshly verified.
    await atomicJSON(invalidationPath,{version:1,staleRuns,latestEdit:editId,updatedAt:row.at});
    await atomicJSON(full,updated);
    audit.push(row);
    await atomicJSON(auditPath,audit);
    return {updated:true,file:rel,hash:newHash,editId,changedFields:row.changedFields,
      invalidatedRuns:affected, status:affected.length?'stale':'edited'};
  });
}

export {assertSafePath as assertSafeShadowdancerPath};
