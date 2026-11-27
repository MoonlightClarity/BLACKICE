import {createHash} from 'node:crypto';
import {searchReleaseSkills,readReleaseSkill} from './release-skills.mjs';
import {defaultSkillLibrary,legacySkillMetadata,readBundledSkill,rankSkillMetadata,skillSearchTerms} from './skill-library.mjs';
import {SkillEditStore} from './skill-edits.mjs';
import {skillDocumentTitle,skillApplicability} from './skill-document-metadata.mjs';
import {InstalledSkillLibrary} from './installed-skill-library.mjs';
import {SkillHybridIndex,hybridSkillScore} from './skill-hybrid-retrieval.mjs';
export {skillApplicability};
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const hash=value=>createHash('sha256').update(value).digest('hex');
export function skillIdFromRequestPath(pathname){
 if(typeof pathname!=='string'||!pathname.startsWith('/api/skills/'))return null;
 let id;try{id=decodeURIComponent(pathname.slice('/api/skills/'.length));}catch{return null;}
 return /^[a-zA-Z0-9_-]{1,100}$/.test(id)?id:null;
}
const projectEdit=edit=>edit?{...edit,hasContent:typeof edit.content==='string',
 ...(typeof edit.content==='string'?{title:skillDocumentTitle(edit.content)}:{}),
 ...skillApplicability(edit.content)}:undefined;
function applicability(base,edit){
 const declared=Boolean(edit?.activationDeclared),activation=declared?edit.activation:(base.activation||[]);
 return {description:edit?.description||base.description||base.summary||base.appliesWhen||'',
  activation:[...activation],activationDeclared:declared||Array.isArray(base.activation),
  appliesWhen:edit?.appliesWhen||base.appliesWhen||'',scope:edit?.scope||base.scope||'',
  exclusions:edit?.exclusions||base.exclusions||''};
}
const fallback=id=>({id,title:id.replace(/^builtin-/,'').replaceAll('-',' '),revision:1});
function effective(base,edit,editable){
 const {summary,appliesWhen,scope,aliases,...visible}=base;
 const detail=applicability(base,edit);
 return {...visible,title:edit?.title?.slice(0,200)||base.title||fallback(base.id).title,
  description:detail.description.slice(0,260),revision:edit?.revision??base.revision,
  source:edit?.hasContent?'user':'bundled',immutable:true,userEditable:editable,
  loaded:edit?.deleted?'deleted':'available_on_demand',...(edit?.deleted?{deleted:true}:{})};
}

/** One effective catalog: packaged base < installed base < owner override.
 * Browse and discovery use bounded metadata projections. Bodies are read only
 * by exact ID; explicit owner-body search uses its transactional token index.
 */
