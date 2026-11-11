import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const fail = (message, status = 400) => Object.assign(new Error(message), { status, code: 'STORAGE_CLEANUP_INVALID' });
const CLEAR_PHRASE = 'DELETE SELECTED DATA';

// Fixed, non-overlapping allowlist. No caller may supply a deletion path.
export const STORAGE_CATEGORIES = Object.freeze([
  { id: 'conversations', title: 'Conversations and run history', kind: 'history', deletable: true,
    detail: 'Saved chats, provider threads, run archives, and task execution state.',
    targets: [['data','conversations'],['data','conversation-state.json'],['data','conversation-state.json.bak'],
      ['data','provider-threads'],['data','runs.json'],['data','runs.json.bak'],['data','run-event-archives'],
      ['data','task-state'],['data','task-state-archives']] },
  { id: 'context', title: 'Saved context and planning', kind: 'history', deletable: true,
    detail: 'Knowledge, learning, planning graphs, and planning organization.',
    targets: [['data','knowledge.json'],['data','knowledge.json.bak'],['data','learning.json'],['data','learning.json.bak'],
      ['data','planning-browser'],['data','planning-organization.json'],['data','planning-organization.json.bak']] },
  { id: 'workspaces', title: 'Saved workspace and task metadata', kind: 'history', deletable: true,
    detail: 'Projects, schedules, workflows, and inbox state. Does not delete working-directory files.',
    targets: [['data','projects.json'],['data','projects.json.bak'],['data','workflows.json'],['data','workflows.json.bak'],
      ['data','operations.json'],['data','operations.json.bak'],['data','inbox.json'],['data','inbox.json.bak']] },
  { id: 'workspaceFiles', title: 'Managed workspace files', kind: 'userdata', deletable: true,
    detail: 'Files under BLACKICE-managed working directories, including documents and source code. External custom workspaces are not touched.',
    targets: [['data','workspace'],['managedWorkspace','workspace']] },
  { id: 'actions', title: 'Direct-action receipts and undo history', kind: 'history', deletable: true,
    detail: 'Durable tool results, idempotency history, outcome evidence, and patch undo records. Earlier actions may no longer be reconcilable.',
    targets: [['data','direct-execution-jobs'],['data','direct-task-outcomes'],['data','file-patches']] },
  { id: 'media', title: 'Attachments, downloads, and workbench media', kind: 'userdata', deletable: true,
    detail: 'Stored uploads, downloads, recordings, and media. Original files may not be recoverable.',
    targets: [['data','attachments'],['data','application-documents'],['data','workbench-media'],
      ['profile','workbench-media'],['profile','downloads']] },
  { id: 'browser', title: 'Browser profiles and saved sign-ins', kind: 'userdata', deletable: true,
    detail: 'Browser profiles, stored credentials, sessions, and site data. Websites will require sign-in again.',
    targets: [['data','browser-profiles'],['data','browser-credentials'],['profile','Partitions'],
      ['profile','Local Storage'],['profile','Session Storage'],['profile','Network']] },
  { id: 'temporary', title: 'Temporary diagnostics and development data', kind: 'cache', deletable: true,
    detail: 'Rebuildable frontend-development artifacts, runtime probes, and diagnostics.',
    targets: [['data','frontend-development'],['data','mistral-vibe-runtime-probe'],
      ['data','mistral-vibe-setup-probe'],['profile','diagnostics']] },
  { id: 'vm', title: 'Workbench virtual machine', kind: 'system', deletable: false,
    detail: 'The guest disk contains an operating system and user files; it requires a separate VM reset workflow.',
    targets: [['data','workbench-vm']] },
  { id: 'browserCache', title: 'Desktop browser rendering caches', kind: 'system', deletable: false,
    detail: 'These may be held open by Electron and need a pre-desktop-startup cleanup hook.',
    targets: [['profile','Cache'],['profile','Code Cache'],['profile','GPUCache'],['profile','GPUPersistentCache'],
      ['profile','DawnGraphiteCache'],['profile','DawnWebGPUCache'],['profile','GrShaderCache'],['profile','ShaderCache']] }
]);
const samePath = (a,b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const choose = ids => {
  if (!Array.isArray(ids) || !ids.length || ids.length > STORAGE_CATEGORIES.length ||
      ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length)
    throw fail('Choose one or more distinct data categories.');
  return ids.map(id => {
    const category = STORAGE_CATEGORIES.find(value => value.id === id && value.deletable);
    if (!category) throw fail('An unsupported or protected category was selected.');
    return category;
  });
};
async function readJson(file, fallback) {
  let stat;
  try { stat = await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64*1024) throw fail('Saved storage management metadata is not a regular file.', 503);
  try { return JSON.parse(await fs.readFile(file,'utf8')); } catch { throw fail('Saved storage management metadata could not be parsed.', 503); }
}
async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive:true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force:true }).catch(()=>{}); }
}

