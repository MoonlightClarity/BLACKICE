import { promises as fs, createReadStream, constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const digestFile = async file => {
  const hash=createHash('sha256');
  for await (const chunk of createReadStream(file,{highWaterMark:1024*1024})) hash.update(chunk);
  return hash.digest('hex');
};
const signature=s=>[s.size,s.mtimeMs,s.ctimeMs,s.ino].join(':');
const changed=()=>Object.assign(new Error('The source history changed during archival; no migration was performed.'),{code:'RUN_ARCHIVE_SOURCE_CHANGED'});
const archiveFailure=message=>Object.assign(new Error(message),{code:'RUN_ARCHIVE_UNAVAILABLE'});

/** Preserve exact original bytes, outside of volatile run objects, before a
 * large run history is ever compacted. Archive is immutable, content-addressed
 * and verified after copying. Do not upload raw transcripts or memory dumps. */
export async function archiveOversizedRuns(dataDir, {
  io=fs, thresholdBytes=32*1024*1024, digest=digestFile
}={}) {
  const source=path.join(dataDir,'runs.json');
  let before;
  try{before=await io.stat(source);}catch(e){if(e.code==='ENOENT')return null;throw e;}
  if(before.size<=thresholdBytes)return null;
  const originalHash=await digest(source);
  const afterDigest=await io.stat(source);
  if(signature(before)!==signature(afterDigest))throw changed();
  const directory=path.join(dataDir,'run-event-archives');
  await io.mkdir(directory,{recursive:true});
  const name='runs-original-'+originalHash+'.json';
  const destination=path.join(directory,name);
  const relative=path.join('run-event-archives',name).replaceAll('\\','/');
  let existing=null;
  try{existing=await io.stat(destination);}catch(e){if(e.code!=='ENOENT')throw e;}
  if(existing){
    if(!existing.isFile()||existing.size!==before.size||(await digest(destination))!==originalHash)
      throw archiveFailure('An existing original history archive failed byte and hash checks. Source history was not changed.');
  }else{
    const temporary=path.join(directory,'.runs-'+randomUUID()+'.tmp');
    try{
      await io.copyFile(source,temporary,constants.COPYFILE_EXCL);
      const copied=await io.stat(temporary);
      if(!copied.isFile()||copied.size!==before.size||(await digest(temporary))!==originalHash)throw archiveFailure('The copied history did not match its original SHA-256.');
      const now=await io.stat(source);
      if(signature(now)!==signature(afterDigest))throw changed();
      const h=await io.open(temporary,'r+');
      try{await h.sync();}finally{await h.close();}
      try{await io.rename(temporary,destination);}catch(e){
        const old=await io.stat(destination).catch(()=>null);
        if(!old||old.size!==before.size||(await digest(destination))!==originalHash)throw e;
      }
    }finally{await io.rm(temporary,{force:true}).catch(()=>{});}
  }
  const finalSource=await io.stat(source);
  if(signature(finalSource)!==signature(afterDigest))throw changed();
  return {format:1,relativePath:relative,sha256:originalHash,bytes:before.size,archivedAt:new Date().toISOString()};
}

