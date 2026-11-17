import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';

// Saved conversation organization only. Never changes the conversation archive,
// the native task, run history, a model choice, browser tabs or any knowledge scope.
const VERSION = 1;
const MAX_BYTES = 8 * 1024 * 1024;
export const AUTO_BATCH_LIMIT = 40;
export const AUTO_FOLDER_LIMIT = 8;
const MAX_SCANS = 20000;
const ID = /^[a-zA-Z0-9_-]{1,100}$/;
const COMMON = new Set(('the and for from with about into these those over under after before how what why when where who ' +
  'new chat chats conversation conversations folder folders grouping group groups auto automatic implementation ' +
  'implement implementing build building create creating make making fix fixing test tests testing review reviewing ' +
  'update updating changes change task tasks project projects design designing analysis analyze research investigating ' +
  'investigate improve improving feature features system systems request requests help need using use results result ' +
  'planning plan work worktree source release validate validation acceptance status issue issues summary notes ' +
  'today tomorrow yesterday latest current existing support supporting discuss question questions').split(/\s+/));
const error = (message, status, code) => Object.assign(new Error(message), {status, code});
const copy = value => structuredClone(value);
const keyOf = value => String(value || '').trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const titleHash = value => createHash('sha256').update(String(value || '').trim()).digest('hex').slice(0, 20);
const blank = () => ({version:VERSION, revision:0, autoEnabled:true, generation:0,
  folders:[], assignments:{}, scans:{}, suppressed:[]});
const validMap = value => value && typeof value === 'object' && !Array.isArray(value);
const validFolder = value => validMap(value) && typeof value.id === 'string' && /^fld_[a-zA-Z0-9_-]{8,100}$/.test(value.id) &&
  typeof value.name === 'string' && value.name.trim() === value.name && value.name.length > 0 && value.name.length <= 60 &&
  ['manual','automatic'].includes(value.origin);
const validAssignment = value => validMap(value) && (value.folderId === null || typeof value.folderId === 'string') &&
  ['manual','automatic'].includes(value.source) && typeof value.reason === 'string' && value.reason.length <= 240;
