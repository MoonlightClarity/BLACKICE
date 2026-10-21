import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const MAX_TEXT=1024*1024;
const hash=text=>createHash('sha256').update(text).digest('hex');
const fail=(message,status=409)=>Object.assign(new Error(message),{status,code:'PATCH_CONFLICT'});
const check=signal=>{if(signal?.aborted)throw Object.assign(new Error('Patch cancelled.'),{name:'AbortError',code:'ABORT_ERR'});};
const validId=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(id);

/** Replace exactly one literal span, preserving surrounding text and Windows line endings. */
export function patchText(text,oldText,newText){
  if(typeof text!=='string'||typeof oldText!=='string'||!oldText||typeof newText!=='string')throw fail('Supply non-empty oldText and string newText.',400);
  if(oldText.includes('\0')||newText.includes('\0'))throw fail('Patches accept UTF-8 text, not binary data.',400);
  const normalized=text.replace(/\r\n/g,'\n'),needle=oldText.replace(/\r\n/g,'\n'),first=normalized.indexOf(needle);
  if(first<0)throw fail('The old text no longer matches. Read the current content and retry.');
  if(normalized.indexOf(needle,first+1)>=0)throw fail('The old text matches more than once. Include more surrounding text.');
  const offset=index=>{let original=0,seen=0;while(seen<index){if(text[original]==='\r'&&text[original+1]==='\n')original++;original++;seen++;}return original;};
  const start=offset(first),end=offset(first+needle.length),span=text.slice(start,end);
  const crlf=span.includes('\r\n')||(!span.includes('\n')&&text.includes('\r\n')&&!text.replace(/\r\n/g,'').includes('\n'));
  const replacement=crlf?newText.replace(/\r\n/g,'\n').replace(/\n/g,'\r\n'):newText;
  const content=text.slice(0,start)+replacement+text.slice(end);
  if(Buffer.byteLength(content)>MAX_TEXT)throw fail('This patch exceeds the 1 MiB text-file limit.',413);
  if(content===text)throw fail('This patch would not change the file.',400);
  return content;
}

