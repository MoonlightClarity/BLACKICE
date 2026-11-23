// Indexed, transactional operational-effect receipts. Chat archival does not erase effects.
import { DatabaseSync } from 'node:sqlite';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const fail=(message,code='OPERATIONAL_RECEIPTS_UNAVAILABLE')=>Object.assign(new Error(message),{code,status:409,actionDispatched:false});
const copy=value=>structuredClone(value);
function validate(row){
  return !!row&&typeof row.operationId==='string'&&typeof row.taskId==='string'&&typeof row.runId==='string'
    &&typeof row.nodeId==='string'&&typeof row.effect==='string'&&['unknown','absent','confirmed'].includes(row.state)
    &&Array.isArray(row.resources)&&row.resources.every(key=>typeof key==='string')
    &&(!row.descriptor||(!!row.callDigest&&row.descriptor.operationKey===row.operationKey&&Array.isArray(row.evidence)))
    &&(!row.resultRef||(/^[a-f0-9]{64}$/.test(row.resultRef.sha256)&&Number.isSafeInteger(row.resultRef.bytes)&&row.resultRef.bytes>0));
}
const schema=[
  'CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;',
  'CREATE TABLE receipts(seq INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT UNIQUE NOT NULL,task_id TEXT NOT NULL,node_id TEXT NOT NULL,adapter TEXT NOT NULL,state TEXT NOT NULL,operation_key TEXT,payload TEXT NOT NULL);',
  'CREATE INDEX receipt_owner_idx ON receipts(task_id,node_id,state,adapter);',
  'CREATE INDEX receipt_operation_idx ON receipts(operation_key,state);',
  'CREATE TABLE resources(operation_id TEXT NOT NULL,resource_key TEXT NOT NULL,PRIMARY KEY(operation_id,resource_key)) WITHOUT ROWID;',
  'CREATE INDEX resource_key_idx ON resources(resource_key);'
].join(' ');

