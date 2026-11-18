import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
// Separate read-only connection verifies committed storage, not a live-store cache.
export function readSavedDirectJobBytes(file,id){const db=new DatabaseSync(file,{readOnly:true});try{const row=db.prepare('SELECT j.metadata,p.body FROM jobs j JOIN payloads p ON p.id=j.id WHERE j.id=?').get(id);assert.ok(row,'Durable receipt must exist');return JSON.stringify(row);}finally{db.close();}}
export function readSavedDirectJob(file,id){return JSON.parse(JSON.parse(readSavedDirectJobBytes(file,id)).body);}