export class StorageManager {
  constructor({dataDir, workspaceDir} = {}) {
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw fail('An absolute data directory is required.');
    this.dataDir = path.resolve(dataDir);
    this.profileDir = path.dirname(this.dataDir);
    this.workspaceDir = typeof workspaceDir === 'string' ? path.resolve(workspaceDir) : null;
    this.pendingFile = path.join(this.dataDir,'storage-cleanup-pending.json');
    this.policyFile = path.join(this.dataDir,'storage-retention.json');
    this.reportFile = path.join(this.dataDir,'storage-cleanup-report.json');
  }
  target([scope,name]) {
    if (!['data','profile','managedWorkspace'].includes(scope)) throw fail('Invalid storage category scope.',503);
    if (scope === 'managedWorkspace' && (!this.workspaceDir ||
        !samePath(this.workspaceDir,path.join(this.profileDir,'workspace')))) return null;
    const root = scope === 'data' ? this.dataDir : this.profileDir;
    const result = path.resolve(root,name);
    if (path.dirname(result)!==root || result===root) throw fail('Unsafe storage target.',503);
    return result;
  }
  async measure(target) {
    let bytes=0, files=0, directories=0, unsafe=false;
    const stack=[target];
    while(stack.length) {
      const item=stack.pop();
      let stat;
      try { stat=await fs.lstat(item); } catch(error) { if(error.code==='ENOENT')continue; throw error; }
      if(stat.isSymbolicLink()){unsafe=true;continue;}
      if(stat.isFile()){files++;bytes+=stat.size;}
      else if(stat.isDirectory()){
        directories++;
        for(const child of await fs.readdir(item))stack.push(path.join(item,child));
      } else unsafe=true;
    }
    return {bytes,files,directories,unsafe};
  }
  async measureCategory(category) {
    let bytes=0,files=0,directories=0,unsafe=false;
    for(const spec of category.targets){
      const target=this.target(spec); if(!target)continue;
      const value=await this.measure(target);
      bytes+=value.bytes;files+=value.files;directories+=value.directories;unsafe ||= value.unsafe;
    }
    return {id:category.id,title:category.title,detail:category.detail,kind:category.kind,
      deletable:category.deletable,bytes,files,directories,unsafe};
  }
  async pending() {
    const value=await readJson(this.pendingFile,null);
    if(value===null)return null;
    if(!value || value.version!==1 || typeof value.requestedAt!=='string' ||
        value.status!==undefined && !['queued','applying','failed'].includes(value.status))
      throw fail('Saved cleanup request needs repair.',503);
    choose(value.categories);
    return {categories:value.categories,requestedAt:value.requestedAt,
      status:value.status||'queued',startedAt:value.startedAt||null,error:value.error||null};
  }
  async policy() {
    const value=await readJson(this.policyFile,{});
    if(!value||typeof value!=='object'||Array.isArray(value)||
       value.autoClearTemporaryOnStartup!==undefined&&typeof value.autoClearTemporaryOnStartup!=='boolean')
      throw fail('Saved cleanup policy needs repair.',503);
    return {autoClearTemporaryOnStartup:value.autoClearTemporaryOnStartup===true};
  }
  async overview(){
    const categories=[];
    for(const category of STORAGE_CATEGORIES)categories.push(await this.measureCategory(category));
    let pending=null,pendingError=null;
    try{pending=await this.pending();}catch(error){pendingError=error.message;}
    return {categories,pending,pendingError,policy:await this.policy(),
      lastCleanup:await readJson(this.reportFile,null),at:new Date().toISOString(),
      externalWorkspace:this.workspaceDir && !samePath(this.workspaceDir,path.join(this.profileDir,'workspace'))
        ? this.workspaceDir : null};
  }
  async schedule({categories,confirmation}={}){
    const selected=choose(categories);
    if(confirmation!==CLEAR_PHRASE)throw fail('Type DELETE SELECTED DATA to queue permanent deletion.');
    if(await this.pending())throw fail('Cancel the existing queued cleanup before choosing new categories.',409);
    for(const category of selected)if((await this.measureCategory(category)).unsafe)
      throw fail('A selected category contains a link or unsupported file: '+category.title,409);
    const value={version:1,status:'queued',categories:selected.map(x=>x.id),requestedAt:new Date().toISOString()};
    await atomicJson(this.pendingFile,value);
    return {pending:{categories:value.categories,requestedAt:value.requestedAt,status:'queued'},applies:'next-startup'};
  }
  async cancel(){
    // Incomplete cleanup can already have removed some files. Do not imply a rollback.
    let previous=null;
    try{previous=await this.pending();}catch{}
    try{await fs.unlink(this.pendingFile);
      return {cancelled:true,partial:previous?.status==='applying'||previous?.status==='failed'};
    }
    catch(error){if(error.code==='ENOENT')return {cancelled:false,partial:false};throw error;}
  }
  async configurePolicy({autoClearTemporaryOnStartup}={}){
    if(typeof autoClearTemporaryOnStartup!=='boolean')throw fail('Choose whether to clear temporary files automatically.');
    const value={version:1,autoClearTemporaryOnStartup};
    await atomicJson(this.policyFile,value);
    return value;
  }
  async verifyExclusiveStartup(){
    const lease=path.join(this.dataDir,'direct-execution-jobs','executor.lock');
    let stat;
    try{stat=await fs.lstat(lease);}catch(error){if(error.code==='ENOENT')return;throw error;}
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)throw fail('Storage owner cannot be verified.',503);
    let pid;
    try{pid=JSON.parse(await fs.readFile(lease,'utf8')).pid;}catch{throw fail('Storage owner cannot be verified.',503);}
    if(!Number.isSafeInteger(pid)||pid<1)throw fail('Storage owner cannot be verified.',503);
    try{process.kill(pid,0);throw fail('Another BLACKICE process owns the storage; cleanup deferred.',409);}
    catch(error){if(error.code!=='ESRCH')throw error;}
  }
  // Must run before any store or direct-execution lease is opened.
  async applyAtStartup(){
    const pending=await this.pending(), policy=await this.policy();
    if(pending?.status!=='queued' && pending)
      throw fail('An earlier cleanup was interrupted. Some files may already be deleted. Review or cancel the failed request before scheduling another.',409);
    const ids=pending?.categories || (policy.autoClearTemporaryOnStartup?['temporary']:[]);
    if(!ids.length)return null;
    await this.verifyExclusiveStartup();
    const selected=choose(ids), measured=[];
    for(const category of selected){
      const result=await this.measureCategory(category);
      if(result.unsafe)throw fail('Cleanup refuses filesystem links in '+category.title,409);
      measured.push(result);
    }
    const result={categories:ids,startedAt:new Date().toISOString(),
      bytesInspected:measured.reduce((n,c)=>n+c.bytes,0),
      filesInspected:measured.reduce((n,c)=>n+c.files,0)};
    // Write the applying marker BEFORE the first delete. After a crash,
    // startup does not repeat an interrupted destructive operation.
    if(pending)await atomicJson(this.pendingFile,{...pending,status:'applying',startedAt:result.startedAt});
    try{
      for(const category of selected)for(const spec of category.targets){
        const dest=this.target(spec);if(!dest)continue;
        let rootStat;
        try{rootStat=await fs.lstat(path.dirname(dest));}
        catch(error){if(error.code==='ENOENT')continue;throw error;}
        if(!rootStat.isDirectory()||rootStat.isSymbolicLink())throw fail('Unsafe cleanup root.',503);
        await fs.rm(dest,{recursive:true,force:true,maxRetries:3,retryDelay:200});
      }
      result.completedAt=new Date().toISOString();
      await atomicJson(this.reportFile,result);
      if(pending)await fs.unlink(this.pendingFile);
      return result;
    }catch(error){
      if(pending)await atomicJson(this.pendingFile,{
        ...pending,status:'failed',startedAt:result.startedAt,error:String(error.message||error).slice(0,600)
      }).catch(()=>{});
      throw error;
    }
  }
}
