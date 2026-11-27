import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {hasBundledSkill} from './skill-library.mjs';
import {SkillEditStore} from './skill-edits.mjs';
const fail=(message,status=400)=>Object.assign(Error(message),{status});
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const id=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(value);
const categories=new Set(['Data & spreadsheets','Documents','General methods','Research & web','Software & QA','Visual communication','Writing & handoffs','Other skills'].map(name=>'category:'+name));
const runtimeRoots=new Set(['system','planning','execution','tool','skill'].map(name=>'runtime:'+name));
const anchor=value=>categories.has(value)||runtimeRoots.has(value);
const runtimeKey=value=>typeof value==='string'&&/^(layer|tool):[a-zA-Z0-9_.:-]{1,180}$/.test(value);
const parentKey=value=>value===null?'runtime:skill':value;
const blank=()=>({version:1,revision:0,folders:[],assignments:{},removedCategories:[],runtimeAssignments:{}});
function validate(value){
 if(!plain(value)||value.version!==1||!Number.isSafeInteger(value.revision)||value.revision<0||!Array.isArray(value.folders)||value.folders.length>250||!plain(value.assignments))throw fail('Invalid skills folder document.',503);
 if(value.removedCategories===undefined)value.removedCategories=[];
 if(value.runtimeAssignments===undefined)value.runtimeAssignments={};
 if(!plain(value.runtimeAssignments)||Object.keys(value.runtimeAssignments).length>5000)throw fail('Invalid runtime item assignments.',503);
 if(!Array.isArray(value.removedCategories)||value.removedCategories.length>categories.size
  ||value.removedCategories.some(name=>!categories.has(name)||name==='category:Other skills')
  ||new Set(value.removedCategories).size!==value.removedCategories.length)throw fail('Invalid removed category folders.',503);
 const ids=new Set(),names=new Set();
 for(const row of value.folders){
  if(!plain(row)||!id(row.id)||ids.has(row.id)||typeof row.name!=='string'||!row.name.trim()||row.name!==row.name.trim()||row.name.length>60||row.parentId!==null&&!id(row.parentId)&&!anchor(row.parentId))throw fail('Invalid skills folder.',503);
  const name=JSON.stringify([parentKey(row.parentId),row.name.toLocaleLowerCase()]);if(names.has(name))throw fail('Duplicate folder name.',409);ids.add(row.id);names.add(name);
 }
 for(const row of value.folders){
  const seen=new Set([row.id]);let parent=row.parentId;
  while(parent!==null&&!anchor(parent)){if(!ids.has(parent)||seen.has(parent)||seen.size>=32)throw fail('Folder nesting must be acyclic and at most 32 levels.',400);seen.add(parent);parent=value.folders.find(x=>x.id===parent).parentId;}
 }
 if(Object.keys(value.assignments).length>1000)throw fail('Too many skill assignments.');
 for(const [skill,folder]of Object.entries(value.assignments))if(!id(skill)||folder!==null&&!ids.has(folder)&&!anchor(folder))throw fail('Invalid skill folder assignment.',503);
 for(const [item,folder] of Object.entries(value.runtimeAssignments))if(!runtimeKey(item)||folder!==null&&!ids.has(folder)&&!anchor(folder))throw fail('Invalid runtime item assignment.',503);
 return value;
}
/** One presentation-only organization store for Runtime, retaining legacy skill folders and placements. */
export class SkillFolderStore{
 constructor({dataDir}){this.file=path.join(dataDir,'skills-folders.json');this.edits=new SkillEditStore({dataDir});this.tail=Promise.resolve();}
 async read(){await this.tail.catch(()=>{});return this.load();}
 async load(){try{const text=await fs.readFile(this.file,'utf8');if(Buffer.byteLength(text)>1024*1024)throw fail('Skills folders exceed size limit.',503);return validate(JSON.parse(text));}catch(e){if(e.code==='ENOENT')return blank();throw e;}}
 mutate(value){
  const pending=this.tail.catch(()=>{}).then(async()=>{
   if(!plain(value)||!Number.isSafeInteger(value.expectedRevision))throw fail('Supply the current folder revision.');
   const allowed={create:['id','name','parentId'],update:['id','name','parentId'],remove:['id','relocateContents'],assign:['skillId','folderId'],assign_runtime:['itemKey','folderId'],remove_category:['category'],restore_category:['category']}[value.action];
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
    const relocateChildren=(from,to)=>{
     const occupied=new Set(state.folders.filter(row=>row.id!==from&&parentKey(row.parentId)===parentKey(to)).map(row=>row.name.toLocaleLowerCase()));
     for(const child of state.folders.filter(row=>row.parentId===from)){
      const original=child.name;let suffix=2;
      while(occupied.has(child.name.toLocaleLowerCase())){const tail=' ('+(suffix++)+')';child.name=original.slice(0,60-tail.length)+tail;}
      occupied.add(child.name.toLocaleLowerCase());child.parentId=to;
     }
    };
    const availableParent=parent=>{if(parent!==null&&!anchor(parent))find(parent);if(state.removedCategories.includes(parent))throw fail('Category no longer exists. Refresh before editing.',409);};
    if(value.action==='create'){availableParent(value.parentId??null);if(!id(value.id)||state.folders.some(x=>x.id===value.id))throw fail('Use a new folder ID.');state.folders.push({id:value.id,name:value.name?.trim(),parentId:value.parentId??null});}
    if(value.action==='update'){const row=find(value.id);if('name'in value)row.name=value.name?.trim();if('parentId'in value){availableParent(value.parentId);row.parentId=value.parentId;}}
    if(value.action==='remove'){
     const target=find(value.id);
     const occupied=state.folders.some(x=>x.parentId===value.id)||Object.values(state.assignments).includes(value.id)||Object.values(state.runtimeAssignments).includes(value.id);
     if(value.relocateContents!==undefined&&typeof value.relocateContents!=='boolean')throw fail('relocateContents must be Boolean.');
     if(occupied&&!value.relocateContents)throw fail('Move skills and child folders out before deleting this folder.',409);
     if(value.relocateContents){
      relocateChildren(value.id,target.parentId);
      for(const [skill,folderId] of Object.entries(state.assignments))if(folderId===value.id)state.assignments[skill]=target.parentId;
      for(const [item,folderId] of Object.entries(state.runtimeAssignments))if(folderId===value.id)state.runtimeAssignments[item]=parentKey(target.parentId);
     }
     state.folders=state.folders.filter(x=>x.id!==value.id);
    }
    if(value.action==='remove_category'||value.action==='restore_category'){
     if(!categories.has(value.category)||value.category==='category:Other skills')throw fail('Unknown category folder.',404);
     if(value.action==='remove_category'){
      if(!state.removedCategories.includes(value.category))state.removedCategories.push(value.category);
      relocateChildren(value.category,null);
      for(const [skill,folder] of Object.entries(state.assignments))if(folder===value.category)state.assignments[skill]=null;
      for(const [item,folder] of Object.entries(state.runtimeAssignments))if(folder===value.category)state.runtimeAssignments[item]='runtime:skill';
     }else state.removedCategories=state.removedCategories.filter(name=>name!==value.category);
    }
    if(value.action==='assign'){
     if(!id(value.skillId))throw fail('Skill not found.',404);
     if(!(value.folderId===null&&orphaned.has(value.skillId))){
      if(!await hasBundledSkill(value.skillId)&&typeof saved[value.skillId]?.content!=='string')throw fail('Release skill not found.',404);
      if(value.folderId!==null&&!anchor(value.folderId))find(value.folderId);
      state.assignments[value.skillId]=state.removedCategories.includes(value.folderId)?null:value.folderId;
     }
    }
    if(value.action==='assign_runtime'){
     if(!runtimeKey(value.itemKey))throw fail('Use a runtime layer or tool ID.');
     availableParent(value.folderId);
     if(value.folderId===null)delete state.runtimeAssignments[value.itemKey];else state.runtimeAssignments[value.itemKey]=value.folderId;
    }
    state.revision++;validate(state);
    const handle=await fs.open(temp,'wx');try{await handle.writeFile(JSON.stringify(state,null,2));await handle.sync();}finally{await handle.close();}
    await fs.rename(temp,this.file);return structuredClone(state);
   }finally{await fs.unlink(temp).catch(()=>{});await lock.close();await fs.unlink(this.file+'.lock');}
  });this.tail=pending;return pending;
 }
 async close(){await this.tail.catch(()=>{});}
}
