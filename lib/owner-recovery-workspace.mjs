import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const fail=()=>Object.assign(new Error('The exact file precondition changed or cannot be verified. Nothing was dispatched.'),{code:'OWNER_RECOVERY_PRECONDITION',actionDispatched:false});
export async function workspaceRecoveryBinding(descriptor){
  const keys=descriptor.resources.filter(row=>row.access==='write'&&!row.scopeOnly&&row.key.startsWith('path:'));
  if(keys.length!==1)throw fail();
  const target=keys[0].key.slice(5);
  if(!path.isAbsolute(target))throw fail();
  try{
    const before=await fs.lstat(target,{bigint:true});
    if(!before.isFile()||before.isSymbolicLink()||before.size>32n*1024n*1024n)throw fail();
    const bytes=await fs.readFile(target),after=await fs.lstat(target,{bigint:true});
    const stamp=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].map(String).join(':');
    if(stamp(before)!==stamp(after))throw fail();
    return {kind:'file',path:target,realpath:await fs.realpath(target),identity:stamp(after),sha256:createHash('sha256').update(bytes).digest('hex')};
  }catch(error){
    if(error.code!=='ENOENT')throw error;
    const parent=path.dirname(target),info=await fs.stat(parent,{bigint:true});
    if(!info.isDirectory())throw fail();
    return {kind:'absent-file',path:target,parent:await fs.realpath(parent),parentIdentity:[info.dev,info.ino].map(String).join(':')};
  }
}
