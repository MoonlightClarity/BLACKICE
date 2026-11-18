import {promises as fs} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {DirectExecutionJobs} from '../lib/direct-execution-jobs.mjs';
/** Explicit offline import, not a second runtime storage backend. Originals stay untouched. */
export async function importReceipts({dataDir,stagingDir,publish=false}){
 dataDir=path.resolve(dataDir);stagingDir=path.resolve(stagingDir);
 if(stagingDir===dataDir)throw Error('Use a separate, new staging directory.');
 await fs.mkdir(stagingDir);const source=new DirectExecutionJobs({dataDir}),target=new DirectExecutionJobs({dataDir:stagingDir});let count=0,retiredApprovals=0;
 try{
  await source.ensureDirectory();await source.acquireLease();
  try{await fs.stat(source.databaseFile);throw Error('Receipt database already exists; refusing replacement.');}catch(e){if(e.code!=='ENOENT')throw e;}
  const entries=await fs.readdir(source.directory);
  // Packed migrations require a separate explicit export, not silent data omission.
  if(entries.some(n=>n.includes('manifest')||n==='direct_'+'0'.repeat(64)+'.json'))throw Error('Packed history requires export before SQLite import. No source data was changed.');
  await target.init();const names=entries.filter(n=>/^direct_[a-f0-9]{64}\.json$/.test(n));
  for(let start=0;start<names.length;start+=128){
   const batch=[];
   for(const name of names.slice(start,start+128)){
    const file=path.join(source.directory,name),stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8*1024*1024)throw Error('Invalid receipt file: '+name);
    const record=JSON.parse(await fs.readFile(file,'utf8'));if(record.id+'.json'!==name)throw Error('Receipt identity mismatch.');
    if(record.interaction?.kind==='approval'){
      record.resolvedInteraction=record.interaction;record.interaction=null;
      if(record.status==='awaiting_input'){record.status='interrupted';record.finishedAt=new Date().toISOString();record.revision++;record.updatedAt=record.finishedAt;record.effects={possible:Boolean(record.dispatched&&record.mutating),confirmed:false};record.error={code:'DIRECT_APPROVAL_RETIRED',message:'Obsolete approval state retired during import. The action was not replayed.'};}
      retiredApprovals++;
    }
    batch.push(record);
   }
   target.transaction(()=>{for(const record of batch)target.write(record);});count+=batch.length;
  }
  if((await target.counts()).total!==count)throw Error('Imported count mismatch.');
  const integrity=target.db.prepare('PRAGMA integrity_check').get();if(Object.values(integrity)[0]!=='ok')throw Error('Imported database integrity check failed.');
  target.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');await target.close();
  let published=false;
  if(publish){const handle=await fs.open(target.databaseFile,'r+');try{await handle.sync();}finally{await handle.close();}await fs.link(target.databaseFile,source.databaseFile);published=true;}
  const report={version:1,count,retiredApprovals,published,sourceDataPreserved:true,database:published?source.databaseFile:target.databaseFile};
  await fs.writeFile(path.join(stagingDir,'import-result.json'),JSON.stringify(report,null,2));return report;
 }finally{await target.close();await source.releaseLease();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const args=process.argv.slice(2);const option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
 if(!option('--data-dir')||!option('--staging-dir'))throw Error('Usage: node scripts/import-sqlite-receipts.mjs --data-dir <stopped profile data> --staging-dir <new folder> [--publish]');
 console.log(JSON.stringify(await importReceipts({dataDir:option('--data-dir'),stagingDir:option('--staging-dir'),publish:args.includes('--publish')}),null,2));
}
