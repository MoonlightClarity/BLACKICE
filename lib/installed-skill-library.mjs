import {createHash} from 'node:crypto';
import path from 'node:path';
import {createSkillLibrary} from './skill-library.mjs';
import {SkillStoreDatabase,skillStoreVersion,bumpSkillStoreVersion,promoteSkillEdits,validateSkillEdit,removeSkillEdit} from './skill-store.mjs';

const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const hash=value=>createHash('sha256').update(value).digest('hex');
const validId=id=>typeof id==='string'&&/^library-[a-z0-9][a-z0-9-]{0,91}$/.test(id);
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
function project(row){
 if(!row)return null;
 let metadata;try{metadata=JSON.parse(row.metadata_json);}catch{throw fail('Invalid installed skill metadata.',503);}
 if(!plain(metadata)||metadata.id!==row.id||!validId(row.id)||typeof metadata.title!=='string'
   ||!Array.isArray(metadata.tags)||!Array.isArray(metadata.aliases)||!plain(metadata.provenance)
   ||!Number.isSafeInteger(row.revision)||row.revision<1||!/^[a-f0-9]{64}$/.test(row.content_hash))
  throw fail('Invalid installed skill record.',503);
 // Source retains the existing base/owner distinction. Catalog names the
 // physical origin; a distinct effective revision prevents stale body reuse.
 return {...metadata,tags:[...metadata.tags],aliases:[...metadata.aliases],
  provenance:{...metadata.provenance,packageRevision:metadata.provenance.revision,
   revision:'installed:'+row.revision+':'+row.content_hash},
  revision:row.revision,source:'bundled',catalog:'installed',
  immutable:true,loaded:'available_on_demand'};
}
const columns='id,metadata_json,content_hash,revision';

/** Durable installed base documents use the native manifest and catalog API.
 * Owner edits remain a separate overlay in the same transactional database.
 */
export class InstalledSkillLibrary{
 constructor({dataDir}){this.database=new SkillStoreDatabase({dataDir});}
 async getVersion(){return this.database.read(db=>skillStoreVersion(db,'installed_generation'));}
 async listMetadata(){
  return this.database.read(db=>({version:skillStoreVersion(db,'installed_generation'),
   entries:db.prepare('SELECT '+columns+' FROM installed_skills ORDER BY rowid').all().map(project)}));
 }
 async list(){return (await this.listMetadata()).entries;}
 async metadata(id){
  if(!validId(id))return null;
  return this.database.read(db=>project(db.prepare('SELECT '+columns+' FROM installed_skills WHERE id=?').get(id)));
 }
 async has(id){return Boolean(await this.metadata(id));}
 async read(id){
  if(!validId(id))throw fail('Installed skill not found.',404);
  return this.database.read(db=>{
   const row=db.prepare('SELECT '+columns+',content FROM installed_skills WHERE id=?').get(id);
   if(!row)throw fail('Installed skill not found.',404);
   if(typeof row.content!=='string'||!row.content.trim()||row.content.length>200000||row.content.includes('\0')
     ||hash(row.content)!==row.content_hash)throw fail('Invalid installed skill body.',503);
   return {...project(row),content:row.content};
  });
 }
 async install({root,ids,expectedVersion,promotions=[]}={}){
  if(typeof root!=='string'||!path.isAbsolute(root)||!Number.isSafeInteger(expectedVersion)||expectedVersion<0)
   throw fail('Supply an absolute native skill-library path and the current installed catalog version.');
  if(ids!==undefined&&(!Array.isArray(ids)||!ids.length||ids.some(id=>!validId(id))||new Set(ids).size!==ids.length))
   throw fail('Use distinct native library skill IDs.');
  if(!Array.isArray(promotions))throw fail('Use a list of exact owner-copy promotion requests.');
  const promoteById=new Map();
  for(const row of promotions){
   if(!plain(row)||Object.keys(row).some(key=>!['id','expectedRevision','contentHash'].includes(key))
     ||!validId(row.id)||!Number.isSafeInteger(row.expectedRevision)||row.expectedRevision<2
     ||!/^[a-f0-9]{64}$/.test(row.contentHash)||promoteById.has(row.id))
    throw fail('Invalid or duplicate owner-copy promotion request.');
   promoteById.set(row.id,row);
  }
  // Stage and validate every requested native document before entering a
  // transaction. A missing/invalid body cannot publish a partial collection.
  const source=createSkillLibrary({root}),available=await source.list(),byId=new Map(available.map(row=>[row.id,row]));
  const selected=ids??available.map(row=>row.id),staged=[];
  for(const id of selected){
   if(!byId.has(id))throw fail('Requested skill is absent from the native manifest: '+id,404);
   const value=await source.read(id);
   const {content,revision,source:origin,immutable,loaded,...metadata}=value;
   const contentHash=hash(content);
   if(promoteById.has(id)&&promoteById.get(id).contentHash!==contentHash)
    throw fail('A promotion fingerprint must match the installed source body.',409);
   staged.push({id,metadataJSON:JSON.stringify(metadata),content,contentHash});
  }
  const stagedIds=new Set(staged.map(row=>row.id));
  if([...promoteById.keys()].some(id=>!stagedIds.has(id)))throw fail('Every promoted copy must be in this native installation.');
  return this.database.transaction(db=>{
   const currentVersion=skillStoreVersion(db,'installed_generation');
   if(currentVersion!==expectedVersion)throw fail('Installed skills changed. Refresh before retrying installation.',409);
   const find=db.prepare('SELECT '+columns+' FROM installed_skills WHERE id=?');
   const put=db.prepare('INSERT INTO installed_skills(id,metadata_json,content,content_hash,revision) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET metadata_json=excluded.metadata_json,content=excluded.content,content_hash=excluded.content_hash,revision=excluded.revision');
   const changed=[],foldedMarkers=[];
   const ownerRead=db.prepare('SELECT record_json FROM skill_edits WHERE id=?');
   for(const row of staged){
    const current=find.get(row.id),promotion=promoteById.get(row.id);
    const saved=ownerRead.get(row.id),owner=saved?validateSkillEdit(row.id,JSON.parse(saved.record_json)):null;
    const inherited=owner?.bundled===true&&!owner.deleted&&typeof owner.content!=='string';
    const same=current?.metadata_json===row.metadataJSON&&current?.content_hash===row.contentHash;
    let revision=current?(same?current.revision:current.revision+1):1;
    if(promotion)revision=Math.max(revision,promotion.expectedRevision);
    if(inherited)revision=Math.max(revision,owner.revision+(same?0:1));
    if(!Number.isSafeInteger(revision)||revision<1)throw fail('Installed skill revision limit reached.',409);
    if(!same||revision!==current.revision){
     put.run(row.id,row.metadataJSON,row.content,row.contentHash,revision);changed.push(row.id);
    }
    if(inherited){removeSkillEdit(db,row.id);foldedMarkers.push(row.id);}
   }
   const promotion=promoteSkillEdits(db,promotions);
   if(foldedMarkers.length&&!promotion.promoted.length)bumpSkillStoreVersion(db);
   const version=changed.length?bumpSkillStoreVersion(db,'installed_generation'):currentVersion;
   return {version,installed:staged.length,changed,foldedMarkers,...promotion};
  });
 }
 async close(){await this.database.close();}
}