export function createOperationalEffectLedger({file,cwd,assertOwner}){
  if(!path.isAbsolute(file)||!path.isAbsolute(cwd))throw Error('An absolute ledger path and workspace are required.');
  const databaseFile=file+'.sqlite',anchorFile=file+'.sqlite.anchor',root=path.resolve(cwd);
  const signature=stat=>stat?String(stat.size)+'|'+String(stat.mtimeMs):'absent';
  async function legacyStat(){try{return await fs.stat(file);}catch(error){if(error.code==='ENOENT')return null;throw fail('The legacy effect journal cannot be inspected.');}}
  async function readAnchor(){
    try{
      const value=JSON.parse(await fs.readFile(anchorFile,'utf8'));
      if(value?.version!==1||value.root!==root||typeof value.ledgerId!=='string'||!value.ledgerId)
        throw Error('Invalid anchor');
      return value;
    }catch(error){if(error.code==='ENOENT')return null;throw fail('The operational ledger migration anchor is invalid. Preserve receipts.');}
  }
  async function legacy(){
    // Once SQLite is authoritative, losing it must not silently roll back to
    // an older journal without the effects written since migration.
    if(await readAnchor())throw fail('The operational ledger is missing after migration. Preserve the anchor and legacy journal.');
    const stat=await legacyStat();
    if(!stat)return{records:[],signature:'absent'};
    let value;
    try{value=JSON.parse(await fs.readFile(file,'utf8'));}
    catch{throw fail('The legacy operational journal is unreadable. Preserve it; no consequential action was dispatched.');}
    if(value?.version!==1||value.root!==root||!Array.isArray(value.records)||!value.records.every(validate)
      ||new Set(value.records.map(row=>row.operationId)).size!==value.records.length)
      throw fail('The legacy operational journal is invalid. Preserve it; no consequential action was dispatched.');
    return{records:value.records,signature:signature(stat)};
  }
  async function exists(){
    try{const stat=await fs.stat(databaseFile);if(!stat.isFile())throw fail('The operational ledger is not a file.');return true;}
    catch(error){if(error.code==='ENOENT')return false;throw error;}
  }
  const decode=row=>{
    let value;
    try{value=JSON.parse(row.payload);}catch{throw fail('An operational receipt is corrupted. Preserve the ledger.');}
    if(!validate(value)||value.operationId!==row.operation_id)throw fail('An operational receipt failed integrity checks. Preserve the ledger.');
    return value;
  };
  function adapter(db){
    const get=db.prepare('SELECT operation_id,payload FROM receipts WHERE operation_id=?');
    const byOwner=db.prepare('SELECT operation_id,payload FROM receipts WHERE task_id=? AND node_id=? ORDER BY seq');
    const byUnresolved=db.prepare("SELECT operation_id,payload FROM receipts WHERE task_id=? AND node_id=? AND state='unknown' AND adapter=? ORDER BY seq");
    const all=db.prepare('SELECT operation_id,payload FROM receipts ORDER BY seq');
    const byKey=db.prepare("SELECT operation_id,payload FROM receipts WHERE operation_key=? AND state<>'absent'");
    const byResource=db.prepare("SELECT receipts.operation_id,receipts.payload FROM resources JOIN receipts ON receipts.operation_id=resources.operation_id WHERE resources.resource_key=? AND receipts.state<>'absent'");
    const insert=db.prepare('INSERT INTO receipts(operation_id,task_id,node_id,adapter,state,operation_key,payload) VALUES(?,?,?,?,?,?,?)');
    const update=db.prepare('UPDATE receipts SET state=?,payload=? WHERE operation_id=?');
    const insertResource=db.prepare('INSERT OR IGNORE INTO resources(operation_id,resource_key) VALUES(?,?)');
    return{
      get:id=>{const row=get.get(id);return row?decode(row):null;},
      all:()=>all.all().map(decode),
      owned:(taskId,nodeId)=>byOwner.all(taskId,nodeId).map(decode),
      unresolved:(taskId,nodeId,adapter)=>byUnresolved.all(taskId,nodeId,adapter).map(decode),
      conflicts:candidate=>{
        const found=new Map();
        if(candidate.operationKey)for(const row of byKey.all(candidate.operationKey))found.set(row.operation_id,decode(row));
        for(const key of candidate.resources)for(const row of byResource.all(key))found.set(row.operation_id,decode(row));
        return[...found.values()];
      },
      insert:row=>{
        if(!validate(row))throw fail('Refusing to save an invalid operation receipt.');
        insert.run(row.operationId,row.taskId,row.nodeId,row.adapter||'',row.state,row.operationKey||null,JSON.stringify(row));
        for(const key of new Set(row.resources))insertResource.run(row.operationId,key);
      },
      update:row=>{
        if(!validate(row))throw fail('Refusing to update an invalid operation receipt.');
        if(update.run(row.state,JSON.stringify(row),row.operationId).changes!==1)throw fail('The original operation receipt is missing. Do not replay the effect.','OPERATIONAL_RECEIPT_MISSING');
      }
    };
  }
  async function withDatabase(callback){
    const db=new DatabaseSync(databaseFile);
    try{
      db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
      const readMeta=db.prepare('SELECT value FROM meta WHERE key=?');
      const anchor=await readAnchor();
      if(anchor?.ledgerId!==readMeta.get('ledger_id')?.value)
        throw fail('The operational ledger identity anchor changed. Preserve the original receipts.');
      if(readMeta.get('version')?.value!=='2'||readMeta.get('root')?.value!==root)
        throw fail('The operational ledger identity is invalid; preserve the original journal.');
      if(readMeta.get('legacy_signature')?.value!==signature(await legacyStat()))
        throw fail('Legacy receipts changed after ledger migration; preserve both copies and reconcile before further external actions.');
      return await callback(db,adapter(db));
    }finally{db.close();}
  }
  async function create(){
    if(await exists())return;
    if(await readAnchor())throw fail('The operational ledger is missing after migration. Preserve the anchor and legacy journal.');
    const initial=await legacy(),ledgerId=randomUUID();
    const temporary=databaseFile+'.'+randomUUID()+'.tmp';
    let db;
    try{
      db=new DatabaseSync(temporary);
      db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;'+schema);
      db.exec('BEGIN IMMEDIATE');
      const ops=adapter(db);
      try{
        for(const row of initial.records)ops.insert(row);
        const put=db.prepare('INSERT INTO meta(key,value) VALUES(?,?)');
        put.run('version','2');put.run('root',root);put.run('legacy_signature',initial.signature);put.run('ledger_id',ledgerId);
        db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');throw error;}
      db.close();db=null;
      await assertOwner();
      // Publish a durable identity anchor BEFORE the database. A crash between
      // them fails closed, rather than reconstructing an incomplete history.
      const marker=await fs.open(anchorFile,'wx',0o600);
      try{
        await marker.writeFile(JSON.stringify({version:1,root,ledgerId,legacySignature:initial.signature}));
        await marker.sync();
      }finally{await marker.close();}
      await assertOwner();
      // Publish only the fully committed database; never overwrite the original JSON.
      await fs.rename(temporary,databaseFile);
    }finally{
      db?.close();
      await fs.rm(temporary,{force:true}).catch(()=>{});
    }
  }
  async function list({taskId,nodeId,unresolvedAdapter}={}){
    if(!await exists()){
      const rows=(await legacy()).records;
      return copy(rows.filter(row=>(!taskId||row.taskId===taskId)&&(!nodeId||row.nodeId===nodeId)
        &&(!unresolvedAdapter||row.adapter===unresolvedAdapter&&row.state==='unknown')));
    }
    try{
      return copy(await withDatabase((_db,ops)=>taskId&&nodeId
        ?unresolvedAdapter?ops.unresolved(taskId,nodeId,unresolvedAdapter):ops.owned(taskId,nodeId)
        :ops.all()));
    }catch(error){if(error.code==='OPERATIONAL_RECEIPTS_UNAVAILABLE')throw error;throw fail('The operational ledger cannot be read. Preserve its receipts.');}
  }
  async function latest({taskId,nodeId,limit=100}){
    if(!taskId||!nodeId||!Number.isSafeInteger(limit)||limit<1)throw fail('An exact worker and positive result window are required.');
    if(!await exists()){
      const rows=(await legacy()).records.filter(row=>row.taskId===taskId&&row.nodeId===nodeId);
      return{total:rows.length,rows:copy(rows.slice(-limit))};
    }
    try{return await withDatabase((db)=>{
      const total=Number(db.prepare('SELECT COUNT(*) AS count FROM receipts WHERE task_id=? AND node_id=?').get(taskId,nodeId)?.count||0);
      const recent=db.prepare('SELECT operation_id,payload FROM receipts WHERE task_id=? AND node_id=? ORDER BY seq DESC LIMIT ?').all(taskId,nodeId,limit);
      return{total,rows:copy(recent.map(decode).reverse())};
    });}catch(error){if(error.code==='OPERATIONAL_RECEIPTS_UNAVAILABLE')throw error;throw fail('The operational receipt index cannot be inspected. Preserve it.');}
  }
  async function get(operationId){
    if(!await exists())return copy((await legacy()).records.find(row=>row.operationId===operationId)||null);
    try{return copy(await withDatabase((_db,ops)=>ops.get(operationId)));}
    catch(error){if(error.code==='OPERATIONAL_RECEIPTS_UNAVAILABLE')throw error;throw fail('The operational receipt cannot be inspected. Preserve its records.');}
  }
  async function transact(callback){
    try{
      await create();
      return await withDatabase((db,ops)=>{
        db.exec('BEGIN IMMEDIATE');
        try{
          const result=callback(ops);
          if(result&&typeof result.then==='function')throw fail('Effect ledger transactions cannot contain asynchronous work.');
          db.exec('COMMIT');return copy(result);
        }catch(error){db.exec('ROLLBACK');throw error;}
      });
    }catch(error){
      if(error.code?.startsWith('OPERATIONAL_'))throw error;
      throw fail('The operational ledger could not durably store the action receipt. No external action was dispatched.');
    }
  }
  return{databaseFile,list,latest,get,transact};
}