/** Durable patch receipts live in the Relay profile, outside the user's project. */
export class FilePatchStore{
  constructor({dataDir,io=fs}={}){if(!dataDir)throw new Error('A patch history directory is required.');this.directory=path.join(path.resolve(dataDir),'file-patches');this.io=io;this.locks=new Map();this.pending=new Set();this.closed=false;}
  file(id){if(!validId(id))throw fail('Invalid patch ID.',400);return path.join(this.directory,id+'.json');}
  async save(record){await this.io.mkdir(this.directory,{recursive:true});const file=this.file(record.id),temp=file+'.'+randomUUID()+'.tmp';try{const handle=await this.io.open(temp,'wx',0o600);try{await handle.writeFile(JSON.stringify(record));await handle.sync();}finally{await handle.close();}await this.io.rename(temp,file);}finally{await this.io.rm(temp,{force:true}).catch(()=>{});}}
  async get(id){const file=this.file(id);let stat;try{stat=await this.io.stat(file);}catch(error){if(error.code==='ENOENT')throw fail('Patch history entry not found.',404);throw error;}if(stat.size>16*MAX_TEXT)throw fail('This patch receipt is too large to read.',413);const record=JSON.parse(await this.io.readFile(file,'utf8'));if(record.version!==1||record.id!==id||!path.isAbsolute(record.path)||typeof record.before!=='string'||typeof record.after!=='string'||hash(record.before)!==record.beforeHash||hash(record.after)!==record.afterHash)throw fail('This patch receipt is damaged. Existing files were preserved.',500);return record;}
  async list({cwd,runId,limit=100,offset=0}={}){
    if(!Number.isSafeInteger(limit)||limit<1||limit>500||!Number.isSafeInteger(offset)||offset<0)throw fail('Use a valid history page.',400);
    let names;try{names=await this.io.readdir(this.directory);}catch(error){if(error.code==='ENOENT')return{patches:[],total:0,hasMore:false};throw error;}
    const entries=[];let damaged=0;
    for(const name of names){if(!/^[a-zA-Z0-9_-]+\.json$/.test(name))continue;try{const record=await this.get(name.slice(0,-5));if(cwd&&path.resolve(record.cwd)!==path.resolve(cwd)||runId&&record.runId!==runId)continue;const{before,after,...metadata}=record;entries.push(metadata);}catch{damaged++;}}
    entries.sort((a,b)=>b.at.localeCompare(a.at)||b.id.localeCompare(a.id));
    return{patches:entries.slice(offset,offset+limit),total:entries.length,hasMore:offset+limit<entries.length,damaged};
  }
  async read(file){const stat=await this.io.stat(file);if(!stat.isFile()||stat.size>MAX_TEXT)throw fail('Choose a regular UTF-8 file no larger than 1 MiB.',413);const bytes=await this.io.readFile(file);if(bytes.includes(0))throw fail('Patches accept text files, not binary data.',400);let text;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw fail('This file is not valid UTF-8 text.',400);}return{text,mode:stat.mode&0o777};}
  async serialized(file,operation){if(this.closed)throw fail('Patch history is shutting down.',503);const key=process.platform==='win32'?file.toLowerCase():file,previous=this.locks.get(key)||Promise.resolve();const next=previous.catch(()=>{}).then(operation);this.locks.set(key,next);this.pending.add(next);try{return await next;}finally{this.pending.delete(next);if(this.locks.get(key)===next)this.locks.delete(key);}}
  async replace(file,before,after,{cwd,source='agent',runId,nodeId,undoOf,signal}={}){
    check(signal);const id=randomUUID(),record={version:1,id,path:file,cwd:path.resolve(cwd||path.dirname(file)),at:new Date().toISOString(),action:undoOf?'undo':'patch',source,...(runId?{runId}:{}),...(nodeId?{nodeId}:{}),...(undoOf?{undoOf}:{}),before:before.text,after,beforeHash:hash(before.text),afterHash:hash(after),status:'prepared'};
    await this.save(record);check(signal);
    const temp=path.join(path.dirname(file),'.'+path.basename(file)+'.relay-patch-'+id+'.tmp');
    try{
      await this.io.writeFile(temp,after,{encoding:'utf8',mode:before.mode,...(signal?{signal}:{})});
      check(signal);if(hash((await this.read(file)).text)!==record.beforeHash)throw fail('The file changed while this patch was being prepared. Read it and retry.');
      await this.io.rename(temp,file);
      record.status='applied';try{await this.save(record);}catch{return{...this.metadata(record),auditReceiptPending:true};}
      return this.metadata(record);
    }catch(error){record.status=signal?.aborted?'cancelled':'not_applied';await this.save(record).catch(()=>{});throw error;}finally{await this.io.rm(temp,{force:true}).catch(()=>{});}
  }
  metadata(record){const{before,after,...metadata}=record;return metadata;}
  async patch({cwd,path:relative,oldText,newText,expectedHash,signal,runId,nodeId,source='agent'}){
    if(!path.isAbsolute(cwd||'')||typeof relative!=='string'||!relative||relative.includes('\0'))throw fail('Choose a working folder and file path.',400);
    const file=await this.io.realpath(path.resolve(cwd,relative));
    return this.serialized(file,async()=>{check(signal);const before=await this.read(file);if(expectedHash!==undefined&&expectedHash!==hash(before.text))throw fail('The file hash changed. Read the latest file before patching.');const after=patchText(before.text,oldText,newText);return this.replace(file,before,after,{cwd,source,runId,nodeId,signal});});
  }
  async undo(id,{signal,source='user',runId,nodeId}={}){
    const record=await this.get(id),file=await this.io.realpath(record.path);
    if(record.status!=='applied'&&record.status!=='prepared')throw fail('This patch was not applied.');
    if(file!==record.path)throw fail('The patch destination moved. Existing files were preserved.');
    return this.serialized(file,async()=>{check(signal);const before=await this.read(file);if(hash(before.text)!==record.afterHash)throw fail('This file has newer changes. Undo the newer patch first, or edit the current file.');return this.replace(file,before,record.before,{cwd:record.cwd,source,runId,nodeId,undoOf:id,signal});});
  }
  async close(){this.closed=true;await Promise.allSettled([...this.pending]);}
}
