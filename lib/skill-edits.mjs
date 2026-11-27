import { randomUUID } from 'node:crypto';
import { hasBundledSkill } from './skill-library.mjs';
import { skillDocumentTitle } from './skill-document-metadata.mjs';
import { SkillStoreDatabase, SKILL_EDIT_LIMITS, skillEditFields, validateSkillEdit, skillEditMetadata, skillStoreVersion, bumpSkillStoreVersion, indexSkillEditBody, searchSkillBodyTerms, removeSkillEdit } from './skill-store.mjs';
export { skillDocumentTitle, SKILL_EDIT_LIMITS };
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const plain=x=>x&&typeof x==='object'&&!Array.isArray(x);
const decode=(id,value)=>value?validateSkillEdit(id,JSON.parse(value.record_json)):undefined;

/** Revisioned owner documents backed by independent durable SQLite rows. */
export class SkillEditStore{
 constructor({dataDir,bundledHas=hasBundledSkill,bundledRevision=async()=>1}){
  this.bundledHas=bundledHas;this.bundledRevision=bundledRevision;
  this.database=new SkillStoreDatabase({dataDir});this.file=this.database.file;this.legacyFile=this.database.legacyFile;this.tail=Promise.resolve();
 }
 publishLock(...args){return this.database.publishLock(...args);}
 releaseLock(...args){return this.database.releaseLock(...args);}
 acquireLock(...args){return this.database.acquireLock(...args);}
 async load(){return this.database.read(db=>({version:1,entries:Object.fromEntries(db.prepare('SELECT id,record_json FROM skill_edits').all().map(row=>[row.id,decode(row.id,row)]))}));}
 async read(){await this.tail.catch(()=>{});return (await this.load()).entries;}
 async readOne(id){await this.tail.catch(()=>{});return this.database.read(db=>decode(id,db.prepare('SELECT record_json FROM skill_edits WHERE id=?').get(id)));}
 async listMetadata(){await this.tail.catch(()=>{});return this.database.read(db=>({version:skillStoreVersion(db),entries:Object.fromEntries(db.prepare('SELECT id,metadata_json FROM skill_edits').all().map(row=>[row.id,JSON.parse(row.metadata_json)]))}));}
 async searchBodyTerms(terms){await this.tail.catch(()=>{});return this.database.read(db=>searchSkillBodyTerms(db,terms));}
 async getVersion(){await this.tail.catch(()=>{});return this.database.read(db=>skillStoreVersion(db));}
 create(value){return this.mutate('user-'+randomUUID(),value,'create');}
 save(id,value){return this.mutate(id,value,'save');}
 delete(id,value){return this.mutate(id,value,'delete');}
 restore(id,value){return this.mutate(id,value,'restore');}
 mutate(id,value,action){
  const pending=this.tail.catch(()=>{}).then(async()=>{
   if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(id))throw fail('Skill not found.',404);
   if(!['create','save','delete','restore'].includes(action))throw fail('Unsupported skill mutation.');
   const creating=action==='create',writing=creating||action==='save';
   const allowed=[...(creating?[]:['expectedRevision']),...(writing?Object.keys(SKILL_EDIT_LIMITS):[])];
   if(!plain(value)||Object.keys(value).some(k=>!allowed.includes(k))||(!creating&&(!Number.isSafeInteger(value.expectedRevision)||value.expectedRevision<1)))throw fail(creating?'Supply the skill document as content.':'Supply the current skill revision and supported edit fields.');
   const edited=writing?skillEditFields(value):null;
   if(creating&&!skillDocumentTitle(edited.content))throw fail('Start the skill with a Markdown title, for example # My Skill.');
   const externalBase=await this.bundledHas(id),externalRevision=externalBase?await this.bundledRevision(id):1;
   return this.database.transaction(db=>{
    const current=decode(id,db.prepare('SELECT record_json FROM skill_edits WHERE id=?').get(id));
    const installed=db.prepare('SELECT revision FROM installed_skills WHERE id=?').get(id);
    const baseExists=Boolean(installed)||externalBase,baseRevision=installed?.revision??externalRevision;
    let row;
    if(creating){
     if(current||baseExists)throw fail('Skill ID already exists. Retry creation.',409);
     row={...edited,revision:2};
    }else{
     if(typeof current?.content!=='string'&&!baseExists)throw fail('Release skill not found.',404);
     const revision=current?.revision??baseRevision;
     if(!Number.isSafeInteger(revision)||revision<1)throw fail('Invalid base skill revision.',503);
     if(revision!==value.expectedRevision)throw fail('Skill changed. Your draft was not saved. Refresh before retrying.',409);
     if(revision>=Number.MAX_SAFE_INTEGER)throw fail('Skill revision limit reached.',409);
     if(action==='restore'&&!current?.deleted)throw fail('Skill is not deleted. Refresh before retrying.',409);
     if(action!=='restore'&&current?.deleted)throw fail('Skill was deleted. Restore it before editing.',409);
     if(action==='restore'&&installed&&typeof current?.content!=='string'){
      const restoredRevision=Math.max(revision,installed.revision)+1;
      if(!Number.isSafeInteger(restoredRevision))throw fail('Skill revision limit reached.',409);
      db.prepare('UPDATE installed_skills SET revision=? WHERE id=?').run(restoredRevision,id);
      removeSkillEdit(db,id);bumpSkillStoreVersion(db);bumpSkillStoreVersion(db,'installed_generation');
      return {revision:restoredRevision,bundled:true};
     }
     if(action==='save')row={...edited,revision:revision+1};
     else row={...(typeof current?.content==='string'?{content:current.content}:{}),revision:revision+1,...(action==='delete'?{deleted:true}:typeof current?.content==='string'?{}:{bundled:true})};
    }
    validateSkillEdit(id,row);
    db.prepare('INSERT INTO skill_edits(id,record_json,metadata_json) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json,metadata_json=excluded.metadata_json').run(id,JSON.stringify(row),JSON.stringify(skillEditMetadata(row)));
    indexSkillEditBody(db,id,row.content);bumpSkillStoreVersion(db);return structuredClone(creating?{id,...row}:row);
   });
  });this.tail=pending;return pending;
 }
 async close(){await this.tail.catch(()=>{});await this.database.close();}
}
