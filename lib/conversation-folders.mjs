import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

// Saved conversation organization only. Never changes the conversation archive,
// the native task, run history, a model choice, browser tabs or any knowledge scope.
const VERSION = 1;
const MAX_BYTES = 8 * 1024 * 1024;
const ID = /^[a-zA-Z0-9_-]{1,100}$/;
const error = (message, status, code) => Object.assign(new Error(message), {status, code});
const copy = value => structuredClone(value);
const keyOf = value => String(value || '').trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const blank = () => ({version:VERSION, revision:0, folders:[], assignments:{}});
const validMap = value => value && typeof value === 'object' && !Array.isArray(value);
const validFolder = value => validMap(value) && typeof value.id === 'string' && /^fld_[a-zA-Z0-9_-]{8,100}$/.test(value.id) &&
  typeof value.name === 'string' && value.name.trim() === value.name && value.name.length > 0 && value.name.length <= 60 &&
  ['manual','automatic'].includes(value.origin);
const validAssignment = value => validMap(value) && (value.folderId === null || typeof value.folderId === 'string') &&
  ['manual','automatic'].includes(value.source) && typeof value.reason === 'string' && value.reason.length <= 240;
function validate(input) {
  if (!validMap(input)) throw error('Folder metadata needs repair. Conversations are unaffected.',503,'FOLDERS_DAMAGED');
  const candidate = input;
  if (candidate.version !== VERSION || !Number.isSafeInteger(candidate.revision) || candidate.revision < 0 ||
    !Array.isArray(candidate.folders) || candidate.folders.length > 250 || !validMap(candidate.assignments))
    throw error('Folder metadata needs repair. Conversations are unaffected.',503,'FOLDERS_DAMAGED');
  const names = new Set(), ids = new Set();
  for (const folder of candidate.folders) {
    if (!validFolder(folder) || ids.has(folder.id) || names.has((folder.parentId??'')+'|'+keyOf(folder.name))) throw error('Folder catalog is damaged.',503,'FOLDERS_DAMAGED');
    ids.add(folder.id); names.add((folder.parentId??'')+'|'+keyOf(folder.name));
  }
  for(const folder of candidate.folders) {
    const seen=new Set([folder.id]);let parent=folder.parentId??null;
    while(parent!==null){
      if(typeof parent!=='string'||!ids.has(parent)||seen.has(parent))throw error('Invalid folder hierarchy.',400,'FOLDER_PARENT');
      seen.add(parent);parent=candidate.folders.find(item=>item.id===parent).parentId??null;
    }
  }
  for (const [id, assignment] of Object.entries(candidate.assignments)) {
    if (!ID.test(id) || !validAssignment(assignment) ||
      assignment.folderId != null && !ids.has(assignment.folderId)) throw error('Folder assignments need repair.',503,'FOLDERS_DAMAGED');
  }
  return candidate;
}
async function atomic(io, target, data) {
  const temp = target + '.' + randomUUID() + '.tmp';
  try {
    const handle = await io.open(temp,'wx',0o600);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    await io.rename(temp,target);
  } finally { await io.rm(temp,{force:true}).catch(()=>{}); }
}
async function readExact(io, file) {
  const info = await io.stat(file);
  if (info.size > MAX_BYTES) throw error('Folder document exceeds its size limit.',503,'FOLDERS_DAMAGED');
  return validate(JSON.parse(await io.readFile(file,'utf8')));
}
function folderName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 60 ||
    /[\u0000-\u001f\u007f]/.test(value)) throw error('Use a folder name of 1 to 60 characters.',400,'FOLDER_NAME');
  return value.trim();
}
function verifyRoot(id, exists) {
  if (typeof id !== 'string' || !ID.test(id) || !exists(id)) throw error('Saved conversation not found.',404,'CONVERSATION_NOT_FOUND');
}
function conflict(revision) {return Object.assign(error('Folder organization changed. Reload and retry this change.',409,'FOLDER_REVISION'),{currentRevision:revision});}

