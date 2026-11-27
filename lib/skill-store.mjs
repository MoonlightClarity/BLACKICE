import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { skillDocumentTitle, skillApplicability } from './skill-document-metadata.mjs';
import { skillBodySearchTerms } from './skill-library.mjs';

const fail=(message,status=400,code)=>Object.assign(new Error(message),{status,...(code?{code}:{})});
const busy=()=>fail('Another skill edit is in progress. Retry after it settles.',409);
const plain=x=>x&&typeof x==='object'&&!Array.isArray(x);
const hash=text=>createHash('sha256').update(text).digest('hex');
const dead=pid=>{if(!Number.isSafeInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return false;}catch(e){return e.code==='ESRCH';}};
const initializing=new Map();
export const SKILL_EDIT_LIMITS=Object.freeze({content:200000});
export function skillEditFields(value){
 const result={};
 for(const [key,max] of Object.entries(SKILL_EDIT_LIMITS)){
  if(typeof value[key]!=='string'||!value[key].trim()||value[key].length>max)throw fail('Skill '+key+' must be nonempty text of at most '+max+' characters.');
  result[key]=value[key];
 }
 return result;
}
export function validateSkillEdit(id,row){
 if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id))throw fail('Invalid skill ID.',503);
 if(!plain(row)||!Number.isSafeInteger(row.revision)||row.revision<2)throw fail('Invalid skill revision.',503);
 if(row.deleted!==undefined&&typeof row.deleted!=='boolean')throw fail('Invalid skill deletion state.',503);
 if(row.content!==undefined)skillEditFields(row);else if(row.deleted!==true&&row.bundled!==true)throw fail('Missing skill document.',503);
 return row;
}
export function skillEditMetadata(row){
 const hasContent=typeof row.content==='string',title=hasContent?skillDocumentTitle(row.content)?.slice(0,200):null;
 return {revision:row.revision,...(row.deleted===undefined?{}:{deleted:row.deleted}),...(row.bundled===undefined?{}:{bundled:row.bundled}),hasContent,...(title?{title}:{}),...skillApplicability(hasContent?row.content:'')};
}
export function skillStoreVersion(db,key='owner_generation'){
 const value=db.prepare('SELECT value FROM skill_store_state WHERE key=?').get(key)?.value;
 const version=Number(value);
 if(typeof value!=='string'||!/^(0|[1-9][0-9]*)$/.test(value)||!Number.isSafeInteger(version)||version<0)throw fail('Invalid skill store generation.',503);
 return version;
}
export function bumpSkillStoreVersion(db,key='owner_generation'){
 const version=skillStoreVersion(db,key);
 if(version>=Number.MAX_SAFE_INTEGER)throw fail('Skill store generation limit reached.',409);
 db.prepare('UPDATE skill_store_state SET value=? WHERE key=?').run(String(version+1),key);
 return version+1;
}
const encodedTerm=term=>'t'+hash(term);
export function indexSkillEditBody(db,id,content){
 const row=db.prepare('SELECT rowid FROM skill_edits WHERE id=?').get(id);
 if(!row)return;
 db.prepare('DELETE FROM skill_body_terms WHERE rowid=?').run(row.rowid);
 if(typeof content==='string')db.prepare('INSERT INTO skill_body_terms(rowid,id,terms) VALUES(?,?,?)').run(row.rowid,id,skillBodySearchTerms(content).map(encodedTerm).join(' '));
}
export function searchSkillBodyTerms(db,terms){
 if(!Array.isArray(terms)||terms.some(term=>typeof term!=='string'))throw fail('Use skill search terms.');
 const matches=new Map(),query=db.prepare('SELECT id FROM skill_body_terms WHERE terms MATCH ?');
 for(const term of new Set(terms)){
  for(const token of skillBodySearchTerms(term)){
   for(const {id} of query.all('"'+encodedTerm(token)+'"')){
    if(!matches.has(id))matches.set(id,new Set());
    matches.get(id).add(term);
   }
  }
 }
 return Object.fromEntries([...matches].map(([id,values])=>[id,[...values]]));
}
export function removeSkillEdit(db,id){
 const row=db.prepare('SELECT rowid FROM skill_edits WHERE id=?').get(id);
 if(!row)return false;
 db.prepare('DELETE FROM skill_body_terms WHERE rowid=?').run(row.rowid);
 db.prepare('DELETE FROM skill_edits WHERE id=?').run(id);
 return true;
}
export function promoteSkillEdits(db,requests){
 const promoted=[],skipped=[];
 for(const request of requests){
  const {id,expectedRevision,contentHash}=request;
  if(typeof id!=='string'||!Number.isSafeInteger(expectedRevision)||expectedRevision<2||!/^[a-f0-9]{64}$/.test(contentHash))throw fail('Invalid skill promotion request.');
  const saved=db.prepare('SELECT rowid,record_json FROM skill_edits WHERE id=?').get(id);
  if(!saved){skipped.push({id,reason:'no-owner-record'});continue;}
  const row=validateSkillEdit(id,JSON.parse(saved.record_json));
  const reason=row.deleted?'deleted':row.revision!==expectedRevision?'revision-changed':typeof row.content!=='string'?'no-owner-content':hash(row.content)!==contentHash?'content-changed':null;
  if(reason){skipped.push({id,reason});continue;}
  const base=db.prepare('SELECT content_hash,revision,content FROM installed_skills WHERE id=?').get(id);
  if(!base||base.content_hash!==contentHash||hash(base.content)!==contentHash||base.revision<row.revision)throw fail('A matching installed skill must exist before promoting its owner copy.',409);
  removeSkillEdit(db,id);promoted.push(id);
 }
 if(promoted.length)bumpSkillStoreVersion(db);
 return {promoted,skipped};
}

