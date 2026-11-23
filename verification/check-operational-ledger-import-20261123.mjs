// Read-only source audit plus offline migration of a COPIED journal.
// Never opens or edits the production journal for writing.
import { readFile, copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createOperationalEffectLedger } from '../lib/operational-effect-ledger.mjs';

const original=process.argv[2];
if(!original||!path.isAbsolute(original))throw Error('Pass the absolute original .effects path.');
const bytes=await readFile(original),sha=value=>createHash('sha256').update(value).digest('hex');
const originalHash=sha(bytes),root=JSON.parse(bytes.toString('utf8')).root;
const scratch=await mkdtemp(path.join(tmpdir(),'blackice-ledger-import-check-'));
const clonePath=path.join(scratch,'journal.effects');
try{
  await copyFile(original,clonePath);
  const ledger=createOperationalEffectLedger({file:clonePath,cwd:root,assertOwner:async()=>{}});
  const oldRows=await ledger.list();
  const imported=await ledger.transact(ops=>({total:ops.all().length}));
  const newRows=await ledger.list();
  const snapshot=rows=>({
    total:rows.length,
    unknown:rows.filter(row=>row.state==='unknown').length,
    confirmed:rows.filter(row=>row.state==='confirmed').length,
    absent:rows.filter(row=>row.state==='absent').length,
    identities:new Set(rows.map(row=>row.operationId)).size
  });
  const before=snapshot(oldRows),after=snapshot(newRows);
  if(JSON.stringify(before)!==JSON.stringify(after)||imported.total!==oldRows.length)throw Error('Migration changed or lost receipts.');
  const originalAfter=await readFile(original);
  if(sha(originalAfter)!==originalHash)throw Error('Source journal changed during offline validation.');
  console.log(JSON.stringify({migration:'verified-copy-only',sourceBytes:bytes.length,sourceSha256:originalHash,before,after,sqliteBytes:(await stat(ledger.databaseFile)).size},null,2));
}finally{await rm(scratch,{recursive:true,force:true});}
