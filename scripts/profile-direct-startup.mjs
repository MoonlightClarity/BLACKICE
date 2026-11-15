// Run only against a disposable copy: initialization legitimately recovers
// unfinished copied receipts. Never point a second executor at a live profile.
import {DirectExecutionJobs} from '../lib/direct-execution-jobs.mjs';
import {writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const [dataDir,output]=process.argv.slice(2);
if(!dataDir||!output)throw Error('Usage: node scripts/profile-direct-startup.mjs COPIED_DATA_DIRECTORY OUTPUT_JSON');
let metrics;
const store=new DirectExecutionJobs({dataDir:path.resolve(dataDir),onStartupDiagnostics:event=>{metrics=event;}});
try {
 await store.init();
 const digest=createHash('sha256');
 for(const [id,record] of [...store.records].sort(([a],[b])=>a.localeCompare(b)))digest.update(JSON.stringify([id,record.requestDigest,record.receiptHash,record.status,record.revision]));
 const result={at:new Date().toISOString(),node:process.version,platform:process.platform,kind:'full-ledger-initialization-on-disposable-history-copy',metrics,records:store.records.size,resourceBuckets:store.resourceIndex.size,stateHash:digest.digest('hex'),limits:'Not a whole-app startup. OS cache is not flushed; concurrent host work may affect timings. Aggregate I/O durations overlap. receipts counts successful validation.'};
 await writeFile(output,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
} finally {await store.close();}
