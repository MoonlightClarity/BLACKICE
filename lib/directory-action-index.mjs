// Experimental derived index. Immutable journal files remain authoritative.
import {DatabaseSync} from 'node:sqlite';
import {mkdir,readFile,readdir,open,unlink} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
const serial=new Map();
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=(code,message)=>Object.assign(new Error(message),{code});
const validId=id=>typeof id==='string'&&/^[a-f0-9]{64}$/.test(id);
export class DirectoryActionIndex {
 constructor(journal,{checkpoint=async()=>{}}={}){this.journal=journal;this.root=journal.root;this.checkpoint=checkpoint;this.pending=path.join(this.root,'index-pending');}
 async serialized(fn){const old=serial.get(this.root)||Promise.resolve(),next=old.catch(()=>{}).then(fn);serial.set(this.root,next);try{return await next;}finally{if(serial.get(this.root)===next)serial.delete(this.root);}}
 async open(){
  await mkdir(this.pending,{recursive:true});
  this.db=new DatabaseSync(path.join(this.root,'action-index.sqlite'));
  this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;');
  const tables=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name);
  if(tables.length){
   const indexes=this.db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(r=>r.name);
   if(['meta','events','edges','evidence','actions'].some(name=>!tables.includes(name))||['page_working','page_action','page_kind','page_unknown','outcome_attempt','action_heads','edge_parent','evidence_source','action_conflicts'].some(name=>!indexes.includes(name)))throw fail('DIRECTORY_INDEX_SCHEMA','Incomplete index schema retained; explicit offline reconstruction required.');
   return this;
  }
  this.db.exec(`
   CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   INSERT OR IGNORE INTO meta VALUES('generation','unbuilt');
   CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,digest TEXT,kind TEXT NOT NULL,action TEXT,attempt TEXT,body TEXT NOT NULL,working INTEGER NOT NULL,unknown INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS page_working ON events(working,id);
   CREATE INDEX IF NOT EXISTS page_action ON events(action,id);
   CREATE INDEX IF NOT EXISTS page_kind ON events(kind,id);
   CREATE INDEX IF NOT EXISTS page_unknown ON events(unknown,id);
   CREATE INDEX IF NOT EXISTS outcome_attempt ON events(attempt);
   CREATE INDEX IF NOT EXISTS action_heads ON events(action,kind,working,id);
   CREATE TABLE IF NOT EXISTS edges(child TEXT,parent TEXT,PRIMARY KEY(child,parent));
   CREATE INDEX IF NOT EXISTS edge_parent ON edges(parent);
   CREATE TABLE IF NOT EXISTS evidence(child TEXT,source TEXT,PRIMARY KEY(child,source));
   CREATE INDEX IF NOT EXISTS evidence_source ON evidence(source);
   CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY,heads INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS action_conflicts ON actions(heads,id);`);
  return this;
 }
 close(){this.db?.close();this.db=null;}
 generation(){return this.db.prepare("SELECT value FROM meta WHERE key='generation'").get().value;}
 async markers(){return readdir(this.pending);}
 async mark(){const name=randomUUID()+'.json',handle=await open(path.join(this.pending,name),'wx');try{await handle.writeFile(JSON.stringify({version:1,id:name,generation:this.generation()}));await handle.sync();}finally{await handle.close();}return name;}
 async clear(names){for(const name of names){if(!/^[a-f0-9-]+\.json$/.test(name))throw fail('DIRECTORY_INDEX_PENDING','Unrecognized maintenance marker retained.');try{await unlink(path.join(this.pending,name));}catch(e){if(e.code!=='ENOENT')throw e;}}}
 assertRow(row){if(!row||!validId(row.id)||!row.event||typeof row.event!=='object'||(row.event.kind==='unpublished'?row.digest!==null:digest(row.event)!==row.digest))throw fail('DIRECTORY_INDEX_SOURCE_CORRUPT','Original journal record failed validation.');}
 insert(row){
  this.assertRow(row);const e=row.event,old=this.db.prepare('SELECT digest FROM events WHERE id=?').get(row.id);
  if(old){if(old.digest!==row.digest)throw fail('DIRECTORY_INDEX_CONFLICT','Event identity changed. Rebuild cannot replace source history.');return false;}
  this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?,?)').run(row.id,row.digest,e.kind,e.actionId??null,e.attemptId??null,JSON.stringify(e),1,e.kind==='outcome'&&e.result?.kind==='uncertain_external_effect'?1:0);
  return true;
 }
 relations(row){
  const e=row.event;
  const parents=e.kind==='action-state'?[e.parent,...(e.reconciles||[])].filter(Boolean):e.kind==='phase-authority'&&e.authorityScope?[e.authorityParent,...(e.authorityReconciles||[])].filter(Boolean):[];
  if(e.kind==='phase-authority'&&e.authorityScope&&(e.authority!=='host-supplied'||e.completeSnapshot!==true||typeof e.authorityScope!=='string'))throw fail('DIRECTORY_AUTHORITY_LINEAGE','Scoped authority must be a complete host snapshot.');
  for(const id of new Set(parents)){
   const parent=this.db.prepare('SELECT kind,action,body FROM events WHERE id=?').get(id);
   if(!parent||id===row.id||parent.kind!==e.kind||(e.kind==='action-state'?parent.action!==e.actionId:JSON.parse(parent.body).authorityScope!==e.authorityScope))throw fail('DIRECTORY_INDEX_LINEAGE','Revision parent must retain the same kind and explicit scope.');
   this.db.prepare('INSERT OR IGNORE INTO edges VALUES(?,?)').run(row.id,id);
  }
  for(const id of e.kind==='action-state'?e.evidence||[]:[])this.db.prepare('INSERT OR IGNORE INTO evidence VALUES(?,?)').run(row.id,id);
 }
 // Rebuild-only projection. Steady publication touches affected records below.
 projectAll(){
  this.db.exec(`UPDATE events SET working=CASE
   WHEN kind IN ('action-state','phase-authority') THEN NOT EXISTS(SELECT 1 FROM edges WHERE parent=events.id)
   WHEN kind='attempt' THEN NOT EXISTS(SELECT 1 FROM events o WHERE o.kind='outcome' AND o.attempt=events.id)
   WHEN kind='outcome' THEN CASE WHEN json_extract(body,'$.result.success') IS NOT 1 OR unknown=1 THEN 1
    WHEN EXISTS(SELECT 1 FROM events n WHERE n.kind='action-state' AND n.action=events.action) OR EXISTS(SELECT 1 FROM evidence WHERE source=events.id OR source=events.attempt) THEN 0 ELSE 1 END
   WHEN kind IN ('legacy-context','unpublished') THEN 1 ELSE 0 END;
   DELETE FROM actions;
   INSERT INTO actions SELECT action,COUNT(*) FROM events WHERE kind='action-state' AND working=1 GROUP BY action;`);
 }
 projectOne(row){
  const e=row.event;
  if(e.kind==='action-state'||e.kind==='phase-authority'){
   this.db.prepare('UPDATE events SET working=0 WHERE id IN (SELECT parent FROM edges WHERE child=?)').run(row.id);
   if(e.kind==='action-state'){
    this.db.prepare("UPDATE events SET working=0 WHERE action=? AND kind='outcome' AND working=1 AND unknown=0 AND json_extract(body,'$.result.success')=1").run(e.actionId??null);
    for(const id of new Set(e.evidence||[])){
     this.db.prepare("UPDATE events SET working=0 WHERE id=? AND kind='outcome' AND working=1 AND unknown=0 AND json_extract(body,'$.result.success')=1").run(id);
     this.db.prepare("UPDATE events SET working=0 WHERE attempt=? AND kind='outcome' AND working=1 AND unknown=0 AND json_extract(body,'$.result.success')=1").run(id);
    }
    this.db.prepare("INSERT INTO actions VALUES(?,(SELECT COUNT(*) FROM events WHERE action=? AND kind='action-state' AND working=1)) ON CONFLICT(id) DO UPDATE SET heads=excluded.heads").run(e.actionId,e.actionId);
   }
  }else if(e.kind==='outcome'){
   this.db.prepare("UPDATE events SET working=0 WHERE kind='attempt' AND id=?").run(e.attemptId);
   if(e.result?.success===true&&e.result?.kind!=='uncertain_external_effect'){
    const known=this.db.prepare("SELECT 1 FROM events WHERE action=? AND kind='action-state' LIMIT 1").get(e.actionId??null);
    const cited=this.db.prepare('SELECT 1 FROM evidence WHERE source IN (?,?) LIMIT 1').get(row.id,e.attemptId);
    if(known||cited)this.db.prepare('UPDATE events SET working=0 WHERE id=?').run(row.id);
   }
  }else if(!['attempt','legacy-context','unpublished'].includes(e.kind))this.db.prepare('UPDATE events SET working=0 WHERE id=?').run(row.id);
 }
 async publish(writeOriginal){return this.serialized(async()=>{
  this.db.exec('BEGIN IMMEDIATE');let marker,committed=false,originalMayHaveChanged=false;
  try{
   if(this.generation()==='unbuilt'||(await this.markers()).length)throw fail('DIRECTORY_INDEX_REBUILD_REQUIRED','Index is incomplete; preserve records and rebuild before admission.');
   marker=await this.mark();await this.checkpoint('marker');
   const row=await writeOriginal(value=>{originalMayHaveChanged=value;});await this.checkpoint('original');
   if(this.insert(row)){this.relations(row);this.projectOne(row);}
   this.db.prepare("UPDATE meta SET value=? WHERE key='generation'").run(randomUUID());await this.checkpoint('indexed');
   this.db.exec('COMMIT');committed=true;await this.checkpoint('committed');
   await this.clear([marker]);return row;
  }catch(error){if(!committed)this.db.exec('ROLLBACK');if(marker&&!committed&&!originalMayHaveChanged)await this.clear([marker]);throw error;}
 });}
 async rebuild({exclusiveWritersConfirmed=false}={}){if(!exclusiveWritersConfirmed)throw fail('DIRECTORY_INDEX_EXCLUSIVE','Exclude legacy writers and reconcile controllers before rebuilding.');return this.serialized(async()=>{
  this.db.exec('BEGIN IMMEDIATE');let committed=false;
  try{
   const prior=await this.markers(),marker=await this.mark();await this.checkpoint('rebuild-marker');
   const rows=await this.journal.events();
   const originals=new Map(rows.map(row=>[row.id,row]));
   for(const priorRow of this.db.prepare('SELECT id,digest,kind FROM events').all()){
    const original=originals.get(priorRow.id);
    if(!original||priorRow.kind!=='unpublished'&&priorRow.digest!==original.digest)throw fail('DIRECTORY_INDEX_SOURCE_CHANGED','Rebuild cannot silently drop or replace previously indexed source evidence.');
   }
   this.db.exec('DELETE FROM evidence; DELETE FROM edges; DELETE FROM actions; DELETE FROM events;');
   for(const row of rows)this.insert(row);
   for(const row of rows)this.relations(row);
   if(this.db.prepare('WITH RECURSIVE ancestry(child,parent) AS (SELECT child,parent FROM edges UNION SELECT a.child,e.parent FROM ancestry a JOIN edges e ON e.child=a.parent) SELECT 1 FROM ancestry WHERE child=parent LIMIT 1').get())throw fail('DIRECTORY_INDEX_LINEAGE','Cyclic lineage cannot form a valid working projection.');
   this.projectAll();const generation=randomUUID();this.db.prepare("UPDATE meta SET value=? WHERE key='generation'").run(generation);
   await this.checkpoint('rebuild-indexed');this.db.exec('COMMIT');committed=true;await this.checkpoint('rebuild-committed');
   await this.clear([...prior,marker]);return {generation,validatedEvents:rows.length,kind:'full-validation-rebuild'};
  }catch(error){if(!committed)this.db.exec('ROLLBACK');throw error;}
 });}
 query({view='working',actionId,after='',limit=20}={}){
  if(!Number.isSafeInteger(limit)||limit<1||limit>50||after!==''&&!validId(after))throw fail('DIRECTORY_INDEX_RANGE','Use a bounded keyset page and exact continuation ID.');
  let predicate='id>?',args=[after];
  if(actionId!==undefined){if(typeof actionId!=='string'||!actionId)throw fail('DIRECTORY_INDEX_RANGE','Action ID required.');predicate='action=? AND id>?';args=[actionId,after];}
  else if(view==='working')predicate='working=1 AND id>?';
  else if(view==='unknown')predicate='unknown=1 AND id>?';
  else if(view==='authority')predicate="kind='phase-authority' AND id>?";
  else if(view!=='events')throw fail('DIRECTORY_INDEX_RANGE','Unsupported indexed view.');
  return {sql:'SELECT * FROM events WHERE '+predicate+' ORDER BY id LIMIT ?',args:[...args,limit+1],limit};
 }
 async read(options={}){return this.serialized(()=>this._read(options));}
 async _read(options={}){
  const started=performance.now();this.db.exec('BEGIN');
  try{
   const generation=this.generation(); // Establish snapshot before checking markers.
   if(generation==='unbuilt'||(await this.markers()).length)throw fail('DIRECTORY_INDEX_REBUILD_REQUIRED','Index maintenance is unfinished; no complete view is available.');
   if(options.generation&&options.generation!==generation)throw fail('DIRECTORY_READ_CHANGED','Index generation changed; restart pagination or inspect exact IDs.');
   const query=this.query(options),queryStarted=performance.now(),found=this.db.prepare(query.sql).all(...query.args),queryMs=performance.now()-queryStarted;
   const selected=found.slice(0,query.limit);let sourceBytes=0;
   const rows=[];
   for(const record of selected){
    let row;
    if(record.kind==='unpublished'){
     await readFile(path.join(this.root,record.id+'.json.claim'));
     try{await readFile(path.join(this.root,record.id+'.json'));throw fail('DIRECTORY_INDEX_SOURCE_CHANGED','Unpublished source changed; rebuild required.');}catch(error){if(error.code!=='ENOENT')throw error;}
     row={id:record.id,digest:null,event:JSON.parse(record.body)};
    }else{
     const raw=await readFile(path.join(this.root,record.id+'.json'),'utf8');sourceBytes+=Buffer.byteLength(raw);row=JSON.parse(raw);this.assertRow(row);
     if(row.id!==record.id||row.digest!==record.digest||JSON.stringify(row.event)!==record.body)throw fail('DIRECTORY_INDEX_SOURCE_CHANGED','Index and original differ; preserve both and rebuild.');
    }
    const e=row.event,heads=e.kind==='action-state'?this.db.prepare('SELECT heads FROM actions WHERE id=?').get(e.actionId)?.heads:undefined;
    rows.push({id:row.id,digest:row.digest,event:{kind:e.kind,actionId:e.actionId,authority:e.authority,authorityScope:e.authorityScope,attemptId:e.attemptId,result:e.result,objective:e.objective?.slice(0,200),state:e.state?.slice(0,200),nextAction:e.nextAction?.slice(0,200),truncatedFields:['objective','state','nextAction'].filter(key=>typeof e[key]==='string'&&e[key].length>200)},...(heads===undefined?{}:{actionHeads:heads})});
   }
   if((await this.markers()).length)throw fail('DIRECTORY_INDEX_REBUILD_REQUIRED','Publication began during read; inspect the committed generation after settlement.');
   this.db.exec('COMMIT');
   return {generation,events:rows,nextAfter:found.length>query.limit?selected.at(-1).id:null,
    cost:{selectedRecords:selected.length,sourceBytes,queryMs,elapsedMs:performance.now()-started,historyEnumerations:0},
    scope:'Committed snapshot generation; selected original records validated, not a full-history integrity audit. Unknown effects remain unresolved. Previews require exact inspection for full obligations.'};
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 explain(options){const q=this.query(options);return this.db.prepare('EXPLAIN QUERY PLAN '+q.sql).all(...q.args);}
}