function validate(input) {
  if (!validMap(input)) throw error('Folder metadata needs repair. Conversations are unaffected.',503,'FOLDERS_DAMAGED');
  // There was no folder storage in .98; a missing document is an empty v1
  // migration. Support an unversioned prototype document without rewriting it
  // until the next committed edit.
  const candidate = input.version == null && Array.isArray(input.folders) ?
    {...blank(), ...input, version:VERSION, generation:0, scans:{}, suppressed:[]} : input;
  if (candidate.version !== VERSION || !Number.isSafeInteger(candidate.revision) || candidate.revision < 0 ||
    typeof candidate.autoEnabled !== 'boolean' || !Number.isSafeInteger(candidate.generation) ||
    candidate.generation < 0 || !Array.isArray(candidate.folders) || candidate.folders.length > 250 ||
    !validMap(candidate.assignments) || !validMap(candidate.scans) ||
    !Array.isArray(candidate.suppressed) || candidate.suppressed.length > 250 ||
    candidate.suppressed.some(item => typeof item !== 'string' || item.length > 120)) {
    throw error('Folder metadata needs repair. Conversations are unaffected.',503,'FOLDERS_DAMAGED');
  }
  const names = new Set(), ids = new Set();
  for (const folder of candidate.folders) {
    if (!validFolder(folder) || ids.has(folder.id) || names.has(keyOf(folder.name))) throw error('Folder catalog is damaged.',503,'FOLDERS_DAMAGED');
    ids.add(folder.id); names.add(keyOf(folder.name));
  }
  for (const [id, assignment] of Object.entries(candidate.assignments)) {
    if (!ID.test(id) || !validAssignment(assignment) ||
      assignment.folderId != null && !ids.has(assignment.folderId)) throw error('Folder assignments need repair.',503,'FOLDERS_DAMAGED');
  }
  for (const [id, scan] of Object.entries(candidate.scans)) {
    if (!ID.test(id) || !validMap(scan) || typeof scan.signature !== 'string' ||
      !Number.isSafeInteger(scan.generation) || scan.generation < 0 ||
      typeof scan.title !== 'string' || scan.title.length > 120 ||
      scan.topic != null && (typeof scan.topic !== 'string' || scan.topic.length > 70) ||
      scan.suggestion != null && typeof scan.suggestion !== 'string') {
      throw error('Folder scan metadata needs repair.',503,'FOLDERS_DAMAGED');
    }
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
function candidateSubject(title) {
  const normalized = String(title || '').slice(0,120);
  if (/^\s*job[\s-]+search\b/i.test(normalized)) return {key:'job search',label:'Job Search'};
  const terms = [...normalized.matchAll(/[A-Za-z][A-Za-z0-9_-]*/g)].map(m=>m[0])
    .filter(term => term.length >= 4 && !COMMON.has(term.toLocaleLowerCase()));
  const names = terms.filter(term => /^[A-Z][a-z]{4,}$/.test(term) ||
    /^[A-Z][A-Z0-9_-]{3,}$/.test(term) || /[a-z][A-Z]/.test(term));
  const distinct = [...new Map(names.map(name=>[keyOf(name),name])).values()];
  // A common umbrella product name is less informative than a single named
  // subproject. "BLACKICE Swarm" is usually about Swarm, not every BLACKICE chat.
  const distinctive=distinct.filter(name=>!['blackice','chatgpt'].includes(keyOf(name)));
  const chosen=distinctive.length===1?distinctive[0]:distinctive.length===0&&distinct.length===1?distinct[0]:null;
  return chosen?{key:keyOf(chosen),label:chosen}:null;
}
function matchFolders(title, folders) {
  const words = ' ' + keyOf(title) + ' ';
  const matching = folders.filter(folder => {
    const phrase = keyOf(folder.name);
    return phrase.length >= 4 && words.includes(' ' + phrase + ' ');
  });
  if (!matching.length) return {folderId:null, reason:'No confident folder match in the chat title.', suggestion:null};
  const subject=candidateSubject(title),namedTopics=[...new Set(
    [...String(title).matchAll(/\b[A-Z][a-z]{4,}\b|\b[A-Z]{4,}\b/g)].map(match=>keyOf(match[0]))
    .filter(term=>!COMMON.has(term))
  )];
  // Comparisons/mixed-topic discussions are not owned by either name.
  if (/\b(vs\.?|versus|and)\b/i.test(String(title)) && namedTopics.length >= 2)
    return {folderId:null,reason:'Mixed topics; review before assigning.',suggestion:matching[0].id};
  const exactSubject=subject&&matching.find(folder=>keyOf(folder.name)===subject.key);
  if(matching.length>1&&!exactSubject)
    return {folderId:null,reason:'Several folder names match; kept Ungrouped.',suggestion:null};
  const found=exactSubject||matching[0];
  // Prefer a distinctive subproject to an umbrella product. Wait for evidence
  // to create/recognize that subproject rather than dumping all titles into one.
  if(subject&&subject.key!==keyOf(found.name)&&['blackice','chatgpt'].includes(keyOf(found.name)))
    return {folderId:null,reason:'Distinct subtopic; waiting for a matching folder.',suggestion:null};
  return {folderId:found.id,reason:'Title matches "'+found.name+'" (local title-only rule; no model call).',suggestion:null};
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
  constructor({dataDir, io=fs}={}) {
    if (typeof dataDir !== 'string' || !dataDir) throw Error('dataDir required.');
    // The configured dataDir belongs to one BLACKICE profile. No global file,
    // shared workspace, cross-profile cache or conversation text is created.
    this.file = path.join(path.resolve(dataDir),'conversation-folders-v1.json');
    this.lock = this.file + '.lock';
    this.io = io; this.data = blank(); this.error = null;
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
  status() { return {healthy:!this.error,error:this.error,revision:this.data.revision,autoEnabled:this.data.autoEnabled,recovered:this.recovered}; }
  snapshot() {
    return {...this.status(),version:VERSION,generation:this.data.generation,folders:copy(this.data.folders),suppressedCount:this.data.suppressed.length,
      scannedCount:Object.keys(this.data.scans).length,method:'Local title-only heuristics; no provider turns or transcript reads.'};
  }
  forConversation(id) {
    const record=this.data.assignments[id]||null;
    const scan=this.data.scans[id]||null;
    return {folderId:record?.folderId??null,folderSource:record?.source??null,
      folderReason:record?.reason||scan?.notice||null,folderSuggestion:record?null:(scan?.suggestion??null)};
  }
  decorate(items) { return items.map(item=>({...item,...this.forConversation(item.rootId||item.taskId||item.id)})); }
  // read-only helper; no transcript or other collection is altered
  counts(items) {
    const byId=Object.create(null);let ungrouped=0;
    for (const item of items) {
      const assignment=this.forConversation(item.rootId||item.taskId||item.id);
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
        const changed=transform(next);
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
  async edit(input,{exists=()=>false}={}) {
    if (!validMap(input) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision<0 ||
      !Array.isArray(input.operations) || input.operations.length<1 || input.operations.length>30)
      throw error('Specify expectedRevision and 1-30 folder operations.',400,'FOLDER_EDIT');
    return this.mutate(next=>{
      for(const op of input.operations) {
        if(!validMap(op)||typeof op.type!=='string')throw error('Invalid folder operation.',400,'FOLDER_EDIT');
        if(op.type==='create_folder') {
          const name=folderName(op.name);
          if(next.folders.some(item=>keyOf(item.name)===keyOf(name)))throw error('That folder already exists.',409,'FOLDER_EXISTS');
          if(next.folders.length>=250)throw error('Folder limit reached.',413,'FOLDER_LIMIT');
          next.folders.push({id:'fld_'+randomUUID().replaceAll('-',''),name,origin:'manual'});
          next.suppressed=next.suppressed.filter(item=>item!==keyOf(name));next.generation++;
        } else if(op.type==='rename_folder') {
          const found=next.folders.find(item=>item.id===op.folderId);
          if(!found)throw error('Folder not found.',404,'FOLDER_NOT_FOUND');
          const name=folderName(op.name);
          if(next.folders.some(item=>item!==found&&keyOf(item.name)===keyOf(name)))throw error('That folder already exists.',409,'FOLDER_EXISTS');
          found.name=name;found.origin='manual';next.generation++;
        } else if(op.type==='delete_folder') {
          const index=next.folders.findIndex(item=>item.id===op.folderId);
          if(index<0)throw error('Folder not found.',404,'FOLDER_NOT_FOUND');
          const [removed]=next.folders.splice(index,1);
          next.suppressed=[...new Set([...next.suppressed,keyOf(removed.name)])].slice(-250);
          // Deletion never deletes or archives a chat. Human removal is sticky:
          // prevent automatic recreation/reassignment surprise.
          for(const entry of Object.values(next.assignments))if(entry.folderId===removed.id)
            Object.assign(entry,{folderId:null,source:'manual',reason:'Folder deleted; chat kept Ungrouped.'});
          for(const scan of Object.values(next.scans))if(scan.suggestion===removed.id)scan.suggestion=null;
          next.generation++;
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
        } else if(op.type==='reset_auto') {
          verifyRoot(op.rootId,exists);
          delete next.assignments[op.rootId];delete next.scans[op.rootId];
        } else if(op.type==='toggle_auto') {
          if(typeof op.enabled!=='boolean')throw error('Specify enabled as true or false.',400,'FOLDER_AUTO');
          next.autoEnabled=op.enabled;
        } else throw error('Unsupported folder operation.',400,'FOLDER_EDIT');
      }
      return true;
    },{expectedRevision:input.expectedRevision});
  }
  // Caller supplies at most 40 observed stable root IDs. Each candidate's
  // *current saved root title* and state must be resolved by the archive, not
  // trusted from the client. Active runs and the open chat are excluded.
  async autoStep({rootIds,resolve,excludeRootId=null}={}) {
    if(!Array.isArray(rootIds)||rootIds.length>AUTO_BATCH_LIMIT||
      rootIds.some(id=>typeof id!=='string'||!ID.test(id))||typeof resolve!=='function')
      throw error('Supply at most 40 saved conversation IDs.',400,'FOLDER_AUTO_BATCH');
    const unique=[...new Set(rootIds)];
    const accepted=unique.map(id=>id===excludeRootId?null:resolve(id)).filter(Boolean)
      .filter(item=>item.state!=='deleted' && !item.busy && typeof item.title==='string');
    const currentSnapshot=await this.mutate(next=>{
      if(!next.autoEnabled||!accepted.length)return false;
      let changed=false;
      for(const item of accepted) {
        const title=item.title.slice(0,120),signature=titleHash(title);
        const previous=next.scans[item.rootId],assigned=next.assignments[item.rootId];
        if(assigned?.source==='manual')continue;
        if(previous?.signature===signature&&previous.generation===next.generation)continue;
        const topic=candidateSubject(title);
        const scan={title,signature,generation:next.generation,topic:topic?.key||null,suggestion:null};
        if(assigned?.source==='automatic') {
          // No oscillation when a follow-up turn changes subject or a user
          // renames a chat: an explicit reset is the update trigger.
          scan.notice=previous?.signature!==signature ?
            'Title changed; automatic folder held until Reset to automatic.' : assigned.reason;
        } else {
          const match=matchFolders(title,next.folders);
          scan.suggestion=match.suggestion;
          scan.notice=match.reason;
          if(match.folderId)next.assignments[item.rootId]={folderId:match.folderId,source:'automatic',reason:match.reason};
        }
        next.scans[item.rootId]=scan;changed=true;
      }
      // No per-chat folders: only a repeated, distinctive title subject across
      // at least three different saved conversations can introduce one.
      const votes=new Map();
      for(const scan of Object.values(next.scans))if(scan.topic) {
        const entry=votes.get(scan.topic)||{count:0,label:candidateSubject(scan.title)?.label||scan.topic};
        entry.count++;votes.set(scan.topic,entry);
      }
      const autoCount=next.folders.filter(item=>item.origin==='automatic').length;
      let capacity=Math.max(0,AUTO_FOLDER_LIMIT-autoCount);
      if(next.autoEnabled&&capacity)for(const [topic,vote] of [...votes].sort((a,b)=>b[1].count-a[1].count)) {
        if(!capacity)break;
        if(vote.count<3||next.suppressed.includes(topic)||next.folders.some(folder=>keyOf(folder.name)===topic))continue;
        next.folders.push({id:'fld_'+randomUUID().replaceAll('-',''),name:folderName(vote.label),origin:'automatic'});
        capacity--;next.generation++;changed=true;
      }
      // Revisit this bounded batch after discovery. Other checked chats are
      // revisited incrementally on subsequent foreground passes.
      if(changed)for(const item of accepted) {
        if(next.assignments[item.rootId])continue;
        const match=matchFolders(item.title,next.folders);
        if(match.folderId)next.assignments[item.rootId]={folderId:match.folderId,source:'automatic',reason:match.reason};
        if(next.scans[item.rootId]){
          next.scans[item.rootId].generation=next.generation;
          next.scans[item.rootId].suggestion=match.suggestion;
          next.scans[item.rootId].notice=match.reason;
        }
      }
      const keys=Object.keys(next.scans);
      if(keys.length>MAX_SCANS)for(const id of keys.slice(0,keys.length-MAX_SCANS))delete next.scans[id];
      return changed;
    });
    return {...currentSnapshot,acceptedRootIds:accepted.map(item=>item.rootId),updated:unique.map(rootId=>({rootId,...this.forConversation(rootId)}))};
  }
}
