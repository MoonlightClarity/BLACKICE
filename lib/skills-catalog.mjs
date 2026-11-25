import { searchReleaseSkills, readReleaseSkill } from './release-skills.mjs';
import { defaultSkillLibrary, legacySkillMetadata, readBundledSkill, rankSkillMetadata, skillSearchTerms, hasBundledSkill } from './skill-library.mjs';
import { SkillEditStore, skillDocumentTitle } from './skill-edits.mjs';
import { SkillHybridIndex, hybridSkillScore } from './skill-hybrid-retrieval.mjs';
const fail = (message, status=400) => Object.assign(new Error(message), {status});
export function skillIdFromRequestPath(pathname) {
 if(typeof pathname!=='string'||!pathname.startsWith('/api/skills/'))return null;
 let id;try{id=decodeURIComponent(pathname.slice('/api/skills/'.length));}catch{return null;}
 return /^[a-zA-Z0-9_-]{1,100}$/.test(id)?id:null;
}
// Method applicability is independent of skill origin. A bounded declaration
// can be supplied by packaged metadata or owner-authored Markdown front matter.
const ACTIVATION = new Set(['substantive-analysis','dependent-work','competing-interpretations','judgment']);
export function skillApplicability(content,base={}){
 const text=typeof content==='string'?content.replace(/^\uFEFF/,''):'';
 const match=/^---[ \t]*\r?\n([\s\S]{0,8192}?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
 const fields={};
 if(match)for(const line of match[1].split(/\r?\n/)){
  const m=/^(activation|applies_to|does_not_apply_to|scope|description):[ \t]*(.*)$/.exec(line);
  if(m&&!Object.hasOwn(fields,m[1]))fields[m[1]]=m[2].slice(0,500);
 }
 const clean=v=>String(v||'').replace(/\s+/g,' ').trim();
 const body=match?text.slice(match[0].length):text;
 const intro=body.replace(/^\s*#[ \t]+[^\r\n]+[\r\n]+/,'').trim().split(/\r?\n\s*\r?\n|\r?\n\s*#{1,6}\s/)[0]?.trim();
 const declared=Object.hasOwn(fields,'activation')||Array.isArray(base.activation);
 const activation=[...new Set((Object.hasOwn(fields,'activation')?fields.activation.replace(/^\[|\]$/g,'').split(',').map(v=>v.trim()):base.activation||[]).filter(v=>ACTIVATION.has(v)))];
 const description=clean(fields.description||fields.applies_to||(!/^(?:#|[-*]\s|\x60{3}|~{3}|>)/.test(intro||'')?intro:'')||base.description||base.summary||base.appliesWhen).slice(0,260);
 return {description,activation,activationDeclared:declared,appliesWhen:clean(fields.applies_to||base.appliesWhen).slice(0,500),scope:clean(fields.scope||base.scope).slice(0,500),exclusions:clean(fields.does_not_apply_to).slice(0,500)};
}

/** UI and model share effective content; edits use the same revisioned store. */
export function createSkillsCatalog({dataDir, library=defaultSkillLibrary}={}){
 const store=dataDir?new SkillEditStore({dataDir, bundledHas:id=>hasBundledSkill(id,library)}):null;
 const index=new SkillHybridIndex();
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
   // Rebuild the disposable FTS index from the effective revisions, never
   // reading packaged bodies. A user-created skill contributes its brief
   // introductory purpose, not unbounded instructions or later examples.
   const indexed=candidates.map(item=>{
    const row=add({id:item.id,edits,base:item.base});
    const content=edits[item.id]?.content;
    const applicability=skillApplicability(content,item.base);
    return {row,metadata:{...item.base,...row,...applicability,tags:item.base?.tags||[],aliases:item.base?.aliases||[]}};
   });
   index.refresh(indexed.map(item=>item.metadata));
   const boosts=index.score(query),hits=[];
   for(let i=0;i<candidates.length;i++){
    const item=candidates[i],{row,metadata}=indexed[i];
    if(source==='deleted'?!row.deleted:row.deleted||source!=='all'&&row.source!==source)continue;
    // Preserve user overlay/legacy body matching without inspecting packaged
    // library skill bodies during search.
    const legacyBody=terms.length?(edits[row.id]?.content??(row.id.startsWith('builtin-')&&item.base?readReleaseSkill(row.id).content:'')).toLowerCase():'';
    const lexical=query.trim()&&!terms.length?-1:rankSkillMetadata(metadata,terms,legacyBody,query);
    const score=hybridSkillScore(metadata,query,lexical,boosts.get(row.id)||0);
    if(score>=0)hits.push({row,score,lexical});
   }
   // When a skill already matches the query's distinctive metadata strongly,
   // exclude speculative concept-only hits. A broad 'document review' skill
   // should not appear for a query specifically about auditing claims.
   const eligible=hits.some(hit=>hit.lexical>=24)?hits.filter(hit=>hit.lexical>=0):hits;
   if(terms.length)eligible.sort((a,b)=>b.score-a.score||a.row.id.localeCompare(b.row.id));
   const entries=eligible.slice(offset,limit===undefined?undefined:offset+limit).map(item=>item.row);
   const nextOffset=offset+entries.length<eligible.length?offset+entries.length:null;
   let bundled=0,user=0;for(const {row} of eligible)if(row.source==='bundled')bundled++;else user++;
   return {entries,totalMatches:eligible.length,nextOffset,sources:{bundled:{status:'available',count:bundled},user:{status:'available',count:user}},truncated:nextOffset!==null,explanation:'Skills are read on demand. Saved edits persist across lookups. Catalog presence does not prove use.'};
  },
  // A task's retrieval index is metadata, not an instruction or a loaded
  // method. Owner-created documents have no manifest entry, so project their
  // actual introductory purpose in addition to the effective saved title.
  async taskMetadata(){
   const edits=store?await store.read():{};
   const combined=[...legacySkillMetadata(),...await library.list()];
   const known=new Set(combined.map(row=>row.id));
   for(const [id,edit] of Object.entries(edits)){
    if(!known.has(id)&&typeof edit.content==='string')combined.push(fallback(id));
   }
   return combined.flatMap(base=>{
    const edit=edits[base.id];
    if(edit?.deleted)return [];
    const row=effective(base,edit);
    const ownerCreated=!known.has(base.id);
    const applicability=skillApplicability(edit?.content,base);
    return [{id:row.id,title:row.title,...applicability,summary:base.summary||'',
      source:row.source,revision:row.source==='user'?row.revision:(row.provenance?.revision??row.revision),
      tags:base.tags||[],aliases:base.aliases||[],ownerCreated}];
   });
  },
  async detail({id}={}){const edits=store?await store.read():{};return entry(id,edits);},
  async create({value}){if(!store)throw fail('Skill editing unavailable.',503);const {id,...edit}=await store.create(value);return entry(id,{[id]:edit});},
  async save({id,value}){if(!store)throw fail('Skill editing unavailable.',503);const edit=await store.save(id,value);return entry(id,{[id]:edit});},
  async delete({id,value}){if(!store)throw fail('Skill editing unavailable.',503);const edit=await store.delete(id,value);return {id,revision:edit.revision,deleted:true};},
  async restore({id,value}){if(!store)throw fail('Skill editing unavailable.',503);const edit=await store.restore(id,value);return entry(id,{[id]:edit});},
  async close(){index.close();await store?.close();}
 };
}
