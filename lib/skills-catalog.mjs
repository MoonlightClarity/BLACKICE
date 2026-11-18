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
 const effective=(base,edits)=>({...base,...edits[base.id],source:edits[base.id]?'user':'bundled',immutable:true,userEditable:Boolean(store)});
 return {
  async list({query='',source='all'}={}){
   if(!['all','bundled','user'].includes(source))throw Object.assign(new Error('Unsupported skill source.'),{status:400});
   searchReleaseSkills(query); // shared query validation
   const edits=store?await store.read():{}, terms=query.toLowerCase().trim().split(/\s+/).filter(Boolean);
   const entries=searchReleaseSkills().map(base=>effective(base,edits)).map(({content,...row})=>row).filter(row=>(source==='all'||row.source===source)&&terms.every(term=>`${row.title} ${row.summary} ${row.scope} ${row.appliesWhen}`.toLowerCase().includes(term)));
   return {entries,sources:{bundled:{status:'available',count:entries.filter(x=>x.source==='bundled').length},user:{status:'available',count:entries.filter(x=>x.source==='user').length}},truncated:false,explanation:'Skills are read on demand. Human edits persist; models cannot edit through skill tools. Catalog presence does not prove use.'};
  },
  async detail({id}={}){const base=readReleaseSkill(id);return effective(base,store?await store.read():{});},
  async save({id,value}){if(!store)throw Object.assign(new Error('Skill editing unavailable.'),{status:503});const edit=await store.save(id,value);return effective(readReleaseSkill(id),{[id]:edit});},
  async close(){await store?.close();}
 };
}
