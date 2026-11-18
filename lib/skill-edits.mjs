import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { readReleaseSkill } from './release-skills.mjs';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const busy=()=>fail('Another skill edit is in progress. Retry after it settles.',409);
const dead=pid=>{if(!Number.isSafeInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return false;}catch(e){return e.code==='ESRCH';}};
const plain=x=>x&&typeof x==='object'&&!Array.isArray(x);
export const SKILL_EDIT_LIMITS=Object.freeze({content:200000});
function fields(value){
 const result={};
 for(const [key,max] of Object.entries(SKILL_EDIT_LIMITS)){
  if(typeof value[key]!=='string'||!value[key].trim()||value[key].length>max)throw fail(`Skill ${key} must be nonempty text of at most ${max} characters.`);
  result[key]=value[key];
 }
 return result;
}
function validate(state){
 if(!plain(state)||state.version!==1||!plain(state.entries)||Object.keys(state.entries).length>100)throw fail('Invalid skill edits document.',503);
 for(const [id,row] of Object.entries(state.entries)){
  readReleaseSkill(id);
  if(!plain(row)||!Number.isSafeInteger(row.revision)||row.revision<2)throw fail('Invalid skill revision.',503);
  fields(row);
 }
 return state;
}
/** Human-authored replacements only; never exposed as a model mutation tool. */
export class SkillEditStore{
 constructor({dataDir}){this.file=path.join(dataDir,'skill-edits','skills.json');this.tail=Promise.resolve();}
 // Publish complete ownership atomically: a crash cannot leave an empty lock.
 async publishLock(file,token){
  const temp=file+'.'+randomUUID()+'.tmp';let handle,published=false;
  try{handle=await fs.open(temp,'wx');await handle.writeFile(JSON.stringify({pid:process.pid,token}));await handle.sync();await fs.link(temp,file);published=true;return handle;}
  finally{if(!published)await handle?.close();await fs.unlink(temp).catch(()=>{});}
 }
 async releaseLock(file,handle,token){await handle.close();try{if(JSON.parse(await fs.readFile(file,'utf8')).token===token)await fs.unlink(file);}catch{}}
 async acquireLock(file,token,depth=0){
  if(depth>16)throw busy();
  try{return await this.publishLock(file,token);}catch(e){if(e.code!=='EEXIST')throw e;}
  let raw,owner;
  try{const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)throw busy();raw=await fs.readFile(file,'utf8');owner=JSON.parse(raw);}catch{throw busy();}
  // Never steal from a live/unknown PID, regardless of elapsed time.
  if(!dead(owner.pid)||typeof owner.token!=='string'||!owner.token)throw busy();
  const claim=file+'.reclaim-'+createHash('sha256').update(raw).digest('hex').slice(0,24);
  const handle=await this.acquireLock(claim,token,depth+1);
  try{
   // The per-owner claim prevents two reclaimers deleting a newly acquired lock.
   let current;try{current=await fs.readFile(file,'utf8');}catch{throw busy();}
   if(current!==raw||!dead(owner.pid))throw busy();
   await fs.unlink(file);
   try{return await this.publishLock(file,token);}catch(e){if(e.code==='EEXIST')throw busy();throw e;}
  }finally{await this.releaseLock(claim,handle,token);}
 }
 async load(){try{const raw=await fs.readFile(this.file,'utf8');if(Buffer.byteLength(raw)>8*1024*1024)throw fail('Skill edits exceed size limit.',503);return validate(JSON.parse(raw));}catch(e){if(e.code==='ENOENT')return {version:1,entries:{}};throw e;}}
 async read(){await this.tail.catch(()=>{});return structuredClone((await this.load()).entries);}
 save(id,value){const pending=this.tail.catch(()=>{}).then(async()=>{
  readReleaseSkill(id);
  if(!plain(value)||Object.keys(value).some(k=>!['expectedRevision',...Object.keys(SKILL_EDIT_LIMITS)].includes(k))||!Number.isSafeInteger(value.expectedRevision)||value.expectedRevision<1)throw fail('Supply the current skill revision and supported edit fields.');
  const edited=fields(value);await fs.mkdir(path.dirname(this.file),{recursive:true});
  const token=randomUUID(),lock=await this.acquireLock(this.file+'.lock',token);
  const temp=this.file+'.'+randomUUID()+'.tmp';
  try{
   const state=await this.load(), revision=state.entries[id]?.revision??1;
   if(revision!==value.expectedRevision)throw fail('Skill changed. Your draft was not saved. Refresh before retrying.',409);
   if(revision>=Number.MAX_SAFE_INTEGER)throw fail('Skill revision limit reached.',409);
   state.entries[id]={...edited,revision:revision+1};validate(state);
   const raw=JSON.stringify(state,null,2);if(Buffer.byteLength(raw)>8*1024*1024)throw fail('Skill edits exceed size limit.');
   const handle=await fs.open(temp,'wx');try{await handle.writeFile(raw);await handle.sync();}finally{await handle.close();}
   await fs.rename(temp,this.file);return structuredClone(state.entries[id]);
  }finally{await fs.unlink(temp).catch(()=>{});await this.releaseLock(this.file+'.lock',lock,token);}
 });this.tail=pending;return pending;}
 async close(){await this.tail.catch(()=>{});}
}
