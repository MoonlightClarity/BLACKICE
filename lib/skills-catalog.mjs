import { searchReleaseSkills, readReleaseSkill } from './release-skills.mjs';
import { SkillEditStore } from './skill-edits.mjs';
export function skillIdFromRequestPath(pathname) {
 if(typeof pathname!=='string'||!pathname.startsWith('/api/skills/'))return null;
 let id;try{id=decodeURIComponent(pathname.slice('/api/skills/'.length));}catch{return null;}
 return /^builtin-[a-z0-9-]+$/.test(id)?id:null;
}
/** UI and model read the same effective content; only the human UI can save. */
export function createSkillsCatalog({dataDir}={}){
 const store=dataDir?new SkillEditStore({dataDir}):null;
 const effective=(base,edits)=>{
   const edit=edits[base.id],content=edit?.content??base.content;
   const heading=/^#\s+(.+)$/m.exec(content)?.[1]?.trim();
   return {id:base.id,title:heading||base.id,revision:edit?.revision??base.revision,source:typeof edit?.content==='string'?'user':'bundled',immutable:true,userEditable:Boolean(store),loaded:edit?.deleted?'deleted':'available_on_demand',...(edit?.deleted?{deleted:true}:{}),content};
  };
 return {
  async list({query='',source='all'}={}){
   if(!['all','bundled','user','deleted'].includes(source))throw Object.assign(new Error('Unsupported skill source.'),{status:400});
   searchReleaseSkills(query); // shared query validation
   const edits=store?await store.read():{}, terms=query.toLowerCase().trim().split(/\s+/).filter(Boolean);
   const entries=searchReleaseSkills().map(base=>effective(readReleaseSkill(base.id),edits)).filter(row=>(source==='deleted'?row.deleted:!row.deleted&&(source==='all'||row.source===source))&&terms.every(term=>row.content.toLowerCase().includes(term))).map(({content,...row})=>row);
   return {entries,sources:{bundled:{status:'available',count:entries.filter(x=>x.source==='bundled').length},user:{status:'available',count:entries.filter(x=>x.source==='user').length}},truncated:false,explanation:'Skills are read on demand. Human edits persist; models cannot edit through skill tools. Catalog presence does not prove use.'};
  },
  async detail({id}={}){const base=readReleaseSkill(id),entry=effective(base,store?await store.read():{});if(entry.deleted)throw Object.assign(new Error('Skill is deleted.'),{status:404});return entry;},
  async save({id,value}){if(!store)throw Object.assign(new Error('Skill editing unavailable.'),{status:503});const edit=await store.save(id,value);return effective(readReleaseSkill(id),{[id]:edit});},
  async delete({id,value}){if(!store)throw Object.assign(new Error('Skill editing unavailable.'),{status:503});const edit=await store.delete(id,value);return {id,revision:edit.revision,deleted:true};},
  async restore({id,value}){if(!store)throw Object.assign(new Error('Skill editing unavailable.'),{status:503});const edit=await store.restore(id,value);return effective(readReleaseSkill(id),{[id]:edit});},
  async close(){await store?.close();}
 };
}
