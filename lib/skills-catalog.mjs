import { searchReleaseSkills, readReleaseSkill } from './release-skills.mjs';
import { defaultSkillLibrary, legacySkillMetadata, readBundledSkill, rankSkillMetadata, skillSearchTerms, hasBundledSkill } from './skill-library.mjs';
import { SkillEditStore, skillDocumentTitle } from './skill-edits.mjs';
const fail = (message, status=400) => Object.assign(new Error(message), {status});
export function skillIdFromRequestPath(pathname) {
 if(typeof pathname!=='string'||!pathname.startsWith('/api/skills/'))return null;
 let id;try{id=decodeURIComponent(pathname.slice('/api/skills/'.length));}catch{return null;}
 return /^[a-zA-Z0-9_-]{1,100}$/.test(id)?id:null;
}
/** UI and model share effective content; only the human UI can save. */
export function createSkillsCatalog({dataDir, library=defaultSkillLibrary}={}){
 const store=dataDir?new SkillEditStore({dataDir, bundledHas:id=>hasBundledSkill(id,library)}):null;
 const fallback=id=>({id,title:id.replace(/^builtin-/,'').replaceAll('-',' '),revision:1});
 const effective=(base,edit)=>{
   const heading=typeof edit?.content==='string'? skillDocumentTitle(edit.content):null;
   const {summary,appliesWhen,scope,aliases,...visible}=base;
   return {...visible,title:heading?.slice(0,200)||base.title||fallback(base.id).title,revision:edit?.revision??base.revision,source:typeof edit?.content==='string'?'user':'bundled',immutable:true,userEditable:Boolean(store),loaded:edit?.deleted?'deleted':'available_on_demand',...(edit?.deleted?{deleted:true}:{})};
 };
 const add=({id, edits, base})=>effective(base??fallback(id),edits[id]);
 async function entry(id,edits){
   const edit=edits[id];
   if(edit?.deleted)throw fail('Skill is deleted.',404);
   if(typeof edit?.content==='string'){
    const base=legacySkillMetadata().find(row=>row.id===id)??(id.startsWith('library-')?await library.metadata(id):null);
    return {...add({id,edits,base}),content:edit.content};
   }
   return effective(await readBundledSkill(id,library),edit);
 }
 return {
  async list({query='',source='all',offset=0,limit}={}){
   if(!['all','bundled','user','deleted'].includes(source))throw fail('Unsupported skill source.');
   searchReleaseSkills(query); // shared query validation
   if(!Number.isSafeInteger(offset)||offset<0||limit!==undefined&&(!Number.isSafeInteger(limit)||limit<1))throw fail('Invalid skill metadata page.');
   const edits=store?await store.read():{},terms=skillSearchTerms(query);
   const legacy=legacySkillMetadata(),manifest=await library.list(), combined=legacy.concat(manifest);
   const ids=new Set(combined.map(row=>row.id));
   const candidates=combined.map(base=>({base,id:base.id}));
   for(const [id,edit] of Object.entries(edits)) if(!ids.has(id)&&typeof edit.content==='string')candidates.push({id});
   const hits=[];
   for(const item of candidates){
    const row=add({id:item.id,edits,base:item.base});
    if(source==='deleted'?!row.deleted:row.deleted||source!=='all'&&row.source!==source)continue;
    // Preserve body lookup for the original three inline skills and the bounded user overlay.
    // Packaged library bodies never participate in discovery.
    const legacyBody=terms.length?(edits[row.id]?.content??(row.id.startsWith('builtin-')&&item.base?readReleaseSkill(row.id).content:'')).toLowerCase():'';
    const score=query.trim()&&!terms.length?-1:rankSkillMetadata({...item.base,...row},terms,legacyBody,query);
    if(score>=0)hits.push({row,score});
   }
   if(terms.length)hits.sort((a,b)=>b.score-a.score||a.row.id.localeCompare(b.row.id));
   const entries=hits.slice(offset,limit===undefined?undefined:offset+limit).map(item=>item.row);
   const nextOffset=offset+entries.length<hits.length?offset+entries.length:null;
   let bundled=0,user=0;for(const {row} of hits)if(row.source==='bundled')bundled++;else user++;
   return {entries,totalMatches:hits.length,nextOffset,sources:{bundled:{status:'available',count:bundled},user:{status:'available',count:user}},truncated:nextOffset!==null,explanation:'Skills are read on demand. Human edits persist; models cannot edit through skill tools. Catalog presence does not prove use.'};
  },
  async detail({id}={}){const edits=store?await store.read():{};return entry(id,edits);},
  async create({value}){if(!store)throw fail('Skill editing unavailable.',503);const {id,...edit}=await store.create(value);return entry(id,{[id]:edit});},
  async save({id,value}){if(!store)throw fail('Skill editing unavailable.',503);const edit=await store.save(id,value);return entry(id,{[id]:edit});},
  async delete({id,value}){if(!store)throw fail('Skill editing unavailable.',503);const edit=await store.delete(id,value);return {id,revision:edit.revision,deleted:true};},
  async restore({id,value}){if(!store)throw fail('Skill editing unavailable.',503);const edit=await store.restore(id,value);return entry(id,{[id]:edit});},
  async close(){await store?.close();}
 };
}