export function createSkillsCatalog({dataDir,library=defaultSkillLibrary}={}){
 const installed=dataDir?new InstalledSkillLibrary({dataDir}):null;
 const index=new SkillHybridIndex();
 let packagedPromise,cache;
 const packaged=()=>packagedPromise??=(async()=>{
  const entries=[...legacySkillMetadata(),...await library.list()];
  return {entries,fingerprint:hash(JSON.stringify(entries))};
 })();
 async function baseMetadata(id){
  const legacy=legacySkillMetadata().find(row=>row.id===id);
  if(legacy)return legacy;
  if(typeof id!=='string'||!id.startsWith('library-'))return null;
  return (installed?await installed.metadata(id):null)??await library.metadata(id);
 }
 const store=dataDir?new SkillEditStore({dataDir,
  bundledHas:async id=>Boolean(await baseMetadata(id)),
  bundledRevision:async id=>(await baseMetadata(id))?.revision??1}):null;
 const versions=async()=>Promise.all([store?store.getVersion():0,installed?installed.getVersion():0]);
 async function snapshot(){
  const pack=await packaged();
  for(let attempt=0;attempt<3;attempt++){
   const before=await versions(),key=pack.fingerprint+':'+before.join(':');
   if(cache?.key===key)return cache;
   const [owner,installation]=await Promise.all([
    store?store.listMetadata():{version:0,entries:{}},
    installed?installed.listMetadata():{version:0,entries:[]},
   ]);
   const after=await versions();
   if(after[0]!==owner.version||after[1]!==installation.version)continue;
   const bases=new Map(pack.entries.map(row=>[row.id,row]));
   for(const row of installation.entries)bases.set(row.id,row);
   const candidates=[...bases.values()].map(base=>({id:base.id,base}));
   for(const [id,edit] of Object.entries(owner.entries))
    if(!bases.has(id)&&edit.hasContent)candidates.push({id,base:fallback(id)});
   const items=candidates.map(({id,base})=>{
    const edit=owner.entries[id],row=effective(base,edit,Boolean(store));
    const metadata={id,title:row.title,...applicability(base,edit),summary:base.summary||'',
     source:row.source,revision:row.source==='user'?row.revision:(row.provenance?.revision??row.revision),
     tags:base.tags||[],aliases:base.aliases||[],ownerCreated:!bases.has(id),
     ...(row.catalog?{catalog:row.catalog}:{})};
    return {base,edit,row,metadata};
   });
   cache={key:pack.fingerprint+':'+after.join(':'),items,byId:new Map(items.map(item=>[item.row.id,item]))};
   return cache;
  }
  throw fail('The skill catalog changed during retrieval. Retry the current lookup.',409);
 }
 async function entry(id,provided){
  const edit=provided??(store?await store.readOne(id):undefined);
  if(edit?.deleted)throw fail('Skill is deleted.',404);
  const base=await baseMetadata(id),projected=projectEdit(edit);
  if(typeof edit?.content==='string')return {...effective(base??fallback(id),projected,Boolean(store)),content:edit.content};
  if(!base)throw fail('Release skill not found.',404);
  const source=base.catalog==='installed'?await installed.read(id):await readBundledSkill(id,library);
  return effective(source,projected,Boolean(store));
 }
 return {
  async has(id,{includeDeleted=true}={}){
   const item=(await snapshot()).byId.get(id);
   return Boolean(item&&(includeDeleted||!item.row.deleted));
  },
  async list({query='',source='all',offset=0,limit}={}){
   if(!['all','bundled','user','deleted'].includes(source))throw fail('Unsupported skill source.');
   searchReleaseSkills(query);
   if(!Number.isSafeInteger(offset)||offset<0||limit!==undefined&&(!Number.isSafeInteger(limit)||limit<1))
    throw fail('Invalid skill metadata page.');
   const current=await snapshot(),terms=skillSearchTerms(query);
   const allowed=current.items.filter(({row})=>source==='deleted'?row.deleted:!row.deleted&&(source==='all'||source===row.source));
   let eligible;
   if(!query.trim())eligible=allowed.map(item=>({row:item.row}));
   else if(!terms.length)eligible=[];
   else{
    index.refresh(current.items.map(item=>item.metadata));
    const boosts=index.score(query),bodyMatches=store?await store.searchBodyTerms(terms):{},hits=[];
    for(const item of allowed){
     const legacyBody=item.edit?.hasContent?(bodyMatches[item.row.id]||[]).join(' '):
      item.row.id.startsWith('builtin-')?readReleaseSkill(item.row.id).content:'';
     const lexical=rankSkillMetadata(item.metadata,terms,legacyBody,query);
     const score=hybridSkillScore(item.metadata,query,lexical,boosts.get(item.row.id)||0);
     if(score>=0)hits.push({row:item.row,score,lexical});
    }
    eligible=hits.some(hit=>hit.lexical>=24)?hits.filter(hit=>hit.lexical>=0):hits;
    eligible.sort((a,b)=>b.score-a.score||a.row.id.localeCompare(b.row.id));
   }
   const entries=eligible.slice(offset,limit===undefined?undefined:offset+limit).map(item=>structuredClone(item.row));
   const nextOffset=offset+entries.length<eligible.length?offset+entries.length:null;
   let bundled=0,user=0;for(const {row} of eligible)if(row.source==='bundled')bundled++;else user++;
   return {entries,totalMatches:eligible.length,nextOffset,catalogVersion:current.key,
    sources:{bundled:{status:'available',count:bundled},user:{status:'available',count:user}},
    truncated:nextOffset!==null,explanation:'Skills are read on demand. Saved edits persist across lookups. Catalog presence does not prove use.'};
  },
  async taskMetadata(){return (await snapshot()).items.filter(item=>!item.row.deleted).map(item=>structuredClone(item.metadata));},
  async detail({id}={}){return entry(id);},
  async create({value}){
   if(!store)throw fail('Skill editing unavailable.',503);
   const {id,...edit}=await store.create(value);return entry(id,edit);
  },
  async save({id,value}){
   if(!store)throw fail('Skill editing unavailable.',503);
   return entry(id,await store.save(id,value));
  },
  async delete({id,value}){
   if(!store)throw fail('Skill editing unavailable.',503);
   const edit=await store.delete(id,value);return {id,revision:edit.revision,deleted:true};
  },
  async restore({id,value}){
   if(!store)throw fail('Skill editing unavailable.',503);
   return entry(id,await store.restore(id,value));
  },
  async close(){index.close();await Promise.all([store?.close(),installed?.close()]);},
 };
}
