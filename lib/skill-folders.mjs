import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {hasBundledSkill} from './skill-library.mjs';
import {SkillEditStore} from './skill-edits.mjs';
const fail=(message,status=400)=>Object.assign(Error(message),{status});
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const id=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(value);
const categories=new Set(['Data & spreadsheets','Documents','General methods','Research & web','Software & QA','Visual communication','Writing & handoffs','Other skills'].map(name=>'category:'+name));
const blank=()=>({version:1,revision:0,folders:[],assignments:{}});
function validate(value){
 if(!plain(value)||value.version!==1||!Number.isSafeInteger(value.revision)||value.revision<0||!Array.isArray(value.folders)||value.folders.length>250||!plain(value.assignments))throw fail('Invalid skills folder document.',503);
 const ids=new Set(),names=new Set();
 for(const row of value.folders){
  if(!plain(row)||!id(row.id)||ids.has(row.id)||typeof row.name!=='string'||!row.name.trim()||row.name!==row.name.trim()||row.name.length>60||row.parentId!==null&&!id(row.parentId))throw fail('Invalid skills folder.',503);
  const name=JSON.stringify([row.parentId,row.name.toLocaleLowerCase()]);if(names.has(name))throw fail('Duplicate folder name.',409);ids.add(row.id);names.add(name);
 }
 for(const row of value.folders){
  const seen=new Set([row.id]);let parent=row.parentId;
  while(parent!==null){if(!ids.has(parent)||seen.has(parent)||seen.size>=32)throw fail('Folder nesting must be acyclic and at most 32 levels.',400);seen.add(parent);parent=value.folders.find(x=>x.id===parent).parentId;}
 }
 if(Object.keys(value.assignments).length>1000)throw fail('Too many skill assignments.');
 for(const [skill,folder]of Object.entries(value.assignments))if(!id(skill)||folder!==null&&!ids.has(folder)&&!categories.has(folder))throw fail('Invalid skill folder assignment.',503);
 return value;
}
/** Organization only: release skill contents and model context are never changed. */
export class SkillFolderStore{
 constructor({dataDir}){this.file=path.join(dataDir,'skills-folders.json');this.edits=new SkillEditStore({dataDir});this.tail=Promise.resolve();}
 async read(){await this.tail.catch(()=>{});return this.load();}
 async load(){try{const text=await fs.readFile(this.file,'utf8');if(Buffer.byteLength(text)>1024*1024)throw fail('Skills folders exceed size limit.',503);return validate(JSON.parse(text));}catch(e){if(e.code==='ENOENT')return blank();throw e;}}
 mutate(value){
  const pending=this.tail.catch(()=>{}).then(async()=>{
   if(!plain(value)||!Number.isSafeInteger(value.expectedRevision))throw fail('Supply the current folder revision.');
   const allowed={create:['id','name','parentId'],update:['id','name','parentId'],remove:['id','relocateContents'],assign:['skillId','folderId']}[value.action];
   if(!allowed||Object.keys(value).some(k=>!['action','expectedRevision',...allowed].includes(k)))throw fail('Use the supported folder operation and fields.');
   await fs.mkdir(path.dirname(this.file),{recursive:true});
   let lock;try{lock=await fs.open(this.file+'.lock','wx');}catch(e){if(e.code==='EEXIST')throw fail('Another folder edit is in progress. Refresh before retrying.',409);throw e;}
   const temp=this.file+'.'+randomUUID()+'.tmp';
   try{
    const state=await this.load();if(state.revision!==value.expectedRevision)throw fail('Folders changed. Refresh before editing.',409);
    const saved=await this.edits.read(), orphaned=new Set();
    for(const skill of Object.keys(state.assignments)){
     if(!await hasBundledSkill(skill)&&typeof saved[skill]?.content!=='string'){orphaned.add(skill);delete state.assignments[skill];}
    }
    const find=id=>{const row=state.folders.find(x=>x.id===id);if(!row)throw fail('Folder not found.',404);return row;};
    if(value.action==='create'){if(!id(value.id)||state.folders.some(x=>x.id===value.id))throw fail('Use a new folder ID.');state.folders.push({id:value.id,name:value.name?.trim(),parentId:value.parentId??null});}
    if(value.action==='update'){const row=find(value.id);if('name'in value)row.name=value.name?.trim();if('parentId'in value)row.parentId=value.parentId;}
    if(value.action==='remove'){
     const target=find(value.id);
     const occupied=state.folders.some(x=>x.parentId===value.id)||Object.values(state.assignments).includes(value.id);
     if(value.relocateContents!==undefined&&typeof value.relocateContents!=='boolean')throw fail('relocateContents must be Boolean.');
     if(occupied&&!value.relocateContents)throw fail('Move skills and child folders out before deleting this folder.',409);
     if(value.relocateContents){
      for(const child of state.folders)if(child.parentId===value.id)child.parentId=target.parentId;
      for(const [skill,folderId] of Object.entries(state.assignments))if(folderId===value.id)state.assignments[skill]=target.parentId;
     }
     state.folders=state.folders.filter(x=>x.id!==value.id);
    }
    if(value.action==='assign'){
     if(!id(value.skillId))throw fail('Skill not found.',404);
     if(!(value.folderId===null&&orphaned.has(value.skillId))){
      if(!await hasBundledSkill(value.skillId)&&typeof saved[value.skillId]?.content!=='string')throw fail('Release skill not found.',404);
      if(value.folderId!==null&&!categories.has(value.folderId))find(value.folderId);state.assignments[value.skillId]=value.folderId;
     }
    }
    state.revision++;validate(state);
    const handle=await fs.open(temp,'wx');try{await handle.writeFile(JSON.stringify(state,null,2));await handle.sync();}finally{await handle.close();}
    await fs.rename(temp,this.file);return structuredClone(state);
   }finally{await fs.unlink(temp).catch(()=>{});await lock.close();await fs.unlink(this.file+'.lock');}
  });this.tail=pending;return pending;
 }
 async close(){await this.tail.catch(()=>{});}
}
