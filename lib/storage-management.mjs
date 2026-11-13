import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const fail = (message, status = 400) => Object.assign(new Error(message), { status, code: 'STORAGE_CLEANUP_INVALID' });
const CLEAR_PHRASE = 'DELETE SELECTED DATA';

// Fixed, non-overlapping allowlist. No caller may supply a deletion path.
export const STORAGE_CATEGORIES = Object.freeze([
  { id: 'conversations', title: 'Conversations and run history', kind: 'history', deletable: true,
    detail: 'Saved chats, provider threads, run archives, and task execution state.',
    targets: [['data','conversations'],['data','conversation-state.json'],['data','conversation-state.json.bak'],
      ['data','provider-threads'],['data','runs.json'],['data','runs.json.bak'],['data','run-event-archives'],
      ['data','task-state'],['data','task-state-archives']] },
  { id: 'context', title: 'Saved context', kind: 'history', deletable: true,
    detail: 'Knowledge, learning, and saved planning data, including archived legacy files. Runtime and modular planning settings are preserved.',
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
  { id: 'media', title: 'Attachments, downloads, and saved media', kind: 'userdata', deletable: true,
    detail: 'Stored uploads, downloads, recordings, and media. Original files may not be recoverable.',
    targets: [['data','attachments'],['data','application-documents'],['data','workbench-media'],
      ['profile','workbench-media'],['profile','downloads']] },
  { id: 'browserCredentials', title: 'Saved browser passwords', kind: 'userdata', deletable: true,
    detail: 'BLACKICE password-vault and mirror records. Does not sign out websites or remove browser profiles and site data.',
    targets: [['data','browser-credentials']] },
  { id: 'browser', title: 'Browser profiles, sessions, and site data', kind: 'system', deletable: false,
    detail: 'Browser processes can own these files before server startup. They are measured only; bulk browser reset is not available here.',
    targets: [['data','browser-profiles'],['data','bp'],['data','browser-tabs.json'],['profile','Partitions'],
      ['profile','Local Storage'],['profile','Session Storage'],['profile','Network']] },
  { id: 'runtimeSettings', title: 'Runtime and modular planning settings', kind: 'system', deletable: false,
    detail: 'Runtime preferences and modular planning definitions are preserved by data cleanup.',
    targets: [['data','runtime-settings.json'],['data','runtime-settings.json.bak']] },
  { id: 'temporary', title: 'Temporary diagnostics and development data', kind: 'cache', deletable: true,
    detail: 'Rebuildable frontend-development artifacts, runtime probes, and diagnostics.',
    targets: [['data','frontend-development'],['data','mistral-vibe-runtime-probe'],
      ['data','mistral-vibe-setup-probe'],['profile','diagnostics']] },
  { id: 'vm', title: 'Retired virtual-machine files', kind: 'system', deletable: false,
    detail: 'Preserved files from the retired Workbench feature may contain user work. Feature removal does not delete these files.',
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
    this.mutationTail = Promise.resolve();
    this.workspaceCatalog = new Map();
    this.workspaceTokens = new Map();
  }
  mutate(operation) {
    const pending = this.mutationTail.then(operation);
    this.mutationTail = pending.catch(() => {});
    return pending;
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

  workspaceRoots() {
    return STORAGE_CATEGORIES.find(item => item.id === 'workspaceFiles').targets
      .map((spec, index) => ({index, path:this.target(spec), label:index===0?'Earlier workspace':'Workspace'}))
      .filter(root => root.path);
  }
  identity(stat) {
    return [stat.dev,stat.ino,stat.birthtimeMs].join(':');
  }
  descriptor(value) {
    if (!value || !Number.isInteger(value.rootIndex) || typeof value.relative !== 'string' ||
        !value.relative || value.relative.length>4096 ||
        value.relative.split('/').some(part => !part || part==='.' || part==='..' || /[\\:\x00]/.test(part)) ||
        typeof value.identity !== 'string' || typeof value.rootIdentity !== 'string')
      throw fail('Invalid workspace selection.',409);
    const root=this.workspaceRoots().find(item=>item.index===value.rootIndex);
    if(!root)throw fail('The selected managed workspace is no longer configured.',409);
    return {root, target:path.join(root.path,...value.relative.split('/'))};
  }
  async assertWorkspaceEntry(value) {
    const {root,target}=this.descriptor(value);
    // Check every app-managed ancestor without following links, including a
    // replaced workspace root. Stored selections cannot turn into external paths.
    const relativeRoot=path.relative(this.profileDir,root.path);
    if(relativeRoot.startsWith('..')||path.isAbsolute(relativeRoot))throw fail('Unsafe workspace root.',409);
    let current=this.profileDir;
    for(const part of ['',...relativeRoot.split(path.sep).filter(Boolean),...value.relative.split('/')]){
      if(part)current=path.join(current,part);
      let stat;
      try{stat=await fs.lstat(current);}catch(error){if(error.code==='ENOENT')throw fail('A selected workspace item is missing. Refresh the selection.',409);throw error;}
      if(stat.isSymbolicLink()||(!stat.isDirectory()&&!stat.isFile()))throw fail('A selected workspace path contains a link or unsupported file.',409);
      if(current!==target&&!stat.isDirectory())throw fail('A workspace ancestor is no longer a directory.',409);
      if(samePath(current,root.path)&&this.identity(stat)!==value.rootIdentity)throw fail('The managed workspace root changed. Refresh the selection.',409);
      if(samePath(current,target)&&this.identity(stat)!==value.identity)throw fail('A selected workspace item changed. Refresh the selection.',409);
    }
    return target;
  }
  tokenFor(descriptor) {
    const key=[descriptor.rootIndex,descriptor.relative,descriptor.identity,descriptor.rootIdentity].join('|');
    const prior=this.workspaceTokens.get(key);
    if(prior&&this.workspaceCatalog.has(prior))return prior;
    if(this.workspaceCatalog.size>=10000){
      const oldest=this.workspaceCatalog.keys().next().value;
      const old=this.workspaceCatalog.get(oldest);
      this.workspaceCatalog.delete(oldest);
      this.workspaceTokens.delete([old.rootIndex,old.relative,old.identity,old.rootIdentity].join('|'));
    }
    const id=randomUUID();
    this.workspaceCatalog.set(id,{...descriptor,id});
    this.workspaceTokens.set(key,id);
    return id;
  }
  async workspaceItems({parent=null,offset=0}={}) {
    if(parent!==null&&(typeof parent!=='string'||!this.workspaceCatalog.has(parent)))throw fail('Workspace location expired. Refresh the workspace list.',409);
    offset=Number(offset);
    if(!Number.isSafeInteger(offset)||offset<0)throw fail('Invalid workspace page.');
    const locations=[],breadcrumbs=[{id:null,name:'Workspace files'}];
    if(parent){
      const item=this.workspaceCatalog.get(parent),target=await this.assertWorkspaceEntry(item);
      if(!(await fs.lstat(target)).isDirectory())throw fail('This workspace item is not a folder.');
      const root=this.workspaceRoots().find(value=>value.index===item.rootIndex);
      const parts=item.relative.split('/');
      for(let i=1;i<=parts.length;i++){
        const relative=parts.slice(0,i).join('/'),stat=await fs.lstat(path.join(root.path,...parts.slice(0,i)));
        breadcrumbs.push({id:this.tokenFor({...item,relative,identity:this.identity(stat)}),name:parts[i-1]});
      }
      locations.push({root,relative:item.relative,target});
    } else {
      for(const root of this.workspaceRoots()){
        let stat;try{stat=await fs.lstat(root.path);}catch(error){if(error.code==='ENOENT')continue;throw error;}
        if(stat.isSymbolicLink()||!stat.isDirectory())continue;
        const profileStat=await fs.lstat(this.profileDir);
        if(profileStat.isSymbolicLink()||!profileStat.isDirectory())throw fail('Unsafe workspace profile.',409);
        if(root.index===0){const dataStat=await fs.lstat(this.dataDir);if(dataStat.isSymbolicLink()||!dataStat.isDirectory())throw fail('Unsafe workspace data root.',409);}
        locations.push({root,relative:'',target:root.path});
      }
    }
    const candidates=[];
    for(const location of locations){
      const rootIdentity=this.identity(await fs.lstat(location.root.path));
      for(const name of (await fs.readdir(location.target)).sort()){
        candidates.push({...location,name,rootIdentity,relative:[location.relative,name].filter(Boolean).join('/')});
      }
    }
    const entries=[];
    for(const candidate of candidates.slice(offset,offset+200)){
      const target=path.join(candidate.root.path,...candidate.relative.split('/'));
      let stat;try{stat=await fs.lstat(target);}catch(error){if(error.code==='ENOENT')continue;throw error;}
      const kind=stat.isSymbolicLink()?'link':stat.isDirectory()?'directory':stat.isFile()?'file':'unsupported';
      const descriptor={rootIndex:candidate.root.index,relative:candidate.relative,identity:this.identity(stat),rootIdentity:candidate.rootIdentity};
      const id=this.tokenFor(descriptor);
      let measured,reason=null;
      try{measured=await this.measure(target);}catch{measured={bytes:0,files:0,unsafe:true};reason='Unable to measure this item. Refresh after checking access.';}
      if(!reason&&measured.unsafe)reason=kind==='link'?'Linked files stay untouched.':'Contains linked or unsupported files. Open this folder to choose supported items.';
      entries.push({id,name:candidate.name,relativePath:candidate.root.label+'/'+candidate.relative,kind,
        bytes:measured.bytes,files:measured.files,unsafe:measured.unsafe,selectable:!measured.unsafe,
        reason,hasChildren:kind==='directory'});
    }
    return {entries,breadcrumbs,parent,nextOffset:offset+200<candidates.length?offset+200:null};
  }
  async workspaceSnapshot(value) {
    const target=await this.assertWorkspaceEntry(value),hash=createHash('sha256');
    let bytes=0,files=0;
    const walk=async(item,relative)=>{
      const stat=await fs.lstat(item);
      if(stat.isSymbolicLink()||(!stat.isFile()&&!stat.isDirectory()))throw fail('A selected workspace item contains a link or unsupported file. Open the folder to choose supported items.',409);
      hash.update(JSON.stringify([relative,stat.isDirectory()?'d':'f',this.identity(stat),stat.mtimeMs,stat.ctimeMs,stat.size]));
      if(stat.isFile()){bytes+=stat.size;files++;return;}
      for(const name of (await fs.readdir(item)).sort())await walk(path.join(item,name),relative+'/'+name);
    };
    await walk(target,'');
    await this.assertWorkspaceEntry(value);
    return {hash:hash.digest('hex'),bytes,files};
  }
  async selectedWorkspace(ids) {
    if(!Array.isArray(ids)||ids.length>100||new Set(ids).size!==ids.length)throw fail('Choose up to 100 distinct workspace items.');
    const selected=ids.map(id=>{
      if(typeof id!=='string'||!this.workspaceCatalog.has(id))throw fail('A workspace selection expired. Refresh and select the item again.',409);
      return this.workspaceCatalog.get(id);
    });
    for(let i=0;i<selected.length;i++)for(let j=i+1;j<selected.length;j++){
      const a=selected[i],b=selected[j];
      if(a.rootIndex===b.rootIndex&&(a.relative.startsWith(b.relative+'/')||b.relative.startsWith(a.relative+'/')))
        throw fail('Choose a folder or its contents, not both.',409);
    }
    const result=[];
    for(const item of selected){
      const snapshot=await this.workspaceSnapshot(item),root=this.workspaceRoots().find(root=>root.index===item.rootIndex);
      result.push({...item,name:path.basename(item.relative),relativePath:root.label+'/'+item.relative,snapshot});
    }
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
    if(!value || ![1,2].includes(value.version) || typeof value.requestedAt!=='string' ||
        value.status!==undefined && !['queued','applying','failed'].includes(value.status))
      throw fail('Saved cleanup request needs repair.',503);
    const entries=value.version===2?value.workspaceEntries:[];
    if(!Array.isArray(entries)||entries.length>100||(!entries.length&&!value.categories?.length))throw fail('Saved cleanup selection needs repair.',503);
    if(value.categories?.length)choose(value.categories);
    else if(!Array.isArray(value.categories))throw fail('Saved cleanup categories need repair.',503);
    if(entries.length&&value.categories.includes('workspaceFiles'))throw fail('Overlapping saved workspace cleanup.',503);
    for(const entry of entries){
      this.descriptor(entry);
      if(typeof entry.id!=='string'||typeof entry.snapshot?.hash!=='string'||!/^[a-f0-9]{64}$/.test(entry.snapshot.hash))throw fail('Saved workspace selection needs repair.',503);
    }
    return {version:value.version,categories:value.categories,...(entries.length?{workspaceEntries:entries}:{}),requestedAt:value.requestedAt,
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
  schedule(value={}) { return this.mutate(() => this._schedule(value)); }
  async _schedule({categories=[],workspaceEntries=[],confirmation}={}){
    if(!Array.isArray(categories))throw fail('Choose data categories.');
    const selected=categories.length?choose(categories):[];
    const entries=await this.selectedWorkspace(workspaceEntries);
    if(!selected.length&&!entries.length)throw fail('Choose one or more data categories or workspace items.');
    if(entries.length&&categories.includes('workspaceFiles'))throw fail('Choose individual workspace items or the whole category, not both.');
    if(confirmation!==CLEAR_PHRASE)throw fail('Type DELETE SELECTED DATA to queue permanent deletion.');
    if(await this.pending())throw fail('Cancel the existing queued cleanup before choosing new categories.',409);
    for(const category of selected)if((await this.measureCategory(category)).unsafe)
      throw fail('A selected category contains a link or unsupported file: '+category.title,409);
    const value={version:entries.length?2:1,status:'queued',categories:selected.map(x=>x.id),...(entries.length?{workspaceEntries:entries}:{}),requestedAt:new Date().toISOString()};
    if(Buffer.byteLength(JSON.stringify(value),'utf8')>60*1024)throw fail('Selection is too large to save. Choose fewer workspace items.');
    await atomicJson(this.pendingFile,value);
    return {pending:{categories:value.categories,...(entries.length?{workspaceEntries:entries}:{}),requestedAt:value.requestedAt,status:'queued'},applies:'next-startup'};
  }
  cancel() { return this.mutate(() => this._cancel()); }
  async _cancel(){
    // Incomplete cleanup can already have removed some files. Do not imply a rollback.
    let previous=null, unknown=false;
    try{previous=await this.pending();}catch{unknown=true;}
    try{await fs.unlink(this.pendingFile);
      return {cancelled:true,partial:unknown||previous?.status==='applying'||previous?.status==='failed'};
    }
    catch(error){if(error.code==='ENOENT')return {cancelled:false,partial:false};throw error;}
  }
  configurePolicy(value={}) { return this.mutate(() => this._configurePolicy(value)); }
  async _configurePolicy({autoClearTemporaryOnStartup}={}){
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
  applyAtStartup() { return this.mutate(() => this._applyAtStartup()); }
  async _applyAtStartup(){
    const pending=await this.pending(), policy=await this.policy();
    if(pending?.status!=='queued' && pending)
      throw fail('An earlier cleanup was interrupted. Some files may already be deleted. Review or cancel the failed request before scheduling another.',409);
    const ids=pending?.categories || (policy.autoClearTemporaryOnStartup?['temporary']:[]);
    const entries=pending?.workspaceEntries||[];
    if(!ids.length&&!entries.length)return null;
    await this.verifyExclusiveStartup();
    const selected=ids.length?choose(ids):[], measured=[];
    for(const entry of entries){
      const snapshot=await this.workspaceSnapshot(entry);
      if(snapshot.hash!==entry.snapshot.hash)throw fail('Selected workspace contents changed after scheduling. Cancel and review the selection again.',409);
      measured.push(snapshot);
    }
    for(const category of selected){
      const result=await this.measureCategory(category);
      if(result.unsafe)throw fail('Cleanup refuses filesystem links in '+category.title,409);
      measured.push(result);
    }
    const result={categories:ids,...(entries.length?{workspaceEntries:entries.map(({id,name,relativePath,snapshot})=>({id,name,relativePath,bytes:snapshot.bytes}))}:{}),startedAt:new Date().toISOString(),
      bytesInspected:measured.reduce((n,c)=>n+c.bytes,0),
      filesInspected:measured.reduce((n,c)=>n+c.files,0)};
    // Write the applying marker BEFORE the first delete. After a crash,
    // startup does not repeat an interrupted destructive operation.
    if(pending)await atomicJson(this.pendingFile,{...pending,status:'applying',startedAt:result.startedAt});
    try{
      for(const entry of entries){
        const snapshot=await this.workspaceSnapshot(entry);
        if(snapshot.hash!==entry.snapshot.hash)throw fail('Selected workspace contents changed during cleanup.',409);
        const dest=await this.assertWorkspaceEntry(entry);
        await fs.rm(dest,{recursive:true,force:false,maxRetries:3,retryDelay:200});
      }
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