export class ConversationFolders {
  constructor({dataDir, io=fs, conversations=null}={}) {
    if (typeof dataDir !== 'string' || !dataDir) throw Error('dataDir required.');
    // The configured dataDir belongs to one BLACKICE profile. No global file,
    // shared workspace, cross-profile cache or conversation text is created.
    this.file = path.join(path.resolve(dataDir),'conversation-folders-v1.json');
    this.lock = this.file + '.lock';
    this.conversations=conversations; this.io = io; this.data = blank(); this.error = null;
    this.recovered = false; this.queue = Promise.resolve();
  }
  async load({repair=false}={}) {
    let primaryError, backupError;
    try {
      const state = await readExact(this.io,this.file);
      return state;
    } catch (failure) {primaryError = failure;}
    try {
      const prior = await readExact(this.io,this.file + '.bak');
      if (repair) {
        if (primaryError.code !== 'ENOENT') await this.io.copyFile(this.file,this.file+'.corrupt-'+randomUUID());
        await atomic(this.io,this.file,JSON.stringify(prior));
      }
      this.recovered = true;
      return prior;
    } catch (failure) {backupError=failure;}
    if (primaryError.code === 'ENOENT' && backupError.code === 'ENOENT') return blank();
    throw error('Folder metadata is damaged or unreadable. Chats remain usable; folder changes are disabled.',503,'FOLDERS_DAMAGED');
  }
  async init() {
    await this.io.mkdir(path.dirname(this.file),{recursive:true});
    try {this.data=await this.load({repair:true});this.error=null;}
    catch (failure) {this.error=failure.message;}
    return this;
  }
  status() { return {healthy:!this.error,error:this.error,revision:this.data.revision,recovered:this.recovered}; }
  snapshot() {
    return {...this.status(),version:VERSION,lifecycleRevision:this.conversations?.metadataRevision??0,folders:copy(this.data.folders).map(folder=>({...folder,state:this.conversations?.folderState(folder.id)||'active'}))};
  }
  forConversation(id) {
    const record=this.data.assignments[id]||null;
    return {folderId:record?.folderId??null,folderSource:record?.source??null,
      folderReason:record?.reason||null};
  }
  decorate(items) { return items.map(item=>{const assignment=this.forConversation(item.rootId||item.taskId||item.id);if(assignment.folderId&&this.conversations&&this.conversations.folderState(assignment.folderId)!==item.state)assignment.folderId=null;return {...item,...assignment};}); }
  // read-only helper; no transcript or other collection is altered
  counts(items) {
    const byId=Object.create(null);let ungrouped=0;
    for (const item of this.decorate(items)) {
      const assignment=item;
      if (!assignment.folderId) ungrouped++; else byId[assignment.folderId]=(byId[assignment.folderId]||0)+1;
    }
    return {byId,ungrouped,total:items.length};
  }
  async mutate(transform,{expectedRevision}={}) {
    if(this.error)throw error(this.error,503,'FOLDERS_DAMAGED');
    const execute=async()=>{
      try { await this.io.mkdir(this.lock); }
      catch (cause) {
        if (cause.code==='EEXIST') throw error('Another folder edit is in progress. Inspect before retrying.',423,'FOLDER_LOCKED');
        throw cause;
      }
      try {
        const current=await this.load();
        this.data=current;
        if (expectedRevision !== undefined && expectedRevision !== current.revision) throw conflict(current.revision);
        const next=copy(current);
        const changed=await transform(next);
        if (!changed) return this.snapshot();
        next.revision=current.revision+1;
        validate(next);
        const text=JSON.stringify(next);
        if (Buffer.byteLength(text)>MAX_BYTES) throw error('Folder index is full; no changes were saved.',413,'FOLDERS_FULL');
        await atomic(this.io,this.file+'.bak',JSON.stringify(current));
        await atomic(this.io,this.file,text);
        this.data=next;this.error=null;
        return this.snapshot();
      } finally { await this.io.rmdir(this.lock).catch(()=>{}); }
    };
    this.queue=this.queue.catch(()=>{}).then(execute);
    return this.queue;
  }
  async lifecycle(id,action,input){
    const state={archive:'archived',delete:'deleted',restore:'active'}[action];
    if(!state||!Number.isSafeInteger(input?.expectedRevision)||!Number.isSafeInteger(input?.expectedMetadataRevision))throw error('Supply both organization revisions.',400,'FOLDER_EDIT');
    let result;
    await this.mutate(async next=>{
      const folder=next.folders.find(f=>f.id===id);if(!folder)throw error('Folder not found.',404,'FOLDER_NOT_FOUND');
      const ids=new Set([id]);let changed=true;while(changed){changed=false;for(const f of next.folders)if(ids.has(f.parentId)&&!ids.has(f.id)){ids.add(f.id);changed=true;}}
      result=await this.conversations.setFolderState({folderIds:[...ids],rootIds:Object.entries(next.assignments).filter(([,a])=>ids.has(a.folderId)).map(([root])=>root),state,expectedMetadataRevision:input.expectedMetadataRevision,parentId:folder.parentId});
      return false;
    },{expectedRevision:input.expectedRevision});
    return {...result,folderOrganization:this.snapshot()};
  }
  async edit(input,{exists=()=>false}={}) {
    if (!validMap(input) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision<0 ||
      !Array.isArray(input.operations) || input.operations.length<1 || input.operations.length>30)
      throw error('Specify expectedRevision and 1-30 folder operations.',400,'FOLDER_EDIT');
    return this.mutate(next=>{
      for(const op of input.operations) {
        if(!validMap(op)||typeof op.type!=='string')throw error('Invalid folder operation.',400,'FOLDER_EDIT');
        for(const target of [op.folderId,op.parentId,op.previous?.folderId])if(target&&this.conversations&&this.conversations.folderState(target)!=='active')throw error('Restore this folder before editing it.',409,'FOLDER_RETIRED');
        if(op.type==='create_folder') {
          const name=folderName(op.name);
          if(next.folders.some(item=>keyOf(item.name)===keyOf(name)&&(item.parentId??null)===(op.parentId??null)))throw error('That folder already exists.',409,'FOLDER_EXISTS');
          if(next.folders.length>=250)throw error('Folder limit reached.',413,'FOLDER_LIMIT');
          next.folders.push({id:'fld_'+randomUUID().replaceAll('-',''),name,parentId:op.parentId??null,origin:'manual'});
        } else if(op.type==='rename_folder') {
          const found=next.folders.find(item=>item.id===op.folderId);
          if(!found)throw error('Folder not found.',404,'FOLDER_NOT_FOUND');
          const name=folderName(op.name);
          if(next.folders.some(item=>item!==found&&(item.parentId??null)===(found.parentId??null)&&keyOf(item.name)===keyOf(name)))throw error('That folder already exists.',409,'FOLDER_EXISTS');
          found.name=name;found.origin='manual';
        } else if(op.type==='move_folder') {
          const found=next.folders.find(item=>item.id===op.folderId);
          if(!found)throw error('Folder not found.',404,'FOLDER_NOT_FOUND');
          found.parentId=op.parentId??null;
        } else if(op.type==='delete_folder') {
          const index=next.folders.findIndex(item=>item.id===op.folderId);
          if(index<0)throw error('Folder not found.',404,'FOLDER_NOT_FOUND');
          if(next.folders.some(f=>f.parentId===op.folderId)||Object.values(next.assignments).some(a=>a.folderId===op.folderId))throw error('Move the folder contents before deleting it.',409,'FOLDER_NOT_EMPTY');
          const [removed]=next.folders.splice(index,1);
        } else if(op.type==='assign') {
          verifyRoot(op.rootId,exists);
          if(op.folderId !== null && !next.folders.some(item=>item.id===op.folderId))
            throw error('Choose an existing folder or Ungrouped.',400,'FOLDER_TARGET');
          next.assignments[op.rootId]={folderId:op.folderId,source:'manual',
            reason:op.folderId===null?'Manually kept Ungrouped.':'Manually moved to '+
            next.folders.find(item=>item.id===op.folderId).name+'.'};
        } else if(op.type==='restore_assignment') {
          verifyRoot(op.rootId,exists);
          if(op.previous == null) delete next.assignments[op.rootId];
          else {
            if(!validAssignment(op.previous)||op.previous.folderId!==null &&
              !next.folders.some(item=>item.id===op.previous.folderId))throw error('Previous folder no longer exists.',409,'FOLDER_UNDO');
            next.assignments[op.rootId]=copy(op.previous);
          }
        } else throw error('Unsupported folder operation.',400,'FOLDER_EDIT');
      }
      return true;
    },{expectedRevision:input.expectedRevision});
  }
}
