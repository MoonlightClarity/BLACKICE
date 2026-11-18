import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

let db;
const open=()=>{
  if(db)return db;
  fs.mkdirSync(workerData.directory,{recursive:true});
  db=new DatabaseSync(path.join(workerData.directory,'run-state.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records(id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(id)); CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);');
  return db;
};
parentPort.on('message',message=>{
  const {id,action}=message;
  try{
    const database=open();let result;
    if(action==='load'){
      const initialized=Boolean(database.prepare("SELECT value FROM metadata WHERE key='initialized'").get());
      const rows=database.prepare('SELECT id,payload FROM records ORDER BY rowid').all();
      const runs=[];
      for(const row of rows){const value=JSON.parse(row.payload);if(value?.id!==row.id)throw new Error('Saved run identity differs from its database key.');runs.push(value);}
      result={initialized,runs};
    }else if(action==='write'){
      // Encoding can fail before the transaction begins. Never acknowledge an
      // incomplete batch or erase the last committed version on an error.
      const rows=message.rows.map(row=>({...row,payload:JSON.stringify(row.value)}));
      database.exec('BEGIN IMMEDIATE');
      try{
        const upsert=database.prepare('INSERT INTO records(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload');
        for(const row of rows)upsert.run(row.id,row.payload);
        const remove=database.prepare('DELETE FROM records WHERE id=?');
        for(const row of message.deleted||[])remove.run(row.id);
        if(message.initialize)database.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES('initialized','1')").run();
        database.exec('COMMIT');
      }catch(error){database.exec('ROLLBACK');throw error;}
      if(message.checkpoint)database.exec('PRAGMA wal_checkpoint(FULL)');
      result={committed:true,rows:rows.length};
    }else if(action==='close'){database.close();db=null;result={closed:true};}
    else throw new Error('Unknown run storage request.');
    parentPort.postMessage({id,result});
  }catch(error){parentPort.postMessage({id,error:{message:error.message,code:error.code}});}
});