/** One durable database. Bodies, metadata, and generations commit atomically. */
export class SkillStoreDatabase{
 constructor({dataDir}){
  this.file=path.join(dataDir,'skill-edits','skills.sqlite');
  this.legacyFile=path.join(dataDir,'skill-edits','skills.json');
  this.tail=Promise.resolve();this.ready=null;this.legacyCache=null;
 }
 async publishLock(file,token){
  const temp=file+'.'+randomUUID()+'.tmp';let handle,published=false;
  try{handle=await fs.open(temp,'wx');await handle.writeFile(JSON.stringify({pid:process.pid,token}));await handle.sync();await fs.link(temp,file);published=true;return handle;}
  finally{if(!published)await handle?.close();await fs.unlink(temp).catch(()=>{});}
 }
 async releaseLock(file,handle,token){await handle.close();try{if(JSON.parse(await fs.readFile(file,'utf8')).token===token)await fs.unlink(file);}catch(e){if(e.code!=='ENOENT')throw e;}}
 async acquireLock(file,token,depth=0){
  if(depth>16)throw busy();
  try{return await this.publishLock(file,token);}catch(e){if(e.code!=='EEXIST')throw e;}
  let raw,owner;
  try{const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)throw busy();raw=await fs.readFile(file,'utf8');owner=JSON.parse(raw);}catch{throw busy();}
  if(!dead(owner.pid)||typeof owner.token!=='string'||!owner.token)throw busy();
  const claim=file+'.reclaim-'+hash(raw).slice(0,24),handle=await this.acquireLock(claim,token,depth+1);
  try{
   let current;try{current=await fs.readFile(file,'utf8');}catch{throw busy();}
   if(current!==raw||!dead(owner.pid))throw busy();
   await fs.unlink(file);
   try{return await this.publishLock(file,token);}catch(e){if(e.code==='EEXIST')throw busy();throw e;}
  }finally{await this.releaseLock(claim,handle,token);}
 }
 async legacy(includeRaw=false){
  let stat;
  try{stat=await fs.stat(this.legacyFile,{bigint:true});}catch(e){if(e.code==='ENOENT')return {hash:'missing',raw:null};throw e;}
  const signature=[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
  if(!includeRaw&&this.legacyCache?.signature===signature)return this.legacyCache;
  const raw=await fs.readFile(this.legacyFile,'utf8'),value={signature,hash:hash(raw)};
  this.legacyCache=value;return includeRaw?{...value,raw}:value;
 }
 async checkLegacy(db){
  const expected=db.prepare("SELECT value FROM skill_store_state WHERE key='legacy_sha256'").get()?.value;
  if(typeof expected!=='string')throw fail('Missing legacy skill migration marker.',503);
  if((await this.legacy()).hash!==expected)throw fail('The legacy skill file changed after migration. Its changes are preserved; reconcile them before editing skills.',409,'SKILL_LEGACY_CHANGED');
 }
 async initialize(){
  if(this.ready)return this.ready;
  let task=initializing.get(this.file);
  if(!task){
   task=(async()=>{
    await fs.mkdir(path.dirname(this.file),{recursive:true});
    let existing;
    try{
     await fs.stat(this.file);existing=new DatabaseSync(this.file);existing.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=0');
     const stateTable=existing.prepare("SELECT name FROM sqlite_master WHERE name='skill_store_state'").get();
     const indexed=existing.prepare("SELECT name FROM sqlite_master WHERE name='skill_body_terms'").get();
     if(stateTable&&indexed&&existing.prepare("SELECT value FROM skill_store_state WHERE key='schema_version'").get()?.value==='1'&&existing.prepare("SELECT value FROM skill_store_state WHERE key='body_index_version'").get()?.value==='sha256-v1'){
      skillStoreVersion(existing);skillStoreVersion(existing,'installed_generation');await this.checkLegacy(existing);return;
     }
    }catch(e){if(e.code!=='ENOENT')throw e;}finally{existing?.close();}
    const token=randomUUID(),lock=await this.acquireLock(this.file+'.lock',token);let db;
    try{
     db=new DatabaseSync(this.file);db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
     const bodyIndexPresent=Boolean(db.prepare("SELECT name FROM sqlite_master WHERE name='skill_body_terms'").get());
     db.exec('CREATE TABLE IF NOT EXISTS skill_store_state(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS skill_edits(id TEXT PRIMARY KEY,record_json TEXT NOT NULL,metadata_json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS installed_skills(id TEXT PRIMARY KEY,metadata_json TEXT NOT NULL,content TEXT NOT NULL,content_hash TEXT NOT NULL,revision INTEGER NOT NULL); CREATE VIRTUAL TABLE IF NOT EXISTS skill_body_terms USING fts5(id UNINDEXED,terms)');
     const version=db.prepare("SELECT value FROM skill_store_state WHERE key='schema_version'").get()?.value;
     if(version===undefined){
      const legacy=await this.legacy(true);
      const state=legacy.raw===null?{version:1,entries:{}}:JSON.parse(legacy.raw);
      if(!plain(state)||state.version!==1||!plain(state.entries))throw fail('Invalid legacy skill edits document.',503);
      const insert=db.prepare('INSERT INTO skill_edits(id,record_json,metadata_json) VALUES(?,?,?)');
      for(const [id,row] of Object.entries(state.entries)){validateSkillEdit(id,row);insert.run(id,JSON.stringify(row),JSON.stringify(skillEditMetadata(row)));}
      const put=db.prepare('INSERT INTO skill_store_state(key,value) VALUES(?,?)');
      put.run('schema_version','1');put.run('owner_generation',Object.keys(state.entries).length?'1':'0');put.run('installed_generation','0');put.run('legacy_sha256',legacy.hash);
     }else{
      if(version!=='1')throw fail('Unsupported skill database schema.',503);
      skillStoreVersion(db);skillStoreVersion(db,'installed_generation');await this.checkLegacy(db);
     }
     if(!bodyIndexPresent||db.prepare("SELECT value FROM skill_store_state WHERE key='body_index_version'").get()?.value!=='sha256-v1'){
      db.exec('DELETE FROM skill_body_terms');
      for(const saved of db.prepare('SELECT id,record_json FROM skill_edits').all()){const row=validateSkillEdit(saved.id,JSON.parse(saved.record_json));indexSkillEditBody(db,saved.id,row.content);}
      db.prepare("INSERT INTO skill_store_state(key,value) VALUES('body_index_version','sha256-v1') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
     }
     db.exec('COMMIT');
    }catch(e){if(db?.isTransaction)db.exec('ROLLBACK');throw e;}
    finally{db?.close();await this.releaseLock(this.file+'.lock',lock,token);}
   })();
   initializing.set(this.file,task);
   task.finally(()=>{if(initializing.get(this.file)===task)initializing.delete(this.file);}).catch(()=>{});
  }
  this.ready=task.catch(e=>{this.ready=null;throw e;});return this.ready;
 }
 async read(callback){
  await this.tail.catch(()=>{});await this.initialize();
  const db=new DatabaseSync(this.file);
  try{
   db.exec('PRAGMA busy_timeout=0; PRAGMA query_only=ON');
   await this.checkLegacy(db);db.exec('BEGIN');
   const result=callback(db);
   if(result&&typeof result.then==='function')throw fail('Skill store callbacks must be synchronous.',500);
   db.exec('COMMIT');return result;
  }catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}finally{db.close();}
 }
 transaction(callback){
  const pending=this.tail.catch(()=>{}).then(async()=>{
   await this.initialize();
   const token=randomUUID(),lock=await this.acquireLock(this.file+'.lock',token);let db;
   try{
    db=new DatabaseSync(this.file);db.exec('PRAGMA synchronous=FULL; PRAGMA busy_timeout=0');await this.checkLegacy(db);db.exec('BEGIN IMMEDIATE');
    const result=callback(db);
    if(result&&typeof result.then==='function')throw fail('Skill store callbacks must be synchronous.',500);
    await this.checkLegacy(db);db.exec('COMMIT');return result;
   }catch(e){if(db?.isTransaction)db.exec('ROLLBACK');if(/database is locked/i.test(e.message))throw busy();throw e;}
   finally{db?.close();await this.releaseLock(this.file+'.lock',lock,token);}
  });this.tail=pending;return pending;
 }
 async close(){await this.tail.catch(()=>{});await this.ready?.catch(()=>{});}
}
