import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const sha256=value=>createHash('sha256').update(value).digest('hex');
const fail=(message,code='WORKSPACE_APPEND_CONFLICT')=>Object.assign(new Error(message),{code,actionDispatched:false});
const check=signal=>{if(signal?.aborted)throw signal.reason||Object.assign(new Error('Workspace action cancelled.'),{name:'AbortError',code:'ABORT_ERR'});};
const sameStat=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;

/** Full-file identity uses bounded memory and never returns the file contents. */
export async function inspectWorkspaceFile(file,{signal,textOnly=false,appendBytes}={}){
  check(signal);
  const handle=await fs.open(file,'r');
  try{
    const before=await handle.stat({bigint:true});
    if(!before.isFile())throw fail('Choose a regular file.','WORKSPACE_FILE_TYPE');
    const hash=createHash('sha256'),post=appendBytes!==undefined?createHash('sha256'):null;
    const decoder=textOnly?new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}):null;
    let size=0;
    for await(const bytes of handle.createReadStream({autoClose:false,highWaterMark:65536})){
      check(signal);hash.update(bytes);post?.update(bytes);size+=bytes.length;
      if(decoder){if(bytes.includes(0))throw fail('Append accepts UTF-8 text, not binary data.','WORKSPACE_APPEND_TEXT');try{decoder.decode(bytes,{stream:true});}catch{throw fail('Append accepts only valid UTF-8 files.','WORKSPACE_APPEND_TEXT');}}
    }
    if(decoder)try{decoder.decode();}catch{throw fail('Append accepts only valid UTF-8 files.','WORKSPACE_APPEND_TEXT');}
    const after=await handle.stat({bigint:true});
    if(!sameStat(before,after)||BigInt(size)!==before.size)throw fail('The file changed during inspection. Read its current identity and retry.');
    check(signal);
    return{path:file,size,sha256:hash.digest('hex'),...(post?{afterHash:post.update(appendBytes).digest('hex')}: {})};
  }finally{await handle.close();}
}
const locks=new Map();
export async function withWorkspaceMutationLock(file,operation){
  const key=process.platform==='win32'?path.resolve(file).toLowerCase():path.resolve(file);
  const previous=locks.get(key)||Promise.resolve(),next=previous.catch(()=>{}).then(operation);
  locks.set(key,next);
  try{return await next;}finally{if(locks.get(key)===next)locks.delete(key);}
}
export function validateAppend(args){
  if(typeof args?.path!=='string'||!args.path.trim()||typeof args.text!=='string'||!args.text||
    args.text.includes('\0')||Buffer.byteLength(args.text,'utf8')>1024*1024||
    typeof args.expectedHash!=='string'||!/^[a-f0-9]{64}$/.test(args.expectedHash))
    throw fail('Append needs one existing path, nonempty UTF-8 text up to 1 MiB, and the exact current SHA-256 in expectedHash.','WORKSPACE_APPEND_ARGUMENTS');
}
/** This stages a complete postimage, then replaces the target atomically.
 * Same-process workspace mutations serialize. External file changes detected
 * before promotion cause a conflict; no absolute cross-process lock is claimed.
 */
export async function appendWorkspaceChunk(selected,args,signal){
  validateAppend(args);check(signal);
  let file;
  try{file=await fs.realpath(selected);}catch(cause){
    if(cause.code==='ENOENT')throw fail('The append target does not exist. Start the file with write, then append using its returned hash.');
    throw cause;
  }
  const bytes=Buffer.from(args.text,'utf8'),temp=path.join(path.dirname(file),'.'+path.basename(file)+'.relay-append-'+randomUUID()+'.tmp');
  let promotionAttempted=false,expectedAfter=null,created=false;
  try{
    const before=await inspectWorkspaceFile(file,{signal,textOnly:true,appendBytes:bytes});
    if(before.sha256!==args.expectedHash)throw fail('The file changed since expectedHash. Inspect its current identity before appending; no chunk was added.');
    expectedAfter=before.afterHash;
    await fs.copyFile(file,temp,constants.COPYFILE_EXCL);created=true;check(signal);
    const staged=await inspectWorkspaceFile(temp,{signal});
    if(staged.sha256!==before.sha256)throw fail('The file changed during staging. No chunk was added.');
    await fs.appendFile(temp,bytes);
    const handle=await fs.open(temp,'r+');
    try{await handle.sync();}finally{await handle.close();}
    const post=await inspectWorkspaceFile(temp,{signal});
    if(post.sha256!==expectedAfter||post.size!==before.size+bytes.length)throw fail('The staged file does not match the expected postimage. No chunk was added.');
    const current=await inspectWorkspaceFile(file,{signal});
    if(current.sha256!==before.sha256||await fs.realpath(selected)!==file)throw fail('The destination changed during staging. No chunk was added.');
    check(signal);promotionAttempted=true;
    await fs.rename(temp,file);created=false;
    return{path:file,status:'applied',atomic:true,beforeHash:before.sha256,afterHash:post.sha256,sha256:post.sha256,size:post.size,bytesWritten:bytes.length,chunkSha256:sha256(bytes),nextAction:'Use sha256 as expectedHash for the next chunk. Verify the complete saved file before reporting completion.'};
  }catch(cause){
    if(promotionAttempted){
      // A failed rename may have an uncertain outcome. Never replay a chunk
      // without inspecting the exact current destination.
      let actual=null;try{actual=await inspectWorkspaceFile(file);}catch{}
      if(actual?.sha256===expectedAfter)return{path:file,status:'applied',atomic:true,beforeHash:args.expectedHash,afterHash:expectedAfter,sha256:expectedAfter,size:actual.size,bytesWritten:bytes.length,chunkSha256:sha256(bytes),reconciled:true};
      if(actual?.sha256===args.expectedHash)throw Object.assign(cause,{actionDispatched:false});
      throw Object.assign(cause,{actionDispatched:true});
    }
    throw Object.assign(cause,{actionDispatched:false});
  }finally{if(created)await fs.rm(temp,{force:true}).catch(()=>{});}
}
