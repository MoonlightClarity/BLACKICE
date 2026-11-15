import {DirectExecutionJobs} from '../lib/direct-execution-jobs.mjs';
import {LedgerStartupMetrics} from '../lib/ledger-startup-metrics.mjs';
import {readdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const [dataDir,output,parallel='4']=process.argv.slice(2),concurrency=Number(parallel);
if(!dataDir||!output||![4,8,16].includes(concurrency))throw Error('Use COPIED_DATA_DIRECTORY OUTPUT_JSON [4|8|16]');
const store=new DirectExecutionJobs({dataDir:path.resolve(dataDir)}),metrics=new LedgerStartupMetrics();
store.startupMetrics=metrics;metrics.mark('enumerate');
const names=(await readdir(store.directory)).filter(n=>/^direct_[a-f0-9]{64}\.json$/.test(n));
metrics.mark('scan');let cursor=0;
await Promise.all(Array.from({length:concurrency},async()=>{
 for(;;){const name=names[cursor++];if(!name)return;const saved=await store.readRecord(name.slice(0,-5));const start=metrics.now();store.remember(saved.record,saved.receiptHash,{deferResourceSort:true});metrics.elapsed('indexMs',start);}
}));
metrics.mark('sort');for(const bucket of store.resourceIndex.values())bucket.sort((a,b)=>{const l=store.records.get(a),r=store.records.get(b);return l.createdAt.localeCompare(r.createdAt)||l.id.localeCompare(r.id);});
const measured=metrics.finish('ready'),digest=createHash('sha256');
for(const [id,record] of [...store.records].sort(([a],[b])=>a.localeCompare(b)))digest.update(JSON.stringify([id,record.requestDigest,store.receiptHashes.get(record),record.status,record.revision]));
const result={at:new Date().toISOString(),node:process.version,platform:process.platform,kind:'read-only-full-receipt-scan-and-index',concurrency,enumerated:names.length,metrics:measured,records:store.records.size,resourceBuckets:store.resourceIndex.size,stateHash:digest.digest('hex'),limits:'No lease acquisition or recovery writes; not whole-app startup. OS cache not flushed. Concurrent host work may affect timings. Aggregate I/O durations overlap. receipts counts successful validation.'};
await writeFile(output,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
