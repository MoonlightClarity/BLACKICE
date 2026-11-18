import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readReleaseSkill } from './release-skills.mjs';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const plain=x=>x&&typeof x==='object'&&!Array.isArray(x);
export const SKILL_EDIT_LIMITS=Object.freeze({title:160,summary:2000,appliesWhen:4000,scope:4000,content:200000});
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
 async load(){try{const raw=await fs.readFile(this.file,'utf8');if(Buffer.byteLength(raw)>8*1024*1024)throw fail('Skill edits exceed size limit.',503);return validate(JSON.parse(raw));}catch(e){if(e.code==='ENOENT')return {version:1,entries:{}};throw e;}}
 async read(){await this.tail.catch(()=>{});return structuredClone((await this.load()).entries);}
 save(id,value){const pending=this.tail.catch(()=>{}).then(async()=>{
  readReleaseSkill(id);
  if(!plain(value)||Object.keys(value).some(k=>!['expectedRevision',...Object.keys(SKILL_EDIT_LIMITS)].includes(k))||!Number.isSafeInteger(value.expectedRevision)||value.expectedRevision<1)throw fail('Supply the current skill revision and supported edit fields.');
  const edited=fields(value);await fs.mkdir(path.dirname(this.file),{recursive:true});
  let lock;try{lock=await fs.open(this.file+'.lock','wx');}catch(e){if(e.code==='EEXIST')throw fail('Another skill edit is in progress. Refresh before retrying.',409);throw e;}
  const temp=this.file+'.'+randomUUID()+'.tmp';
  try{
   const state=await this.load(), revision=state.entries[id]?.revision??1;
   if(revision!==value.expectedRevision)throw fail('Skill changed. Your draft was not saved. Refresh before retrying.',409);
   if(revision>=Number.MAX_SAFE_INTEGER)throw fail('Skill revision limit reached.',409);
   state.entries[id]={...edited,revision:revision+1};validate(state);
   const raw=JSON.stringify(state,null,2);if(Buffer.byteLength(raw)>8*1024*1024)throw fail('Skill edits exceed size limit.');
   const handle=await fs.open(temp,'wx');try{await handle.writeFile(raw);await handle.sync();}finally{await handle.close();}
   await fs.rename(temp,this.file);return structuredClone(state.entries[id]);
  }finally{await fs.unlink(temp).catch(()=>{});await lock.close();await fs.unlink(this.file+'.lock');}
 });this.tail=pending;return pending;}
 async close(){await this.tail.catch(()=>{});}
}
